#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeProfileRoots } from "./lib/platform-support.mjs";

const EXTENSION_ID = "miccjajdhchpcdpmmiahheilooppepnl";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "extension");

const roots = chromeProfileRoots({
  platform: process.platform,
  homeDir: os.homedir(),
  localAppData: process.env.LOCALAPPDATA
});
const profiles = roots.flatMap((root) => profileStatuses(root));
const installedProfiles = profiles.filter((profile) => profile.installed);
const loadedFromWorkspace = installedProfiles.some((profile) => samePath(profile.path, extensionPath));

const result = {
  ok: loadedFromWorkspace,
  extensionId: EXTENSION_ID,
  expectedPath: extensionPath,
  profiles
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = loadedFromWorkspace ? 0 : 2;

function profileStatuses([browser, root]) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/u.test(entry.name)))
    .map((entry) => profileStatus(browser, root, entry.name));
}

function profileStatus(browser, root, profileDirectory) {
  const profilePath = path.join(root, profileDirectory);
  const preferences = readJson(path.join(profilePath, "Preferences")) ?? {};
  const securePreferences = readJson(path.join(profilePath, "Secure Preferences")) ?? {};
  const settings = {
    ...preferences.extensions?.settings?.[EXTENSION_ID],
    ...securePreferences.extensions?.settings?.[EXTENSION_ID]
  };
  const packedPath = path.join(profilePath, "Extensions", EXTENSION_ID);
  const pathSetting = typeof settings.path === "string" ? path.resolve(profilePath, settings.path) : null;
  const installed = fs.existsSync(packedPath) || (pathSetting !== null && fs.existsSync(pathSetting));
  const disabled = settings.state === 0 || Object.keys(settings.disable_reasons ?? {}).length > 0;
  const hasGrantedPermissions = Array.isArray(settings.active_permissions?.api) || Array.isArray(settings.granted_permissions?.api);

  return {
    browser,
    profileDirectory,
    installed,
    enabled: installed && !disabled && (settings.state !== undefined || hasGrantedPermissions),
    path: pathSetting,
    packedPath: fs.existsSync(packedPath) ? packedPath : null,
    state: settings.state ?? null
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function samePath(left, right) {
  if (left === null) return false;
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
