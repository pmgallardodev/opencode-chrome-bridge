#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installOpenCodePlugin } from "./lib/opencode-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");

const result = await installOpenCodePlugin({
  configPath,
  configDirectory: path.dirname(configPath),
  pluginPath: repoRoot,
  readFile,
  writeFile,
  mkdir
});
console.log(`OpenCode plugin path installed: ${repoRoot}${result.changed ? "" : " (already configured)"}`);
