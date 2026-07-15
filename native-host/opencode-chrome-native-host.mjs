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
const HOST_NAME = "com.opencode.chrome_bridge";
const HOST_VERSION = "1.2.0";
const HOST_PROTOCOL_MIN = "1.0.0";
const HOST_PROTOCOL_MAX = "1.0.0";
const DEFAULT_CLIENT_NAME = "opencode-plugin";
const STATUS_HANDSHAKE_TIMEOUT_MS = 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/u;
const CAPABILITY_RE = /^[a-z][a-z0-9.-]{0,99}$/u;

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
    else entry.reject(new ExtensionCommandError(message.error || "Chrome extension command failed"));
    return;
  }
  if (message?.type === "event") {
    broadcastEvent(message.event ?? message);
    return;
  }
  if (message?.type === "ping") {
    // Liveness probe from the extension: reply so the popup can distinguish a
    // healthy host from a present-but-wedged one.
    const id = typeof message.id === "string" ? message.id : null;
    writeNativeMessage({ type: "pong", id, host: hostHandshake() }).catch((error) => {
      log(`could not answer ping: ${error?.message ?? error}`);
    });
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
      sendJson(res, 200, await negotiateStatus(req));
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

async function negotiateStatus(req) {
  const diagnostics = [];
  const client = clientHandshake(req.headers, diagnostics);
  const requiredCapabilities = client.requiredCapabilities;
  let connected = true;
  let extension;
  try {
    extension = normalizeExtensionHandshake(
      await sendCommand("handshake", {}, STATUS_HANDSHAKE_TIMEOUT_MS),
      diagnostics
    );
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      connected = false;
      extension = null;
      diagnostics.push({
        code: "EXTENSION_DISCONNECTED",
        message: "The Chrome extension did not answer the handshake.",
        repair: "Reload Chrome or reinstall the native host."
      });
    } else {
      extension = incompatibleExtensionPlaceholder();
      diagnostics.push({
        code: error instanceof ExtensionCommandError ? "HANDSHAKE_UNSUPPORTED" : "HANDSHAKE_FAILED",
        message: "The connected Chrome extension could not negotiate the bridge protocol.",
        repair: "Update and reload the extension, then reinstall the native host."
      });
    }
  }

  const missingCapabilities = extension === null
    ? []
    : requiredCapabilities.filter((capability) => !extension.capabilities.includes(capability)).sort();
  if (missingCapabilities.length > 0) {
    diagnostics.push({
      code: "MISSING_CAPABILITIES",
      message: `The extension is missing required capabilities: ${missingCapabilities.join(", ")}.`,
      repair: "Update and reload the extension."
    });
  }
  const protocolCompatible = extension !== null
    && isVersionInRange(extension.protocolVersion, HOST_PROTOCOL_MIN, HOST_PROTOCOL_MAX)
    && isVersionInRange(extension.protocolVersion, client.protocolMin, client.protocolMax);
  if (connected && !protocolCompatible && !diagnostics.some((entry) => entry.code.includes("HANDSHAKE"))) {
    diagnostics.push({
      code: "PROTOCOL_INCOMPATIBLE",
      message: `Extension protocol ${extension.protocolVersion} is outside the supported host/client ranges.`,
      repair: "Update the OpenCode plugin, native host, and extension together."
    });
  }

  return {
    client: {
      name: client.name,
      protocolMax: client.protocolMax,
      protocolMin: client.protocolMin,
      version: client.version
    },
    compatible: connected && protocolCompatible && missingCapabilities.length === 0 && diagnostics.length === 0,
    connected,
    diagnostics,
    extension,
    host: hostHandshake(),
    hostReachable: true,
    legacy: false,
    missingCapabilities,
    ok: true,
    pending: pending.size,
    pid: process.pid
  };
}

function hostHandshake() {
  return {
    name: HOST_NAME,
    protocolMax: HOST_PROTOCOL_MAX,
    protocolMin: HOST_PROTOCOL_MIN,
    version: HOST_VERSION
  };
}

function clientHandshake(headers, diagnostics) {
  const rawVersion = singleHeader(headers["x-opencode-bridge-client-version"]);
  const rawMin = singleHeader(headers["x-opencode-bridge-protocol-min"]);
  const rawMax = singleHeader(headers["x-opencode-bridge-protocol-max"]);
  const version = validVersionOrFallback(rawVersion, HOST_VERSION, diagnostics, "CLIENT_VERSION_INVALID");
  const protocolMin = validVersionOrFallback(rawMin, HOST_PROTOCOL_MIN, diagnostics, "CLIENT_PROTOCOL_INVALID");
  const protocolMax = validVersionOrFallback(rawMax, HOST_PROTOCOL_MAX, diagnostics, "CLIENT_PROTOCOL_INVALID");
  let requiredCapabilities = ["bridge.handshake"];
  const rawCapabilities = singleHeader(headers["x-opencode-bridge-capabilities"]);
  if (rawCapabilities !== null) {
    const parsed = rawCapabilities.split(",").filter(Boolean);
    if (rawCapabilities.length > 10_000 || parsed.length > 200 || parsed.some((entry) => !CAPABILITY_RE.test(entry))) {
      diagnostics.push({
        code: "CLIENT_CAPABILITIES_INVALID",
        message: "The client sent an invalid capability requirement list.",
        repair: "Update the OpenCode bridge plugin."
      });
      requiredCapabilities = ["bridge.invalid-client-capabilities"];
    } else {
      requiredCapabilities = [...new Set(["bridge.handshake", ...parsed])].sort();
    }
  }
  if (compareVersions(protocolMin, protocolMax) > 0) {
    diagnostics.push({
      code: "CLIENT_PROTOCOL_INVALID",
      message: "The client protocol range is invalid.",
      repair: "Update the OpenCode bridge plugin."
    });
    return {
      name: DEFAULT_CLIENT_NAME,
      protocolMax: "0.0.0",
      protocolMin: "0.0.0",
      requiredCapabilities,
      version
    };
  }
  return { name: DEFAULT_CLIENT_NAME, protocolMax, protocolMin, requiredCapabilities, version };
}

function normalizeExtensionHandshake(value, diagnostics) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(invalidExtensionDiagnostic());
    return incompatibleExtensionPlaceholder();
  }
  const capabilities = Array.isArray(value.capabilities)
    && value.capabilities.length <= 200
    && value.capabilities.every((entry) => typeof entry === "string" && CAPABILITY_RE.test(entry))
    ? [...new Set(value.capabilities)].sort()
    : null;
  const valid = typeof value.extensionId === "string" && value.extensionId.length > 0 && value.extensionId.length <= 256
    && VERSION_RE.test(value.extensionVersion)
    && typeof value.hostName === "string" && value.hostName === HOST_NAME
    && VERSION_RE.test(value.protocolVersion)
    && capabilities !== null;
  if (!valid) {
    diagnostics.push(invalidExtensionDiagnostic());
    return incompatibleExtensionPlaceholder();
  }
  return {
    capabilities,
    extensionId: value.extensionId,
    extensionName: typeof value.extensionName === "string" && value.extensionName.length <= 256
      ? value.extensionName
      : undefined,
    extensionVersion: value.extensionVersion,
    hostName: value.hostName,
    protocolVersion: value.protocolVersion
  };
}

function incompatibleExtensionPlaceholder() {
  return {
    capabilities: [],
    extensionId: "unknown",
    extensionVersion: "0.0.0",
    hostName: HOST_NAME,
    protocolVersion: "0.0.0"
  };
}

function invalidExtensionDiagnostic() {
  return {
    code: "EXTENSION_HANDSHAKE_INVALID",
    message: "The extension returned an invalid bridge handshake.",
    repair: "Update and reload the extension."
  };
}

function validVersionOrFallback(value, fallback, diagnostics, code) {
  if (value === null) return fallback;
  if (VERSION_RE.test(value)) return value;
  diagnostics.push({
    code,
    message: "The client sent a malformed bridge version.",
    repair: "Update the OpenCode bridge plugin."
  });
  return "0.0.0";
}

function singleHeader(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : "";
  return String(value);
}

function isVersionInRange(version, minimum, maximum) {
  return VERSION_RE.test(version)
    && compareVersions(version, minimum) >= 0
    && compareVersions(version, maximum) <= 0;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
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
      writeNativeMessage({ type: "cancel", id }).catch((error) => {
        log(`could not cancel timed-out Chrome command ${id}: ${error?.message ?? error}`);
      });
      reject(new CommandTimeoutError(`Timed out waiting for Chrome command ${method}`));
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
  return Math.max(1000, Math.min(parsed, 125000));
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

class CommandTimeoutError extends Error {}

class ExtensionCommandError extends Error {}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
