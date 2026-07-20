const DOCS_URL = "https://opencode.ai/docs";
const COPYRIGHT_URL = "https://github.com/pmgallardodev";
const EXTENSIONS_URL = "chrome://extensions/";
const REPOSITORY_TROUBLESHOOTING_URL = "https://github.com/pmgallardodev/opencode-chrome-bridge#troubleshooting";
const REPAIRS = Object.freeze({
  EXTENSION_DISCONNECTED: { command: "npm run install:native", url: REPOSITORY_TROUBLESHOOTING_URL },
  HOST_HANDSHAKE_MISSING: { command: "npm run install:native", url: REPOSITORY_TROUBLESHOOTING_URL },
  PROTOCOL_INCOMPATIBLE: { command: "npm ci && npm run install:native && npm run install:opencode", url: REPOSITORY_TROUBLESHOOTING_URL },
  MISSING_CAPABILITIES: { command: "Reload OpenCode Chrome Bridge in chrome://extensions", url: EXTENSIONS_URL },
  DISABLED_PERMISSIONS: { command: "Enable OpenCode Chrome Bridge in chrome://extensions", url: EXTENSIONS_URL }
});

const wrapper = document.getElementById("status");
const text = document.getElementById("statusText");
const detail = document.getElementById("statusDetail");
const version = document.getElementById("version");
const learnMore = document.getElementById("learnMore");
const settingsButton = document.getElementById("settingsButton");
const copyrightLink = document.getElementById("copyrightLink");
const repair = document.getElementById("repair");
const repairCommand = document.getElementById("repairCommand");
const repairLink = document.getElementById("repairLink");
let repairUrl = null;

learnMore?.addEventListener("click", openDocs);
settingsButton?.addEventListener("click", openDocs);
copyrightLink?.addEventListener("click", () => openUrl(COPYRIGHT_URL));
repairLink?.addEventListener("click", () => repairUrl && openUrl(repairUrl));

const MAX_REFRESH_ATTEMPTS = 4;
const REFRESH_RETRY_DELAY_MS = 500;

setVersion();
refresh();

async function refresh(attempt = 1) {
  try {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      setStatus(true, "Connected", "Preview mode outside Chrome extension runtime");
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "GET_BRIDGE_STATUS" });
    const connected = response?.connected === true;
    const permissionStatus = await requiredPermissionsStatus();
    const permissionsEnabled = permissionStatus.enabled;
    const compatible = connected && response?.compatible === true && permissionsEnabled;
    const diagnosticCode = permissionsEnabled
      ? response?.diagnostics?.[0]?.code
      : "DISABLED_PERMISSIONS";
    const diagnostic = formatDiagnostic(response?.diagnostics);
    setStatus(
      compatible,
      compatible ? "Connected" : connected ? "Update required" : "Disconnected",
      compatible
        ? "Ready for OpenCode browser tools"
        : permissionsEnabled
          ? diagnostic ?? (connected ? "Update the extension and native host together" : "Reload the extension or reinstall the native host")
          : formatPermissionDiagnostic(permissionStatus)
    );
    setRepair(compatible ? null : diagnosticCode ?? (connected ? "PROTOCOL_INCOMPATIBLE" : "EXTENSION_DISCONNECTED"));
    // The native host announces itself shortly after the service worker
    // connects; re-check briefly before settling on a disconnected verdict.
    if (!connected && attempt < MAX_REFRESH_ATTEMPTS) {
      setTimeout(() => refresh(attempt + 1), REFRESH_RETRY_DELAY_MS);
    }
  } catch (error) {
    setStatus(false, "Unavailable", error?.message ?? String(error));
    setRepair("EXTENSION_DISCONNECTED");
  }
}

async function requiredPermissionsStatus() {
  if (!globalThis.chrome?.permissions?.contains || !globalThis.chrome?.permissions?.getAll) {
    return { enabled: true, missingOrigins: [], missingPermissions: [] };
  }
  try {
    const manifest = chrome.runtime.getManifest();
    const requiredPermissions = [...new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])].sort();
    const requiredOrigins = [...new Set(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [])].sort();
    const granted = await chrome.permissions.getAll();
    const grantedPermissions = new Set(Array.isArray(granted?.permissions) ? granted.permissions : []);
    const grantedOrigins = new Set(Array.isArray(granted?.origins) ? granted.origins : []);
    const missingPermissions = requiredPermissions.filter((entry) => !grantedPermissions.has(entry));
    const missingOrigins = requiredOrigins.filter((entry) => !grantedOrigins.has(entry));
    const containsAll = await chrome.permissions.contains({
      permissions: requiredPermissions,
      origins: requiredOrigins
    });
    return {
      enabled: containsAll === true && missingPermissions.length === 0 && missingOrigins.length === 0,
      missingOrigins,
      missingPermissions
    };
  } catch {
    return {
      enabled: false,
      missingOrigins: [],
      missingPermissions: ["permission inspection unavailable"]
    };
  }
}

function formatPermissionDiagnostic(status) {
  const parts = [];
  if (status.missingPermissions.length > 0) {
    parts.push(`Missing Chrome permissions: ${status.missingPermissions.join(", ")}.`);
  }
  if (status.missingOrigins.length > 0) {
    parts.push(`Missing host origins: ${status.missingOrigins.join(", ")}.`);
  }
  return parts.join(" ") || "Chrome reports required extension grants as disabled.";
}

function formatDiagnostic(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const first = diagnostics[0];
  if (!first || typeof first.message !== "string") return null;
  const repair = typeof first.repair === "string" ? ` ${first.repair}` : "";
  return `${first.message}${repair}`;
}

function setStatus(connected, label, detailText) {
  wrapper?.classList.toggle("connected", connected);
  if (text) text.textContent = label;
  if (detail) detail.textContent = detailText;
}

function setRepair(code) {
  const entry = REPAIRS[code] ?? null;
  repairUrl = entry?.url ?? null;
  if (repair) repair.hidden = entry === null;
  if (repairCommand) repairCommand.textContent = entry?.command ?? "";
  if (repairLink) repairLink.textContent = entry?.url === EXTENSIONS_URL ? "Open Chrome extensions" : "Open troubleshooting";
}

function setVersion() {
  if (!version) return;
  try {
    const manifestVersion = globalThis.chrome?.runtime?.getManifest ? chrome.runtime.getManifest().version : null;
    version.textContent = manifestVersion ? `v${manifestVersion}` : "v1.4.4";
  } catch {
    version.textContent = "v1.4.4";
  }
}

function openDocs() {
  openUrl(DOCS_URL);
}

function openUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.href !== EXTENSIONS_URL) return;
  } catch {
    return;
  }
  if (globalThis.chrome?.tabs?.create) {
    chrome.tabs.create({ active: true, url });
    return;
  }
  globalThis.open?.(url, "_blank", "noopener");
}
