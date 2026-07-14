const DOCS_URL = "https://opencode.ai/docs";
const COPYRIGHT_URL = "https://github.com/pmgallardodev";

const wrapper = document.getElementById("status");
const text = document.getElementById("statusText");
const detail = document.getElementById("statusDetail");
const version = document.getElementById("version");
const learnMore = document.getElementById("learnMore");
const settingsButton = document.getElementById("settingsButton");
const copyrightLink = document.getElementById("copyrightLink");

learnMore?.addEventListener("click", openDocs);
settingsButton?.addEventListener("click", openDocs);
copyrightLink?.addEventListener("click", () => openUrl(COPYRIGHT_URL));

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
    setStatus(
      connected,
      connected ? "Connected" : "Disconnected",
      connected ? "Ready for OpenCode browser tools" : "Reload the extension or reinstall the native host"
    );
    // The native host announces itself shortly after the service worker
    // connects; re-check briefly before settling on a disconnected verdict.
    if (!connected && attempt < MAX_REFRESH_ATTEMPTS) {
      setTimeout(() => refresh(attempt + 1), REFRESH_RETRY_DELAY_MS);
    }
  } catch (error) {
    setStatus(false, "Unavailable", error?.message ?? String(error));
  }
}

function setStatus(connected, label, detailText) {
  wrapper?.classList.toggle("connected", connected);
  if (text) text.textContent = label;
  if (detail) detail.textContent = detailText;
}

function setVersion() {
  if (!version) return;
  try {
    const manifestVersion = globalThis.chrome?.runtime?.getManifest ? chrome.runtime.getManifest().version : null;
    version.textContent = manifestVersion ? `v${manifestVersion}` : "v1.1.0";
  } catch {
    version.textContent = "v1.1.0";
  }
}

function openDocs() {
  openUrl(DOCS_URL);
}

function openUrl(url) {
  try {
    if (new URL(url).protocol !== "https:") return;
  } catch {
    return;
  }
  if (globalThis.chrome?.tabs?.create) {
    chrome.tabs.create({ active: true, url });
    return;
  }
  globalThis.open?.(url, "_blank", "noopener");
}
