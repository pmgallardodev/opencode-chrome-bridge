#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bridgeCommand, bridgeStatus } from "../src/bridge-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version: EXPECTED_RELEASE_VERSION } = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8")
);
const REQUIRED_CAPABILITIES = Object.freeze([
  "bridge.handshake",
  "browser.schedules",
  "browser.tabs",
  "browser.webmcp",
  "browser.workflows",
  "session.tab-leases"
]);

export async function runInstalledStackSmoke({
  command = installedCommand,
  createFixtureServer = startFixtureServer,
  status = () => bridgeStatus(REQUIRED_CAPABILITIES)
} = {}) {
  const liveStatus = await status();
  assertInstalledStatus(liveStatus);

  const suffix = randomUUID();
  const sessionId = `installed-smoke-${suffix}`;
  const turnId = `turn-${suffix}`;
  const workflowId = `workflow-${suffix}`;
  const shortcut = `installed-smoke-${suffix}`;
  let fixture;
  let scheduleId;
  let tabId;
  let workflowMayExist = false;
  let sessionMayExist = false;
  let primaryError;
  let result;
  const cleanupErrors = [];

  try {
    fixture = await createFixtureServer();
    const url = `${fixture.origin}/opencode-installed-smoke`;
    sessionMayExist = true;
    const createdTab = await command("createTab", { active: false, sessionId, turnId, url });
    if (!Number.isInteger(createdTab?.id)) throw new Error("Installed smoke did not create a dedicated Chrome tab");
    tabId = createdTab.id;
    const tab = await waitForDedicatedTab(command, tabId, fixture.origin);

    const now = new Date().toISOString();
    const workflow = {
      schemaVersion: 1,
      id: workflowId,
      name: `Installed stack smoke ${suffix}`,
      shortcut,
      requiredCapabilities: ["browser.tabs"],
      requiredOrigins: [fixture.origin],
      steps: [{ method: "getTab", params: { tabId }, timeoutMs: 5000 }],
      createdAt: now,
      updatedAt: now
    };
    workflowMayExist = true;
    const imported = await command("workflowImport", { workflow });
    if (imported?.id !== workflowId) throw new Error("Installed smoke workflow import was not persisted");
    const workflows = await command("workflowList");
    if (!Array.isArray(workflows) || !workflows.some((entry) => entry?.id === workflowId)) {
      throw new Error("Installed smoke workflow is missing from extension storage");
    }

    const scheduleDraft = {
      enabled: false,
      name: `Disabled installed smoke ${suffix}`,
      notify: "none",
      recurrence: { kind: "daily", hour: 0, minute: 0 },
      requiredOrigins: imported.requiredOrigins,
      workflowId
    };
    const approval = await command("scheduleApprovalPreview", scheduleDraft);
    if (typeof approval?.scheduleId !== "string" || typeof approval?.pattern !== "string") {
      throw new Error("Installed smoke schedule approval preview is invalid");
    }
    scheduleId = approval.scheduleId;
    const schedule = await command("scheduleCreate", { ...scheduleDraft, approval });
    if (schedule?.id !== scheduleId || schedule?.enabled !== false) {
      throw new Error("Installed smoke disabled schedule was not persisted safely");
    }
    const schedules = await command("scheduleList");
    if (!Array.isArray(schedules) || !schedules.some((entry) => entry?.id === scheduleId)) {
      throw new Error("Installed smoke schedule is missing from extension storage");
    }
    const history = await command("scheduleHistory", { id: scheduleId });
    if (!Array.isArray(history)) throw new Error("Installed smoke schedule history is invalid");

    const binding = {
      documentId: tab.documentId,
      navigationGeneration: tab.navigationGeneration,
      tabId
    };
    const webMcp = await command("webMcpList", { tabId }, {
      expectedBindings: [binding],
      expectedScopes: [canonicalFixtureScope(tab.url)]
    });
    result = {
      extensionVersion: liveStatus.extension.extensionVersion,
      ok: true,
      scheduleStorageRoundTrip: true,
      tabId,
      webMcp: {
        supported: webMcp?.supported === true,
        toolCount: Array.isArray(webMcp?.tools) ? webMcp.tools.length : 0
      },
      workflowStorageRoundTrip: true
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (scheduleId) await cleanupCommand(command, cleanupErrors, "scheduleDelete", { id: scheduleId });
    if (workflowMayExist) await cleanupCommand(command, cleanupErrors, "workflowDelete", { id: workflowId });
    if (sessionMayExist) await cleanupCommand(command, cleanupErrors, "finalizeTabs", { keep: [], sessionId });
    if (fixture) {
      try { await fixture.close(); } catch (error) { cleanupErrors.push(error); }
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter(Boolean),
      primaryError ? `Installed stack smoke failed: ${primaryError.message}` : "Installed stack smoke cleanup failed"
    );
  }
  return result;
}

export async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/opencode-installed-smoke") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "Origin-Agent-Cluster": "?1",
      "Permissions-Policy": "tools=(self)"
    });
    response.end("<!doctype html><meta charset=utf-8><title>OpenCode installed-stack smoke</title><h1>Installed stack smoke</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Installed smoke fixture did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function assertInstalledStatus(status) {
  if (status?.ok !== true || status?.connected !== true || status?.compatible !== true) {
    throw new Error("Installed smoke requires a connected and compatible real bridge status");
  }
  if (status.extension?.extensionVersion !== EXPECTED_RELEASE_VERSION) {
    throw new Error(`Installed smoke requires extension ${EXPECTED_RELEASE_VERSION}; reload chrome://extensions before retrying`);
  }
  if (status.host?.version !== EXPECTED_RELEASE_VERSION) {
    throw new Error(`Installed smoke requires native host ${EXPECTED_RELEASE_VERSION}; reinstall the current native host before retrying`);
  }
  if (status.client?.version !== EXPECTED_RELEASE_VERSION) {
    throw new Error(`Installed smoke requires OpenCode client ${EXPECTED_RELEASE_VERSION}; restart OpenCode from this checkout before retrying`);
  }
}

async function installedCommand(method, params, scope) {
  if (!scope) return bridgeCommand(method, params);
  return bridgeCommand("scopedCommand", {
    expectedBindings: scope.expectedBindings,
    expectedScopes: scope.expectedScopes,
    method,
    params
  });
}

async function cleanupCommand(command, errors, method, params) {
  try {
    await command(method, params);
  } catch (error) {
    if (!/not found|no .* found|unknown workflow|unknown schedule/iu.test(error?.message ?? "")) errors.push(error);
  }
}

function canonicalFixtureScope(url) {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname || "/"}`;
}

async function waitForDedicatedTab(command, tabId, origin) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const tab = await command("getTab", { tabId });
      if (
        typeof tab?.url === "string"
        && tab.url.startsWith(`${origin}/`)
        && typeof tab.documentId === "string"
        && Number.isInteger(tab.navigationGeneration)
      ) return tab;
      lastError = new Error("dedicated local fixture has not committed its document binding");
    } catch (error) {
      if (/tab.*(?:not found|closed|invalid)|no tab/iu.test(error?.message ?? "")) throw error;
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Installed smoke tab did not load the dedicated local fixture: ${lastError?.message ?? "timed out"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runInstalledStackSmoke(), null, 2));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
