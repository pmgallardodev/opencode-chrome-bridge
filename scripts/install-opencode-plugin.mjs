#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installOpenCodePlugin, V1_PLUGIN_KEY, V2_PLUGIN_KEY } from "./lib/opencode-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = process.env.OPENCODE_CONFIG_DIR
  || path.join(os.homedir(), ".config", "opencode");
const configPath = path.join(configDirectory, "opencode.jsonc");

// OpenCode 1 and OpenCode 2 read the same global config file but different keys:
// `plugin` takes the package root and loads src/plugin-entry.js, while `plugins`
// needs the v2 entrypoint directly because OpenCode 2 resolves a directory only
// through a string `exports`/`main` field, which would point at the v1 entry.
const targets = [
  { key: V1_PLUGIN_KEY, pluginPath: repoRoot, runtime: "opencode" },
  { key: V2_PLUGIN_KEY, pluginPath: path.join(repoRoot, "src", "plugin-entry-v2.js"), runtime: "opencode2" }
];

for (const { key, pluginPath, runtime } of targets) {
  const result = await installOpenCodePlugin({
    configPath,
    configDirectory,
    pluginPath,
    key,
    readFile,
    writeFile,
    mkdir
  });
  console.log(
    `${runtime}: ${key} path installed: ${pluginPath}${result.changed ? "" : " (already configured)"}`
  );
}
console.log(`OpenCode config: ${configPath}`);
