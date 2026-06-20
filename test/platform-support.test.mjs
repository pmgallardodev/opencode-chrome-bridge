import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  chromeProfileRoots,
  createLauncher,
  nativeHostLayout,
  windowsRegistryAddArgs,
  windowsRegistryKey,
  windowsRegistryQueryArgs
} from "../scripts/lib/platform-support.mjs";

const HOST_NAME = "com.opencode.chrome_bridge";
const repoRoot = path.resolve(import.meta.dirname, "..");

test("Windows layout uses a cmd launcher and per-user native-host manifest", () => {
  const layout = nativeHostLayout({ platform: "win32", homeDir: "C:\\Users\\Ada" });

  assert.deepEqual(layout, {
    launcherPath: "C:\\Users\\Ada\\.opencode\\chrome-bridge\\bin\\opencode-chrome-native-host.cmd",
    manifestPath: `C:\\Users\\Ada\\.opencode\\chrome-bridge\\native-host\\${HOST_NAME}.json`,
    runtimeMetadataPath: "C:\\Users\\Ada\\.opencode\\chrome-bridge\\bin\\opencode-chrome-native-host.cmd.runtime.json",
    requiresRegistry: true
  });
});

test("Unix layouts preserve the existing native-host locations", () => {
  assert.deepEqual(nativeHostLayout({ platform: "darwin", homeDir: "/Users/ada" }), {
    launcherPath: "/Users/ada/.opencode/chrome-bridge/bin/opencode-chrome-native-host",
    manifestPath: `/Users/ada/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    runtimeMetadataPath: "/Users/ada/.opencode/chrome-bridge/bin/opencode-chrome-native-host.runtime.json",
    requiresRegistry: false
  });
  assert.deepEqual(nativeHostLayout({ platform: "linux", homeDir: "/home/ada" }), {
    launcherPath: "/home/ada/.opencode/chrome-bridge/bin/opencode-chrome-native-host",
    manifestPath: `/home/ada/.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    runtimeMetadataPath: "/home/ada/.opencode/chrome-bridge/bin/opencode-chrome-native-host.runtime.json",
    requiresRegistry: false
  });
});

test("unsupported platforms fail explicitly", () => {
  assert.throws(
    () => nativeHostLayout({ platform: "freebsd", homeDir: "/home/ada" }),
    /Unsupported platform: freebsd/u
  );
});

test("Windows registry arguments register and query the Chrome native host under HKCU", () => {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

  assert.equal(windowsRegistryKey(), key);
  assert.deepEqual(windowsRegistryAddArgs("C:\\Users\\Ada Example\\host.json"), [
    "add", key, "/ve", "/t", "REG_SZ", "/d", "C:\\Users\\Ada Example\\host.json", "/f"
  ]);
  assert.deepEqual(windowsRegistryQueryArgs("C:\\Users\\Áda Example\\host.json"), [
    "query", key, "/ve", "/f", "C:\\Users\\Áda Example\\host.json", "/d", "/e", "/t", "REG_SZ"
  ]);
});

test("Windows launcher safely quotes paths and preserves literal percent signs", () => {
  const launcher = createLauncher({
    platform: "win32",
    nodePath: "C:\\Program Files\\node%20\\node.exe",
    hostPath: "C:\\Users\\Ada & Bob\\bridge (local)\\host.mjs"
  });

  assert.equal(
    launcher,
    "@echo off\r\n\"C:\\Program Files\\node%%20\\node.exe\" \"C:\\Users\\Ada & Bob\\bridge (local)\\host.mjs\"\r\n"
  );
  assert.throws(
    () => createLauncher({ platform: "win32", nodePath: "C:\\bad\"path\\node.exe", hostPath: "C:\\host.mjs" }),
    /cannot contain/u
  );
});

test("POSIX launcher preserves the existing absolute Node wrapper behavior", () => {
  const launcher = createLauncher({
    platform: "darwin",
    nodePath: "/Applications/Node's Runtime/bin/node",
    hostPath: "/Users/ada/Open Code/native-host/host.mjs"
  });

  assert.equal(
    launcher,
    "#!/bin/sh\nexec '/Applications/Node'\\''s Runtime/bin/node' '/Users/ada/Open Code/native-host/host.mjs'\n"
  );
});

test("Chrome profile roots include Google Chrome stable on Windows", () => {
  assert.deepEqual(chromeProfileRoots({
    platform: "win32",
    homeDir: "C:\\Users\\Ada",
    localAppData: "D:\\Profiles\\Ada\\Local"
  }), [["Google Chrome", "D:\\Profiles\\Ada\\Local\\Google\\Chrome\\User Data"]]);

  assert.deepEqual(chromeProfileRoots({
    platform: "win32",
    homeDir: "C:\\Users\\Ada"
  }), [["Google Chrome", "C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\User Data"]]);
});

test("Chrome profile roots preserve macOS stable and Canary plus Linux stable", () => {
  assert.deepEqual(chromeProfileRoots({ platform: "darwin", homeDir: "/Users/ada" }), [
    ["Google Chrome", "/Users/ada/Library/Application Support/Google/Chrome"],
    ["Google Chrome Canary", "/Users/ada/Library/Application Support/Google/Chrome Canary"]
  ]);
  assert.deepEqual(chromeProfileRoots({ platform: "linux", homeDir: "/home/ada" }), [
    ["Google Chrome", "/home/ada/.config/google-chrome"]
  ]);
});

test("native-host installer registers Windows through reg.exe and shared platform helpers", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "install-native-host.mjs"), "utf8");

  assert.match(source, /platform-support\.mjs/u);
  assert.match(source, /execFileAsync\("reg\.exe", windowsRegistryAddArgs\(manifestPath\)/u);
  assert.match(source, /isSupportedNodeVersion\(nodeVersion\)/u);
  assert.match(source, /--node=/u);
  assert.match(source, /execFileAsync\(nodePath, \["--version"\]/u);
  assert.match(source, /writeFile\(runtimeMetadataPath/u);
  assert.doesNotMatch(source, /Windows support needs a registry installer/u);
});

test("verification queries the Windows registration and validates its manifest path", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "verify.mjs"), "utf8");

  assert.match(source, /platform-support\.mjs/u);
  assert.match(source, /import \{ parseJsonc \} from "\.\/lib\/opencode-config\.mjs"/u);
  assert.match(source, /execFileAsync\("reg\.exe", windowsRegistryQueryArgs\(manifestPath\)/u);
  assert.doesNotMatch(source, /function stripJsonComments/u);
  assert.doesNotMatch(source, /parseWindowsRegistryQuery/u);
  assert.match(source, /assertExactStringSet\(manifest\.permissions, expectedPermissions/u);
  assert.match(source, /assertExactStringSet\(manifest\.host_permissions, \["<all_urls>"\]/u);
  assert.match(source, /assertExactStringSet\(nativeManifest\.allowed_origins, \[expectedOrigin\]/u);
  assert.match(source, /runtimeMetadataPath/u);
  assert.match(source, /isSupportedNodeVersion\(installedNodeVersion\)/u);
});

test("extension checker consumes the shared Windows-aware Chrome profile roots", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "check-chrome-extension.mjs"), "utf8");

  assert.match(source, /platform-support\.mjs/u);
  assert.match(source, /chromeProfileRoots/u);
});

test("syntax check uses a cross-platform Node script instead of shell globs", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(packageJson.scripts.check, "node scripts/check-syntax.mjs");
});

test("native messaging limits cover screenshot responses and enforce Chrome's outbound cap", async () => {
  const source = await readFile(path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs"), "utf8");

  assert.match(source, /MAX_NATIVE_MESSAGE_BYTES = 16 \* 1024 \* 1024/u);
  assert.match(source, /MAX_NATIVE_OUTBOUND_MESSAGE_BYTES = 1 \* 1024 \* 1024/u);
  assert.match(source, /payload\.length > MAX_NATIVE_OUTBOUND_MESSAGE_BYTES/u);
});
