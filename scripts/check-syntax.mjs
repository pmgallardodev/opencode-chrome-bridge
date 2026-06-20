#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = ["src", "native-host", "extension", "scripts"];
const files = (await Promise.all(sourceDirectories.map((directory) => collectJavaScriptFiles(path.join(repoRoot, directory)))))
  .flat()
  .sort();

for (const file of files) {
  try {
    await execFileAsync(process.execPath, ["--check", file]);
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || String(error);
    throw new Error(`Syntax check failed for ${path.relative(repoRoot, file)}:\n${detail}`, { cause: error });
  }
}

console.log(`Syntax OK: ${files.length} JavaScript files`);

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && /\.(?:m?js)$/u.test(entry.name)) {
      results.push(entryPath);
    }
  }
  return results;
}
