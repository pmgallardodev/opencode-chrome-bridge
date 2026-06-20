#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "extension", "images");
const faviconPath = path.join(outputDir, "opencode-favicon.ico");
const tempPngPath = path.join(outputDir, ".opencode-favicon-source.png");
const sizes = [16, 32, 48, 128];

await mkdir(outputDir, { recursive: true });
await ensureOfficialFavicon();
await execFileAsync("sips", ["-s", "format", "png", faviconPath, "--out", tempPngPath]);

for (const size of sizes) {
  await execFileAsync("sips", ["-z", String(size), String(size), tempPngPath, "--out", path.join(outputDir, `icon${size}.png`)]);
}

// cursor-chat.png: used by the content script visual overlay as the agent cursor indicator.
// Sized to 44x44 (the overlay ripple diameter) so it is distinct from icon32.png and
// visually appropriate as a larger cursor/chat bubble asset.
await execFileAsync("sips", ["-z", "44", "44", tempPngPath, "--out", path.join(outputDir, "cursor-chat.png")]);

console.log(`Generated ${sizes.length} Chrome icons + cursor-chat.png from ${faviconPath}`);

async function ensureOfficialFavicon() {
  try {
    await access(faviconPath, constants.R_OK);
    return;
  } catch {}

  const response = await fetch("https://opencode.ai/favicon.ico");
  if (!response.ok) {
    throw new Error(`Could not download OpenCode favicon: HTTP ${response.status}`);
  }
  await writeFile(faviconPath, Buffer.from(await response.arrayBuffer()));
}
