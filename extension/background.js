const HOST_NAME = "com.opencode.chrome_bridge";
const BRIDGE_PROTOCOL_VERSION = "1.0.0";
const BRIDGE_CAPABILITIES = Object.freeze([
  "bridge.handshake",
  "browser.accessibility",
  "browser.bookmarks",
  "browser.cdp",
  "browser.console",
  "browser.downloads",
  "browser.events",
  "browser.history",
  "browser.navigation",
  "browser.page-context",
  "browser.screenshots",
  "browser.tab-groups",
  "browser.tabs",
  "browser.windows",
  "session.tab-leases"
]);
const RECONNECT_ALARM = "opencode-chrome-bridge-reconnect";
const DEBUGGER_VERSION = "1.3";
const OVERLAY_SOURCE = "opencode-bridge";
const CONSOLE_LOG_METHODS = ["Console.messageAdded", "Log.entryAdded", "Runtime.exceptionThrown"];
const CONSOLE_LOG_BUFFER_MAX = 500;
const CONSOLE_LOG_BUFFER_MAX_CHARS = 2_000_000;
const MAX_CONSOLE_LOG_TEXT_CHARS = 20_000;
const MAX_CONSOLE_LOG_URL_CHARS = 2_048;
const MAX_EXTENSION_EVENT_CHARS = 170_000;
const MAX_NATIVE_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_NATIVE_ERROR_CHARS = 2_000;
const TAB_LEASES_STORAGE_KEY = "opencodeTabLeases";
const MAX_CAPTURE_DIMENSION = 10000;
const MAX_CAPTURE_AREA = 25_000_000;
const MAX_SCREENSHOT_BASE64_CHARS = Math.ceil((10 * 1024 * 1024) / 3) * 4;
const MAX_TEXT_CHARS = 100_000;
const MAX_EXPRESSION_CHARS = 200_000;
const MAX_KEY_CHARS = 100;
const MAX_MOVE_POINTS = 100;
const MAX_MOVE_EVENTS = 2000;
const MAX_MOVE_DURATION_MS = 30_000;
const MAX_TAB_IDS = 200;
const MAX_CDP_METHODS = 100;
const MAX_QUERY_CHARS = 1000;

let nativePort = null;
let nativeHostReady = false;
let reconnecting = false;
let tabLeasesLoaded = false;
let tabLeasesLoadPromise = null;
let tabLeaseMutationQueue = Promise.resolve();

// Serialize debugger attach/detach per-target to avoid "Debugger already attached" races
const debuggerQueue = new Map();

// CDP event subscriptions: key=tabId, value=Set of subscribed CDP method names
const cdpSubscriptions = new Map();
let cdpEventSeq = 1;

// Per-tab ring buffer of console messages, network log entries, and uncaught exceptions
const consoleLogBuffers = new Map();
const consoleLogBufferChars = new Map();
// Tabs with a long-lived debugger attached for console log capture
const consoleLogAttached = new Set();
// Tabs with a long-lived debugger attached for CDP event subscriptions
const cdpEventAttached = new Set();
const cdpEnabledDomains = new Map();
const tabLeases = new Map();

chrome.runtime.onInstalled.addListener(connectNativeHost);
chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connectNativeHost();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_BRIDGE_STATUS") {
    // connectNative "succeeds" even when the native host is not installed, so a
    // non-null port alone is a false positive until the host announces itself
    // (bridgeReady event) or sends any other message. Once ready, an active
    // ping/pong round trip also detects a host that is present but wedged.
    if (nativePort === null || !nativeHostReady) {
      sendResponse(disconnectedPopupStatus());
      return false;
    }
    pingNativeHost().then((pong) => {
      sendResponse(popupStatusFromPong(pong));
    });
    return true;
  }
  if (message?.type === "STOP_AGENT_REQUEST" && Number.isInteger(sender?.tab?.id)) {
    // The in-page Stop button asks the user's agent to halt. Forward it to the
    // native host so OpenCode clients see it through event polling.
    sendEvent({ category: "bridge", type: "stopRequested", tabId: sender.tab.id });
    sendResponse({ ok: true });
  }
  return false;
});

registerBrowserEventListeners();

connectNativeHost();

function connectNativeHost() {
  if (nativePort || reconnecting) return;
  reconnecting = true;
  try {
    nativeHostReady = false;
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      nativeHostReady = false;
      scheduleReconnect();
    });
    chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
  } catch {
    nativePort = null;
    scheduleReconnect();
  } finally {
    reconnecting = false;
  }
}

const pendingPings = new Map();
let pingSeq = 1;

function pingNativeHost(timeoutMs = 1000) {
  const port = nativePort;
  if (!port) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `ping:${pingSeq++}`;
    const timer = setTimeout(() => {
      pendingPings.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingPings.set(id, { resolve, timer });
    try {
      port.postMessage({ type: "ping", id, handshake: createExtensionHandshake() });
    } catch {
      pendingPings.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function createExtensionHandshake() {
  const manifest = chrome.runtime.getManifest();
  return {
    capabilities: [...BRIDGE_CAPABILITIES],
    extensionId: chrome.runtime.id,
    extensionName: manifest.name,
    extensionVersion: manifest.version,
    hostName: HOST_NAME,
    protocolVersion: BRIDGE_PROTOCOL_VERSION
  };
}

function disconnectedPopupStatus() {
  return {
    compatible: false,
    connected: false,
    diagnostics: [{
      code: "EXTENSION_DISCONNECTED",
      message: "The native host is not connected.",
      repair: "Reload the extension or reinstall the native host."
    }],
    extension: createExtensionHandshake(),
    host: null,
    missingCapabilities: []
  };
}

function popupStatusFromPong(host) {
  if (host === null) return disconnectedPopupStatus();
  const validHost = isVersionString(host.version)
    && isVersionString(host.protocolMin)
    && isVersionString(host.protocolMax)
    && host.name === HOST_NAME;
  if (!validHost) {
    return {
      ...disconnectedPopupStatus(),
      connected: true,
      diagnostics: [{
        code: "HOST_HANDSHAKE_MISSING",
        message: "The native host does not support protocol negotiation.",
        repair: "Reinstall the current native host."
      }]
    };
  }
  const protocolCompatible = compareVersions(BRIDGE_PROTOCOL_VERSION, host.protocolMin) >= 0
    && compareVersions(BRIDGE_PROTOCOL_VERSION, host.protocolMax) <= 0;
  return {
    compatible: protocolCompatible,
    connected: true,
    diagnostics: protocolCompatible ? [] : [{
      code: "PROTOCOL_INCOMPATIBLE",
      message: `Extension protocol ${BRIDGE_PROTOCOL_VERSION} is outside the host range ${host.protocolMin}-${host.protocolMax}.`,
      repair: "Update the extension and native host together."
    }],
    extension: createExtensionHandshake(),
    host: {
      name: host.name,
      protocolMax: host.protocolMax,
      protocolMin: host.protocolMin,
      version: host.version
    },
    missingCapabilities: []
  };
}

function isVersionString(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function scheduleReconnect() {
  // Chrome MV3 silently clamps alarm periods to a minimum of 1 minute in
  // production builds (smaller values only work in unpacked developer mode).
  // Use the smallest production-safe values so reconnect latency is bounded
  // and predictable across installed extensions.
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }).catch(() => {});
}

async function handleNativeMessage(message) {
  // Any message proves a live native host on the other end of the port.
  nativeHostReady = true;
  if (message?.type === "pong" && typeof message.id === "string") {
    const pending = pendingPings.get(message.id);
    if (pending) {
      pendingPings.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.host ?? {});
    }
    return;
  }
  if (message?.type !== "command" || typeof message.id !== "string") return;
  try {
    const result = await executeCommand(message.method, message.params ?? {});
    postNativeResponse({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    postNativeResponse({
      type: "response",
      id: message.id,
      ok: false,
      error: truncateString(error?.message || String(error), MAX_NATIVE_ERROR_CHARS)
    });
  }
}

function postNativeResponse(message) {
  const port = nativePort;
  if (!port) return;
  const serialized = JSON.stringify(message);
  if (new TextEncoder().encode(serialized).byteLength > MAX_NATIVE_RESPONSE_BYTES) {
    throw new Error("Chrome command response is too large for the local bridge");
  }
  try {
    port.postMessage(message);
  } catch {
    // The native host disconnected after the command completed. Its reconnect
    // listener owns recovery, so do not turn this into an unhandled rejection.
  }
}

async function executeCommand(method, params) {
  switch (method) {
    case "handshake":
      return createExtensionHandshake();
    case "status":
      return { connected: true, extensionId: chrome.runtime.id, hostName: HOST_NAME };
    case "listTabs":
      return (await chrome.tabs.query({})).map(tabInfo);
    case "getTab":
      return tabInfo(await chrome.tabs.get(requireTabId(params)));
    case "createTab": {
      validateOptionalLeaseParams(params);
      const createUrl = params.url ?? "about:blank";
      if (params.url != null) await assertNavigationAllowed(params.url);
      const tab = await chrome.tabs.create({ active: params.active !== false, url: createUrl });
      await maybeClaimTabFromParams(tab.id, params, "agent");
      return tabInfo(tab);
    }
    case "closeTab":
      await chrome.tabs.remove(requireTabId(params));
      return { closed: true };
    case "activateTab":
      return activateTab(requireTabId(params));
    case "navigate":
      return navigateTab(params);
    case "reload":
      await chrome.tabs.reload(requireTabId(params));
      return { reloaded: true };
    case "back":
      await chrome.tabs.goBack(requireTabId(params));
      return { ok: true };
    case "forward":
      await chrome.tabs.goForward(requireTabId(params));
      return { ok: true };
    case "screenshot":
      return captureScreenshot(params);
    case "screenshotRegion":
      return captureScreenshotRegion(params);
    case "getConsoleLogs":
      return getConsoleLogs(params);
    case "click":
      return dispatchClick(params);
    case "doubleClick":
      return dispatchDoubleClick(params);
    case "hover":
      return dispatchHover(params);
    case "type":
      return insertText(params);
    case "keypress":
      return dispatchKey(params);
    case "evaluate":
      return evaluateInTab(params);
    case "pageText":
      return pageText(params);
    case "domContent":
      return domContent(params);
    case "scroll":
      return dispatchScroll(params);
    case "setViewport":
      return setViewport(params);
    case "resetViewport":
      return resetViewport(params);
    case "cdpTargets":
      return cdpTargets();
    case "cdpCommand":
      return cdpCommand(params);
    case "history":
      return searchHistory(params);
    case "bookmarks":
      return searchBookmarks(params);
    case "setWindowState":
      return setWindowState(params);
    case "getWindowState":
      return getWindowState(params);
    case "createWindow":
      return createWindow(params);
    case "claimTab":
      return claimTab(params);
    case "finalizeTabs":
      return finalizeTabs(params);
    case "endTurn":
      return endTurn(params);
    case "releaseDebuggers":
      return releaseDebuggers(params);
    case "moveSequence":
      return moveSequence(params);
    case "listDownloads":
      return listDownloads(params);
    case "cancelDownload":
      return cancelDownload(params);
    case "pauseDownload":
      return pauseDownload(params);
    case "resumeDownload":
      return resumeDownload(params);
    case "showDownload":
      return showDownload(params);
    case "createTabGroup":
      return createTabGroup(params);
    case "updateTabGroup":
      return updateTabGroup(params);
    case "listTabGroups":
      return listTabGroups(params);
    case "groupTabs":
      return groupTabs(params);
    case "ungroupTabs":
      return ungroupTabs(params);
    case "subscribeCdpEvents":
      return subscribeCdpEvents(params);
    case "unsubscribeCdpEvents":
      return unsubscribeCdpEvents(params);
    case "setCursorState":
      return setCursorState(params);
    case "setFaviconBadge":
      return setFaviconBadge(params);
    case "accessibilityTree":
      return accessibilityTree(params);
    case "tabContext":
      return tabContext(params);
    case "readPage":
      return readPage(params);
    case "clickElement":
      return clickElement(params);
    case "fillElement":
      return fillElement(params);
    case "getBlockedUrlPatterns":
      return { patterns: await loadBlockedUrlPatterns() };
    default:
      throw new Error(`Unsupported command: ${method}`);
  }
}

function tabInfo(tab) {
  return {
    active: tab.active === true,
    id: tab.id,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId
  };
}

function requireTabId(params) {
  if (!Number.isInteger(params.tabId)) throw new Error("tabId must be an integer");
  return params.tabId;
}

async function activateTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return tabInfo(await chrome.tabs.update(tabId, { active: true }));
}

async function navigateTab(params) {
  const tabId = requireTabId(params);
  if (typeof params.url !== "string" || params.url.length === 0) throw new Error("url must be a non-empty string");
  await assertNavigationAllowed(params.url);
  validateOptionalLeaseParams(params);
  // Claim before navigating so a tab owned by another session is left untouched.
  await maybeClaimTabFromParams(tabId, params, "user");
  return tabInfo(await chrome.tabs.update(tabId, { url: params.url }));
}

async function tabStillExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function captureScreenshot(params) {
  const tabId = params.tabId == null ? null : requireTabId(params);
  let windowId = params.windowId;
  if (tabId !== null) {
    const tab = await activateTab(tabId);
    windowId = tab.windowId;
  }
  if (!Number.isInteger(windowId)) {
    const current = await chrome.windows.getCurrent();
    windowId = current.id;
  }
  const format = params.format === "jpeg" ? "jpeg" : "png";
  const quality = format === "jpeg" ? clampInteger(params.quality, 1, 100, 80, "quality") : undefined;
  const captureOptions = quality === undefined ? { format } : { format, quality };
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, captureOptions);
  const separator = typeof dataUrl === "string" ? dataUrl.indexOf(",") : -1;
  if (separator === -1) throw new Error("Chrome did not return a screenshot data URL");
  assertScreenshotPayloadSize(dataUrl.slice(separator + 1));
  return { dataUrl, format };
}

async function captureScreenshotRegion(params) {
  const x = requireFiniteNumber(params.x, "x");
  const y = requireFiniteNumber(params.y, "y");
  const width = requireFiniteNumber(params.width, "width");
  const height = requireFiniteNumber(params.height, "height");
  if (width <= 0 || height <= 0) throw new Error("width and height must be positive numbers");
  if (width > MAX_CAPTURE_DIMENSION || height > MAX_CAPTURE_DIMENSION || width * height > MAX_CAPTURE_AREA) {
    throw new Error(`screenshot region is too large; max dimension ${MAX_CAPTURE_DIMENSION}px and max area ${MAX_CAPTURE_AREA}px`);
  }

  const format = params.format === "png" ? "png" : "jpeg";
  const quality = format === "jpeg" ? clampInteger(params.quality, 1, 100, 80, "quality") : undefined;

  let tabId = params.tabId == null ? null : requireTabId(params);
  let windowId = params.windowId;
  if (tabId !== null) {
    const tab = await activateTab(tabId);
    windowId = tab.windowId;
  }
  if (!Number.isInteger(windowId)) {
    const current = await chrome.windows.getCurrent();
    windowId = current.id;
  }
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs.length === 0) throw new Error("screenshotRegion requires an active tab in the target window");
    tabId = tabs[0].id;
  }

  const captureParams = {
    format,
    clip: { x, y, width, height, scale: 1 },
    captureBeyondViewport: true
  };
  if (quality !== undefined) captureParams.quality = quality;

  const data = await withDebugger(tabId, async (target) => {
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", captureParams);
    return result.data;
  });
  assertScreenshotPayloadSize(data);

  const dataUrl = `data:image/${format};base64,${data}`;
  return { dataUrl, format, region: { x, y, width, height } };
}

function assertScreenshotPayloadSize(base64Data) {
  if (typeof base64Data !== "string" || base64Data.length > MAX_SCREENSHOT_BASE64_CHARS) {
    throw new Error("screenshot response is too large for the local bridge");
  }
}

async function dispatchClick(params) {
  const tabId = requireTabId(params);
  const x = requireFiniteNumber(params.x, "x");
  const y = requireFiniteNumber(params.y, "y");
  const button = requireButton(params.button);
  const modifiers = resolveModifiers(params.modifiers);
  await withOverlayInputPassThrough(tabId, { x, y }, async () => {
    await withDebugger(tabId, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      await dispatchMousePressAndRelease(target, { button, clickCount: 1, modifiers, x, y });
    });
  });
  return { clicked: true };
}

async function dispatchDoubleClick(params) {
  const tabId = requireTabId(params);
  const x = requireFiniteNumber(params.x, "x");
  const y = requireFiniteNumber(params.y, "y");
  const button = requireButton(params.button);
  const modifiers = resolveModifiers(params.modifiers);
  await withOverlayInputPassThrough(tabId, { x, y }, async () => {
    await withDebugger(tabId, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      for (const clickCount of [1, 2]) {
        await dispatchMousePressAndRelease(target, { button, clickCount, modifiers, x, y });
      }
    });
  });
  return { doubleClicked: true };
}

async function dispatchHover(params) {
  const tabId = requireTabId(params);
  const x = requireFiniteNumber(params.x, "x");
  const y = requireFiniteNumber(params.y, "y");
  await notifyOverlay(tabId, "cursor-move", { x, y });
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  });
  return { hovered: true };
}

async function dispatchScroll(params) {
  const tabId = requireTabId(params);
  const x = requireFiniteNumber(params.x, "x");
  const y = requireFiniteNumber(params.y, "y");
  const deltaX = typeof params.deltaX === "number" && Number.isFinite(params.deltaX) ? params.deltaX : 0;
  const deltaY = typeof params.deltaY === "number" && Number.isFinite(params.deltaY) ? params.deltaY : 0;
  if (deltaX === 0 && deltaY === 0) throw new Error("at least one of deltaX or deltaY must be a non-zero finite number");
  await notifyOverlay(tabId, "cursor-move", { x, y });
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY
    });
  });
  return { scrolled: true };
}

async function insertText(params) {
  const tabId = requireTabId(params);
  if (typeof params.text !== "string") throw new Error("text must be a string");
  if (params.text.length > MAX_TEXT_CHARS) throw new Error(`text is too large; max ${MAX_TEXT_CHARS} characters`);
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: params.text });
  });
  return { typed: true };
}

async function dispatchKey(params) {
  const tabId = requireTabId(params);
  if (typeof params.key !== "string" || params.key.length === 0) throw new Error("key must be a non-empty string");
  if (params.key.length > MAX_KEY_CHARS) throw new Error(`key is too large; max ${MAX_KEY_CHARS} characters`);
  const modifiers = resolveModifiers(params.modifiers);
  await withDebugger(tabId, async (target) => {
    await dispatchKeyDownAndUp(target, { key: params.key, modifiers });
  });
  return { pressed: true };
}

async function dispatchMousePressAndRelease(target, event) {
  let pressed = false;
  let operationError = null;
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...event, type: "mousePressed" });
    pressed = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...event, type: "mouseReleased" });
    pressed = false;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (pressed) {
      try {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...event, type: "mouseReleased" });
      } catch (releaseError) {
        if (operationError === null) throw releaseError;
      }
    }
  }
}

// CDP treats a keyDown without text as rawKeyDown, which never triggers default
// actions (Enter submitting a form, character insertion). Resolve the text and
// virtual key codes Chrome needs so keys behave like real keyboard input.
const NAMED_KEY_DETAILS = {
  Alt: { keyCode: 18 },
  ArrowDown: { keyCode: 40 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  ArrowUp: { keyCode: 38 },
  Backspace: { keyCode: 8 },
  Control: { keyCode: 17 },
  Delete: { keyCode: 46 },
  End: { keyCode: 35 },
  Enter: { keyCode: 13, text: "\r" },
  Escape: { keyCode: 27 },
  Home: { keyCode: 36 },
  Insert: { keyCode: 45 },
  Meta: { keyCode: 91 },
  PageDown: { keyCode: 34 },
  PageUp: { keyCode: 33 },
  Shift: { keyCode: 16 },
  Space: { key: " ", keyCode: 32, text: " " },
  Tab: { keyCode: 9 }
};

function keyEventDetails(rawKey, modifiers) {
  const shifted = (modifiers & 8) !== 0;
  const shortcut = (modifiers & 7) !== 0;
  const codeMatch = /^Key([A-Z])$/u.exec(rawKey);
  const digitMatch = /^Digit([0-9])$/u.exec(rawKey);
  const codeKey = codeMatch ? (shifted ? codeMatch[1] : codeMatch[1].toLowerCase()) : null;
  const key = codeKey ?? (digitMatch ? digitMatch[1] : rawKey);
  const named = NAMED_KEY_DETAILS[key];
  if (named) {
    return { key: named.key ?? key, keyCode: named.keyCode, text: shortcut ? undefined : named.text };
  }
  const functionKey = /^F(1[0-2]|[1-9])$/u.exec(key);
  if (functionKey) return { key, keyCode: 111 + Number(functionKey[1]) };
  if (key.length === 1) {
    const printableKey = shifted && /^[a-z]$/u.test(key) ? key.toUpperCase() : key;
    const upper = printableKey.toUpperCase();
    const keyCode = /^[A-Z0-9]$/u.test(upper) ? upper.charCodeAt(0) : key === " " ? 32 : undefined;
    return { key: printableKey, keyCode, text: shortcut ? undefined : printableKey };
  }
  return { key };
}

async function dispatchKeyDownAndUp(target, { key, modifiers }) {
  const details = keyEventDetails(key, modifiers);
  const event = { key: details.key, modifiers };
  if (details.keyCode !== undefined) {
    event.windowsVirtualKeyCode = details.keyCode;
    event.nativeVirtualKeyCode = details.keyCode;
  }
  const keyDownEvent = details.text === undefined
    ? { ...event, type: "rawKeyDown" }
    : { ...event, text: details.text, type: "keyDown" };
  let keyDown = false;
  let operationError = null;
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", keyDownEvent);
    keyDown = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    keyDown = false;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (keyDown) {
      try {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...event, type: "keyUp" });
      } catch (releaseError) {
        if (operationError === null) throw releaseError;
      }
    }
  }
}

async function evaluateInTab(params) {
  const tabId = requireTabId(params);
  if (typeof params.expression !== "string" || params.expression.length === 0) {
    throw new Error("expression must be a non-empty string");
  }
  if (params.expression.length > MAX_EXPRESSION_CHARS) {
    throw new Error(`expression is too large; max ${MAX_EXPRESSION_CHARS} characters`);
  }
  return withDebugger(tabId, async (target) => {
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      awaitPromise: true,
      expression: params.expression,
      returnByValue: true
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Page evaluation failed");
    return response.result?.value ?? response.result?.description ?? null;
  });
}

async function pageText(params) {
  const tabId = requireTabId(params);
  const maxChars = clampInteger(params.maxChars, 0, 50000, 12000, "maxChars");
  const expression = `({
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText.slice(0, ${maxChars}) : ""
  })`;
  return evaluateInTab({ tabId, expression });
}

async function domContent(params) {
  const tabId = requireTabId(params);
  const maxChars = clampInteger(params.maxChars, 0, 500000, 50000, "maxChars");
  const contentType = params.contentType === "text" ? "text" : "html";
  const expression = contentType === "text"
    ? `({ title: document.title, url: location.href, contentType: "text", content: document.body ? document.body.innerText.slice(0, ${maxChars}) : "" })`
    : `({ title: document.title, url: location.href, contentType: "html", content: document.documentElement.outerHTML.slice(0, ${maxChars}) })`;
  return evaluateInTab({ tabId, expression });
}

async function setViewport(params) {
  const tabId = requireTabId(params);
  const width = clampInteger(params.width, 100, 7680, null, "width");
  const height = clampInteger(params.height, 100, 4320, null, "height");
  if (width === null || height === null) throw new Error("width and height must be integers (100–7680 / 100–4320)");
  const deviceScaleFactor = typeof params.deviceScaleFactor === "number" && Number.isFinite(params.deviceScaleFactor)
    ? Math.max(0, Math.min(10, params.deviceScaleFactor))
    : 1;
  const mobile = params.mobile === true;
  const result = await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile
    });
    return { width, height, deviceScaleFactor, mobile };
  });
  return { tabId, emulated: true, ...result };
}

async function resetViewport(params) {
  const tabId = requireTabId(params);
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride", {});
  });
  return { tabId, reset: true };
}

async function setWindowState(params) {
  const windowId = requireWindowId(params);
  const state = params.state;
  if (!["normal", "minimized", "maximized", "fullscreen"].includes(state)) {
    throw new Error("state must be one of: normal, minimized, maximized, fullscreen");
  }
  await chrome.windows.update(windowId, { state });
  return windowInfo(await chrome.windows.get(windowId, { populate: true }));
}

async function getWindowState(params) {
  const windowId = requireWindowId(params);
  return windowInfo(await chrome.windows.get(windowId, { populate: true }));
}

async function createWindow(params) {
  validateOptionalLeaseParams(params);
  const createArgs = {};
  if (typeof params.url === "string" && params.url.length > 0) {
    await assertNavigationAllowed(params.url);
    createArgs.url = params.url;
  }
  if (params.type === "popup" || params.type === "panel") createArgs.type = params.type;
  if (params.incognito === true) createArgs.incognito = true;
  if (params.state && ["normal", "minimized", "maximized", "fullscreen"].includes(params.state)) {
    createArgs.state = params.state;
  }
  const width = clampInteger(params.width, 100, 7680, null, "width");
  const height = clampInteger(params.height, 100, 4320, null, "height");
  if (width !== null) createArgs.width = width;
  if (height !== null) createArgs.height = height;
  if (Number.isInteger(params.left)) createArgs.left = params.left;
  if (Number.isInteger(params.top)) createArgs.top = params.top;
  const win = await chrome.windows.create(createArgs);
  for (const tab of win.tabs ?? []) {
    if (Number.isInteger(tab.id)) await maybeClaimTabFromParams(tab.id, params, "agent");
  }
  return windowInfo(win);
}

async function claimTab(params) {
  const tabId = requireTabId(params);
  const sessionId = requireNonEmptyString(params.sessionId, "sessionId");
  const turnId = requireNonEmptyString(params.turnId, "turnId");
  const origin = params.origin === "agent" ? "agent" : "user";
  return withTabLeaseMutation(async () => {
    const tab = await chrome.tabs.get(tabId);
    assertClaimableTab(tab);
    await ensureTabLeasesLoaded();
    const existing = tabLeases.get(tabId);
    if (existing?.state === "active" && existing.sessionId !== sessionId) {
      throw new Error(`Tab ${tabId} is already part of browser session ${existing.sessionId}`);
    }
    const nextLeases = new Map(tabLeases);
    nextLeases.set(tabId, {
      claimedAt: Date.now(),
      origin,
      sessionId,
      state: "active",
      tabId,
      turnId
    });
    try {
      await persistTabLeases(nextLeases);
    } catch (error) {
      // Retain the claim in memory on write failure so another session cannot
      // take the tab while persistent state is uncertain.
      replaceTabLeases(nextLeases);
      throw error;
    }
    replaceTabLeases(nextLeases);
    return { claimed: true, tabId, sessionId, turnId, origin };
  });
}

function assertClaimableTab(tab) {
  if (typeof tab.url !== "string") return;
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return;
  }
  if (parsed.protocol === "chrome:" || parsed.protocol === "chrome-extension:") {
    throw new Error(`Chrome internal tab ${tab.id} cannot be claimed`);
  }
}

async function maybeClaimTabFromParams(tabId, params, origin) {
  if (!Number.isInteger(tabId) || typeof params.sessionId !== "string" || typeof params.turnId !== "string") return;
  await claimTab({ tabId, sessionId: params.sessionId, turnId: params.turnId, origin });
}

function validateOptionalLeaseParams(params) {
  const hasSessionId = params.sessionId != null;
  const hasTurnId = params.turnId != null;
  if (hasSessionId !== hasTurnId) {
    throw new Error("sessionId and turnId must be provided together");
  }
  if (hasSessionId) {
    requireNonEmptyString(params.sessionId, "sessionId");
    requireNonEmptyString(params.turnId, "turnId");
  }
}

async function finalizeTabs(params) {
  const sessionId = requireNonEmptyString(params.sessionId, "sessionId");
  const keep = normalizeFinalizeKeep(params.keep);
  return withTabLeaseMutation(async () => {
    await ensureTabLeasesLoaded();
    const sessionLeases = [...tabLeases.values()].filter((lease) => lease.sessionId === sessionId && lease.state === "active");
    const sessionTabIds = new Set(sessionLeases.map((lease) => lease.tabId));
    for (const entry of keep) {
      if (!sessionTabIds.has(entry.tabId)) throw new Error(`finalizeTabs cannot keep unknown tab ${entry.tabId}`);
    }
    const keepIds = new Set(keep.map((entry) => entry.tabId));
    const closeIds = [];
    const releasedTabIds = [];
    const closeFailures = [];
    const nextLeases = new Map(tabLeases);

    for (const lease of sessionLeases) {
      const kept = keep.find((entry) => entry.tabId === lease.tabId);
      if (kept) {
        nextLeases.set(lease.tabId, { ...lease, state: "handoff", handoffStatus: kept.status });
        continue;
      }
      if (lease.origin === "agent") {
        try {
          await chrome.tabs.remove(lease.tabId);
          closeIds.push(lease.tabId);
        } catch (error) {
          // Only keep the lease when the tab genuinely still exists. If it was
          // already closed in a race, releasing the lease here prevents a stale
          // entry from blocking future claims of the reused tab id.
          if (await tabStillExists(lease.tabId)) {
            closeFailures.push({ error, tabId: lease.tabId });
            continue;
          }
          closeIds.push(lease.tabId);
        }
      }
      nextLeases.delete(lease.tabId);
      releasedTabIds.push(lease.tabId);
    }

    await persistTabLeases(nextLeases);
    replaceTabLeases(nextLeases);
    await releaseDebuggers({ tabIds: releasedTabIds });
    if (closeFailures.length > 0) {
      const detail = closeFailures.map(({ error, tabId }) => `${tabId}: ${error?.message || error}`).join(", ");
      throw new Error(`Could not close agent tabs: ${detail}`);
    }
    return { finalized: true, closedTabIds: closeIds, keptTabIds: [...keepIds], sessionId };
  });
}

async function endTurn(params) {
  const sessionId = requireNonEmptyString(params.sessionId, "sessionId");
  const turnId = requireNonEmptyString(params.turnId, "turnId");
  return withTabLeaseMutation(async () => {
    await ensureTabLeasesLoaded();
    const releasedTabIds = [];
    const nextLeases = new Map(tabLeases);
    for (const [tabId, lease] of tabLeases.entries()) {
      if (lease.sessionId !== sessionId || lease.turnId !== turnId || lease.state !== "active") continue;
      nextLeases.delete(tabId);
      releasedTabIds.push(tabId);
    }
    if (releasedTabIds.length === 0) return { ended: true, releasedTabIds: [], sessionId, turnId };
    await persistTabLeases(nextLeases);
    replaceTabLeases(nextLeases);
    await releaseDebuggers({ tabIds: releasedTabIds });
    await Promise.all(releasedTabIds.map((tabId) => notifyOverlay(tabId, "cursor-state", { state: "hidden" })));
    return { ended: true, releasedTabIds, sessionId, turnId };
  });
}

function normalizeFinalizeKeep(keep) {
  if (!Array.isArray(keep)) throw new Error("keep must be an array");
  if (keep.length > MAX_TAB_IDS) throw new Error(`keep must contain at most ${MAX_TAB_IDS} entries`);
  const seen = new Set();
  return keep.map((entry, index) => {
    const tabId = requireTabId({ tabId: entry?.tabId });
    const status = entry?.status;
    if (status !== "handoff" && status !== "deliverable") {
      throw new Error(`keep[${index}].status must be handoff or deliverable`);
    }
    if (seen.has(tabId)) throw new Error(`keep contains duplicate tabId ${tabId}`);
    seen.add(tabId);
    return { tabId, status };
  });
}

function ensureTabLeasesLoaded() {
  // Memoize the in-flight load promise (not just a boolean) so concurrent callers
  // await the same load instead of racing on a half-populated tabLeases map.
  if (tabLeasesLoaded) return Promise.resolve();
  if (tabLeasesLoadPromise) return tabLeasesLoadPromise;
  tabLeasesLoadPromise = loadTabLeases().finally(() => { tabLeasesLoadPromise = null; });
  return tabLeasesLoadPromise;
}

function withTabLeaseMutation(callback) {
  const operation = tabLeaseMutationQueue.then(callback);
  tabLeaseMutationQueue = operation.catch(() => {});
  return operation;
}

async function loadTabLeases() {
  const stored = (await chrome.storage.session.get(TAB_LEASES_STORAGE_KEY))[TAB_LEASES_STORAGE_KEY];
  // Clear before repopulating so a partial failure on a later retry does not
  // leave stale entries from a previous load mixed with the new snapshot.
  tabLeases.clear();
  if (stored != null) {
    if (typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("stored tab lease data is invalid");
    }
    for (const [key, value] of Object.entries(stored)) {
      const tabId = Number(key);
      if (!isValidStoredTabLease(tabId, value)) throw new Error("stored tab lease data is invalid");
      tabLeases.set(tabId, value);
    }
  }
  tabLeasesLoaded = true;
}

function isValidStoredTabLease(tabId, value) {
  return Number.isInteger(tabId)
    && value !== null
    && typeof value === "object"
    && value.tabId === tabId
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && value.sessionId.length <= MAX_KEY_CHARS
    && typeof value.turnId === "string"
    && value.turnId.length > 0
    && value.turnId.length <= MAX_KEY_CHARS
    && (value.origin === "agent" || value.origin === "user")
    && (value.state === "active" || value.state === "handoff")
    && Number.isFinite(value.claimedAt)
    && (value.state !== "handoff" || value.handoffStatus === "handoff" || value.handoffStatus === "deliverable");
}

async function persistTabLeases(leaseMap = tabLeases) {
  const leases = Object.fromEntries([...leaseMap.entries()].map(([tabId, lease]) => [String(tabId), lease]));
  await chrome.storage.session.set({ [TAB_LEASES_STORAGE_KEY]: leases });
}

function replaceTabLeases(nextLeases) {
  tabLeases.clear();
  for (const [tabId, lease] of nextLeases) tabLeases.set(tabId, lease);
}

async function removeClosedTabLease(tabId) {
  return withTabLeaseMutation(async () => {
    await ensureTabLeasesLoaded();
    const nextLeases = new Map(tabLeases);
    nextLeases.delete(tabId);
    await persistTabLeases(nextLeases);
    replaceTabLeases(nextLeases);
  });
}

async function replaceClosedTabLease(addedTabId, removedTabId) {
  return withTabLeaseMutation(async () => {
    await ensureTabLeasesLoaded();
    const nextLeases = new Map(tabLeases);
    const lease = nextLeases.get(removedTabId);
    nextLeases.delete(removedTabId);
    if (lease) nextLeases.set(addedTabId, { ...lease, tabId: addedTabId });
    await persistTabLeases(nextLeases);
    replaceTabLeases(nextLeases);
  });
}

function reportLeasePersistenceError(error) {
  console.error("OpenCode bridge could not persist tab lease cleanup", error);
}

async function moveSequence(params) {
  const tabId = requireTabId(params);
  const points = Array.isArray(params.points) ? params.points : [];
  if (points.length === 0) throw new Error("points must be a non-empty array of {x,y}");
  if (points.length > MAX_MOVE_POINTS) throw new Error(`points must contain at most ${MAX_MOVE_POINTS} entries`);
  const steps = clampInteger(params.steps, 1, 500, 20, "steps");
  const stepDelayMs = clampInteger(params.stepDelayMs, 0, 1000, 8, "stepDelayMs");
  const drag = params.drag === true;
  const button = requireButton(params.button);
  const modifiers = resolveModifiers(params.modifiers);

  const validated = points.map((p, i) => {
    const x = requireFiniteNumber(p?.x, `points[${i}].x`);
    const y = requireFiniteNumber(p?.y, `points[${i}].y`);
    return { x, y };
  });

  const interpolatedEventCount = (validated.length - 1) * steps + 1;
  if (interpolatedEventCount > MAX_MOVE_EVENTS) {
    throw new Error(`move sequence has too many interpolated events; max ${MAX_MOVE_EVENTS}`);
  }
  const estimatedDurationMs = interpolatedEventCount * stepDelayMs;
  if (estimatedDurationMs > MAX_MOVE_DURATION_MS) {
    throw new Error(`move sequence is too long; max duration ${MAX_MOVE_DURATION_MS}ms`);
  }

  const interpolated = interpolatePath(validated, steps);
  const first = interpolated[0];
  const last = interpolated[interpolated.length - 1];

  const overlayReady = await injectOverlay(tabId);
  if (overlayReady) await sendOverlayMessage(tabId, "cursor-move", { x: first.x, y: first.y });

  await withDebugger(tabId, async (target) => {
    let mousePressed = false;
    let operationError = null;
    try {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: first.x, y: first.y, modifiers
      });
      if (drag) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mousePressed", button, clickCount: 1, modifiers, x: first.x, y: first.y
        });
        mousePressed = true;
      }
      for (const point of interpolated) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: point.x, y: point.y, modifiers
        });
        if (overlayReady) await sendOverlayMessage(tabId, "cursor-move", { x: point.x, y: point.y });
        if (stepDelayMs > 0) await sleep(stepDelayMs);
      }
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (mousePressed) {
        try {
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased", button, clickCount: 1, modifiers, x: last.x, y: last.y
          });
        } catch (releaseError) {
          if (operationError === null) throw releaseError;
        }
      }
    }
  });

  if (drag && overlayReady) await sendOverlayMessage(tabId, "cursor-click", { x: last.x, y: last.y });

  return { moved: true, points: validated.length, steps: interpolated.length, drag };
}

async function listDownloads(params) {
  const query = {};
  if (typeof params.state === "string" && ["in_progress", "interrupted", "complete"].includes(params.state)) {
    query.state = params.state;
  }
  const limit = clampInteger(params.limit, 1, 1000, 100, "limit");
  const orderBy = Array.isArray(params.orderBy) ? params.orderBy : ["-startTime"];
  query.orderBy = orderBy;
  query.limit = limit;
  if (typeof params.query === "string" && params.query.length > 0) query.query = [limitString(params.query, "query", MAX_QUERY_CHARS)];
  const items = await chrome.downloads.search(query);
  return items.map((d) => ({
    id: d.id,
    filename: d.filename,
    fileSize: d.fileSize,
    mime: d.mime,
    state: d.state,
    url: d.url,
    paused: d.paused === true,
    startTime: d.startTime,
    endTime: d.endTime,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    danger: d.danger,
    incognito: d.incognito === true
  }));
}

async function cancelDownload(params) {
  const downloadId = requireDownloadId(params);
  await chrome.downloads.cancel(downloadId);
  return { cancelled: true, id: downloadId };
}

async function pauseDownload(params) {
  const downloadId = requireDownloadId(params);
  await chrome.downloads.pause(downloadId);
  return { paused: true, id: downloadId };
}

async function resumeDownload(params) {
  const downloadId = requireDownloadId(params);
  await chrome.downloads.resume(downloadId);
  return { resumed: true, id: downloadId };
}

async function showDownload(params) {
  if (params.showDefaultFolder === true || params.downloadId == null) {
    await chrome.downloads.showDefaultFolder();
    return { showed: "defaultFolder" };
  }
  const downloadId = requireDownloadId(params);
  await chrome.downloads.show(downloadId);
  return { showed: true, id: downloadId };
}

async function createTabGroup(params) {
  const tabIds = requireTabIdArray(params.tabIds);
  const createProperties = {};
  if (Number.isInteger(params.windowId)) createProperties.windowId = params.windowId;
  const groupId = await chrome.tabs.group({ tabIds, createProperties });
  const updateArgs = {};
  if (typeof params.title === "string") updateArgs.title = params.title;
  if (typeof params.color === "string" && ["grey", "blue", "red", "yellow", "green", "pink", "orange", "cyan", "purple"].includes(params.color)) {
    updateArgs.color = params.color;
  }
  if (typeof params.collapsed === "boolean") updateArgs.collapsed = params.collapsed;
  if (Object.keys(updateArgs).length > 0) {
    await chrome.tabGroups.update(groupId, updateArgs);
  }
  const group = await chrome.tabGroups.get(groupId);
  return tabGroupInfo(group);
}

async function updateTabGroup(params) {
  const groupId = requireGroupId(params);
  const updateArgs = {};
  if (typeof params.title === "string") updateArgs.title = params.title;
  if (typeof params.color === "string" && ["grey", "blue", "red", "yellow", "green", "pink", "orange", "cyan", "purple"].includes(params.color)) {
    updateArgs.color = params.color;
  }
  if (typeof params.collapsed === "boolean") updateArgs.collapsed = params.collapsed;
  await chrome.tabGroups.update(groupId, updateArgs);
  return tabGroupInfo(await chrome.tabGroups.get(groupId));
}

async function listTabGroups(params) {
  const query = {};
  if (Number.isInteger(params.windowId)) query.windowId = params.windowId;
  const groups = await chrome.tabGroups.query(query);
  return groups.map(tabGroupInfo);
}

async function groupTabs(params) {
  const tabIds = requireTabIdArray(params.tabIds);
  const groupArgs = { tabIds };
  if (Number.isInteger(params.groupId)) groupArgs.groupId = params.groupId;
  const groupId = await chrome.tabs.group(groupArgs);
  return { groupId, tabIds };
}

async function ungroupTabs(params) {
  const tabIds = requireTabIdArray(params.tabIds);
  await chrome.tabs.ungroup(tabIds);
  return { ungrouped: true, tabIds };
}

function windowInfo(win) {
  return {
    id: win.id,
    focused: win.focused === true,
    incognito: win.incognito === true,
    state: win.state,
    type: win.type,
    top: win.top,
    left: win.left,
    width: win.width,
    height: win.height,
    tabsCount: win.tabs?.length ?? 0
  };
}

function tabGroupInfo(group) {
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed === true
  };
}

function requireWindowId(params) {
  if (!Number.isInteger(params.windowId)) throw new Error("windowId must be an integer");
  return params.windowId;
}

function requireDownloadId(params) {
  if (!Number.isInteger(params.downloadId)) throw new Error("downloadId must be an integer");
  return params.downloadId;
}

function requireGroupId(params) {
  if (!Number.isInteger(params.groupId)) throw new Error("groupId must be an integer");
  return params.groupId;
}

function requireTabIdArray(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0 || !tabIds.every((id) => Number.isInteger(id))) {
    throw new Error("tabIds must be a non-empty array of integers");
  }
  if (tabIds.length > MAX_TAB_IDS) throw new Error(`tabIds must contain at most ${MAX_TAB_IDS} entries`);
  return tabIds;
}

function interpolatePath(points, steps) {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpTargets() {
  return (await chrome.debugger.getTargets()).map((target) => ({
    attached: target.attached === true,
    id: target.id,
    tabId: target.tabId,
    title: target.title,
    type: target.type,
    url: target.url
  }));
}

async function cdpCommand(params) {
  if (!isValidCdpMethod(params.method)) {
    throw new Error("method must be a CDP method string in 'Domain.method' format");
  }
  if (params.method === "Target.getTargets") {
    // Return real CDP TargetInfo objects (targetId, not the extension's id/tabId
    // shape) so callers expecting protocol output are not surprised.
    return {
      targetInfos: (await chrome.debugger.getTargets()).map((target) => ({
        attached: target.attached === true,
        canAccessOpener: false,
        targetId: target.id,
        title: target.title ?? "",
        type: target.type,
        url: target.url ?? ""
      }))
    };
  }
  const target = debuggerTarget(params);
  const commandParams = params.commandParams ?? {};
  if (typeof commandParams !== "object" || commandParams === null || Array.isArray(commandParams)) {
    throw new Error("commandParams must be an object when provided");
  }
  return withDebuggerTarget(target, async (attachedTarget) => {
    return chrome.debugger.sendCommand(attachedTarget, params.method, commandParams);
  });
}

async function searchHistory(params) {
  const maxResults = clampInteger(params.limit, 1, 1000, 100, "limit");
  const query = typeof params.query === "string" ? limitString(params.query, "query", MAX_QUERY_CHARS) : "";
  const search = { text: query, maxResults };
  const startTime = optionalTime(params.from, "from");
  const endTime = optionalTime(params.to, "to");
  if (startTime !== null) search.startTime = startTime;
  if (endTime !== null) search.endTime = endTime;
  return (await chrome.history.search(search)).map((entry) => ({
    id: entry.id,
    lastVisitTime: entry.lastVisitTime,
    title: entry.title,
    typedCount: entry.typedCount,
    url: entry.url,
    visitCount: entry.visitCount
  }));
}

async function searchBookmarks(params) {
  const limit = clampInteger(params.limit, 1, 1000, 100, "limit");
  const query = typeof params.query === "string" && params.query.length > 0
    ? limitString(params.query, "query", MAX_QUERY_CHARS)
    : {};
  return (await chrome.bookmarks.search(query)).slice(0, limit).map((entry) => ({
    dateAdded: entry.dateAdded,
    id: entry.id,
    parentId: entry.parentId,
    title: entry.title,
    url: entry.url
  }));
}

async function withDebugger(tabId, callback) {
  return withDebuggerTarget({ tabId }, callback);
}

async function withDebuggerTarget(debugTarget, callback) {
  const key = debuggerKey(debugTarget);
  return withDebuggerLock(key, async () => {
    // Persistent attachment state can change while this operation waits for the lock.
    const reused = Number.isInteger(debugTarget.tabId) && isPersistentDebuggerAttached(debugTarget.tabId);
    let attached = false;
    try {
      if (!reused) {
        await chrome.debugger.attach(debugTarget, DEBUGGER_VERSION);
        attached = true;
      }
      return await callback(debugTarget);
    } finally {
      if (attached) await chrome.debugger.detach(debugTarget).catch(() => {});
    }
  });
}

function debuggerKey(debugTarget) {
  if (!Number.isInteger(debugTarget.tabId) && typeof debugTarget.targetId !== "string") {
    throw new Error("CDP target must include tabId or targetId");
  }
  return Number.isInteger(debugTarget.tabId) ? `tab:${debugTarget.tabId}` : `target:${debugTarget.targetId}`;
}

function isPersistentDebuggerAttached(tabId) {
  return consoleLogAttached.has(tabId) || cdpEventAttached.has(tabId);
}

async function withDebuggerLock(key, callback) {
  const prev = debuggerQueue.get(key) ?? Promise.resolve();
  let resolveLock;
  const lock = new Promise((resolve) => { resolveLock = resolve; });
  debuggerQueue.set(key, lock);

  await prev;
  try {
    return await callback();
  } finally {
    resolveLock();
    if (debuggerQueue.get(key) === lock) debuggerQueue.delete(key);
  }
}

async function releaseDebuggers(params = {}) {
  const tabIds = Array.isArray(params.tabIds)
    ? (params.tabIds.length === 0 ? [] : requireTabIdArray(params.tabIds))
    : [...new Set([...consoleLogAttached, ...cdpEventAttached])];
  for (const tabId of tabIds) {
    const target = { tabId };
    await withDebuggerLock(debuggerKey(target), async () => {
      const attached = isPersistentDebuggerAttached(tabId);
      consoleLogAttached.delete(tabId);
      cdpEventAttached.delete(tabId);
      cdpSubscriptions.delete(tabId);
      cdpEnabledDomains.delete(tabId);
      consoleLogBuffers.delete(tabId);
      consoleLogBufferChars.delete(tabId);
      if (attached) await chrome.debugger.detach(target).catch(() => {});
    });
  }
  return { released: true, tabIds };
}

async function notifyOverlay(tabId, type, data) {
  if (!await injectOverlay(tabId)) return;
  await sendOverlayMessage(tabId, type, data);
}

async function withOverlayInputPassThrough(tabId, point, operation) {
  const overlayInjected = await injectOverlay(tabId);
  if (overlayInjected) {
    await sendOverlayMessage(tabId, "agent-input-start", {});
    await sendOverlayMessage(tabId, "cursor-click", point);
  }
  try {
    return await operation();
  } finally {
    if (overlayInjected) await sendOverlayMessage(tabId, "agent-input-end", {});
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/opencode.js"] });
    return true;
  } catch {
    // Tab may be chrome://, file://, or otherwise non-injectable — silently skip
    return false;
  }
}

async function sendOverlayMessage(tabId, type, data) {
  await chrome.tabs.sendMessage(tabId, { source: OVERLAY_SOURCE, type, ...data }).catch(() => {});
}

function debuggerTarget(params) {
  if (Number.isInteger(params.tabId)) return { tabId: params.tabId };
  if (typeof params.targetId === "string" && params.targetId.length > 0) return { targetId: params.targetId };
  throw new Error("cdpCommand requires an integer tabId or non-empty targetId");
}

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function requireButton(value) {
  const button = value ?? "left";
  if (!VALID_MOUSE_BUTTONS.has(button)) throw new Error("button must be left, middle, or right");
  return button;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (value.length > MAX_KEY_CHARS) throw new Error(`${name} is too large; max ${MAX_KEY_CHARS} characters`);
  return value;
}

function clampInteger(value, min, max, fallback, name = "value") {
  if (value == null) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.max(min, Math.min(max, value));
}

function optionalTime(value, name) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new Error(`${name} must be a timestamp number or parseable date string`);
}

function sendEvent(event) {
  if (!nativePort) return;
  try {
    const message = { type: "event", event, seq: cdpEventSeq };
    if (JSON.stringify(message).length > MAX_EXTENSION_EVENT_CHARS) return;
    nativePort.postMessage(message);
    cdpEventSeq += 1;
  } catch {}
}

function registerBrowserEventListeners() {
  chrome.tabs.onCreated.addListener((tab) => sendEvent({ category: "tabs", type: "tabCreated", tab: tabInfo(tab) }));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    sendEvent({ category: "tabs", type: "tabUpdated", tabId, changeInfo, tab: tabInfo(tab) })
  );
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    const persistence = removeClosedTabLease(tabId);
    persistence.catch(reportLeasePersistenceError);
    void releaseDebuggers({ tabIds: [tabId] }).catch(() => {});
    sendEvent({ category: "tabs", type: "tabRemoved", tabId, windowId: removeInfo.windowId, isWindowClosing: removeInfo.isWindowClosing });
  });
  chrome.tabs.onActivated.addListener((activeInfo) =>
    sendEvent({ category: "tabs", type: "tabActivated", tabId: activeInfo.tabId, windowId: activeInfo.windowId })
  );
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const persistence = replaceClosedTabLease(addedTabId, removedTabId);
    persistence.catch(reportLeasePersistenceError);
    sendEvent({ category: "tabs", type: "tabReplaced", addedTabId, removedTabId });
  });
  chrome.windows.onFocusChanged.addListener((windowId) =>
    sendEvent({ category: "windows", type: "windowFocusChanged", windowId })
  );
  chrome.downloads.onCreated.addListener((item) =>
    sendEvent({ category: "downloads", type: "downloadCreated", downloadId: item.id, filename: item.filename, url: item.url })
  );
  chrome.downloads.onChanged.addListener((delta) =>
    sendEvent({ category: "downloads", type: "downloadChanged", downloadId: delta.id, state: delta.state, paused: delta.paused, bytesReceived: delta.bytesReceived })
  );
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;
    const subscribed = cdpSubscriptions.get(tabId);
    const collectsConsole = consoleLogAttached.has(tabId) && CONSOLE_LOG_METHODS.includes(method);
    if (!collectsConsole && (!subscribed || !subscribed.has(method))) return;
    if (collectsConsole) {
      appendConsoleLog(tabId, method, params);
    }
    sendEvent({ category: "cdp", type: "cdpEvent", tabId, method, params });
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source?.tabId;
    if (Number.isInteger(tabId)) {
      cdpSubscriptions.delete(tabId);
      consoleLogBuffers.delete(tabId);
      consoleLogBufferChars.delete(tabId);
      consoleLogAttached.delete(tabId);
      cdpEventAttached.delete(tabId);
      cdpEnabledDomains.delete(tabId);
      sendEvent({ category: "cdp", type: "cdpDetached", tabId, reason });
    }
  });
}

const CDP_METHOD_RE = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u;
const VALID_MOUSE_BUTTONS = new Set(["left", "middle", "right"]);

async function subscribeCdpEvents(params) {
  const tabId = requireTabId(params);
  const methods = Array.isArray(params.methods) ? params.methods : [];
  if (methods.length === 0 || methods.length > MAX_CDP_METHODS || !methods.every(isValidCdpMethod)) {
    throw new Error("methods must be a non-empty array of CDP method strings in 'Domain.method' format");
  }
  let subscribed = cdpSubscriptions.get(tabId);
  const previous = new Set(subscribed ?? []);
  subscribed = new Set(previous);
  for (const method of methods) subscribed.add(method);
  if (subscribed.size > MAX_CDP_METHODS) {
    throw new Error(`a tab can subscribe to at most ${MAX_CDP_METHODS} CDP methods per tab`);
  }
  cdpSubscriptions.set(tabId, subscribed);
  try {
    await ensureCdpEventDebugger(tabId, methods);
  } catch (error) {
    if (previous.size === 0) cdpSubscriptions.delete(tabId);
    else cdpSubscriptions.set(tabId, previous);
    throw error;
  }
  return { tabId, subscribed: [...subscribed] };
}

async function unsubscribeCdpEvents(params) {
  const tabId = requireTabId(params);
  const methods = Array.isArray(params.methods) ? params.methods : [];
  if (methods.length > MAX_CDP_METHODS) {
    throw new Error(`methods must contain at most ${MAX_CDP_METHODS} CDP methods`);
  }
  if (methods.length > 0 && !methods.every(isValidCdpMethod)) {
    throw new Error("methods must be CDP method strings in 'Domain.method' format");
  }
  if (methods.length === 0) {
    cdpSubscriptions.delete(tabId);
    await detachCdpEventDebuggerIfIdle(tabId);
    return { tabId, subscribed: [] };
  }
  const subscribed = cdpSubscriptions.get(tabId);
  if (subscribed) {
    for (const method of methods) subscribed.delete(method);
    if (subscribed.size === 0) cdpSubscriptions.delete(tabId);
  }
  await detachCdpEventDebuggerIfIdle(tabId);
  return { tabId, subscribed: subscribed ? [...subscribed] : [] };
}

async function getConsoleLogs(params) {
  const tabId = requireTabId(params);
  const clear = params.clear === true;
  const autoAttach = params.autoAttach !== false;
  if (autoAttach) await ensureConsoleLogDebugger(tabId);
  const buffer = consoleLogBuffers.get(tabId);
  const logs = buffer ? buffer.slice() : [];
  if (clear && buffer) {
    buffer.length = 0;
    consoleLogBufferChars.set(tabId, 0);
  }
  return {
    tabId,
    count: logs.length,
    attached: consoleLogAttached.has(tabId),
    logs
  };
}

async function setCursorState(params) {
  const tabId = requireTabId(params);
  const state = params.state;
  if (!["active", "handoff", "deliverable", "hidden", "abort"].includes(state)) {
    throw new Error("state must be active, handoff, deliverable, hidden, or abort");
  }
  await notifyOverlay(tabId, "cursor-state", { state });
  return { tabId, state };
}

async function setFaviconBadge(params) {
  const tabId = requireTabId(params);
  const badge = params.badge ?? null;
  if (badge !== null && !["active", "handoff", "deliverable"].includes(badge)) {
    throw new Error("badge must be active, handoff, deliverable, or null");
  }
  await notifyOverlay(tabId, "favicon-badge", { badge });
  return { tabId, badge };
}

const MAX_A11Y_REF_CHARS = 50;
const MAX_BLOCKED_URL_PATTERNS = 500;
const MAX_BLOCKED_URL_PATTERN_CHARS = 500;

async function injectA11yScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/a11y.js"] });
}

async function runInA11yWorld(tabId, func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  const result = results?.[0]?.result;
  if (result == null) throw new Error("Accessibility script did not return a result");
  return result;
}

async function accessibilityTree(params) {
  const tabId = requireTabId(params);
  const maxNodes = clampInteger(params.maxNodes, 1, 2000, 800, "maxNodes");
  const maxChars = clampInteger(params.maxChars, 100, 200000, 50000, "maxChars");
  const interactiveOnly = params.interactiveOnly === true;
  await injectA11yScript(tabId);
  const result = await runInA11yWorld(
    tabId,
    (options) => window.__opencodeA11yGenerate ? window.__opencodeA11yGenerate(options) : null,
    [{ maxNodes, maxChars, interactiveOnly }]
  );
  return { tabId, ...result };
}

async function tabContext(params) {
  const tabId = requireTabId(params);
  const maxChars = clampInteger(params.maxChars, 100, 200000, 50000, "maxChars");
  const maxSelectionChars = clampInteger(params.maxSelectionChars, 1, 10000, 2000, "maxSelectionChars");
  await injectA11yScript(tabId);
  const result = await runInA11yWorld(
    tabId,
    (options) => window.__opencodeTabContext ? window.__opencodeTabContext(options) : null,
    [{ maxChars, maxSelectionChars }]
  );
  validateTabContextResult(result, "tab context");
  return { tabId, ...result };
}

async function readPage(params) {
  const tabId = requireTabId(params);
  const options = {
    interactiveOnly: params.interactiveOnly === true,
    maxChars: clampInteger(params.maxChars, 100, 200000, 50000, "maxChars"),
    maxNodes: clampInteger(params.maxNodes, 1, 2000, 800, "maxNodes"),
    maxSelectionChars: clampInteger(params.maxSelectionChars, 1, 10000, 2000, "maxSelectionChars")
  };
  if (params.includeScreenshot === true) await activateTab(tabId);
  await injectA11yScript(tabId);
  const combined = await runInA11yWorld(
    tabId,
    (readOptions) => {
      if (!window.__opencodeTabContext || !window.__opencodeA11yGenerate) return null;
      return {
        context: window.__opencodeTabContext(readOptions),
        accessibility: window.__opencodeA11yGenerate(readOptions)
      };
    },
    [options]
  );
  validateReadPageResult(combined);
  const screenshot = params.includeScreenshot === true
    ? await captureScreenshot({
        format: params.screenshotFormat,
        quality: params.screenshotQuality,
        tabId
      })
    : null;
  return {
    tabId,
    context: combined.context,
    accessibility: combined.accessibility,
    screenshot
  };
}

function validateReadPageResult(result) {
  if (!isRecord(result)
    || !isRecord(result.accessibility)
    || typeof result.accessibility.tree !== "string"
    || result.accessibility.tree.length > 200000
    || !isValidTabContextResult(result.context)) {
    throw new Error("read page result is invalid");
  }
}

function validateTabContextResult(result, label) {
  if (!isValidTabContextResult(result)) throw new Error(`${label} result is invalid`);
}

function isValidTabContextResult(result) {
  if (!isRecord(result)
    || typeof result.visibleText !== "string"
    || result.visibleText.length > 200000) return false;
  if (result.returnedChars != null
    && (!Number.isInteger(result.returnedChars) || result.returnedChars !== result.visibleText.length)) return false;
  if (result.totalChars != null
    && (!Number.isInteger(result.totalChars) || result.totalChars < result.visibleText.length)) return false;
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireElementRef(params) {
  if (typeof params.ref !== "string" || params.ref.length === 0 || params.ref.length > MAX_A11Y_REF_CHARS) {
    throw new Error("ref must be a non-empty element reference string from accessibilityTree");
  }
  return params.ref;
}

async function locateElement(tabId, ref) {
  await injectA11yScript(tabId);
  const location = await runInA11yWorld(
    tabId,
    (elementRef) => window.__opencodeA11yLocate ? window.__opencodeA11yLocate(elementRef) : null,
    [ref]
  );
  if (location.found !== true) {
    throw new Error(`Element ${ref} was not found; capture a fresh accessibilityTree`);
  }
  if (location.visible !== true || !(location.width > 0) || !(location.height > 0)) {
    throw new Error(`Element ${ref} is not visible; capture a fresh accessibilityTree`);
  }
  if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) {
    throw new Error(`Element ${ref} has no usable position`);
  }
  return location;
}

async function clickElement(params) {
  const tabId = requireTabId(params);
  const ref = requireElementRef(params);
  const location = await locateElement(tabId, ref);
  await dispatchClick({
    tabId,
    x: location.x,
    y: location.y,
    button: params.button,
    modifiers: params.modifiers
  });
  return { clicked: true, ref, x: location.x, y: location.y, role: location.role, name: location.name };
}

async function fillElement(params) {
  const tabId = requireTabId(params);
  const ref = requireElementRef(params);
  if (typeof params.text !== "string") throw new Error("text must be a string");
  if (params.text.length > MAX_TEXT_CHARS) throw new Error(`text is too large; max ${MAX_TEXT_CHARS} characters`);
  const clear = params.clear !== false;
  await injectA11yScript(tabId);
  const focusResult = await runInA11yWorld(
    tabId,
    (elementRef, selectAll) => window.__opencodeA11yFocus ? window.__opencodeA11yFocus(elementRef, selectAll) : null,
    [ref, clear]
  );
  if (focusResult.found !== true) {
    throw new Error(`Element ${ref} was not found; capture a fresh accessibilityTree`);
  }
  if (focusResult.editable !== true) {
    throw new Error(`Element ${ref} is not an editable field (input, textarea, or contenteditable)`);
  }
  if (focusResult.focused !== true) {
    throw new Error(`Element ${ref} could not be focused; it may be disabled or covered`);
  }
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: params.text });
  });
  const verifyResult = await runInA11yWorld(
    tabId,
    (elementRef, text, selectedAll) => window.__opencodeA11yVerifyFill
      ? window.__opencodeA11yVerifyFill(elementRef, text, selectedAll)
      : null,
    [ref, params.text, clear]
  );
  if (verifyResult.found !== true) {
    throw new Error(`Element ${ref} was replaced while filling; capture a fresh accessibilityTree`);
  }
  if (verifyResult.verified !== true) {
    throw new Error(`Filling element ${ref} did not update the field to the requested value`);
  }
  return { filled: true, ref, tabId, cleared: clear };
}

async function loadBlockedUrlPatterns() {
  const patterns = [];
  for (const areaName of ["managed", "local"]) {
    const area = chrome.storage?.[areaName];
    if (typeof area?.get !== "function") continue;
    let stored;
    try {
      stored = await area.get("blockedUrlPatterns");
    } catch (error) {
      throw new Error(`Could not read blockedUrlPatterns from ${areaName} storage: ${error?.message || error}`);
    }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error(`${areaName} storage returned an invalid blockedUrlPatterns result`);
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "blockedUrlPatterns")) continue;
    const list = stored.blockedUrlPatterns;
    if (!Array.isArray(list)) {
      throw new Error(`blockedUrlPatterns in ${areaName} storage must be an array`);
    }
    if (list.length > MAX_BLOCKED_URL_PATTERNS) {
      throw new Error(`blockedUrlPatterns in ${areaName} storage exceeds the limit of ${MAX_BLOCKED_URL_PATTERNS}`);
    }
    for (const entry of list) {
      if (
        typeof entry !== "string"
        || entry.trim().length === 0
        || entry.length > MAX_BLOCKED_URL_PATTERN_CHARS
        || normalizeBlockPattern(entry) === null
      ) {
        throw new Error(`blockedUrlPatterns in ${areaName} storage contains an invalid pattern`);
      }
      patterns.push(entry.trim());
    }
  }
  const uniquePatterns = [...new Set(patterns)];
  if (uniquePatterns.length > MAX_BLOCKED_URL_PATTERNS) {
    throw new Error(`blockedUrlPatterns exceeds the combined limit of ${MAX_BLOCKED_URL_PATTERNS}`);
  }
  return uniquePatterns;
}

function normalizeBlockPattern(pattern) {
  const normalized = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
  if (normalized.length === 0) return null;
  return normalized.includes("/") ? normalized : `${normalized}/*`;
}

function urlMatchesBlockPattern(parsedUrl, pattern) {
  const normalized = normalizeBlockPattern(pattern);
  if (normalized === null) return false;
  const host = parsedUrl.hostname.toLowerCase().replace(/^www\./u, "");
  let pathname;
  try {
    pathname = decodeURIComponent(parsedUrl.pathname).toLowerCase();
  } catch {
    throw new Error("Navigation URL contains invalid percent-encoding");
  }
  const subject = `${host}${pathname}`;
  if (wildcardMatch(subject, normalized)) return true;
  return !normalized.endsWith("*") && wildcardMatch(subject, `${normalized}/*`);
}

function wildcardMatch(subject, pattern) {
  if (!pattern.includes("*")) return subject === pattern;
  const startsWithWildcard = pattern.startsWith("*");
  const endsWithWildcard = pattern.endsWith("*");
  const parts = pattern.split("*").filter(Boolean);
  if (parts.length === 0) return true;

  let cursor = 0;
  let firstPart = 0;
  let lastPart = parts.length;
  if (!startsWithWildcard) {
    if (!subject.startsWith(parts[0])) return false;
    cursor = parts[0].length;
    firstPart = 1;
  }
  if (!endsWithWildcard) lastPart -= 1;
  for (let index = firstPart; index < lastPart; index += 1) {
    const foundAt = subject.indexOf(parts[index], cursor);
    if (foundAt === -1) return false;
    cursor = foundAt + parts[index].length;
  }
  if (endsWithWildcard) return true;

  const finalPart = parts.at(-1);
  const finalStart = subject.length - finalPart.length;
  return finalStart >= cursor && subject.endsWith(finalPart);
}

async function assertNavigationAllowed(url) {
  validateNavigationUrl(url);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  for (const pattern of await loadBlockedUrlPatterns()) {
    if (urlMatchesBlockPattern(parsed, pattern)) {
      throw new Error(`Navigation blocked by policy pattern: ${pattern}`);
    }
  }
}

async function ensureConsoleLogDebugger(tabId) {
  const target = { tabId };
  return withDebuggerLock(debuggerKey(target), async () => {
    const alreadyAttached = consoleLogAttached.has(tabId);
    if (!isPersistentDebuggerAttached(tabId)) {
      await chrome.debugger.attach(target, DEBUGGER_VERSION);
    }
    await enableCdpDomains(target, ["Console", "Log", "Runtime"]);
    consoleLogAttached.add(tabId);
    return { tabId, attached: true, alreadyAttached };
  });
}

function appendConsoleLog(tabId, method, params) {
  let buffer = consoleLogBuffers.get(tabId);
  if (!buffer) {
    buffer = [];
    consoleLogBuffers.set(tabId, buffer);
  }
  const entry = normalizeConsoleLog(method, params);
  let bufferedChars = consoleLogBufferChars.get(tabId) ?? 0;
  buffer.push(entry);
  bufferedChars += JSON.stringify(entry).length;
  while (buffer.length > CONSOLE_LOG_BUFFER_MAX || bufferedChars > CONSOLE_LOG_BUFFER_MAX_CHARS) {
    const removed = buffer.shift();
    bufferedChars -= JSON.stringify(removed).length;
  }
  consoleLogBufferChars.set(tabId, bufferedChars);
}

function normalizeConsoleLog(method, params) {
  const entry = { source: method, timestamp: Date.now() };
  if (method === "Console.messageAdded") {
    const message = params?.message ?? {};
    entry.level = typeof message.level === "string" ? message.level.toLowerCase() : "info";
    entry.text = truncateString(message.text, MAX_CONSOLE_LOG_TEXT_CHARS);
    if (typeof message.url === "string") entry.url = truncateString(message.url, MAX_CONSOLE_LOG_URL_CHARS);
    if (Number.isFinite(message.line)) entry.line = message.line;
    if (Number.isFinite(message.column)) entry.column = message.column;
    return entry;
  }
  if (method === "Log.entryAdded") {
    const logEntry = params?.entry ?? {};
    entry.level = typeof logEntry.level === "string" ? logEntry.level.toLowerCase() : "info";
    entry.text = truncateString(logEntry.text, MAX_CONSOLE_LOG_TEXT_CHARS);
    if (typeof logEntry.url === "string") entry.url = truncateString(logEntry.url, MAX_CONSOLE_LOG_URL_CHARS);
    if (Number.isFinite(logEntry.lineNumber)) entry.line = logEntry.lineNumber;
    if (Number.isFinite(logEntry.columnNumber)) entry.column = logEntry.columnNumber;
    return entry;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params?.exceptionDetails ?? {};
    const exc = details.exception ?? {};
    entry.level = "error";
    entry.text = truncateString((typeof exc.description === "string" && exc.description)
      || (typeof details.text === "string" && details.text)
      || (typeof exc.value === "string" ? exc.value : null)
      || "Uncaught exception", MAX_CONSOLE_LOG_TEXT_CHARS);
    if (typeof details.url === "string") entry.url = truncateString(details.url, MAX_CONSOLE_LOG_URL_CHARS);
    if (Number.isFinite(details.lineNumber)) entry.line = details.lineNumber;
    if (Number.isFinite(details.columnNumber)) entry.column = details.columnNumber;
    return entry;
  }
  entry.level = "info";
  entry.text = "Unrecognized console event";
  return entry;
}

function truncateString(value, maxChars) {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

function validateNavigationUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol === "about:") {
    if (parsed.href === "about:blank") return;
    throw new Error("only about:blank is allowed for about: URLs");
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }
}

function isValidCdpMethod(method) {
  return typeof method === "string" && method.length <= MAX_KEY_CHARS && CDP_METHOD_RE.test(method);
}

async function ensureCdpEventDebugger(tabId, methods) {
  const target = { tabId };
  await withDebuggerLock(debuggerKey(target), async () => {
    if (!isPersistentDebuggerAttached(tabId)) {
      await chrome.debugger.attach(target, DEBUGGER_VERSION);
    }
    cdpEventAttached.add(tabId);
    await enableCdpDomains(target, [...new Set(methods.map((method) => method.split(".")[0]))]);
  });
}

async function enableCdpDomains(target, domains) {
  const tabId = target.tabId;
  const enabled = Number.isInteger(tabId) ? (cdpEnabledDomains.get(tabId) ?? new Set()) : new Set();
  for (const domain of domains) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(domain) || enabled.has(domain)) continue;
    try {
      await chrome.debugger.sendCommand(target, `${domain}.enable`, {});
      enabled.add(domain);
    } catch {
      // Some domains do not expose an enable command. Do not mark failures as
      // enabled so transient target errors can be retried on the next request.
    }
  }
  if (Number.isInteger(tabId)) cdpEnabledDomains.set(tabId, enabled);
}

async function detachCdpEventDebuggerIfIdle(tabId) {
  if (cdpSubscriptions.has(tabId) || !cdpEventAttached.has(tabId)) return;
  const target = { tabId };
  await withDebuggerLock(debuggerKey(target), async () => {
    if (cdpSubscriptions.has(tabId) || !cdpEventAttached.has(tabId)) return;
    cdpEventAttached.delete(tabId);
    cdpEnabledDomains.delete(tabId);
    if (!consoleLogAttached.has(tabId)) await chrome.debugger.detach(target).catch(() => {});
  });
}

function limitString(value, name, maxLength) {
  if (value.length > maxLength) throw new Error(`${name} is too large; max ${maxLength} characters`);
  return value;
}

// Resolves modifier key names to the CDP bitmask: Alt=1, Control=2, Meta=4, Shift=8.
// "ControlOrMeta" maps to Control on non-Mac, Meta (Cmd) on Mac.
function resolveModifiers(modifiers) {
  if (!Array.isArray(modifiers) || modifiers.length === 0) return 0;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  const isMac = /mac/i.test(platform);
  let mask = 0;
  for (const mod of modifiers) {
    switch (mod) {
      case "Alt":    mask |= 1; break;
      case "Control": mask |= 2; break;
      case "Meta":   mask |= 4; break;
      case "Shift":  mask |= 8; break;
      case "ControlOrMeta": mask |= isMac ? 4 : 2; break;
      default: throw new Error(`Unknown modifier: ${mod}. Use Alt, Control, Meta, Shift, or ControlOrMeta`);
    }
  }
  return mask;
}
