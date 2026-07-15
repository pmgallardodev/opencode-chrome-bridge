import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousStateDir = process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
const stateDir = await mkdtemp(path.join(os.tmpdir(), "opencode-origin-permissions-"));
process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = stateDir;
await writeFile(path.join(stateDir, "state.json"), JSON.stringify({
  host: "127.0.0.1",
  port: 31337,
  token: "a".repeat(32)
}), { mode: 0o600 });

const pluginModule = await import("../src/opencode-plugin.js");
const OpenCodeChromeBridgePlugin = pluginModule.default;

after(async () => {
  if (previousStateDir === undefined) delete process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
  else process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

function compatibleStatus() {
  return {
    ok: true,
    connected: true,
    compatible: true,
    hostReachable: true,
    legacy: false,
    host: { name: "com.opencode.chrome_bridge", version: "1.2.0", protocolMin: "1.0.0", protocolMax: "1.0.0" },
    client: { name: "opencode-plugin", version: "1.2.0", protocolMin: "1.0.0", protocolMax: "1.0.0" },
    extension: {
      extensionId: "extension-id", extensionName: "opencode-chrome-bridge", extensionVersion: "1.2.0", protocolVersion: "1.0.0",
      hostName: "com.opencode.chrome_bridge",
      capabilities: pluginModule.ALL_TOOL_REQUIRED_CAPABILITIES
    },
    missingCapabilities: [],
    diagnostics: []
  };
}

function installBridge(respond) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "GET") {
      return new Response(JSON.stringify(compatibleStatus()), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const request = JSON.parse(options.body);
    const command = request.method === "scopedCommand"
      ? { ...request.params, scoped: true }
      : request;
    calls.push(command);
    const result = await respond(command, calls);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function context(asks, sessionID = "session-a") {
  return {
    directory: path.resolve(import.meta.dirname, ".."),
    sessionID,
    ask: async (request) => { asks.push(request); }
  };
}

test("canonical page scopes include effective ports and normalized IDN paths", () => {
  assert.equal(
    pluginModule.canonicalPageScope("HTTPS://B\u00dcCHER.example:443/a/../caf%C3%A9/%7euser?token=x#part"),
    "https://xn--bcher-kva.example:443/caf%C3%A9/~user"
  );
  assert.equal(pluginModule.canonicalPageScope("http://Example.COM"), "http://example.com:80/");
  assert.equal(pluginModule.canonicalPageScope("https://example.com:444/a"), "https://example.com:444/a");
  assert.equal(pluginModule.canonicalPageScope("https://example.com/app/"), "https://example.com:443/app/");
  assert.throws(() => pluginModule.canonicalPageScope("file:///tmp/private"), /http.*https/iu);
  for (const ambiguous of [
    "https://example.com/app/..%2Fadmin",
    "https://example.com/app/..%5Cadmin",
    "https://example.com/app/%252e%252e%252fadmin"
  ]) {
    assert.throws(() => pluginModule.canonicalPageScope(ambiguous), /ambiguous|encoded|separator|traversal/iu);
  }
});

test("path grants honor segment boundaries and never cross scheme or port", () => {
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app", "https://example.com:443/app"), true);
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app", "https://example.com:443/app/orders"), true);
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app/", "https://example.com:443/app/orders"), true);
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app", "https://example.com:443/apple"), false);
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app", "http://example.com:80/app"), false);
  assert.equal(pluginModule.pageScopeCovers("https://example.com:443/app", "https://example.com:444/app"), false);
});

test("open asks for its normalized destination and exposes the same scope as an always rule", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "createTab") return { id: 9, url: params.url };
    assert.equal(method, "getTab");
    return { id: 9, url: "https://xn--bcher-kva.example/checkout" };
  });
  try {
    await plugin.tool.chrome_open.execute({ url: "https://B\u00dcCHER.example/shop/../checkout" }, context(asks));
  } finally {
    bridge.restore();
  }
  assert.equal(asks[0].permission, "chrome_open");
  assert.deepEqual(asks[1].patterns, ["https://xn--bcher-kva.example:443/checkout"]);
  assert.deepEqual(asks[1].always, ["https://xn--bcher-kva.example:443/checkout"]);
  assert.deepEqual(bridge.calls.map((entry) => entry.method), ["createTab", "getTab"]);
});

test("tab reads resolve minimal metadata after the tool prompt and re-prompt after a redirect", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  let metadataReads = 0;
  const bridge = installBridge(({ method }) => {
    if (method === "getTab") {
      metadataReads += 1;
      return { id: 7, url: metadataReads === 1 ? "https://example.com/app" : "https://login.example.com/callback" };
    }
    assert.equal(method, "pageText");
    return { text: "redirected", url: "https://intermediate.example.org/continue" };
  });
  try {
    await plugin.tool.chrome_page_text.execute({ tabId: 7, maxChars: 100 }, context(asks));
  } finally {
    bridge.restore();
  }
  assert.deepEqual(asks.map((entry) => entry.permission), ["chrome_page_text", "browser.origin", "browser.origin"]);
  assert.deepEqual(asks[1].patterns, ["https://example.com:443/app"]);
  assert.deepEqual(asks[2].patterns, [
    "https://intermediate.example.org:443/continue",
    "https://login.example.com:443/callback"
  ]);
  assert.deepEqual(bridge.calls.map((entry) => entry.method), ["getTab", "pageText", "getTab"]);
});

test("new-tab redirects are re-evaluated before returning page metadata", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "createTab") return { id: 12, url: params.url };
    if (method === "getTab") return { id: 12, url: "https://accounts.example.net/login" };
    throw new Error(`unexpected ${method}`);
  });
  try {
    await plugin.tool.chrome_open.execute({ url: "https://example.com/app" }, context(asks));
  } finally {
    bridge.restore();
  }
  assert.deepEqual(
    asks.filter((entry) => entry.permission === "browser.origin").map((entry) => entry.patterns),
    [["https://example.com:443/app"], ["https://accounts.example.net:443/login"]]
  );
});

test("explicit session grants are cached only inside their context sessionID", async () => {
  pluginModule.clearPageOriginSessionGrants();
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method }) => method === "getTab"
    ? { id: 7, url: "https://example.com/app" }
    : { text: "ok" });
  try {
    const args = { tabId: 7, maxChars: 100, originGrant: "session" };
    await plugin.tool.chrome_page_text.execute(args, context(asks, "session-a"));
    await plugin.tool.chrome_page_text.execute(args, context(asks, "session-a"));
    await plugin.tool.chrome_page_text.execute(args, context(asks, "session-b"));
  } finally {
    bridge.restore();
  }
  assert.equal(asks.filter((entry) => entry.permission === "chrome_page_text").length, 3);
  assert.equal(asks.filter((entry) => entry.permission === "browser.origin").length, 2);
});

test("session grants fail closed without an explicit context sessionID", async () => {
  pluginModule.clearPageOriginSessionGrants();
  const plugin = await OpenCodeChromeBridgePlugin();
  const bridge = installBridge(({ method }) => method === "getTab"
    ? { id: 7, url: "https://example.com/app" }
    : { text: "must not run" });
  try {
    await assert.rejects(() => plugin.tool.chrome_page_text.execute({
      tabId: 7,
      maxChars: 100,
      originGrant: "session"
    }, { directory: path.resolve(import.meta.dirname, ".."), ask: async () => {} }), /context\.sessionID/u);
  } finally {
    bridge.restore();
  }
  assert.deepEqual(bridge.calls.map((entry) => entry.method), ["getTab"]);
});

test("raw CDP rejects browser-wide Target methods before dispatch", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const bridge = installBridge(({ method }) => method === "getTab"
    ? { id: 7, url: "https://example.com/app" }
    : (() => { throw new Error("raw CDP must not dispatch"); })());
  try {
    await assert.rejects(() => plugin.tool.chrome_cdp.execute({
      tabId: 7,
      method: "Target.getTargets"
    }, context([])), /Target.*dedicated|browser-wide|not allowed/iu);
  } finally {
    bridge.restore();
  }
  assert.equal(bridge.calls.some((entry) => entry.method === "cdpCommand"), false);
});

test("raw CDP allowlist rejects global storage, cookie, and browser domains", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  for (const method of [
    "Storage.getCookies", "Storage.clearDataForOrigin", "Network.getAllCookies",
    "Network.setCookie", "Browser.getVersion", "Security.enable", "SystemInfo.getInfo"
  ]) {
    const bridge = installBridge(({ method: bridgeMethod }) => bridgeMethod === "getTab"
      ? { id: 7, url: "https://example.com/app" }
      : (() => { throw new Error("forbidden CDP dispatched"); })());
    try {
      await assert.rejects(() => plugin.tool.chrome_cdp.execute({ tabId: 7, method }, context([])), /CDP method.*not allowed|dedicated/iu, method);
    } finally {
      bridge.restore();
    }
    assert.equal(bridge.calls.some((entry) => entry.method === "cdpCommand"), false, method);
  }
});

test("batch preflights a deduplicated origin union once before its first side effect", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "getTab") return { id: params.tabId, url: "https://example.com/app" };
    if (method === "browserBatch") {
      const action = params.actions[0];
      return { results: [{ index: 0, ok: true, result: { id: action.params.tabId, url: action.params.url ?? "https://example.com/app" }, type: action.type }] };
    }
    throw new Error(`unexpected ${method}`);
  });
  try {
    await plugin.tool.chrome_batch.execute({
      actions: [
        { type: "getTab", params: { tabId: 7 } },
        { type: "findElements", params: { tabId: 7, query: "Pay" } },
        { type: "navigate", params: { tabId: 7, url: "https://example.com/checkout" } },
        { type: "navigate", params: { tabId: 8, url: "https://example.com/checkout" } }
      ]
    }, context(asks));
  } finally {
    bridge.restore();
  }
  assert.equal(asks.filter((entry) => entry.permission === "browser.origin").length, 1);
  assert.deepEqual(asks[1].patterns, [
    "https://example.com:443/app",
    "https://example.com:443/checkout"
  ]);
  assert.equal(bridge.calls.filter((entry) => entry.method === "browserBatch").length, 4);
  assert.ok(
    bridge.calls.findIndex((entry) => entry.method === "browserBatch")
      > bridge.calls.findIndex((entry) => entry.method === "getTab"),
    "browserBatch must run only after minimal tab metadata preflight"
  );
});

test("batch origin denial fails before browserBatch and before any page side effect", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const calls = [];
  const bridge = installBridge(({ method, params }) => {
    calls.push(method);
    if (method === "getTab") return { id: params.tabId, url: "https://example.com/app" };
    throw new Error("side effect must not run");
  });
  const denyContext = context([]);
  denyContext.ask = async (request) => {
    if (request.permission === "browser.origin") throw new Error("origin denied");
  };
  try {
    await assert.rejects(() => plugin.tool.chrome_batch.execute({
      actions: [
        { type: "clickElement", params: { tabId: 7, ref: "e1" } },
        { type: "navigate", params: { tabId: 7, url: "https://example.com/checkout" } }
      ]
    }, denyContext), /origin denied/u);
  } finally {
    bridge.restore();
  }
  assert.deepEqual(calls, ["getTab"]);
});

test("batch navigation redirect requires the new scope before the following click", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  let navigated = false;
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "getTab") return { id: 7, url: navigated ? "https://redirect.example/landing" : "https://example.com/start" };
    if (method === "browserBatch") {
      const type = params.actions[0].type;
      if (type === "navigate") {
        navigated = true;
        return { results: [{ index: 0, ok: true, result: { id: 7, url: "https://redirect.example/landing" }, type }] };
      }
      throw new Error("click must not run before redirect approval");
    }
    throw new Error(`unexpected ${method}`);
  });
  const denyRedirect = context(asks);
  denyRedirect.ask = async (request) => {
    asks.push(request);
    if (request.permission === "browser.origin" && request.patterns.includes("https://redirect.example:443/landing")) {
      throw new Error("redirect denied");
    }
  };
  try {
    await assert.rejects(() => plugin.tool.chrome_batch.execute({
      actions: [
        { type: "navigate", params: { tabId: 7, url: "https://example.com/next" } },
        { type: "clickElement", params: { tabId: 7, ref: "e1" } },
        { type: "fillElement", params: { tabId: 7, ref: "e2", text: "must-not-run" } }
      ],
      stopOnError: false
    }, denyRedirect), /redirect denied/u);
  } finally {
    bridge.restore();
  }
  assert.equal(bridge.calls.filter((entry) => entry.method === "browserBatch").length, 1);
});

test("batch rechecks its total timeout after a slow origin approval", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const bridge = installBridge(({ method }) => method === "getTab"
    ? { id: 7, url: "https://example.com/app" }
    : (() => { throw new Error("expired batch action executed"); })());
  const slow = context([]);
  slow.ask = async (request) => {
    if (request.permission === "browser.origin") await new Promise((resolve) => setTimeout(resolve, 70));
  };
  try {
    const output = JSON.parse(await plugin.tool.chrome_batch.execute({
      actions: [{ type: "clickElement", params: { tabId: 7, ref: "e1" } }],
      totalTimeoutMs: 50
    }, slow));
    assert.equal(output.ok, false);
    assert.match(output.results[0].error, /total timeout/iu);
  } finally {
    bridge.restore();
  }
  assert.equal(bridge.calls.some((entry) => entry.method === "browserBatch"), false);
});

test("batch stopOnError false continues after an action-specific failure", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  let batches = 0;
  const bridge = installBridge(({ method, params }) => {
    if (method === "getTab") return { id: params.tabId, url: "https://example.com/app" };
    if (method === "browserBatch") {
      batches += 1;
      const action = params.actions[0];
      return { results: [{ index: 0, ok: batches > 1, error: batches === 1 ? "first failed" : undefined, result: {}, type: action.type }] };
    }
    throw new Error(`unexpected ${method}`);
  });
  try {
    const output = JSON.parse(await plugin.tool.chrome_batch.execute({
      actions: [
        { type: "clickElement", params: { tabId: 7, ref: "e1" } },
        { type: "fillElement", params: { tabId: 8, ref: "e2", text: "ok" } }
      ],
      stopOnError: false
    }, context([])));
    assert.deepEqual(output.results.map((entry) => [entry.index, entry.ok]), [[0, false], [1, true]]);
  } finally {
    bridge.restore();
  }
});

test("internal tabs and targets are filtered before tool output", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method }) => {
    if (method === "listTabs") return [
      { id: 1, title: "Settings", url: "chrome://settings" },
      { id: 2, title: "Public", url: "https://example.com/app" }
    ];
    throw new Error(`unexpected ${method}`);
  });
  try {
    const tabs = JSON.parse(await plugin.tool.chrome_tabs.execute({}, context(asks)));
    assert.deepEqual(tabs.map((tab) => tab.id), [2]);
  } finally {
    bridge.restore();
  }
});

test("screenshot without tabId binds approval and capture to the actual active tab", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "getActiveTab" || method === "getTab") return { active: true, id: 42, url: "https://example.com/capture" };
    if (method === "screenshot") {
      assert.equal(params.tabId, 42);
      return { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    }
    throw new Error(`unexpected ${method}`);
  });
  const outputPath = "capture.png";
  const screenshotContext = context(asks);
  screenshotContext.directory = stateDir;
  try {
    await plugin.tool.chrome_screenshot.execute({ outputPath, format: "png" }, screenshotContext);
  } finally {
    bridge.restore();
    await rm(path.join(stateDir, outputPath), { force: true });
  }
  assert.deepEqual(asks[1].patterns, ["https://example.com:443/capture"]);
});

test("wizard stops after a click changes scope before eval or screenshot", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const wizardContext = context([]);
  wizardContext.ask = async (request) => {
    if (request.permission === "browser.origin" && request.patterns.includes("https://redirect.example:443/next")) {
      throw new Error("redirect denied");
    }
  };
  const bridge = installBridge(({ method }) => {
    if (method === "getTab") return { id: 7, url: "https://example.com/start" };
    if (method === "click") throw new Error("Page scope changed or is not authorized: https://redirect.example:443/next");
    throw new Error(`${method} must not run after the click transition`);
  });
  try {
    await assert.rejects(() => plugin.tool.chrome_wizard_step.execute({
      tabId: 7,
      x: 10,
      y: 10,
      expression: "document.title",
      screenshotPath: path.join(stateDir, "wizard.png")
    }, wizardContext), /redirect denied/iu);
  } finally {
    bridge.restore();
  }
  assert.equal(bridge.calls.some((entry) => entry.method === "evaluate" || entry.method === "screenshot"), false);
});

test("wizard can continue under the newly approved redirect scope without clicking twice", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  let tabReads = 0;
  const bridge = installBridge(({ method }) => {
    if (method === "getTab") {
      tabReads += 1;
      return { id: 7, url: tabReads === 1 ? "https://example.com/start" : "https://redirect.example/next" };
    }
    if (method === "click") throw new Error("Page scope changed or is not authorized: https://redirect.example:443/next");
    if (method === "evaluate") return "continued";
    throw new Error(`unexpected ${method}`);
  });
  try {
    const output = JSON.parse(await plugin.tool.chrome_wizard_step.execute({
      tabId: 7,
      x: 10,
      y: 10,
      waitMs: 0,
      expression: "document.title"
    }, context([])));
    assert.equal(output.evaluation, "continued");
  } finally {
    bridge.restore();
  }
  assert.equal(bridge.calls.filter((entry) => entry.method === "click").length, 1);
});

test("scope race rejects combined page data before any workspace artifact is written", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const outputDirectory = path.join(stateDir, "race-artifacts");
  const bridge = installBridge(({ method }) => {
    if (method === "getTab") return { id: 7, url: "https://example.com/start" };
    if (method === "readPage") throw new Error("Page scope changed or is not authorized: https://other.example:443/private");
    throw new Error(`unexpected ${method}`);
  });
  try {
    await assert.rejects(() => plugin.tool.chrome_read_page.execute({
      tabId: 7,
      includeScreenshot: true,
      outputDirectory,
      saveText: true
    }, context([])), /scope changed/iu);
    await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(outputDirectory)));
  } finally {
    bridge.restore();
  }
});

test("CDP target listing filters internal and devtools targets", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const bridge = installBridge(({ method }) => {
    if (method === "cdpTargets") return [
      { id: "internal", title: "DevTools", url: "devtools://devtools/bundled" },
      { id: "web", title: "Web", url: "https://example.com/app" }
    ];
    throw new Error(`unexpected ${method}`);
  });
  try {
    const targets = JSON.parse(await plugin.tool.chrome_cdp_targets.execute({}, context([])));
    assert.deepEqual(targets.map((target) => target.id), ["web"]);
  } finally {
    bridge.restore();
  }
});

test("every public tool has an explicit page or browser origin classification", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const publicNames = Object.keys(plugin.tool).filter((name) => name !== "chrome_status").sort();
  assert.deepEqual(Object.keys(pluginModule.TOOL_ORIGIN_SCOPE_CLASSIFICATION).sort(), publicNames);
  assert.equal(pluginModule.TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_cursor_state, "page");
  assert.equal(pluginModule.TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_favicon_badge, "page");
  assert.equal(pluginModule.TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_events, "page");
  assert.equal(pluginModule.TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_history, "browser");
});

test("origin-bearing events drop internal page metadata before exposure", () => {
  const sanitized = pluginModule.sanitizeOriginBearingEvents({
    events: [
      { seq: 1, event: { tab: { title: "Settings", url: "chrome://settings" } } },
      { seq: 2, event: { tab: { title: "Web", url: "https://example.com/app" } } }
    ],
    nextSeq: 3
  });
  assert.deepEqual(sanitized.events.map((entry) => entry.seq), [2]);
});

test("CDP events without capture-time page provenance never expose params", () => {
  const sanitized = pluginModule.sanitizeOriginBearingEvents({
    events: [
      { seq: 1, event: { category: "cdp", method: "Runtime.consoleAPICalled", params: { args: [{ value: "secret-B" }], executionContextId: 12 } } },
      { seq: 2, event: { category: "cdp", method: "Runtime.consoleAPICalled", pageScope: "https://a.example:443/", navigationGeneration: 3, params: { args: [{ value: "allowed-A" }] } } }
    ]
  });
  assert.equal(sanitized.events.length, 1);
  assert.equal(sanitized.events[0].seq, 2);
});
