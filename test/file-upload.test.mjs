import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pluginModule from "../src/opencode-plugin.js";

test("workspace upload reads bounded chunks and commits only after every file is staged", async (t) => {
  assert.equal(typeof pluginModule.uploadWorkspaceFiles, "function");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "hello.txt"), "hello world");
  await writeFile(path.join(workspace, "empty.bin"), Buffer.alloc(0));
  const calls = [];
  const command = async (method, params) => {
    calls.push({ method, params });
    if (method === "fileUploadBegin") return { transferId: "opaque-transfer-id" };
    if (method === "fileUploadCommit") return { committed: true, count: 2, names: ["hello.txt", "empty.bin"] };
    return { accepted: true };
  };

  const result = await pluginModule.uploadWorkspaceFiles({
    command,
    directory: workspace,
    paths: ["hello.txt", "empty.bin"],
    ref: "e7",
    tabId: 9,
    chunkBytes: 4
  });

  assert.equal(result.committed, true);
  assert.deepEqual(calls.map((entry) => entry.method), [
    "fileUploadBegin", "fileUploadChunk", "fileUploadChunk", "fileUploadChunk", "fileUploadCommit"
  ]);
  assert.ok(calls.filter((entry) => entry.method === "fileUploadChunk")
    .every((entry) => Buffer.from(entry.params.data, "base64").length <= 4));
  assert.deepEqual(calls.at(-1).params, { transferId: "opaque-transfer-id", tabId: 9, ref: "e7" });
});

test("workspace upload rejects directories and symlink escapes before staging", async (t) => {
  assert.equal(typeof pluginModule.uploadWorkspaceFiles, "function");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  await mkdir(path.join(workspace, "folder"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
  let calls = 0;
  const command = async () => { calls += 1; };

  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({ command, directory: workspace, paths: ["folder"], ref: "e1", tabId: 1 }),
    /regular file/iu
  );
  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({ command, directory: workspace, paths: ["escape.txt"], ref: "e1", tabId: 1 }),
    /outside.*workspace|escape/iu
  );
  assert.equal(calls, 0);
});

test("workspace upload aborts staging on a chunk failure or cancellation", async (t) => {
  assert.equal(typeof pluginModule.uploadWorkspaceFiles, "function");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-abort-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "hello.txt"), "hello");
  const calls = [];
  const command = async (method) => {
    calls.push(method);
    if (method === "fileUploadBegin") return { transferId: "opaque-transfer-id" };
    if (method === "fileUploadChunk") throw new Error("transport failed");
    return { aborted: true };
  };

  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({ command, directory: workspace, paths: ["hello.txt"], ref: "e1", tabId: 1 }),
    /transport failed/u
  );
  assert.deepEqual(calls, ["fileUploadBegin", "fileUploadChunk", "fileUploadAbort"]);
});

test("workspace upload keeps validated handles across a symlink swap during begin", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-swap-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-swap-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  const candidate = path.join(workspace, "payload.txt");
  const original = path.join(workspace, "payload-original.txt");
  const secret = path.join(outside, "secret.txt");
  await writeFile(candidate, "inside");
  await writeFile(secret, "outside-secret");
  const chunks = [];
  const command = async (method, params) => {
    if (method === "fileUploadBegin") {
      await rename(candidate, original);
      await symlink(secret, candidate);
      return { transferId: "opaque-transfer-id" };
    }
    if (method === "fileUploadChunk") chunks.push(Buffer.from(params.data, "base64").toString("utf8"));
    if (method === "fileUploadCommit") return { committed: true, count: 1, names: ["payload.txt"] };
    return { accepted: true };
  };

  const result = await pluginModule.uploadWorkspaceFiles({
    command, directory: workspace, paths: ["payload.txt"], ref: "e1", tabId: 1, chunkBytes: 64
  });

  assert.equal(result.committed, true);
  assert.deepEqual(chunks, ["inside"]);
  assert.doesNotMatch(chunks.join(""), /outside-secret/u);
});

test("workspace upload rejects empty, excessive, and byte-oversized file lists", async (t) => {
  assert.equal(typeof pluginModule.uploadWorkspaceFiles, "function");
  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({ command: async () => {}, directory: process.cwd(), paths: [], ref: "e1", tabId: 1 }),
    /at least one file/iu
  );
  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({
      command: async () => {}, directory: process.cwd(), paths: Array.from({ length: 21 }, (_, i) => `f${i}`), ref: "e1", tabId: 1
    }),
    /at most 20 files/iu
  );
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-upload-oversize-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const oversized = path.join(workspace, "oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 50 * 1024 * 1024 + 1);
  let calls = 0;
  await assert.rejects(
    pluginModule.uploadWorkspaceFiles({
      command: async () => { calls += 1; }, directory: workspace, paths: ["oversized.bin"], ref: "e1", tabId: 1
    }),
    /total exceeds/iu
  );
  assert.equal(calls, 0);
});
