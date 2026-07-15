import assert from "node:assert/strict";
import os from "node:os";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import OpenCodeChromeBridgePlugin, { TOOL_CAPABILITY_REQUIREMENTS } from "../src/opencode-plugin.js";
import * as pluginModule from "../src/opencode-plugin.js";
import { writeDataUrlToFile } from "../src/bridge-client.js";
import { createLauncher, isSupportedNodeVersion, nativeHostLayout } from "../scripts/lib/platform-support.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("extension manifest exposes required browser permissions and blocks extension-page network access", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
  const expectedPermissions = [
    "alarms",
    "bookmarks",
    "debugger",
    "downloads",
    "downloads.ui",
    "history",
    "nativeMessaging",
    "scripting",
    "storage",
    "tabGroups",
    "tabs"
  ];

  for (const permission of expectedPermissions) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`);
  }
  for (const permission of ["favicon", "notifications", "readingList", "sessions", "topSites"]) {
    assert.ok(!manifest.permissions.includes(permission), `unused permission ${permission} must be removed`);
  }

  const csp = manifest.content_security_policy?.extension_pages ?? "";
  assert.match(csp, /connect-src\s+'none'/u);
  assert.doesNotMatch(csp, /127\.0\.0\.1|localhost|ws:/u, "extension pages do not communicate with the local HTTP bridge");
});

test("extension manifest wires branded PNG icons for Chrome surfaces", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
  const expectedIcons = {
    "16": "images/icon16.png",
    "32": "images/icon32.png",
    "48": "images/icon48.png",
    "128": "images/icon128.png"
  };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);

  for (const iconPath of Object.values(expectedIcons)) {
    const absolutePath = path.join(repoRoot, "extension", iconPath);
    await access(absolutePath);
    const bytes = await readFile(absolutePath);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${iconPath} must be a PNG`);
  }
});

test("popup presents a polished bridge dashboard", async () => {
  const popup = await readFile(path.join(repoRoot, "extension", "popup.html"), "utf8");

  assert.match(popup, /brand-mark/u);
  assert.match(popup, /OpenCode/u);
  assert.match(popup, /Control Chrome with OpenCode/u);
  assert.match(popup, /Learn more/u);
  assert.match(popup, /settingsButton/u);
  assert.match(popup, /Version/u);
  assert.match(popup, /v\d+\.\d+\.\d+/u);
  assert.match(popup, /Copyright 2026/u);
  assert.match(popup, /pmgallardodev/u);
  assert.match(popup, /statusDetail/u);
});

test("popup action opens OpenCode installation documentation", async () => {
  const popupScript = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");

  assert.match(popupScript, /https:\/\/opencode\.ai\/docs/u);
  assert.match(popupScript, /https:\/\/github\.com\/pmgallardodev/u);
  assert.match(popupScript, /chrome\.tabs\.create/u);
  assert.match(popupScript, /getManifest\(\)\.version/u);
});

test("background supports full CDP commands plus browser history and bookmarks", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  for (const method of ["cdpCommand", "cdpTargets", "history", "bookmarks", "scroll", "doubleClick", "hover", "domContent", "setViewport", "resetViewport"]) {
    assert.match(background, new RegExp(`case "${method}"`, "u"), `missing background command ${method}`);
  }
});

test("background supports window state, creation, downloads, and tab group commands", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  for (const method of [
    "setWindowState", "getWindowState", "createWindow", "moveSequence",
    "listDownloads", "cancelDownload", "pauseDownload", "resumeDownload", "showDownload",
    "createTabGroup", "updateTabGroup", "listTabGroups", "groupTabs", "ungroupTabs"
  ]) {
    assert.match(background, new RegExp(`case "${method}"`, "u"), `missing background command ${method}`);
  }
});

test("background supports tab session finalization and debugger cleanup", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  for (const method of ["claimTab", "finalizeTabs", "endTurn", "releaseDebuggers", "setCursorState", "setFaviconBadge"]) {
    assert.match(background, new RegExp(`case "${method}"`, "u"), `missing background command ${method}`);
  }

  assert.match(background, /opencodeTabLeases/u, "missing tab lease storage key");
  assert.match(background, /handoff|deliverable/u, "missing handoff/deliverable finalization states");
  assert.match(background, /chrome\.storage\.session\.set/u, "tab leases should persist in session storage");
  assert.match(background, /chrome\.debugger\.detach/u, "releaseDebuggers must detach Chrome debugger");
  assert.match(background, /Chrome internal tab .* cannot be claimed/u, "claimTab must reject internal Chrome tabs");
  assert.match(background, /already part of browser session/u, "claimTab must not overwrite another active session lease");
  assert.match(background, /lease\.sessionId !== sessionId \|\| lease\.turnId !== turnId/u, "endTurn must release only the active turn leases");
});

test("background rejects internal Chrome navigation schemes by default", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /ALLOWED_URL_SCHEMES = new Set\(\["http:", "https:"\]\)/u);
  assert.match(background, /parsed\.href === "about:blank"/u);
  assert.doesNotMatch(background, /ALLOWED_URL_SCHEMES = new Set\([^)]*"chrome:/u, "chrome: URLs should not be in the default navigation allowlist");
  assert.doesNotMatch(background, /ALLOWED_URL_SCHEMES = new Set\([^)]*"chrome-extension:/u, "chrome-extension: URLs should not be in the default navigation allowlist");
});

test("background uses CDP Emulation.setDeviceMetricsOverride for viewport emulation", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /Emulation\.setDeviceMetricsOverride/u, "setViewport must use CDP emulation");
  assert.match(background, /Emulation\.clearDeviceMetricsOverride/u, "resetViewport must clear CDP emulation");
});

test("viewport tool descriptions match CDP emulation behavior", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  assert.match(plugin.tool.chrome_set_viewport.description, /emulat/iu);
  assert.doesNotMatch(plugin.tool.chrome_set_viewport.description, /resize the Chrome window/iu);
  assert.match(plugin.tool.chrome_reset_viewport.description, /clear.*emulat|emulat.*clear/iu);
});

test("background moveSequence interpolates a drag path with press and release", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /interpolatePath/u, "missing interpolatePath helper");
  assert.match(background, /mousePressed/u, "moveSequence drag must press the button");
  assert.match(background, /mouseReleased/u, "moveSequence drag must release the button");
  assert.match(background, /MAX_MOVE_DURATION_MS/u, "move sequences must have an overall duration budget");
  assert.match(background, /estimatedDurationMs/u, "move duration must be validated before dispatching events");
});

test("background exposes downloads search and lifecycle operations", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /chrome\.downloads\.search/u, "missing chrome.downloads.search");
  assert.match(background, /chrome\.downloads\.cancel/u, "missing chrome.downloads.cancel");
  assert.match(background, /chrome\.downloads\.pause/u, "missing chrome.downloads.pause");
  assert.match(background, /chrome\.downloads\.resume/u, "missing chrome.downloads.resume");
  assert.match(background, /chrome\.downloads\.show/u, "missing chrome.downloads.show");
});

test("background exposes tab group operations via chrome.tabs.group and chrome.tabGroups", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /chrome\.tabs\.group/u, "missing chrome.tabs.group");
  assert.match(background, /chrome\.tabs\.ungroup/u, "missing chrome.tabs.ungroup");
  assert.match(background, /chrome\.tabGroups\.update/u, "missing chrome.tabGroups.update");
  assert.match(background, /chrome\.tabGroups\.query/u, "missing chrome.tabGroups.query");
  assert.match(background, /chrome\.tabGroups\.get/u, "missing chrome.tabGroups.get");
});

test("background registers browser event listeners that stream events to the native host", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /registerBrowserEventListeners/u, "missing registerBrowserEventListeners");
  assert.match(background, /sendEvent/u, "missing sendEvent helper");
  assert.match(background, /chrome\.tabs\.onCreated/u, "missing chrome.tabs.onCreated listener");
  assert.match(background, /chrome\.tabs\.onUpdated/u, "missing chrome.tabs.onUpdated listener");
  assert.match(background, /chrome\.tabs\.onRemoved/u, "missing chrome.tabs.onRemoved listener");
  assert.match(background, /chrome\.tabs\.onActivated/u, "missing chrome.tabs.onActivated listener");
  assert.match(background, /chrome\.windows\.onFocusChanged/u, "missing chrome.windows.onFocusChanged listener");
  assert.match(background, /chrome\.downloads\.onCreated/u, "missing chrome.downloads.onCreated listener");
  assert.match(background, /chrome\.downloads\.onChanged/u, "missing chrome.downloads.onChanged listener");
});

test("background supports CDP event subscription and forwarding via debugger.onEvent", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /case "subscribeCdpEvents"/u, "missing subscribeCdpEvents command");
  assert.match(background, /case "unsubscribeCdpEvents"/u, "missing unsubscribeCdpEvents command");
  assert.match(background, /cdpSubscriptions/u, "missing cdpSubscriptions state map");
  assert.match(background, /chrome\.debugger\.onEvent/u, "missing chrome.debugger.onEvent listener");
  assert.match(background, /type: "event"/u, "background must post type:'event' messages to native host");
});

test("native host accepts event messages and exposes SSE and polling endpoints", async () => {
  const nativeHost = await readFile(path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs"), "utf8");

  assert.match(nativeHost, /type === "event"/u, "native host must handle type:'event' messages");
  assert.match(nativeHost, /broadcastEvent/u, "missing broadcastEvent helper");
  assert.match(nativeHost, /eventBuffer/u, "missing eventBuffer ring buffer");
  assert.match(nativeHost, /text\/event-stream/u, "missing SSE Content-Type for /events");
  assert.match(nativeHost, /\/events\/poll/u, "missing /events/poll endpoint");
  assert.match(nativeHost, /eventSubscribers/u, "missing eventSubscribers set");
  assert.match(nativeHost, /broadcastEvent\(message\.event \?\? message\);/u, "native host must assign its own monotonic event sequence");
  assert.match(nativeHost, /nextSeq:\s*eventBuffer\.at\(-1\)\?\.seq\s*\?\?\s*\(nextEventSeq\s*-\s*1\)/u, "poll cursor must fall back to last assigned seq, not reset to 0");
});

test("native host validates local bridge command requests before forwarding to Chrome", async () => {
  const nativeHost = await readFile(path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs"), "utf8");

  assert.match(nativeHost, /Content-Type must be application\/json/u, "native host must require JSON command bodies");
  assert.match(nativeHost, /Request body too large/u, "native host must cap HTTP body size");
  assert.match(nativeHost, /method must be a valid bridge command name/u, "native host must validate command method names");
  assert.match(nativeHost, /params must be a JSON object/u, "native host must validate params objects");
  assert.match(nativeHost, /chmod\(STATE_DIR, 0o700\)/u, "native host must restrict state directory permissions");
  assert.match(nativeHost, /rename\(temporaryStatePath, STATE_PATH\)/u, "native host must publish state atomically");
  assert.match(nativeHost, /randomBytes\(32\)\.toString\("base64url"\)/u, "bridge token must contain 256 random bits");
  assert.doesNotMatch(nativeHost, /randomUUID/u, "UUID entropy is below the 128-bit session-token requirement");
  assert.match(nativeHost, /timingSafeEqual/u, "bearer token comparisons must be timing safe");
  assert.match(nativeHost, /requestUrl\.pathname === "\/events\/poll"/u, "event polling must use an exact route match");
  assert.match(nativeHost, /EVENT_BUFFER_MAX_BYTES/u, "event buffering must have a total byte limit");
  assert.match(nativeHost, /EVENT_MAX_BYTES/u, "individual events must have a byte limit");
  assert.match(nativeHost, /MAX_PENDING_COMMANDS/u, "pending Chrome commands must be bounded");
  assert.match(nativeHost, /MAX_EVENT_SUBSCRIBERS/u, "SSE subscribers must be bounded");
  assert.match(nativeHost, /if \(!subscriber\.write/u, "slow SSE subscribers must be disconnected instead of buffering indefinitely");
  assert.match(nativeHost, /server\.headersTimeout/u, "local HTTP headers must have a finite timeout");
  assert.match(nativeHost, /type:\s*"cancel",\s*id/u, "timed-out commands must cancel extension work");
  assert.match(nativeHost, /Math\.min\(parsed,\s*125000\)/u, "host timeout must leave five seconds for extension cleanup");
  assert.match(nativeHost, /"Cache-Control": "no-store"/u, "JSON responses containing browser data must not be cached");
  assert.match(nativeHost, /"X-Content-Type-Options": "nosniff"/u, "JSON responses must disable MIME sniffing");
});

test("bridge client aborts stalled local HTTP requests", async () => {
  const source = await readFile(path.join(repoRoot, "src", "bridge-client.js"), "utf8");

  assert.match(source, /AbortController/u, "bridge client must create an AbortController for fetch");
  assert.match(source, /setTimeout/u, "bridge client must enforce a client-side timeout");
  assert.match(source, /clearTimeout/u, "bridge client must clear the timeout after fetch settles");
  assert.match(source, /MAX_REQUEST_TIMEOUT_MS\s*=\s*126000/u, "client timeout must outlive the maximum native-host command timeout");
  assert.match(source, /await open\(STATE_PATH, "r"\)/u, "bridge client must validate the opened state file rather than a racy path");
  assert.match(source, /stateInfo\.mode & 0o077/u, "bridge client must reject a state token readable by other users");
  assert.match(source, /stateInfo\.uid !== process\.getuid\(\)/u, "bridge client must reject state owned by another user");
});

test("native-host smoke check reports child startup failures", async () => {
  const smoke = await readFile(path.join(repoRoot, "scripts", "smoke-native-host.mjs"), "utf8");
  assert.match(smoke, /child\.stderr\.on\("data"/u);
  assert.match(smoke, /child\.exitCode/u);
  assert.match(smoke, /Native host exited/u);
});

test("bridge client only writes bounded PNG or JPEG data URLs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-bridge-test-"));
  try {
    const pngPath = path.join(tempDir, "capture.png");
    const result = await writeDataUrlToFile("data:image/png;base64,iVBORw0KGgo=", pngPath);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, 8);

    const jpegResult = await writeDataUrlToFile("data:image/jpeg;base64,/9j/2Q==", path.join(tempDir, "capture.jpg"));
    assert.equal(jpegResult.mimeType, "image/jpeg");
    assert.equal(jpegResult.bytes, 4);

    await assert.rejects(
      () => writeDataUrlToFile("data:text/html;base64,PGgxPm5vPC9oMT4=", path.join(tempDir, "capture.html")),
      /unsupported MIME type/u
    );

    await assert.rejects(
      () => writeDataUrlToFile("data:image/jpeg;base64,not-base64", path.join(tempDir, "capture.jpg")),
      /invalid base64/u
    );
    await assert.rejects(
      () => writeDataUrlToFile("data:image/png;base64,A", path.join(tempDir, "short.png")),
      /invalid base64/u
    );
    await assert.rejects(
      () => writeDataUrlToFile("data:image/png,%89PNG", path.join(tempDir, "plain.png")),
      /base64/u
    );
    await assert.rejects(
      () => writeDataUrlToFile("data:image/png;base64,PGh0bWw+", path.join(tempDir, "spoofed.png")),
      /signature/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("background resolves modifier keys to CDP bitmask including ControlOrMeta", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /resolveModifiers/u, "missing resolveModifiers helper");
  assert.match(background, /ControlOrMeta/u, "missing ControlOrMeta modifier support");
  assert.match(background, /navigator\.platform/u, "missing platform detection for ControlOrMeta");
});

test("background serializes debugger access per target to prevent race conditions", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /debuggerQueue/u, "missing debuggerQueue serialization map");
  assert.match(background, /resolveLock/u, "missing per-target lock resolver");
  assert.match(
    background,
    /withDebuggerLock\(key, async \(\) => \{[\s\S]{0,300}const reused =/u,
    "persistent debugger state must be checked after acquiring the per-target lock"
  );
  assert.match(
    background,
    /withDebuggerLock\(debuggerKey\(target\), async \(\) => \{[\s\S]{0,500}chrome\.debugger\.detach/u,
    "debugger release must use the same per-target lock as attach and command operations"
  );
});

test("background reports a numeric window tab count", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");
  assert.match(background, /tabsCount:\s*win\.tabs\?\.length\s*\?\?\s*0/u);
});

test("wizard forwards configured JPEG quality to the screenshot command", async () => {
  const plugin = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(
    plugin,
    /"screenshot",\s*\{\s*tabId:\s*args\.tabId,\s*format:\s*args\.screenshotFormat,\s*quality:\s*args\.screenshotQuality\s*\}/u
  );
});

test("background injects content script overlay on click and scroll actions", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /notifyOverlay/u, "missing notifyOverlay helper");
  assert.match(background, /content-scripts\/opencode\.js/u, "missing content script path reference");
});

test("content script overlay is idempotent and uses shadow DOM", async () => {
  const script = await readFile(path.join(repoRoot, "extension", "content-scripts", "opencode.js"), "utf8");

  assert.match(script, /__opencodeOverlayInstalled/u, "missing idempotency guard");
  assert.match(script, /attachShadow/u, "missing shadow DOM isolation");
  assert.match(script, /cursor-click/u, "missing click animation handler");
  assert.match(script, /cursor-move/u, "missing move animation handler");
  assert.match(script, /cursor-hide/u, "missing hide handler");
});

test("content script overlay supports state changes, bezier movement, and favicon badge", async () => {
  const script = await readFile(path.join(repoRoot, "extension", "content-scripts", "opencode.js"), "utf8");

  assert.match(script, /cursor-state/u, "missing cursor-state message handler");
  assert.match(script, /cursor-arrived/u, "missing cursor-arrived message handler");
  assert.match(script, /STATE_COLORS/u, "missing STATE_COLORS state map");
  assert.match(script, /handoff|deliverable|abort/u, "missing handoff/deliverable/abort overlay states");
  assert.match(script, /animateBezier/u, "missing bezier movement animation");
  assert.match(script, /favicon-badge|oc-favicon-badge/u, "missing favicon badge element");
  assert.match(script, /link\[rel~="icon"\]/u, "missing real document favicon support");
  assert.match(script, /data-opencode-favicon-badge/u, "missing favicon restoration marker");
});

test("manifest declares web_accessible_resources for content script assets", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));

  assert.ok(Array.isArray(manifest.web_accessible_resources), "missing web_accessible_resources");
  const resources = manifest.web_accessible_resources.flatMap((r) => r.resources ?? []);
  assert.ok(resources.includes("images/cursor-chat.png"), "cursor-chat.png not declared as web accessible");
});

test("cursor-chat.png image exists in extension images", async () => {
  await access(path.join(repoRoot, "extension", "images", "cursor-chat.png"));
});

test("OpenCode plugin exposes full CDP and user browser context tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool).sort();

  for (const toolName of ["chrome_cdp", "chrome_cdp_targets", "chrome_history", "chrome_bookmarks"]) {
    assert.ok(tools.includes(toolName), `missing Opencode tool ${toolName}`);
  }

  assert.match(plugin.tool.chrome_cdp.description, /full Chrome DevTools Protocol|full CDP/i);
});

test("OpenCode plugin exposes navigation and tab management tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool);

  for (const toolName of [
    "chrome_close_tab", "chrome_activate_tab", "chrome_reload", "chrome_back", "chrome_forward",
    "chrome_get_tab", "chrome_double_click", "chrome_hover", "chrome_dom_content",
    "chrome_set_viewport", "chrome_reset_viewport"
  ]) {
    assert.ok(tools.includes(toolName), `missing plugin tool ${toolName}`);
  }
});

test("OpenCode plugin exposes window, drag, downloads, and tab group tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool);

  for (const toolName of [
    "chrome_set_window_state", "chrome_get_window_state", "chrome_open_window",
    "chrome_drag", "chrome_move",
    "chrome_downloads_list", "chrome_download_cancel", "chrome_download_pause",
    "chrome_download_resume", "chrome_download_show",
    "chrome_tab_group_create", "chrome_tab_group_update", "chrome_tab_groups",
    "chrome_group_tabs", "chrome_ungroup_tabs"
  ]) {
    assert.ok(tools.includes(toolName), `missing plugin tool ${toolName}`);
  }
});

test("OpenCode plugin exposes session, cleanup, cursor, and favicon tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool);

  for (const toolName of [
    "chrome_claim_tab", "chrome_finalize_tabs", "chrome_end_turn", "chrome_release_debuggers",
    "chrome_cursor_state", "chrome_favicon_badge"
  ]) {
    assert.ok(tools.includes(toolName), `missing plugin tool ${toolName}`);
  }
});

test("OpenCode plugin chrome_drag accepts a points array and performs press-move-release", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  assert.ok("chrome_drag" in plugin.tool, "chrome_drag tool missing");
  assert.match(plugin.tool.chrome_drag.description, /drag/i, "chrome_drag description should mention drag");
});

test("OpenCode plugin exposes event polling and CDP subscription tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool);

  for (const toolName of ["chrome_events", "chrome_subscribe_cdp", "chrome_unsubscribe_cdp"]) {
    assert.ok(tools.includes(toolName), `missing plugin tool ${toolName}`);
  }

  assert.match(plugin.tool.chrome_events.description, /poll/i, "chrome_events should mention polling");
  assert.match(plugin.tool.chrome_subscribe_cdp.description, /subscribe/i, "chrome_subscribe_cdp should mention subscribe");
});

test("OpenCode plugin chrome_click accepts button parameter", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const desc = plugin.tool.chrome_click.description;

  assert.ok("chrome_click" in plugin.tool, "chrome_click tool missing");
  assert.match(plugin.tool.chrome_scroll.description, /scroll/i, "chrome_scroll tool missing");
});

test("OpenCode plugin chrome_screenshot accepts optional tabId", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  assert.match(
    plugin.tool.chrome_screenshot.description,
    /Omit tabId/u,
    "chrome_screenshot description should document optional tabId"
  );
});

test("OpenCode plugin resolves screenshot output paths against real project paths", async () => {
  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");

  assert.match(source, /import \{ lstat, realpath \} from "node:fs\/promises"/u, "plugin must inspect real filesystem paths");
  assert.match(source, /await resolveProjectOutputPath\(context\.directory/u, "screenshot tools must await path validation");
  assert.match(source, /nearestExistingAncestor/u, "plugin must validate existing symlink ancestors");
  assert.match(source, /assertPathWithin/u, "plugin must reject paths outside the project");
});

test("OpenCode plugin exposes chrome_wizard_step, chrome_screenshot_region, and chrome_get_console_logs", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const tools = Object.keys(plugin.tool);

  for (const toolName of ["chrome_wizard_step", "chrome_screenshot_region", "chrome_get_console_logs"]) {
    assert.ok(tools.includes(toolName), `missing plugin tool ${toolName}`);
  }

  assert.match(
    plugin.tool.chrome_wizard_step.description,
    /click.*wait.*screenshot|click\s*\+\s*wait/su,
    "chrome_wizard_step description should describe a click + wait + screenshot pipeline"
  );
  assert.match(
    plugin.tool.chrome_screenshot_region.description,
    /rectangular|region|rectangle/iu,
    "chrome_screenshot_region description should mention a region or rectangle"
  );
  assert.match(
    plugin.tool.chrome_get_console_logs.description,
    /console|exception|network log/iu,
    "chrome_get_console_logs description should mention console, exceptions, or network log"
  );
});

test("OpenCode plugin exposes bounded tab context and combined page reading tools", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  for (const toolName of ["chrome_tab_context", "chrome_read_page"]) {
    assert.ok(plugin.tool[toolName], `${toolName} tool missing`);
    assert.match(plugin.tool[toolName].description, /page|context/iu);
  }
  assert.match(plugin.tool.chrome_tab_context.description, /selection|visible text/iu);
  assert.match(plugin.tool.chrome_read_page.description, /accessibility|screenshot/iu);

  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(source, /chrome_tab_context[\s\S]{0,3000}maxChars[\s\S]{0,1000}outputDirectory/u);
  assert.match(source, /chrome_read_page[\s\S]{0,4000}includeScreenshot[\s\S]{0,1500}outputDirectory/u);
  assert.match(source, /bridgeCommand\("tabContext"/u);
  assert.match(source, /bridgeCommand\("readPage"/u);
});

test("OpenCode plugin exposes ranked page finding with an explicit capability", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  assert.ok(plugin.tool.chrome_find, "chrome_find tool missing");
  assert.match(plugin.tool.chrome_find.description, /rank|find|element/iu);
  assert.deepEqual(
    [...TOOL_CAPABILITY_REQUIREMENTS.chrome_find],
    ["bridge.handshake", "browser.find", "browser.tabs"]
  );

  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(source, /bridgeCommand\("findElements"/u);
  assert.match(source, /chrome_find[\s\S]{0,2500}interactiveOnly[\s\S]{0,1000}visibleOnly/u);
});

test("OpenCode plugin exposes one typed deterministic wait tool and capability", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  assert.ok(plugin.tool.chrome_wait_for, "chrome_wait_for tool missing");
  assert.match(plugin.tool.chrome_wait_for.description, /wait|condition/iu);
  assert.deepEqual(
    [...TOOL_CAPABILITY_REQUIREMENTS.chrome_wait_for],
    ["bridge.handshake", "browser.cdp", "browser.downloads", "browser.tabs", "browser.wait"]
  );
  assert.equal(typeof pluginModule.requiredCapabilitiesForTool, "function");
  assert.deepEqual(
    pluginModule.requiredCapabilitiesForTool("chrome_wait_for", { condition: { type: "download" } }),
    ["bridge.handshake", "browser.downloads", "browser.wait"]
  );
  assert.deepEqual(
    pluginModule.requiredCapabilitiesForTool("chrome_wait_for", { condition: { type: "networkIdle" } }),
    ["bridge.handshake", "browser.cdp", "browser.tabs", "browser.wait"]
  );
  assert.deepEqual(
    pluginModule.requiredCapabilitiesForTool("chrome_wait_for", { condition: { type: "text" } }),
    ["bridge.handshake", "browser.tabs", "browser.wait"]
  );

  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(source, /bridgeCommand\("waitFor"/u);
  for (const type of ["url", "navigation", "text", "ref", "selector", "networkIdle", "download"]) {
    assert.match(source, new RegExp(`"${type}"`, "u"), `missing wait condition ${type}`);
  }
});

test("wait condition schemas are strict discriminated unions for every condition type", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const conditionSchema = plugin.tool.chrome_wait_for.args.condition;
  const validConditions = [
    { type: "url", value: "/ready", match: "contains" },
    { type: "navigation" },
    { type: "text", value: "Ready", caseSensitive: false },
    { type: "ref", ref: "e1", visibleOnly: true },
    { type: "selector", selector: "button", visibleOnly: false },
    { type: "networkIdle", idleMs: 500 },
    { type: "download", downloadId: 7 }
  ];
  for (const condition of validConditions) {
    assert.equal(conditionSchema.safeParse(condition).success, true, `valid ${condition.type} condition rejected`);
  }

  const invalidConditions = [
    { type: "url" },
    { type: "navigation", value: "/wrong-field" },
    { type: "text", caseSensitive: false },
    { type: "ref", visibleOnly: true },
    { type: "selector", visibleOnly: true },
    { type: "networkIdle", idleMs: 9 },
    { type: "download" },
    { type: "text", value: "Ready", selector: "button" }
  ];
  for (const condition of invalidConditions) {
    assert.equal(conditionSchema.safeParse(condition).success, false, `invalid ${condition.type} condition accepted`);
  }
});

test("OpenCode plugin exposes one approved typed batch with negotiated action capabilities", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  assert.ok(plugin.tool.chrome_batch, "chrome_batch tool missing");
  assert.match(plugin.tool.chrome_batch.description, /sequential|batch/iu);
  assert.deepEqual(
    [...TOOL_CAPABILITY_REQUIREMENTS.chrome_batch],
    ["bridge.handshake", "browser.batch"]
  );
  assert.deepEqual(
    pluginModule.requiredCapabilitiesForTool("chrome_batch", {
      actions: [
        { type: "getTab", params: { tabId: 7 } },
        { type: "findElements", params: { tabId: 7, query: "Checkout" } },
        { type: "waitFor", params: { tabId: 7, condition: { type: "text", value: "Done" } } }
      ]
    }),
    ["bridge.handshake", "browser.batch", "browser.find", "browser.tabs", "browser.wait"]
  );

  const asks = [];
  await assert.rejects(
    plugin.tool.chrome_batch.execute({
      actions: [
        { type: "getTab", params: { tabId: 7 } },
        { type: "getTab", params: { tabId: 8 } }
      ]
    }, {
      directory: repoRoot,
      ask: async (request) => {
        asks.push(request);
        throw new Error("approval probe");
      }
    }),
    /approval probe/u
  );
  assert.equal(asks.length, 1);
  assert.equal(asks[0].permission, "chrome_batch");
  assert.equal(asks[0].metadata.actionCount, 2);
});

test("chrome_batch publishes a strict bounded allowlist without raw CDP or meta-actions", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  for (const type of [
    "getTab", "activateTab", "navigate", "reload", "back", "forward",
    "tabContext", "findElements", "waitFor", "clickElement", "fillElement"
  ]) {
    assert.match(source, new RegExp(`batchAction[\\s\\S]{0,12000}\"${type}\"`, "u"), `batch schema missing ${type}`);
  }
  assert.match(source, /actions:[\s\S]{0,300}\.min\(1\)\.max\(25\)/u);
  assert.match(source, /totalTimeoutMs:[\s\S]{0,200}\.min\(50\)\.max\(120000\)/u);
  assert.doesNotMatch(source, /batchAction[\s\S]{0,12000}literal\("(?:cdpCommand|browserBatch|workflow|scheduler|meta)"\)/u);
  const actionsSchema = plugin.tool.chrome_batch.args.actions;
  const getTab = (timeoutMs) => [{ type: "getTab", params: { tabId: 7 }, timeoutMs }];
  assert.equal(actionsSchema.safeParse(getTab(50)).success, true);
  assert.equal(actionsSchema.safeParse(getTab(30_000)).success, true);
  assert.equal(actionsSchema.safeParse(getTab(49)).success, false);
  assert.equal(actionsSchema.safeParse(getTab(30_001)).success, false);
});

test("dangerous and private-data tools require user approval before running", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const gatedTools = Object.keys(plugin.tool).filter((name) => name !== "chrome_status");
  for (const name of gatedTools) {
    const tool = plugin.tool[name];
    assert.ok(tool, `missing gated tool ${name}`);
    const asks = [];
    const denyContext = {
      directory: repoRoot,
      ask: async (input) => { asks.push(input); throw new Error("denied by user"); }
    };
    // Denial must short-circuit before any bridge call, so this stays offline-safe.
    await assert.rejects(() => tool.execute({}, denyContext), /denied by user/u, `${name} must ask before running`);
    assert.equal(asks.length, 1, `${name} must call context.ask exactly once`);
    assert.equal(asks[0].permission, name, `${name} must use its own permission key`);
    assert.deepEqual(asks[0].always, [name], `${name} must offer an "always" grant`);
    assert.equal(typeof asks[0].metadata?.action, "string", `${name} must describe the action for the prompt`);
  }
});

test("only the bridge status probe runs without browser-data approval", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  let asked = false;
  const context = { directory: repoRoot, ask: async () => { asked = true; } };
  await plugin.tool.chrome_status.execute({}, context).catch(() => {});
  assert.equal(asked, false);
});

test("approved browser tools preflight negotiated capabilities before execution", async () => {
  const source = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");

  assert.match(source, /requireBridgeCapabilities/u);
  assert.match(source, /requiredCapabilitiesForTool\(name, args\)/u);
  assert.match(source, /await context\.ask[\s\S]*await requireBridgeCapabilities/u);
});

test("approval gate fails closed when the host runtime lacks context.ask", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  await assert.rejects(
    plugin.tool.chrome_history.execute({ query: "x" }, { directory: repoRoot }),
    /requires an OpenCode runtime with permission prompts/u
  );
});

test("background implements screenshotRegion with CDP Page.captureScreenshot and captureBeyondViewport", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /case "screenshotRegion"/u, "missing screenshotRegion command");
  assert.match(background, /Page\.captureScreenshot/u, "screenshotRegion must use CDP Page.captureScreenshot");
  assert.match(background, /captureBeyondViewport/u, "screenshotRegion must capture beyond the viewport");
  assert.match(background, /clip:\s*\{[^}]*x[^}]*y[^}]*width[^}]*height/u, "screenshotRegion must pass a clip with x, y, width, height");
});

test("background implements getConsoleLogs with a per-tab buffer and persistent debugger", async () => {
  const background = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

  assert.match(background, /case "getConsoleLogs"/u, "missing getConsoleLogs command");
  assert.match(background, /consoleLogBuffers/u, "missing consoleLogBuffers state map");
  assert.match(background, /consoleLogAttached/u, "missing consoleLogAttached set");
  assert.match(background, /CONSOLE_LOG_METHODS/u, "missing CONSOLE_LOG_METHODS constant");
  assert.match(background, /enableCdpDomains/u, "ensureConsoleLogDebugger must enable CDP domains");
  assert.match(background, /"Console", "Log", "Runtime"/u, "ensureConsoleLogDebugger must enable Console, Log, and Runtime domains");
  assert.match(background, /appendConsoleLog/u, "missing appendConsoleLog helper");
  assert.match(background, /normalizeConsoleLog/u, "missing normalizeConsoleLog helper");
});

test("OpenCode plugin chrome_wizard_step accepts optional eval and screenshotPath", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();

  const wizard = plugin.tool.chrome_wizard_step;
  assert.ok(wizard, "chrome_wizard_step tool missing");
  const argsSource = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(argsSource, /chrome_wizard_step[\s\S]{0,4000}expression[\s\S]{0,200}screenshotPath/u, "chrome_wizard_step must expose expression and screenshotPath args");
});

test("plugin loader resolves @opencode-ai/plugin from the pinned local dependency", async () => {
  const plugin = await readFile(path.join(repoRoot, "src", "opencode-plugin.js"), "utf8");
  assert.match(plugin, /import\.meta\.resolve\("@opencode-ai\/plugin"\)/u, "must resolve from pinned local dependency");
  assert.doesNotMatch(plugin, /node_modules.*@opencode-ai.*plugin/u, "must not fall back to unverified paths outside node_modules");
});

test("installed native host manifest uses an absolute Node launcher wrapper for Chrome GUI", async (t) => {
  const { manifestPath, launcherPath, runtimeMetadataPath } = nativeHostLayout({ platform: process.platform, homeDir: os.homedir() });
  try {
    await access(manifestPath);
  } catch {
    t.skip("native host manifest not installed on this machine");
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.path, launcherPath);
  assert.doesNotMatch(manifest.path, /\.mjs$/u);

  const launcher = await readFile(manifest.path, "utf8");
  const runtimeMetadata = JSON.parse(await readFile(runtimeMetadataPath, "utf8"));
  assert.equal(path.isAbsolute(runtimeMetadata.nodePath), true);
  assert.equal(isSupportedNodeVersion(runtimeMetadata.nodeVersion), true);
  assert.equal(launcher, createLauncher({
    platform: process.platform,
    nodePath: runtimeMetadata.nodePath,
    hostPath: runtimeMetadata.hostPath
  }));
  assert.match(launcher, /native-host[\\/]opencode-chrome-native-host\.mjs/u);
});
