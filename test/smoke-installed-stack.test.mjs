import assert from "node:assert/strict";
import test from "node:test";
import { runInstalledStackSmoke } from "../scripts/smoke-installed-stack.mjs";

test("installed-stack smoke owns and cleans one dedicated workflow and schedule lifecycle", async () => {
  const calls = [];
  const scheduleId = "smoke-schedule";
  let workflowId;
  const command = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "createTab") return { id: 91, url: params.url };
    if (method === "getTab") return { documentId: "doc-91", id: 91, navigationGeneration: 1, url: `${server.origin}/opencode-installed-smoke` };
    if (method === "workflowImport") {
      workflowId = params.workflow.id;
      return params.workflow;
    }
    if (method === "workflowList") return [{ id: workflowId }];
    if (method === "scheduleApprovalPreview") return { pattern: "v1:approval", scheduleId };
    if (method === "scheduleCreate") return { enabled: false, id: scheduleId };
    if (method === "scheduleList") return [{ id: scheduleId }];
    if (method === "scheduleHistory") return [];
    if (["scheduleDelete", "workflowDelete"].includes(method)) return { deleted: true };
    if (method === "webMcpList") return { supported: false, tools: [] };
    if (method === "finalizeTabs") return { closedTabIds: [91], finalized: true };
    throw new Error(`unexpected ${method}`);
  };
  const status = async () => ({
    client: { version: "1.4.1" },
    compatible: true,
    connected: true,
    extension: { extensionVersion: "1.4.1" },
    host: { version: "1.4.1" },
    ok: true
  });
  const server = {
    origin: "http://127.0.0.1:34567",
    close: async () => { calls.push({ method: "fixtureClose", params: {} }); }
  };
  const result = await runInstalledStackSmoke({ command, createFixtureServer: async () => server, status });
  assert.equal(result.ok, true);
  assert.equal(result.webMcp.supported, false);
  assert.deepEqual(calls.map(({ method }) => method), [
    "createTab", "getTab", "workflowImport", "workflowList", "scheduleApprovalPreview",
    "scheduleCreate", "scheduleList", "scheduleHistory", "webMcpList", "scheduleDelete",
    "workflowDelete", "finalizeTabs", "fixtureClose"
  ]);
  const imported = calls.find(({ method }) => method === "workflowImport").params.workflow;
  assert.equal(Number.isNaN(Date.parse(imported.createdAt)), false);
  assert.equal(imported.createdAt, imported.updatedAt);
  assert.equal(calls.find(({ method }) => method === "scheduleCreate").params.enabled, false);
});

test("installed-stack smoke rejects stale or incompatible extension before creating a tab", async () => {
  let commands = 0;
  await assert.rejects(() => runInstalledStackSmoke({
    command: async () => { commands += 1; },
    createFixtureServer: async () => { throw new Error("fixture must not start"); },
    status: async () => ({
      client: { version: "1.4.1" },
      compatible: true,
      connected: true,
      extension: { extensionVersion: "1.3.0" },
      host: { version: "1.4.1" },
      ok: true
    })
  }), /extension.*1\.4\.1/iu);
  assert.equal(commands, 0);
});

test("installed-stack smoke rejects stale native host or client versions before creating a tab", async () => {
  for (const status of [
    {
      client: { version: "1.4.1" },
      compatible: true,
      connected: true,
      extension: { extensionVersion: "1.4.1" },
      host: { version: "1.3.0" },
      ok: true
    },
    {
      client: { version: "1.3.0" },
      compatible: true,
      connected: true,
      extension: { extensionVersion: "1.4.1" },
      host: { version: "1.4.1" },
      ok: true
    }
  ]) {
    let commands = 0;
    await assert.rejects(() => runInstalledStackSmoke({
      command: async () => { commands += 1; },
      createFixtureServer: async () => { throw new Error("fixture must not start"); },
      status: async () => status
    }), /requires .*1\.4\.1/iu);
    assert.equal(commands, 0);
  }
});

test("installed-stack smoke safely finalizes its dedicated session after a partial failure", async () => {
  const methods = [];
  await assert.rejects(() => runInstalledStackSmoke({
    command: async (method, params) => {
      methods.push(method);
      if (method === "createTab") return { id: 92, url: params.url };
      if (method === "getTab") throw new Error("tab not found after fixture navigation");
      if (method === "finalizeTabs") return { finalized: true };
      throw new Error(`unexpected ${method}`);
    },
    createFixtureServer: async () => ({
      origin: "http://127.0.0.1:34568",
      close: async () => { methods.push("fixtureClose"); }
    }),
    status: async () => ({
      client: { version: "1.4.1" },
      compatible: true,
      connected: true,
      extension: { extensionVersion: "1.4.1" },
      host: { version: "1.4.1" },
      ok: true
    })
  }), /tab not found/iu);
  assert.deepEqual(methods, ["createTab", "getTab", "finalizeTabs", "fixtureClose"]);
});
