import os from "node:os";
import path from "node:path";
import { open, writeFile } from "node:fs/promises";

const STATE_DIR = process.env.OPENCODE_CHROME_BRIDGE_STATE_DIR || path.join(os.homedir(), ".opencode", "chrome-bridge");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,256}$/u;
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
const ALLOWED_DATA_URL_MIME_TYPES = new Set(["image/png", "image/jpeg"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 35000;
const MAX_REQUEST_TIMEOUT_MS = 125000;

export async function readBridgeState() {
  const stateFile = await open(STATE_PATH, "r");
  let raw;
  try {
    const stateInfo = await stateFile.stat();
    if (process.platform !== "win32") {
      if ((stateInfo.mode & 0o077) !== 0) throw new Error("Bridge state file permissions are too broad");
      if (typeof process.getuid === "function" && stateInfo.uid !== process.getuid()) {
        throw new Error("Bridge state file is owned by another user");
      }
    }
    raw = await stateFile.readFile("utf8");
  } finally {
    await stateFile.close();
  }
  const state = JSON.parse(raw);
  if (state.host !== "127.0.0.1") throw new Error("Bridge state host is not local");
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    throw new Error("Bridge state has an invalid port");
  }
  if (typeof state.token !== "string" || !TOKEN_RE.test(state.token)) {
    throw new Error("Bridge state has an invalid token");
  }
  return state;
}

export async function bridgeStatus() {
  return request("GET", "/status");
}

export async function bridgeCommand(method, params = {}, options = {}) {
  const response = await request("POST", "/command", {
    method,
    params,
    timeoutMs: options.timeoutMs
  });
  return response.result;
}

export async function pollEvents(since = 0) {
  const sinceNum = Number.isFinite(Number(since)) ? Math.max(0, Math.floor(Number(since))) : 0;
  const params = new URLSearchParams({ since: String(sinceNum) });
  const response = await request("GET", `/events/poll?${params}`);
  return response;
}

export async function writeDataUrlToFile(dataUrl, outputPath) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/u.exec(dataUrl);
  if (!match) throw new Error("Screenshot response was not a data URL");
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_DATA_URL_MIME_TYPES.has(mimeType)) {
    throw new Error("Screenshot response used an unsupported MIME type");
  }
  const isBase64 = match[2] === ";base64";
  if (!isBase64) throw new Error("Screenshot response must use base64 encoding");
  const data = decodeBase64DataUrl(match[3]);
  validateImageSignature(data, mimeType);
  if (data.length > MAX_DATA_URL_BYTES) {
    throw new Error("Screenshot response is too large to write");
  }
  await writeFile(outputPath, data);
  return { bytes: data.length, mimeType, path: outputPath };
}

function decodeBase64DataUrl(value) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("Screenshot response contained invalid base64 data");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Screenshot response contained invalid base64 data");
  }
  return decoded;
}

function validateImageSignature(data, mimeType) {
  const valid = mimeType === "image/png"
    ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!valid) throw new Error(`Screenshot response did not contain a valid ${mimeType} signature`);
}

async function request(method, pathname, body) {
  const state = await readBridgeState();
  const url = `http://${state.host}:${state.port}${pathname}`;
  const timeoutMs = requestTimeoutMs(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Bridge request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `Bridge request failed with HTTP ${response.status}`);
  }
  return payload;
}

function requestTimeoutMs(body) {
  const commandTimeout = Number(body?.timeoutMs);
  if (Number.isFinite(commandTimeout) && commandTimeout > 0) {
    return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1000, commandTimeout + 1000));
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
