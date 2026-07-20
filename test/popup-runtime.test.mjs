import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(path.resolve(import.meta.dirname, "../extension/popup.js"), "utf8");
const requiredPermissions = ["alarms", "debugger", "nativeMessaging", "notifications", "webNavigation"];
const requiredOrigins = ["<all_urls>"];

test("popup reports every sorted missing manifest permission and host origin", async () => {
  const rendered = await renderPopup({
    grantedPermissions: ["alarms", "nativeMessaging"],
    grantedOrigins: []
  });
  assert.equal(rendered.elements.get("statusText").textContent, "Update required");
  assert.match(rendered.elements.get("statusDetail").textContent, /debugger, notifications, webNavigation/u);
  assert.match(rendered.elements.get("statusDetail").textContent, /<all_urls>/u);
  assert.match(rendered.elements.get("repairCommand").textContent, /chrome:\/\/extensions/u);
  assert.deepEqual(rendered.containsCalls[0], {
    permissions: [...requiredPermissions].sort(),
    origins: [...requiredOrigins].sort()
  });
});

test("popup stays healthy when getAll and contains confirm the complete manifest grant", async () => {
  const rendered = await renderPopup({
    grantedPermissions: requiredPermissions,
    grantedOrigins: requiredOrigins
  });
  assert.equal(rendered.elements.get("statusText").textContent, "Connected");
  assert.equal(rendered.elements.get("statusDetail").textContent, "Ready for OpenCode browser tools");
  assert.equal(rendered.elements.get("repair").hidden, true);
});

async function renderPopup({ grantedPermissions, grantedOrigins }) {
  const elements = new Map();
  for (const id of [
    "status", "statusText", "statusDetail", "version", "learnMore", "settingsButton",
    "copyrightLink", "repair", "repairCommand", "repairLink"
  ]) {
    elements.set(id, {
      addEventListener() {},
      classList: { toggle() {} },
      hidden: id === "repair",
      textContent: ""
    });
  }
  const containsCalls = [];
  const manifest = {
    name: "OpenCode Chrome Bridge",
    version: "1.4.4",
    permissions: requiredPermissions,
    host_permissions: requiredOrigins
  };
  const response = {
    compatible: true,
    connected: true,
    diagnostics: [],
    extension: { capabilities: ["bridge.handshake", "browser.tabs"] },
    missingCapabilities: []
  };
  const context = vm.createContext({
    URL,
    chrome: {
      permissions: {
        async contains(query) {
          containsCalls.push(structuredClone(query));
          return query.permissions.every((entry) => grantedPermissions.includes(entry))
            && query.origins.every((entry) => grantedOrigins.includes(entry));
        },
        getAll: async () => ({ permissions: grantedPermissions, origins: grantedOrigins })
      },
      runtime: {
        getManifest: () => manifest,
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
  return { containsCalls, elements };
}
