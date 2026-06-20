import path from "node:path";

export const NATIVE_HOST_NAME = "com.opencode.chrome_bridge";

const WINDOWS_REGISTRY_ROOT = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts";

export function nativeHostLayout({ platform, homeDir }) {
  if (platform === "win32") {
    const launcherPath = path.win32.join(homeDir, ".opencode", "chrome-bridge", "bin", "opencode-chrome-native-host.cmd");
    return {
      launcherPath,
      manifestPath: path.win32.join(homeDir, ".opencode", "chrome-bridge", "native-host", `${NATIVE_HOST_NAME}.json`),
      runtimeMetadataPath: `${launcherPath}.runtime.json`,
      requiresRegistry: true
    };
  }

  const launcherPath = path.posix.join(homeDir, ".opencode", "chrome-bridge", "bin", "opencode-chrome-native-host");
  if (platform === "darwin") {
    return {
      launcherPath,
      manifestPath: path.posix.join(
        homeDir,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        `${NATIVE_HOST_NAME}.json`
      ),
      runtimeMetadataPath: `${launcherPath}.runtime.json`,
      requiresRegistry: false
    };
  }
  if (platform === "linux") {
    return {
      launcherPath,
      manifestPath: path.posix.join(homeDir, ".config/google-chrome/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      runtimeMetadataPath: `${launcherPath}.runtime.json`,
      requiresRegistry: false
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(version));
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  return major >= 26;
}

export function chromeProfileRoots({ platform, homeDir, localAppData }) {
  if (platform === "win32") {
    const localRoot = localAppData || path.win32.join(homeDir, "AppData", "Local");
    return [["Google Chrome", path.win32.join(localRoot, "Google", "Chrome", "User Data")]];
  }
  if (platform === "darwin") {
    return [
      ["Google Chrome", path.posix.join(homeDir, "Library/Application Support/Google/Chrome")],
      ["Google Chrome Canary", path.posix.join(homeDir, "Library/Application Support/Google/Chrome Canary")]
    ];
  }
  if (platform === "linux") {
    return [["Google Chrome", path.posix.join(homeDir, ".config/google-chrome")]];
  }
  return [];
}

export function windowsRegistryKey() {
  return `${WINDOWS_REGISTRY_ROOT}\\${NATIVE_HOST_NAME}`;
}

export function windowsRegistryAddArgs(manifestPath) {
  return ["add", windowsRegistryKey(), "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

export function windowsRegistryQueryArgs(manifestPath) {
  return ["query", windowsRegistryKey(), "/ve", "/f", manifestPath, "/d", "/e", "/t", "REG_SZ"];
}

export function createLauncher({ platform, nodePath, hostPath }) {
  if (platform === "win32") {
    return `@echo off\r\n${quoteWindowsCommandPath(nodePath)} ${quoteWindowsCommandPath(hostPath)}\r\n`;
  }
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(hostPath)}\n`;
}

function quoteWindowsCommandPath(value) {
  if (/[\0\r\n"]/u.test(value)) {
    throw new Error("Windows launcher paths cannot contain nulls, line breaks, or double quotes");
  }
  return `"${value.replaceAll("%", "%%")}"`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
