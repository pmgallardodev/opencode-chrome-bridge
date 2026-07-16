import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

async function waitForState(statePath, diagnostics = () => "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(await readFile(statePath, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`native host state was not published: ${diagnostics()}`);
}
