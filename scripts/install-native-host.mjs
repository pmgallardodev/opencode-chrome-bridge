#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createLauncher,
  isSupportedNodeVersion,
  nativeHostLayout,
  NATIVE_HOST_NAME,
  windowsRegistryAddArgs
} from "./lib/platform-support.mjs";

const EXTENSION_ID = "miccjajdhchpcdpmmiahheilooppepnl";
const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs");
const { launcherPath, manifestPath, runtimeMetadataPath, requiresRegistry } = nativeHostLayout({
  platform: process.platform,
  homeDir: os.homedir()
});

const installerArgs = process.argv.slice(2);
if (installerArgs.length > 1 || (installerArgs[0] && !installerArgs[0].startsWith("--node="))) {
  throw new Error("Usage: npm run install:native -- --node=/absolute/path/to/node");
}
const nodePath = installerArgs[0]?.slice("--node=".length) || process.execPath;
if (!path.isAbsolute(nodePath) || /[\0\r\n]/u.test(nodePath)) {
  throw new Error("--node must be an absolute executable path");
}
let nodeVersion;
try {
  const { stdout } = await execFileAsync(nodePath, ["--version"], { windowsHide: true });
  nodeVersion = stdout.trim();
} catch (error) {
  throw new Error(`Could not start the selected Node executable: ${nodePath}`, { cause: error });
}
if (!isSupportedNodeVersion(nodeVersion)) {
  throw new Error(`Node.js ${nodeVersion} is not supported. Use 22.22.2+, 24.15.0+, or 26.0.0+.`);
}

const manifest = {
  name: NATIVE_HOST_NAME,
  description: "OpenCode Chrome Bridge native messaging host",
  path: launcherPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
};

if (process.platform !== "win32") await chmod(hostPath, 0o755);
await mkdir(path.dirname(launcherPath), { recursive: true });
await writeFile(launcherPath, createLauncher({ platform: process.platform, nodePath, hostPath }));
if (process.platform !== "win32") await chmod(launcherPath, 0o755);
await writeFile(runtimeMetadataPath, `${JSON.stringify({
  hostPath,
  nodePath,
  nodeVersion
}, null, 2)}\n`, { mode: 0o600 });
if (process.platform !== "win32") await chmod(runtimeMetadataPath, 0o600);
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (requiresRegistry) {
  try {
    await execFileAsync("reg.exe", windowsRegistryAddArgs(manifestPath), { windowsHide: true });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(`Could not register the Chrome native messaging host in HKCU: ${detail}`, { cause: error });
  }
}

const summary = [
  "Native host manifest written to:",
  manifestPath,
  "",
  "Native host launcher:",
  launcherPath,
  "",
  "Node runtime:",
  `${nodeVersion} (${nodePath})`,
  "",
  "Extension ID:",
  EXTENSION_ID
];
if (requiresRegistry) {
  summary.push(
    "",
    "Windows registry registration:",
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  );
}
summary.push(
  "",
  "Next step:",
  "Open chrome://extensions, enable Developer mode, and Load unpacked:",
  path.join(repoRoot, "extension")
);
console.log(summary.join("\n"));
