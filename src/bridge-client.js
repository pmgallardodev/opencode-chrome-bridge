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
export const BRIDGE_CLIENT_VERSION = "1.1.0";
export const BRIDGE_PROTOCOL_MIN = "1.0.0";
export const BRIDGE_PROTOCOL_MAX = "1.0.0";
const DEFAULT_REQUIRED_CAPABILITIES = Object.freeze(["bridge.handshake"]);
const VERSION_RE = /^\d+\.\d+\.\d+$/u;
const CAPABILITY_RE = /^[a-z][a-z0-9.-]{0,99}$/u;

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
  const payload = await request("GET", "/status", undefined, {
    "X-OpenCode-Bridge-Capabilities": DEFAULT_REQUIRED_CAPABILITIES.join(","),
    "X-OpenCode-Bridge-Client-Version": BRIDGE_CLIENT_VERSION,
    "X-OpenCode-Bridge-Protocol-Max": BRIDGE_PROTOCOL_MAX,
    "X-OpenCode-Bridge-Protocol-Min": BRIDGE_PROTOCOL_MIN
  });
  return validateBridgeStatus(payload);
}

export function validateBridgeStatus(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Bridge status must be an object");
  }
  if (payload.ok !== true) throw new Error("Bridge status did not report success");
  if (typeof payload.connected !== "boolean") throw new Error("Bridge status connected must be a boolean");
  if (typeof payload.compatible !== "boolean") throw new Error("Bridge status compatible must be a boolean");
  const host = validatePeer(payload.host, "host");
  const client = validatePeer(payload.client, "client");
  const extension = payload.extension === null ? null : validateExtension(payload.extension);
  const missingCapabilities = validateCapabilityList(payload.missingCapabilities, "missing capabilities");
  const diagnostics = validateDiagnostics(payload.diagnostics);

  if (payload.connected && extension === null) {
    throw new Error("Connected bridge status must include the extension handshake");
  }
  if (!payload.connected && extension !== null) {
    throw new Error("Disconnected bridge status must not include an extension handshake");
  }
  if (extension !== null) {
    if (extension.hostName !== host.name) {
      throw new Error("Bridge status extension host name does not match the native host");
    }
    const protocolCompatible = isVersionInRange(extension.protocolVersion, host.protocolMin, host.protocolMax)
      && isVersionInRange(extension.protocolVersion, client.protocolMin, client.protocolMax);
    const expectedCompatible = protocolCompatible && missingCapabilities.length === 0 && diagnostics.length === 0;
    if (payload.compatible !== expectedCompatible) {
      throw new Error("Bridge status compatibility is inconsistent with the negotiated protocol, capabilities, or diagnostics");
    }
  } else if (payload.compatible) {
    throw new Error("Disconnected bridge status cannot be compatible");
  }

  return {
    ...payload,
    client,
    diagnostics,
    extension,
    host,
    missingCapabilities
  };
}

export async function requireBridgeCapabilities(requiredCapabilities, suppliedStatus) {
  const required = validateCapabilityList(requiredCapabilities, "required capabilities");
  const status = validateBridgeStatus(suppliedStatus ?? await bridgeStatus());
  const repair = status.diagnostics
    .map((diagnostic) => diagnostic.repair)
    .filter(Boolean)
    .join(" ");
  if (!status.connected) {
    throw new Error(`OpenCode Chrome Bridge is not connected. ${repair || "Reload Chrome or reinstall the native host."}`);
  }
  const available = new Set(status.extension.capabilities);
  const missing = [...new Set([
    ...status.missingCapabilities,
    ...required.filter((capability) => !available.has(capability))
  ])].sort();
  if (!status.compatible || missing.length > 0) {
    const detail = missing.length > 0 ? ` Missing capabilities: ${missing.join(", ")}.` : "";
    throw new Error(`OpenCode Chrome Bridge is incompatible.${detail} ${repair || "Update the extension and native host together."}`);
  }
  return status;
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

async function request(method, pathname, body, extraHeaders = {}) {
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
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders
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

function validatePeer(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Bridge status ${label} must be an object`);
  }
  const name = requireBoundedString(value.name, `${label} name`, 1, 128);
  const version = requireVersion(value.version, `${label} version`);
  const protocolMin = requireVersion(value.protocolMin, `${label} protocol minimum`);
  const protocolMax = requireVersion(value.protocolMax, `${label} protocol maximum`);
  if (compareVersions(protocolMin, protocolMax) > 0) {
    throw new Error(`Bridge status ${label} protocol range is invalid`);
  }
  return { name, version, protocolMin, protocolMax };
}

function validateExtension(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridge status extension must be an object");
  }
  return {
    capabilities: validateCapabilityList(value.capabilities, "extension capabilities"),
    extensionId: requireBoundedString(value.extensionId, "extension id", 1, 256),
    extensionName: value.extensionName == null
      ? undefined
      : requireBoundedString(value.extensionName, "extension name", 1, 256),
    extensionVersion: requireVersion(value.extensionVersion, "extension version"),
    hostName: requireBoundedString(value.hostName, "extension host name", 1, 128),
    protocolVersion: requireVersion(value.protocolVersion, "extension protocol version")
  };
}

function validateCapabilityList(value, label) {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`Bridge status ${label} must be a bounded array`);
  const capabilities = value.map((entry) => {
    if (typeof entry !== "string" || !CAPABILITY_RE.test(entry)) {
      throw new Error(`Bridge status ${label} contains an invalid capability`);
    }
    return entry;
  });
  return [...new Set(capabilities)].sort();
}

function validateDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Bridge status diagnostics must be a bounded array");
  return value.map((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
      throw new Error("Bridge status diagnostic must be an object");
    }
    return {
      code: requireBoundedString(diagnostic.code, "diagnostic code", 1, 100),
      message: requireBoundedString(diagnostic.message, "diagnostic message", 1, 1000),
      repair: diagnostic.repair == null
        ? undefined
        : requireBoundedString(diagnostic.repair, "diagnostic repair", 1, 1000)
    };
  });
}

function requireVersion(value, label) {
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    throw new Error(`Bridge status ${label} is invalid`);
  }
  return value;
}

function requireBoundedString(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`Bridge status ${label} is invalid`);
  }
  return value;
}

function isVersionInRange(version, minimum, maximum) {
  return compareVersions(version, minimum) >= 0 && compareVersions(version, maximum) <= 0;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requestTimeoutMs(body) {
  const commandTimeout = Number(body?.timeoutMs);
  if (Number.isFinite(commandTimeout) && commandTimeout > 0) {
    return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1000, commandTimeout + 1000));
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
