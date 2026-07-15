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
    calls.push(request);
    const result = await respond(request, calls);
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

test("batch preflights a deduplicated origin union once before its first side effect", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  const asks = [];
  const bridge = installBridge(({ method, params }) => {
    if (method === "getTab") return { id: params.tabId, url: "https://example.com/app" };
    if (method === "browserBatch") return { results: [] };
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
  assert.equal(bridge.calls.filter((entry) => entry.method === "browserBatch").length, 1);
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
