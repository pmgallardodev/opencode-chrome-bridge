import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";

const repoRoot = path.resolve(import.meta.dirname, "..");
const previousStateDir = process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
const stateDir = await mkdtemp(path.join(os.tmpdir(), "opencode-handshake-test-"));
process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = stateDir;
await writeFile(path.join(stateDir, "state.json"), JSON.stringify({
  host: "127.0.0.1",
  port: 31337,
  token: "a".repeat(32)
}), { mode: 0o600 });
const bridgeClient = await import("../src/bridge-client.js");
const pluginModule = await import("../src/opencode-plugin.js");
const { requireBridgeCapabilities, validateBridgeStatus } = bridgeClient;
const OpenCodeChromeBridgePlugin = pluginModule.default;
const TOOL_CAPABILITY_REQUIREMENTS = pluginModule.TOOL_CAPABILITY_REQUIREMENTS;

after(async () => {
  if (previousStateDir === undefined) delete process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
  else process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const caps = (...capabilities) => ["bridge.handshake", ...capabilities].sort();
const EXPECTED_TOOL_CAPABILITIES = {
  chrome_accessibility_tree: caps("browser.accessibility", "browser.tabs"),
  chrome_activate_tab: caps("browser.tabs", "browser.windows"),
  chrome_back: caps("browser.navigation", "browser.tabs"),
  chrome_blocked_urls: caps("browser.navigation"),
  chrome_bookmarks: caps("browser.bookmarks"),
  chrome_cdp: caps("browser.cdp"),
  chrome_cdp_targets: caps("browser.cdp"),
  chrome_claim_tab: caps("browser.tabs", "session.tab-leases"),
  chrome_click: caps("browser.cdp", "browser.tabs"),
  chrome_click_element: caps("browser.accessibility", "browser.cdp", "browser.tabs"),
  chrome_close_tab: caps("browser.tabs"),
  chrome_cursor_state: caps("browser.tabs"),
  chrome_dom_content: caps("browser.cdp", "browser.tabs"),
  chrome_double_click: caps("browser.cdp", "browser.tabs"),
  chrome_download_cancel: caps("browser.downloads"),
  chrome_download_pause: caps("browser.downloads"),
  chrome_download_resume: caps("browser.downloads"),
  chrome_download_show: caps("browser.downloads"),
  chrome_downloads_list: caps("browser.downloads"),
  chrome_drag: caps("browser.cdp", "browser.tabs"),
  chrome_end_turn: caps("browser.cdp", "browser.tabs", "session.tab-leases"),
  chrome_evaluate: caps("browser.cdp", "browser.tabs"),
  chrome_events: caps("browser.events"),
  chrome_favicon_badge: caps("browser.tabs"),
  chrome_fill_element: caps("browser.accessibility", "browser.cdp", "browser.tabs"),
  chrome_finalize_tabs: caps("browser.cdp", "browser.tabs", "session.tab-leases"),
  chrome_forward: caps("browser.navigation", "browser.tabs"),
  chrome_get_console_logs: caps("browser.cdp", "browser.console", "browser.tabs"),
  chrome_get_tab: caps("browser.tabs"),
  chrome_get_window_state: caps("browser.windows"),
  chrome_group_tabs: caps("browser.tab-groups", "browser.tabs"),
  chrome_history: caps("browser.history"),
  chrome_hover: caps("browser.cdp", "browser.tabs"),
  chrome_keypress: caps("browser.cdp", "browser.tabs"),
  chrome_move: caps("browser.cdp", "browser.tabs"),
  chrome_open: caps("browser.navigation", "browser.tabs", "session.tab-leases"),
  chrome_open_window: caps("browser.navigation", "browser.tabs", "browser.windows", "session.tab-leases"),
  chrome_page_text: caps("browser.cdp", "browser.tabs"),
  chrome_release_debuggers: caps("browser.cdp"),
  chrome_reload: caps("browser.navigation", "browser.tabs"),
  chrome_reset_viewport: caps("browser.cdp", "browser.tabs"),
  chrome_screenshot: caps("browser.screenshots", "browser.tabs", "browser.windows"),
  chrome_screenshot_region: caps("browser.cdp", "browser.screenshots", "browser.tabs", "browser.windows"),
  chrome_scroll: caps("browser.cdp", "browser.tabs"),
  chrome_set_viewport: caps("browser.cdp", "browser.tabs"),
  chrome_set_window_state: caps("browser.windows"),
  chrome_subscribe_cdp: caps("browser.cdp", "browser.events", "browser.tabs"),
  chrome_tab_group_create: caps("browser.tab-groups", "browser.tabs"),
  chrome_tab_group_update: caps("browser.tab-groups", "browser.tabs"),
  chrome_tab_groups: caps("browser.tab-groups", "browser.tabs"),
  chrome_tabs: caps("browser.tabs"),
  chrome_type: caps("browser.cdp", "browser.tabs"),
  chrome_ungroup_tabs: caps("browser.tab-groups", "browser.tabs"),
  chrome_unsubscribe_cdp: caps("browser.cdp", "browser.events", "browser.tabs"),
  chrome_wizard_step: caps("browser.cdp", "browser.screenshots", "browser.tabs", "browser.windows")
};

function compatibleStatus(overrides = {}) {
  return {
    ok: true,
    connected: true,
    compatible: true,
    host: {
      name: "com.opencode.chrome_bridge",
      version: "1.1.0",
      protocolMin: "1.0.0",
      protocolMax: "1.0.0"
    },
    client: {
      name: "opencode-plugin",
      version: "1.1.0",
      protocolMin: "1.0.0",
      protocolMax: "1.0.0"
    },
    extension: {
      extensionId: "extension-id",
      extensionVersion: "1.1.0",
      hostName: "com.opencode.chrome_bridge",
      protocolVersion: "1.0.0",
      capabilities: ["bridge.handshake", "browser.tabs"]
    },
    missingCapabilities: [],
    diagnostics: [],
    ...overrides
  };
}

test("bridge status schema accepts supported ranges and capabilities", () => {
  const status = validateBridgeStatus(compatibleStatus());

  assert.equal(status.compatible, true);
  assert.deepEqual(status.extension.capabilities, ["bridge.handshake", "browser.tabs"]);
});

test("bridge status schema rejects malformed protocol versions", () => {
  const malformed = compatibleStatus({
    extension: {
      ...compatibleStatus().extension,
      protocolVersion: "latest"
    }
  });

  assert.throws(() => validateBridgeStatus(malformed), /extension protocol version/u);
});

test("bridge status compatibility requires an empty diagnostics list", async () => {
  const contradictory = compatibleStatus({
    diagnostics: [{
      code: "CLIENT_VERSION_INVALID",
      message: "The client version is invalid.",
      repair: "Update the OpenCode plugin."
    }]
  });

  assert.throws(
    () => validateBridgeStatus(contradictory),
    /compatibility.*diagnostics|diagnostics.*compatibility/iu
  );
  await assert.rejects(
    () => requireBridgeCapabilities(["browser.tabs"], contradictory),
    /compatibility.*diagnostics|diagnostics.*compatibility/iu
  );
  assert.throws(
    () => validateBridgeStatus(compatibleStatus({ compatible: false })),
    /compatibility is inconsistent/iu
  );
});

test("required capabilities fail with sorted actionable names", async () => {
  const status = compatibleStatus({
    compatible: false,
    missingCapabilities: ["browser.windows", "browser.downloads"],
    diagnostics: [{
      code: "MISSING_CAPABILITIES",
      message: "The extension is missing required capabilities.",
      repair: "Reload the current extension build."
    }]
  });

  await assert.rejects(
    () => requireBridgeCapabilities(["browser.windows", "browser.downloads"], status),
    /browser\.downloads, browser\.windows.*Reload the current extension build\./su
  );
});

test("disconnected and incompatible extensions produce different failures", async () => {
  const disconnected = compatibleStatus({
    connected: false,
    compatible: false,
    extension: null,
    diagnostics: [{
      code: "EXTENSION_DISCONNECTED",
      message: "The Chrome extension is not connected.",
      repair: "Reload Chrome or reinstall the native host."
    }]
  });
  const incompatible = compatibleStatus({
    compatible: false,
    extension: {
      ...compatibleStatus().extension,
      protocolVersion: "2.0.0"
    },
    diagnostics: [{
      code: "PROTOCOL_INCOMPATIBLE",
      message: "The extension protocol is outside the supported range.",
      repair: "Update the extension and native host together."
    }]
  });

  await assert.rejects(
    () => requireBridgeCapabilities(["bridge.handshake"], disconnected),
    /not connected.*Reload Chrome/su
  );
  await assert.rejects(
    () => requireBridgeCapabilities(["bridge.handshake"], incompatible),
    /incompatible.*Update the extension and native host together/su
  );
});

test("popup renders compatibility diagnostics returned by the service worker", async () => {
  const source = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");
  const elements = new Map();
  for (const id of ["status", "statusText", "statusDetail", "version", "learnMore", "settingsButton", "copyrightLink"]) {
    elements.set(id, {
      classList: { toggle() {} },
      addEventListener() {},
      textContent: ""
    });
  }
  const response = compatibleStatus({
    compatible: false,
    diagnostics: [{
      code: "PROTOCOL_INCOMPATIBLE",
      message: "Protocol 2.0.0 is not supported.",
      repair: "Update the native host."
    }]
  });
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.1.0" }),
        sendMessage: async () => response
      },
      tabs: { create() {} }
    },
    document: { getElementById: (id) => elements.get(id) ?? null },
    globalThis: null,
    open() {},
    setTimeout() {}
  });
  context.globalThis = context;

  vm.runInContext(source, context, { filename: "extension/popup.js" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("statusText").textContent, "Update required");
  assert.equal(
    elements.get("statusDetail").textContent,
    "Protocol 2.0.0 is not supported. Update the native host."
  );
});

test("every public browser tool has an explicit exhaustive capability declaration", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const publicTools = Object.keys(plugin.tool).filter((name) => name !== "chrome_status").sort();

  assert.deepEqual(Object.keys(TOOL_CAPABILITY_REQUIREMENTS ?? {}).sort(), publicTools);
  assert.deepEqual(TOOL_CAPABILITY_REQUIREMENTS, EXPECTED_TOOL_CAPABILITIES);
});

test("every browser tool fails before execution when its negotiated capability is missing", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const statusWithoutToolCapabilities = compatibleStatus({
    extension: {
      ...compatibleStatus().extension,
      capabilities: ["bridge.handshake"]
    }
  });
  const originalFetch = globalThis.fetch;
  let statusRequests = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.method, "GET", "preflight must query status before a browser command");
    statusRequests += 1;
    return new Response(JSON.stringify(statusWithoutToolCapabilities), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  };
  try {
    for (const [name, required] of Object.entries(EXPECTED_TOOL_CAPABILITIES)) {
      let asked = 0;
      await assert.rejects(
        () => plugin.tool[name].execute({}, {
          ask: async () => { asked += 1; },
          directory: repoRoot
        }),
        (error) => {
          const missing = required.filter((capability) => capability !== "bridge.handshake");
          assert.match(error.message, /Missing capabilities:/u, name);
          for (const capability of missing) assert.match(error.message, new RegExp(capability.replaceAll(".", "\\."), "u"), name);
          return true;
        },
        name
      );
      assert.equal(asked, 1, `${name} must ask exactly once before capability preflight`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(statusRequests, Object.keys(EXPECTED_TOOL_CAPABILITIES).length);
});
