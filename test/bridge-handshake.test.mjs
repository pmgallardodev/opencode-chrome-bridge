import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  requireBridgeCapabilities,
  validateBridgeStatus
} from "../src/bridge-client.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function compatibleStatus(overrides = {}) {
  return {
    ok: true,
    connected: true,
    compatible: true,
    host: {
      name: "com.opencode.chrome_bridge",
      version: "1.1.0",
      protocolMin: "1.0.0",
      protocolMax: "1.0.0"
    },
    client: {
      name: "opencode-plugin",
      version: "1.1.0",
      protocolMin: "1.0.0",
      protocolMax: "1.0.0"
    },
    extension: {
      extensionId: "extension-id",
      extensionVersion: "1.1.0",
      hostName: "com.opencode.chrome_bridge",
      protocolVersion: "1.0.0",
      capabilities: ["bridge.handshake", "browser.tabs"]
    },
    missingCapabilities: [],
    diagnostics: [],
    ...overrides
  };
}

test("bridge status schema accepts supported ranges and capabilities", () => {
  const status = validateBridgeStatus(compatibleStatus());

  assert.equal(status.compatible, true);
  assert.deepEqual(status.extension.capabilities, ["bridge.handshake", "browser.tabs"]);
});

test("bridge status schema rejects malformed protocol versions", () => {
  const malformed = compatibleStatus({
    extension: {
      ...compatibleStatus().extension,
      protocolVersion: "latest"
    }
  });

  assert.throws(() => validateBridgeStatus(malformed), /extension protocol version/u);
});

test("required capabilities fail with sorted actionable names", async () => {
  const status = compatibleStatus({
    compatible: false,
    missingCapabilities: ["browser.windows", "browser.downloads"],
    diagnostics: [{
      code: "MISSING_CAPABILITIES",
      message: "The extension is missing required capabilities.",
      repair: "Reload the current extension build."
    }]
  });

  await assert.rejects(
    () => requireBridgeCapabilities(["browser.windows", "browser.downloads"], status),
    /browser\.downloads, browser\.windows.*Reload the current extension build\./su
  );
});

test("disconnected and incompatible extensions produce different failures", async () => {
  const disconnected = compatibleStatus({
    connected: false,
    compatible: false,
    extension: null,
    diagnostics: [{
      code: "EXTENSION_DISCONNECTED",
      message: "The Chrome extension is not connected.",
      repair: "Reload Chrome or reinstall the native host."
    }]
  });
  const incompatible = compatibleStatus({
    compatible: false,
    extension: {
      ...compatibleStatus().extension,
      protocolVersion: "2.0.0"
    },
    diagnostics: [{
      code: "PROTOCOL_INCOMPATIBLE",
      message: "The extension protocol is outside the supported range.",
      repair: "Update the extension and native host together."
    }]
  });

  await assert.rejects(
    () => requireBridgeCapabilities(["bridge.handshake"], disconnected),
    /not connected.*Reload Chrome/su
  );
  await assert.rejects(
    () => requireBridgeCapabilities(["bridge.handshake"], incompatible),
    /incompatible.*Update the extension and native host together/su
  );
});

test("popup renders compatibility diagnostics returned by the service worker", async () => {
  const source = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");
  const elements = new Map();
  for (const id of ["status", "statusText", "statusDetail", "version", "learnMore", "settingsButton", "copyrightLink"]) {
    elements.set(id, {
      classList: { toggle() {} },
      addEventListener() {},
      textContent: ""
    });
  }
  const response = compatibleStatus({
    compatible: false,
    diagnostics: [{
      code: "PROTOCOL_INCOMPATIBLE",
      message: "Protocol 2.0.0 is not supported.",
      repair: "Update the native host."
    }]
  });
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.1.0" }),
        sendMessage: async () => response
      },
      tabs: { create() {} }
    },
    document: { getElementById: (id) => elements.get(id) ?? null },
    globalThis: null,
    open() {},
    setTimeout() {}
  });
  context.globalThis = context;

  vm.runInContext(source, context, { filename: "extension/popup.js" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("statusText").textContent, "Update required");
  assert.equal(
    elements.get("statusDetail").textContent,
    "Protocol 2.0.0 is not supported. Update the native host."
  );
});
