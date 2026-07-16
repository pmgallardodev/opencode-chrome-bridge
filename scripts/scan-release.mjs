#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scanTrackedFiles } from "./lib/release-artifact-scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "buffer",
  windowsHide: true
});
const trackedPaths = stdout.toString("utf8").split("\0").filter(Boolean);
const issues = await scanTrackedFiles({ root: repoRoot, trackedPaths });
if (issues.length > 0) {
  throw new Error(`Release artifact scan failed: ${issues.map((issue) => `${issue.path}: ${issue.reason}`).join("; ")}`);
}
console.log(JSON.stringify({ ok: true, trackedFiles: trackedPaths.length }, null, 2));
