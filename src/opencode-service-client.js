// Minimal client for the OpenCode 2 local service API.
//
// OpenCode 1 handed tools a `context.ask()` helper that raised the native
// "allow once / allow always / deny" prompt. OpenCode 2 dropped that helper from
// the tool context, but the same permission engine is still reachable over the
// local HTTP API (`POST /api/session/{id}/permission`). Rebuilding `ask()` on
// top of it keeps the plugin's deny-by-default policy intact instead of
// silently downgrading it.
//
// The service publishes its URL and password in a state file, exactly as
// @opencode-ai/client's service discovery does; the plugin runs inside that same
// server process, so the call never leaves the machine.
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const HEALTH_TIMEOUT_MS = 5000;
const SERVICE_USERNAME = "opencode";

export function serviceRegistrationPath(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "opencode", "service.json");
}

export function serviceAuthorizationHeader(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("OpenCode service registration is missing a password");
  }
  return `Basic ${Buffer.from(`${SERVICE_USERNAME}:${password}`).toString("base64")}`;
}

export async function readServiceRegistration({
  file = serviceRegistrationPath(),
  read = readFile
} = {}) {
  let raw;
  try {
    raw = await read(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`OpenCode service registration not found at ${file}`);
    }
    throw error;
  }
  const registration = JSON.parse(raw);
  const url = registration?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("OpenCode service registration is missing a url");
  }
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") {
    throw new Error("OpenCode service registration url is not local");
  }
  return { url: parsed.origin, authorization: serviceAuthorizationHeader(registration?.password) };
}

// Resolved once per plugin process: the registration file only changes when the
// background service restarts, which also restarts the plugin.
let endpointPromise = null;

export function resetServiceEndpointCache() {
  endpointPromise = null;
}

export async function resolveServiceEndpoint(options = {}) {
  endpointPromise ??= probeServiceEndpoint(options);
  try {
    return await endpointPromise;
  } catch (error) {
    endpointPromise = null;
    throw error;
  }
}

async function probeServiceEndpoint({ fetchImpl = fetch, ...readOptions } = {}) {
  const endpoint = await readServiceRegistration(readOptions);
  const response = await fetchImpl(`${endpoint.url}/api/health`, {
    headers: { authorization: endpoint.authorization },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`OpenCode service health check failed with status ${response.status}`);
  }
  return endpoint;
}

// Blocks until the user answers, mirroring OpenCode 1's context.ask(). Returns
// nothing on approval and throws on denial so callers can stay written as
// `await context.ask(...)`.
export async function requestPermission(request, options = {}) {
  const { fetchImpl = fetch } = options;
  const endpoint = await resolveServiceEndpoint(options);
  const { sessionID, ...body } = request;
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new Error("OpenCode permission requests require a session id");
  }
  const response = await fetchImpl(
    `${endpoint.url}/api/session/${encodeURIComponent(sessionID)}/permission`,
    {
      method: "POST",
      headers: { authorization: endpoint.authorization, "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  if (response.status === 404) {
    throw new Error(
      `Permission request for ${body.action} could not reach session ${sessionID}. `
      + "The OpenCode Chrome Bridge needs the shared background service; "
      + "sessions started with --standalone cannot approve browser access."
    );
  }
  if (!response.ok) {
    throw new Error(`Permission request for ${body.action} failed with status ${response.status}`);
  }
  const payload = await response.json();
  const effect = payload?.data?.effect ?? payload?.effect;
  if (effect !== "allow") {
    throw new Error(`Permission denied for ${body.action}`);
  }
}
