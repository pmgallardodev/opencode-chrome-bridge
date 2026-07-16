import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("aborting an HTTP command immediately sends native cancel for the pending id", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "bridge-native-cancel-"));
  const child = spawn(process.execPath, [path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs")], {
    env: { ...process.env, OPENCODE_CHROME_BRIDGE_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(stateDir, { recursive: true, force: true });
  });
  const frames = nativeFrames(child.stdout);
  try {
    await waitForState(path.join(stateDir, "state.json"), () => stderr);
  } catch (error) {
    if (/listen EPERM/iu.test(error.message)) {
      t.skip("sandbox does not permit binding the native host loopback server");
      return;
    }
    throw error;
  }
  const previousStateDir = process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
  process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = stateDir;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR;
    else process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR = previousStateDir;
  });
  const { bridgeCommand } = await import(`../src/bridge-client.js?cancel=${Date.now()}`);
  const controller = new AbortController();
  const request = bridgeCommand("fileUploadCommit", { tabId: 7 }, { signal: controller.signal, timeoutMs: 120000 });
  const command = await frames.next((message) => message.type === "command" && message.method === "fileUploadCommit");
  controller.abort(new Error("client cancelled"));
  await assert.rejects(request, /cancel|abort/iu);

  const cancel = await frames.next((message) => message.type === "cancel", 1000);
  assert.equal(cancel.id, command.id);
});

test("no-timeout WebMCP quota rejects excess while regular commands and status remain available", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "bridge-native-quota-"));
  const child = spawn(process.execPath, [path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs")], {
    env: { ...process.env, OPENCODE_CHROME_BRIDGE_STATE_DIR: stateDir }, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => { child.kill("SIGTERM"); await rm(stateDir, { recursive: true, force: true }); });
  const frames = nativeFrames(child.stdout);
  const state = await waitForState(path.join(stateDir, "state.json"));
  const url = `http://${state.host}:${state.port}`;
  const headers = { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" };
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map((controller) => fetch(`${url}/command`, {
    body: JSON.stringify({ method: "scopedCommand", params: { method: "webMcpInvoke", params: {} }, timeoutMs: 0 }),
    headers, method: "POST", signal: controller.signal
  }).catch(() => null));
  const commands = [];
  for (let index = 0; index < 8; index += 1) {
    commands.push(await frames.next((message) => message.type === "command")
      .catch((error) => { throw new Error(`quota command ${index}: ${error.message}`); }));
  }

  const excess = await fetch(`${url}/command`, {
    body: JSON.stringify({ method: "scopedCommand", params: { method: "webMcpInvoke", params: {} }, timeoutMs: 0 }),
    headers, method: "POST"
  });
  assert.equal(excess.status, 429);
  controllers[0].abort();
  await pending[0];
  const stillFull = await httpJson(`${url}/command`, {
    body: { method: "scopedCommand", params: { method: "webMcpInvoke", params: {} }, timeoutMs: 0 }, headers, method: "POST"
  });
  assert.equal(stillFull.status, 429, "disconnect must not release the no-timeout quota before extension settlement");
  writeNativeFrame(child.stdin, { type: "settled", id: commands[0].id });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replacementRequest = httpJson(`${url}/command`, {
    body: { method: "scopedCommand", params: { method: "webMcpInvoke", params: {} }, timeoutMs: 0 }, headers, method: "POST"
  });
  const replacement = await frames.next((message) => message.type === "command" && message.id !== commands[0].id);
  writeNativeFrame(child.stdin, { type: "response", id: replacement.id, ok: true, result: { ok: true } });
  assert.equal((await replacementRequest).status, 200, "extension settlement must release one no-timeout quota slot");

  const regularRequest = httpJson(`${url}/command`, {
    body: { method: "getTab", params: { tabId: 7 }, timeoutMs: 5_000 }, headers, method: "POST"
  });
  const regular = await frames.next((message) => message.type === "command" && message.method === "getTab")
    .catch((error) => { throw new Error(`regular command: ${error.message}`); });
  writeNativeFrame(child.stdin, { type: "response", id: regular.id, ok: true, result: { id: 7 } });
  assert.equal((await regularRequest).status, 200);

  const statusRequest = httpJson(`${url}/status`, { headers: { Authorization: `Bearer ${state.token}` }, method: "GET" });
  const handshake = await frames.next((message) => message.type === "command" && message.method === "handshake")
    .catch((error) => { throw new Error(`status handshake: ${error.message}`); });
  writeNativeFrame(child.stdin, { type: "response", id: handshake.id, ok: true, result: {
    capabilities: ["bridge.handshake"], extensionId: "test-extension", extensionVersion: "1.4.2",
    hostName: "com.opencode.chrome_bridge", protocolVersion: "1.0.0"
  } });
  const status = await statusRequest;
  assert.equal(status.status, 200);
  assert.equal(status.payload.connected, true);

  controllers.forEach((controller) => controller.abort());
  await Promise.all(pending);
  for (const command of commands) writeNativeFrame(child.stdin, { type: "settled", id: command.id });
});

function nativeFrames(stream) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) break;
      messages.push(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      buffer = buffer.subarray(length + 4);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    async next(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for native frame; queued=${JSON.stringify(messages)}`)), Math.max(1, deadline - Date.now()));
          waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      throw new Error("timed out waiting for native frame");
    }
  };
}

function writeNativeFrame(stream, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  stream.write(Buffer.concat([header, payload]));
}

function httpJson(url, { body, headers, method }) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      headers: { ...headers, ...(serialized === undefined ? {} : { "Content-Length": Buffer.byteLength(serialized) }) }, method
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ payload: JSON.parse(Buffer.concat(chunks).toString("utf8")), status: response.statusCode }));
    });
    request.on("error", reject);
    request.end(serialized);
  });
}

async function waitForState(statePath, diagnostics = () => "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(await readFile(statePath, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`native host state was not published: ${diagnostics()}`);
}
