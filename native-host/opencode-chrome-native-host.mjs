#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";

const STATE_DIR = process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR || path.join(os.homedir(), ".opencode", "chrome-bridge");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const MAX_NATIVE_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_OUTBOUND_MESSAGE_BYTES = 1 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_METHOD_CHARS = 128;
const MAX_PENDING_COMMANDS = 100;
const MAX_EVENT_SUBSCRIBERS = 16;
const COMMAND_METHOD_RE = /^[A-Za-z][A-Za-z0-9]*$/u;

const pending = new Map();
const eventSubscribers = new Set();
const eventBuffer = [];
const EVENT_BUFFER_MAX = 500;
const EVENT_MAX_BYTES = 512 * 1024;
const EVENT_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
const token = randomBytes(32).toString("base64url");
let nextId = 1;
let nextEventSeq = 1;
let eventBufferBytes = 0;
let server;

process.stdin.on("data", onNativeData);
process.stdin.on("end", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error?.stack ?? error}`);
  shutdown(1);
});

let inputBuffer = Buffer.alloc(0);

server = http.createServer(handleHttp);
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    log("failed to bind local bridge server");
    shutdown(1);
    return;
  }
  await writeState(address.port);
  log(`listening on 127.0.0.1:${address.port}`);
  // Announce readiness so the extension can distinguish a live host from a
  // connectNative call that will fail asynchronously.
  writeNativeMessage({
    type: "event",
    event: { category: "bridge", type: "bridgeReady", pid: process.pid }
  }).catch((error) => log(`could not announce readiness: ${error?.message ?? error}`));
});

function onNativeData(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length > MAX_NATIVE_MESSAGE_BYTES) {
      log(`native message too large: ${length}`);
      shutdown(1);
      return;
    }
    if (inputBuffer.length < length + 4) return;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    handleNativeMessage(payload);
  }
}

function handleNativeMessage(payload) {
  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    log(`invalid native JSON: ${error?.message ?? error}`);
    return;
  }
  if (message?.type === "response" && typeof message.id === "string") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "Chrome extension command failed"));
    return;
  }
  if (message?.type === "event") {
    broadcastEvent(message.event ?? message);
    return;
  }
}

async function handleHttp(req, res) {
  try {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/status") {
      sendJson(res, 200, { ok: true, pid: process.pid, pending: pending.size });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/command") {
      requireJsonRequest(req);
      const body = await readJsonBody(req);
      const result = await sendCommand(body.method, body.params ?? {}, body.timeoutMs);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/events") {
      streamEvents(req, res);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/events/poll") {
      pollEvents(requestUrl, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    sendJson(res, statusCode, { ok: false, error: error?.message || "Internal bridge error" });
  }
}

function isAuthorized(req) {
  const supplied = Buffer.from(String(req.headers.authorization ?? ""), "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  // timingSafeEqual requires equal-length buffers. Pad the shorter one so the
  // comparison does not leak which side mismatched, then verify the lengths
  // matched independently. The padding value does not affect the result.
  const maxLen = Math.max(supplied.length, expected.length);
  const suppliedPadded = Buffer.alloc(maxLen);
  const expectedPadded = Buffer.alloc(maxLen);
  supplied.copy(suppliedPadded);
  expected.copy(expectedPadded);
  const matches = timingSafeEqual(suppliedPadded, expectedPadded);
  return supplied.length === expected.length && matches;
}

function requireJsonRequest(req) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.split(";")[0].trim().endsWith("/json") && !contentType.includes("+json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new HttpError(400, "Request body must be a JSON object");
        }
        resolve(parsed);
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, "Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendCommand(method, params, timeoutMs = 15000) {
  if (typeof method !== "string" || method.length === 0 || method.length > MAX_COMMAND_METHOD_CHARS || !COMMAND_METHOD_RE.test(method)) {
    throw new HttpError(400, "method must be a valid bridge command name");
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new HttpError(400, "params must be a JSON object");
  }
  if (pending.size >= MAX_PENDING_COMMANDS) {
    throw new HttpError(429, "Too many pending Chrome commands");
  }
  const id = `opencode:${nextId++}`;
  const message = { type: "command", id, method, params };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Chrome command ${method}`));
    }, clampTimeout(timeoutMs));
    pending.set(id, { resolve, reject, timeout });
    writeNativeMessage(message).catch((error) => {
      clearTimeout(timeout);
      pending.delete(id);
      reject(error);
    });
  });
}

async function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_NATIVE_OUTBOUND_MESSAGE_BYTES) {
    throw new HttpError(413, "Command is too large for Chrome native messaging");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  await new Promise((resolve, reject) => {
    process.stdout.write(Buffer.concat([header, payload]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function broadcastEvent(event) {
  const entry = { seq: nextEventSeq, event, timestamp: Date.now() };
  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    log("dropping event that cannot be serialized");
    return;
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > EVENT_MAX_BYTES) {
    log(`dropping oversized event: ${bytes} bytes`);
    return;
  }
  nextEventSeq += 1;
  eventBuffer.push(entry);
  eventBufferBytes += bytes;
  while (eventBuffer.length > EVENT_BUFFER_MAX || eventBufferBytes > EVENT_BUFFER_MAX_BYTES) {
    const removed = eventBuffer.shift();
    eventBufferBytes -= Buffer.byteLength(JSON.stringify(removed));
  }
  for (const subscriber of eventSubscribers) {
    try {
      if (!subscriber.write(`data: ${serialized}\n\n`)) {
        subscriber.end();
        eventSubscribers.delete(subscriber);
      }
    } catch {
      eventSubscribers.delete(subscriber);
    }
  }
}

function streamEvents(req, res) {
  if (eventSubscribers.size >= MAX_EVENT_SUBSCRIBERS) {
    sendJson(res, 503, { ok: false, error: "Too many event subscribers" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  if (!res.write(":connected\n\n")) {
    res.end();
    return;
  }
  eventSubscribers.add(res);
  const heartbeat = setInterval(() => {
    try {
      if (!res.write(":ping\n\n")) res.end();
    } catch {
      res.end();
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    eventSubscribers.delete(res);
  });
}

function pollEvents(requestUrl, res) {
  const sinceParam = requestUrl.searchParams.get("since");
  const since = Number(sinceParam);
  const filtered = Number.isFinite(since)
    ? eventBuffer.filter((e) => e.seq > since)
    : eventBuffer.slice();
  sendJson(res, 200, { ok: true, events: filtered, nextSeq: eventBuffer.at(-1)?.seq ?? (nextEventSeq - 1) });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15000;
  return Math.max(1000, Math.min(parsed, 120000));
}

async function writeState(port) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  const temporaryStatePath = path.join(
    STATE_DIR,
    `.state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await writeFile(
      temporaryStatePath,
      JSON.stringify(
        {
          host: "127.0.0.1",
          nativeHostName: "com.opencode.chrome_bridge",
          pid: process.pid,
          port,
          token,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    if (process.platform !== "win32") await chmod(temporaryStatePath, 0o600);
    await rename(temporaryStatePath, STATE_PATH);
    if (process.platform !== "win32") await chmod(STATE_PATH, 0o600);
  } finally {
    await rm(temporaryStatePath, { force: true }).catch(() => {});
  }
}

async function shutdown(code) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error("Native host shutting down"));
  }
  pending.clear();
  for (const subscriber of eventSubscribers) {
    try { subscriber.end(); } catch {}
  }
  eventSubscribers.clear();
  try {
    server?.close();
  } catch {}
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (state.pid === process.pid) await rm(STATE_PATH, { force: true });
  } catch {}
  process.exit(code);
}

function log(message) {
  process.stderr.write(`[opencode-chrome-native-host] ${message}\n`);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
