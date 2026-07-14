#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = await mkdtemp(path.join(os.tmpdir(), "opencode-chrome-bridge-"));
const statePath = path.join(stateDir, "state.json");
if (process.platform !== "win32") {
  await writeFile(statePath, "stale", { mode: 0o644 });
}
const child = spawn(process.execPath, [path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs")], {
  env: { ...process.env, OPENCODE_CHROME_BRIDGE_STATE_DIR: stateDir },
  stdio: ["pipe", "pipe", "pipe"]
});
let childStderr = "";
child.stderr.on("data", (chunk) => { childStderr += chunk.toString("utf8"); });
const readNativeMessage = createNativeMessageReader(child.stdout);

try {
  const state = await waitForState(stateDir, child, () => childStderr);

  const readyFrame = await readNativeMessage();
  if (readyFrame.type !== "event" || readyFrame.event?.type !== "bridgeReady") {
    throw new Error(`Expected a bridgeReady announcement first, got: ${JSON.stringify(readyFrame)}`);
  }

  await writeNativeMessage(child.stdin, { type: "ping", id: "smoke-ping-1" });
  const pongFrame = await readNativeMessage();
  if (pongFrame.type !== "pong" || pongFrame.id !== "smoke-ping-1") {
    throw new Error(`Expected a pong reply to the liveness ping, got: ${JSON.stringify(pongFrame)}`);
  }
  if (process.platform !== "win32") {
    const stateDirMode = (await stat(stateDir)).mode & 0o777;
    if (stateDirMode !== 0o700) throw new Error(`Expected state directory mode 0700, got ${stateDirMode.toString(8)}`);
    const stateFileMode = (await stat(statePath)).mode & 0o777;
    if (stateFileMode !== 0o600) throw new Error(`Expected state file mode 0600, got ${stateFileMode.toString(8)}`);
  }

  const unauthorizedResponse = await fetch(`http://127.0.0.1:${state.port}/status`);
  if (unauthorizedResponse.status !== 401) {
    throw new Error(`Expected unauthorized status to return 401, got ${unauthorizedResponse.status}`);
  }

  const unsupportedMediaResponse = await fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ method: "listTabs", params: {} })
  });
  if (unsupportedMediaResponse.status !== 415) {
    throw new Error(`Expected non-JSON command to return 415, got ${unsupportedMediaResponse.status}`);
  }

  const badJsonResponse = await fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json"
    },
    body: "{"
  });
  if (badJsonResponse.status !== 400) {
    throw new Error(`Expected bad JSON command to return 400, got ${badJsonResponse.status}`);
  }

  const response = await fetch(`http://127.0.0.1:${state.port}/status`, {
    headers: { Authorization: `Bearer ${state.token}` }
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(`Unexpected status response: ${JSON.stringify(payload)}`);
  if (response.headers.get("cache-control") !== "no-store") throw new Error("Status response must disable caching");
  if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error("Status response must disable MIME sniffing");

  const commandRequest = fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method: "listTabs", params: {}, timeoutMs: 5000 })
  });
  const nativeCommand = await readNativeMessage();
  if (nativeCommand.type !== "command" || nativeCommand.method !== "listTabs" || typeof nativeCommand.id !== "string") {
    throw new Error(`Unexpected native command frame: ${JSON.stringify(nativeCommand)}`);
  }
  await writeNativeMessage(child.stdin, {
    type: "response",
    id: nativeCommand.id,
    ok: true,
    result: [{ id: 7, title: "Smoke test tab" }]
  });
  const commandResponse = await commandRequest;
  const commandPayload = await commandResponse.json();
  if (!commandResponse.ok || commandPayload.result?.[0]?.id !== 7) {
    throw new Error(`Unexpected command round-trip response: ${JSON.stringify(commandPayload)}`);
  }

  const oversizedCommandResponse = await fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method: "type", params: { text: "x".repeat(1_100_000) } })
  });
  if (oversizedCommandResponse.status !== 413) {
    throw new Error(`Expected an oversized Chrome-bound command to return 413, got ${oversizedCommandResponse.status}`);
  }

  const largeResponseRequest = fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method: "screenshot", params: {}, timeoutMs: 5000 })
  });
  const largeNativeCommand = await readNativeMessage();
  const largeResult = "x".repeat(9 * 1024 * 1024);
  await writeNativeMessage(child.stdin, {
    type: "response",
    id: largeNativeCommand.id,
    ok: true,
    result: { data: largeResult }
  });
  const largeResponse = await largeResponseRequest;
  const largePayload = await largeResponse.json();
  if (!largeResponse.ok || largePayload.result?.data?.length !== largeResult.length) {
    throw new Error("Native host truncated a valid large Chrome response");
  }

  await writeNativeMessage(child.stdin, { type: "event", event: { category: "tabs", type: "tabCreated", tabId: 7 } });
  const eventsPayload = await waitForEvents(state);
  if (eventsPayload.events?.[0]?.event?.tabId !== 7) {
    throw new Error(`Unexpected native event round-trip: ${JSON.stringify(eventsPayload)}`);
  }

  console.log(JSON.stringify({ ok: true, port: state.port, pid: state.pid, commandRoundTrip: true, largeResponseBytes: largeResult.length, eventRoundTrip: true }, null, 2));
} finally {
  const exited = child.exitCode == null ? new Promise((resolve) => child.once("exit", resolve)) : Promise.resolve();
  child.kill("SIGTERM");
  await exited;
  await rm(stateDir, { recursive: true, force: true });
}

async function waitForState(dir, childProcess, readStderr) {
  const statePath = path.join(dir, "state.json");
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null) {
      throw new Error(`Native host exited with code ${childProcess.exitCode}: ${readStderr().trim()}`);
    }
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const detail = readStderr().trim();
  throw new Error(`Timed out waiting for native-host state${detail ? `: ${detail}` : ""}`, { cause: lastError });
}

function createNativeMessageReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  return async function readMessage() {
    while (true) {
      if (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length >= length + 4) {
          const payload = buffer.subarray(4, length + 4);
          buffer = buffer.subarray(length + 4);
          return JSON.parse(payload.toString("utf8"));
        }
      }
      const { value, done } = await iterator.next();
      if (done) throw new Error("Native host stdout closed before a complete message arrived");
      buffer = Buffer.concat([buffer, value]);
    }
  };
}

async function writeNativeMessage(stream, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  await new Promise((resolve, reject) => {
    stream.write(Buffer.concat([header, payload]), (error) => error ? reject(error) : resolve());
  });
}

async function waitForEvents(state) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${state.port}/events/poll?since=0`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const payload = await response.json();
    if (payload.events?.length > 0) return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a native event round-trip");
}
