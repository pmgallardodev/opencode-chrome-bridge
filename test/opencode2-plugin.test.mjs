import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  installOpenCodePlugin,
  parseJsonc,
  withPluginPath,
  V2_PLUGIN_KEY
} from "../scripts/lib/opencode-config.mjs";
import v2Entry from "../src/plugin-entry-v2.js";
import {
  createV1ToolContext,
  toInputSchema,
  toV2Result,
  PLUGIN_ID
} from "../src/opencode-plugin-v2.js";
import {
  readServiceRegistration,
  requestPermission,
  resetServiceEndpointCache,
  serviceAuthorizationHeader,
  serviceRegistrationPath
} from "../src/opencode-service-client.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadSchema() {
  const { tool } = await import("@opencode-ai/plugin");
  return tool.schema;
}

function stubPluginContext(directory = "/workspace/project") {
  return { session: { get: async () => ({ location: { directory } }) } };
}

function stubToolContext(overrides = {}) {
  return { sessionID: "ses_1", messageID: "msg_1", agent: "build", id: "call_1", ...overrides };
}

test("OpenCode 2 entrypoint exposes only the plugin module OpenCode 2 validates", async () => {
  const namespace = await import("../src/plugin-entry-v2.js");
  assert.deepEqual(Object.keys(namespace), ["default"]);
  assert.equal(v2Entry.id, PLUGIN_ID);
  assert.equal(typeof v2Entry.setup, "function");
});

test("OpenCode 2 setup registers every OpenCode 1 tool with a JSON Schema input", async () => {
  const added = [];
  let disposed = false;
  const context = {
    ...stubPluginContext(),
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition) });
        return { dispose: async () => { disposed = true; } };
      }
    }
  };

  const cleanup = await v2Entry.setup(context);

  const v1Plugin = (await import("../src/opencode-plugin.js")).default;
  const { tool: v1Tools } = await v1Plugin();
  assert.deepEqual(added.map((entry) => entry.name), Object.keys(v1Tools));
  assert.ok(added.length > 0);
  for (const definition of added) {
    assert.equal(typeof definition.description, "string");
    assert.equal(definition.input.type, "object");
    assert.equal(typeof definition.execute, "function");
    // Code mode would batch calls behind the per-origin approval wrapper.
    assert.equal(definition.options.codemode, false);
    // The approval wrapper raises its own prompt; a declared permission action
    // would make OpenCode 2 ask a second time for the same call.
    assert.equal(definition.options.permission, undefined);
  }

  await cleanup();
  assert.equal(disposed, true);
});

test("Zod defaults stay optional in the published OpenCode 2 input schema", async () => {
  const schema = await loadSchema();
  const input = toInputSchema({
    url: schema.string(),
    originGrant: schema.enum(["once", "session"]).default("once")
  }, schema);

  assert.deepEqual(input.required, ["url"]);
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.properties.originGrant.enum, ["once", "session"]);
});

test("OpenCode 1 tool results become OpenCode 2 content", () => {
  assert.deepEqual(toV2Result("{\"ok\":true}"), { content: "{\"ok\":true}" });
  assert.deepEqual(
    toV2Result({
      title: "Screenshot",
      output: "saved",
      metadata: { tabId: 7 },
      attachments: [{ type: "file", mime: "image/png", url: "file:///shot.png", filename: "shot.png" }]
    }),
    {
      content: [
        { type: "text", text: "saved" },
        { type: "file", uri: "file:///shot.png", mime: "image/png", name: "shot.png" }
      ],
      metadata: { tabId: 7, title: "Screenshot" }
    }
  );
});

test("the OpenCode 1 tool context is rebuilt from the OpenCode 2 session", async () => {
  let sessionLookups = 0;
  const pluginContext = {
    session: {
      get: async ({ sessionID }) => {
        sessionLookups += 1;
        assert.equal(sessionID, "ses_1");
        return { location: { directory: "/workspace/project" } };
      }
    }
  };
  const directories = new Map();

  const first = await createV1ToolContext(stubToolContext(), pluginContext, directories);
  const second = await createV1ToolContext(stubToolContext(), pluginContext, directories);

  assert.equal(first.directory, "/workspace/project");
  assert.equal(first.worktree, "/workspace/project");
  assert.equal(first.sessionID, "ses_1");
  assert.equal(first.messageID, "msg_1");
  assert.equal(first.agent, "build");
  assert.equal(first.abort instanceof AbortSignal, true);
  assert.equal(first.abort.aborted, false);
  assert.equal(second.directory, "/workspace/project");
  assert.equal(sessionLookups, 1, "session directory is resolved once per session");
});

test("tools refuse to run without a session-scoped OpenCode 2 context", async () => {
  await assert.rejects(
    createV1ToolContext({ messageID: "msg_1" }, stubPluginContext(), new Map()),
    /session-scoped tool context/u
  );
});

test("OpenCode 1 metadata updates are forwarded to OpenCode 2 progress", async () => {
  const updates = [];
  const context = await createV1ToolContext(
    stubToolContext({ progress: async (update) => updates.push(update) }),
    stubPluginContext(),
    new Map()
  );

  context.metadata({ title: "Navigating", metadata: { tabId: 3 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(updates, [{ tabId: 3, title: "Navigating" }]);
});

test("approval prompts are raised through the OpenCode 2 permission API", async () => {
  resetServiceEndpointCache();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/api/health")) return new Response("{}", { status: 200 });
    return Response.json({ data: { id: "per_1", effect: "allow" } });
  };
  const context = await createV1ToolContext(stubToolContext(), stubPluginContext(), new Map(), {
    fetchImpl,
    read: async () => JSON.stringify({ url: "http://127.0.0.1:4321", password: "secret" })
  });

  await context.ask({
    permission: "chrome_open",
    patterns: ["chrome_open"],
    always: ["chrome_open"],
    metadata: { action: "Open a page" }
  });

  const permissionRequest = requests.at(-1);
  assert.equal(permissionRequest.url, "http://127.0.0.1:4321/api/session/ses_1/permission");
  assert.equal(permissionRequest.init.method, "POST");
  assert.equal(permissionRequest.init.headers.authorization, serviceAuthorizationHeader("secret"));
  assert.deepEqual(JSON.parse(permissionRequest.init.body), {
    action: "chrome_open",
    resources: ["chrome_open"],
    save: ["chrome_open"],
    metadata: { action: "Open a page" },
    agent: "build",
    source: { type: "tool", messageID: "msg_1", id: "call_1" }
  });
  resetServiceEndpointCache();
});

test("a denied OpenCode 2 permission stops the tool", async () => {
  resetServiceEndpointCache();
  const fetchImpl = async (url) => url.endsWith("/api/health")
    ? new Response("{}", { status: 200 })
    : Response.json({ data: { id: "per_1", effect: "deny" } });

  await assert.rejects(
    requestPermission({ sessionID: "ses_1", action: "chrome_open", resources: ["chrome_open"] }, {
      fetchImpl,
      read: async () => JSON.stringify({ url: "http://127.0.0.1:4321", password: "secret" })
    }),
    /Permission denied for chrome_open/u
  );
  resetServiceEndpointCache();
});

test("an unreachable session fails closed with an actionable message", async () => {
  resetServiceEndpointCache();
  const fetchImpl = async (url) => url.endsWith("/api/health")
    ? new Response("{}", { status: 200 })
    : new Response("", { status: 404 });

  await assert.rejects(
    requestPermission({ sessionID: "ses_missing", action: "chrome_open", resources: ["chrome_open"] }, {
      fetchImpl,
      read: async () => JSON.stringify({ url: "http://127.0.0.1:4321", password: "secret" })
    }),
    /--standalone cannot approve browser access/u
  );
  resetServiceEndpointCache();
});

test("the OpenCode 2 service registration must be local and authenticated", async () => {
  await assert.rejects(
    readServiceRegistration({ read: async () => JSON.stringify({ url: "http://example.com", password: "x" }) }),
    /not local/u
  );
  await assert.rejects(
    readServiceRegistration({ read: async () => JSON.stringify({ url: "http://127.0.0.1:4321" }) }),
    /missing a password/u
  );
  await assert.rejects(
    readServiceRegistration({
      file: "/missing/service.json",
      read: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); }
    }),
    /registration not found at \/missing\/service\.json/u
  );
  assert.equal(
    serviceRegistrationPath({ XDG_STATE_HOME: "/state" }),
    path.join("/state", "opencode", "service.json")
  );
});

test("OpenCode 2 config keeps the OpenCode 1 plugin key alongside the new one", () => {
  const parsed = parseJsonc(`{
    "plugin": ["/home/ada/bridge"]
  }`);
  const v2Path = "/home/ada/bridge/src/plugin-entry-v2.js";
  const once = withPluginPath(parsed, v2Path, V2_PLUGIN_KEY);
  const twice = withPluginPath(once, v2Path, V2_PLUGIN_KEY);

  assert.deepEqual(twice.plugin, ["/home/ada/bridge"]);
  assert.deepEqual(twice.plugins, [v2Path]);
});

test("OpenCode 2 object plugin entries are recognised instead of duplicated", () => {
  const v2Path = "/home/ada/bridge/src/plugin-entry-v2.js";
  const config = { plugins: [{ package: v2Path, options: { verbose: true } }] };

  assert.deepEqual(withPluginPath(config, v2Path, V2_PLUGIN_KEY).plugins, config.plugins);
  assert.throws(
    () => withPluginPath({ plugins: [42] }, v2Path, V2_PLUGIN_KEY),
    /strings or \{ package \} objects/u
  );
});

test("installing the OpenCode 2 entry preserves object entries and comments", async () => {
  const original = `{
  // Keep this user explanation.
  "plugins": [
    { "package": "opencode-acme-plugin", "options": { "enabled": true } }
  ]
}`;
  let written = null;

  const result = await installOpenCodePlugin({
    configPath: "/home/ada/.config/opencode/opencode.jsonc",
    configDirectory: "/home/ada/.config/opencode",
    pluginPath: "/home/ada/bridge/src/plugin-entry-v2.js",
    key: V2_PLUGIN_KEY,
    readFile: async () => original,
    writeFile: async (_, contents) => { written = contents; },
    mkdir: async () => {}
  });

  assert.equal(result.changed, true);
  assert.match(written, /Keep this user explanation/u);
  assert.deepEqual(parseJsonc(written).plugins, [
    { package: "opencode-acme-plugin", options: { enabled: true } },
    "/home/ada/bridge/src/plugin-entry-v2.js"
  ]);
});

test("the package exposes the OpenCode 2 entrypoint for direct config references", async () => {
  const manifest = parseJsonc(await import("node:fs/promises").then((fs) => fs.readFile(
    path.join(repoRoot, "package.json"),
    "utf8"
  )));

  assert.equal(manifest.exports["."], "./src/plugin-entry.js");
  assert.equal(manifest.exports["./v2"], "./src/plugin-entry-v2.js");
});
