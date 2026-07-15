import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ALL_TOOL_REQUIRED_CAPABILITIES } from "../src/opencode-plugin.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const backgroundSource = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");

test("tab claims fail closed when session storage cannot be read", async () => {
  const harness = createBackgroundHarness({
    storageGet: async () => {
      throw new Error("session storage unavailable");
    }
  });

  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" }),
    /session storage unavailable/u
  );
});

test("tab claims fail closed when persisted lease data is malformed", async () => {
  const harness = createBackgroundHarness({
    storageGet: async () => ({
      opencodeTabLeases: {
        "7": { tabId: 7, sessionId: 42, turnId: "turn-a", origin: "user", state: "active" }
      }
    })
  });

  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
    /stored tab lease data is invalid/u
  );
});

test("loadTabLeases clears stale in-memory entries before repopulating", async () => {
  const firstLease = {
    claimedAt: Date.now(),
    origin: "user",
    sessionId: "session-a",
    state: "active",
    tabId: 7,
    turnId: "turn-a"
  };
  const secondLease = {
    claimedAt: Date.now(),
    origin: "agent",
    sessionId: "session-b",
    state: "active",
    tabId: 9,
    turnId: "turn-b"
  };
  let callCount = 0;
  const harness = createBackgroundHarness({
    storageGet: async () => {
      callCount += 1;
      if (callCount === 1) return { opencodeTabLeases: { "7": firstLease } };
      return { opencodeTabLeases: { "9": secondLease } };
    }
  });

  await harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" });
  // Force a second loadTabLeases call by resetting the memoization flag and
  // invoking loadTabLeases directly through the harness VM context.
  await harness.reloadTabLeases();
  // After the second load, tab 7 (no longer in storage) must not linger in
  // memory. A claim on tab 7 from a different session should succeed because
  // the in-memory map was cleared before repopulating with tab 9's lease.
  await harness.execute("claimTab", { tabId: 7, sessionId: "session-c", turnId: "turn-c", origin: "user" });
  // Tab 9 is now in memory from the second load, so a claim from another
  // session must be rejected.
  await assert.rejects(
    harness.execute("claimTab", { tabId: 9, sessionId: "session-d", turnId: "turn-d", origin: "user" }),
    /already part of browser session session-b/u
  );
});

test("tab lifecycle persistence failures preserve the previous fail-closed lease", async () => {
  const existingLease = {
    claimedAt: Date.now(),
    origin: "user",
    sessionId: "session-a",
    state: "active",
    tabId: 7,
    turnId: "turn-a"
  };
  const loggedErrors = [];
  const harness = createBackgroundHarness({
    storageGet: async () => ({ opencodeTabLeases: { "7": existingLease } }),
    storageSet: async () => {
      throw new Error("session storage write failed");
    },
    consoleError: (...args) => loggedErrors.push(args)
  });

  await harness.execute("endTurn", { sessionId: "unused", turnId: "unused" });
  // The tabs.onRemoved listener fires removeClosedTabLease as a fire-and-forget
  // promise (Chrome does not await returns from event listeners). Wait for the
  // background's tab-lease mutation queue to settle before asserting side effects.
  await harness.events.tabsOnRemoved.emit(7, { windowId: 1, isWindowClosing: false });
  await harness.awaitTabLeaseQueue();
  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
    /already part of browser session session-a/u
  );
  assert.match(String(loggedErrors[0]?.[0]), /could not persist tab lease cleanup/u);
});

test("endTurn keeps the active lease when persistence fails", async () => {
  let writeAttempts = 0;
  const harness = createBackgroundHarness({
    storageGet: async () => ({
      opencodeTabLeases: {
        "7": {
          claimedAt: Date.now(), origin: "user", sessionId: "session-a",
          state: "active", tabId: 7, turnId: "turn-a"
        }
      }
    }),
    storageSet: async () => {
      writeAttempts += 1;
      if (writeAttempts === 1) throw new Error("session storage write failed");
    }
  });

  await assert.rejects(
    harness.execute("endTurn", { sessionId: "session-a", turnId: "turn-a" }),
    /session storage write failed/u
  );
  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
    /already part of browser session session-a/u
  );
});

test("finalizeTabs does not report or release an agent tab that Chrome failed to close", async () => {
  const harness = createBackgroundHarness({
    tabsRemove: async () => { throw new Error("tab close denied"); }
  });
  await harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "agent" });

  await assert.rejects(
    harness.execute("finalizeTabs", { sessionId: "session-a", keep: [] }),
    /tab close denied/u
  );
  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
    /already part of browser session session-a/u
  );
});

test("keypress resolves text and virtual key codes so default actions fire", async () => {
  const keyEvents = [];
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchKeyEvent") keyEvents.push(params);
      return {};
    }
  });

  await harness.execute("keypress", { tabId: 7, key: "Enter" });
  assert.equal(keyEvents[0].type, "keyDown");
  assert.equal(keyEvents[0].text, "\r");
  assert.equal(keyEvents[0].windowsVirtualKeyCode, 13);
  assert.equal(keyEvents[1].type, "keyUp");
  assert.equal(keyEvents[1].text, undefined);

  keyEvents.length = 0;
  await harness.execute("keypress", { tabId: 7, key: "Shift" });
  assert.equal(keyEvents[0].type, "rawKeyDown");
  assert.equal(keyEvents[0].windowsVirtualKeyCode, 16);

  keyEvents.length = 0;
  await harness.execute("keypress", { tabId: 7, key: "KeyA" });
  assert.equal(keyEvents[0].type, "keyDown");
  assert.equal(keyEvents[0].key, "a");
  assert.equal(keyEvents[0].text, "a");
  assert.equal(keyEvents[0].windowsVirtualKeyCode, 65);

  keyEvents.length = 0;
  await harness.execute("keypress", { tabId: 7, key: "KeyA", modifiers: ["Shift"] });
  assert.equal(keyEvents[0].type, "keyDown");
  assert.equal(keyEvents[0].key, "A");
  assert.equal(keyEvents[0].text, "A");

  keyEvents.length = 0;
  await harness.execute("keypress", { tabId: 7, key: "KeyC", modifiers: ["Control"] });
  assert.equal(keyEvents[0].type, "rawKeyDown");
  assert.equal(keyEvents[0].key, "c");
  assert.equal(keyEvents[0].text, undefined);

  keyEvents.length = 0;
  await harness.execute("keypress", { tabId: 7, key: "UnknownNamedKey" });
  assert.equal(keyEvents[0].type, "rawKeyDown");
  assert.equal(keyEvents[0].key, "UnknownNamedKey");
  assert.equal(keyEvents[0].windowsVirtualKeyCode, undefined);
});

test("bridge status reports connected only after the native host sends a message", async () => {
  const harness = createBackgroundHarness();

  assert.equal(await harness.bridgeStatus(), false);
  await harness.events.nativeOnMessage.emit({ type: "event", event: { category: "bridge", type: "bridgeReady" } });
  assert.equal(await harness.bridgeStatus(), true);
});

test("extension handshake exposes a stable sorted capability contract", async () => {
  const harness = createBackgroundHarness();

  const result = await harness.execute("handshake", {});

  assert.equal(result.extensionId, "test-extension");
  assert.equal(result.extensionVersion, "1.1.0");
  assert.equal(result.hostName, "com.opencode.chrome_bridge");
  assert.match(result.protocolVersion, /^\d+\.\d+\.\d+$/u);
  assert.ok(result.capabilities.includes("bridge.handshake"));
  assert.equal(JSON.stringify(result.capabilities), JSON.stringify([...result.capabilities].sort()));
  assert.equal(new Set(result.capabilities).size, result.capabilities.length);
  assert.equal(JSON.stringify(result.capabilities), JSON.stringify(ALL_TOOL_REQUIRED_CAPABILITIES));
});

test("finalizeTabs releases the lease of an agent tab that already closed in a race", async () => {
  let tabGone = false;
  const harness = createBackgroundHarness({
    tabsRemove: async () => {
      tabGone = true;
      throw new Error("No tab with id: 7.");
    },
    tabsGet: async (tabId) => {
      if (tabGone && tabId === 7) throw new Error("No tab with id: 7.");
      return { active: true, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 };
    }
  });
  await harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "agent" });

  const result = await harness.execute("finalizeTabs", { sessionId: "session-a", keep: [] });
  assert.equal(JSON.stringify(result.closedTabIds), JSON.stringify([7]));

  // The stale lease must not block a future claim of the reused tab id.
  tabGone = false;
  await harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" });
});

test("navigate claims the tab when lease identifiers are provided", async () => {
  const harness = createBackgroundHarness();

  await harness.execute("navigate", {
    tabId: 7,
    url: "https://example.com/next",
    sessionId: "session-a",
    turnId: "turn-a"
  });
  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
    /already part of browser session session-a/u
  );
});

test("cdpCommand Target.getTargets returns CDP-shaped target infos", async () => {
  const harness = createBackgroundHarness();
  harness.setDebuggerTargets([
    { attached: true, id: "target-1", tabId: 7, title: "Example", type: "page", url: "https://example.com" }
  ]);

  const result = await harness.execute("cdpCommand", { method: "Target.getTargets" });

  assert.equal(JSON.stringify(result.targetInfos), JSON.stringify([{
    attached: true,
    canAccessOpener: false,
    targetId: "target-1",
    title: "Example",
    type: "page",
    url: "https://example.com"
  }]));
});

test("accessibilityTree injects the snapshot script and returns its result", async () => {
  const injections = [];
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      injections.push(injection);
      if (injection.files) return [];
      return [{
        result: { title: "Example", url: "https://example.com/", nodeCount: 2, truncated: false, tree: '[e1] button "Go"' }
      }];
    }
  });

  const result = await harness.execute("accessibilityTree", { tabId: 7 });

  assert.equal(result.tabId, 7);
  assert.equal(result.nodeCount, 2);
  assert.match(result.tree, /\[e1\] button/u);
  assert.ok(injections.some((injection) => Array.isArray(injection.files) && injection.target?.tabId === 7));
  const funcCall = injections.find((injection) => typeof injection.func === "function");
  assert.equal(funcCall.args[0].maxNodes, 800);
  assert.equal(funcCall.args[0].interactiveOnly, false);
});

test("tabContext injects the isolated page reader with bounded options", async () => {
  const injections = [];
  const contextResult = {
    dimensions: {
      document: { height: 2000, width: 1200 },
      viewport: { deviceScaleFactor: 2, height: 700, scrollX: 0, scrollY: 10, width: 1100 }
    },
    mimeType: "text/html",
    selectedElementRefs: ["e4"],
    selection: { refs: ["e4"], text: "Selected" },
    title: "Example",
    truncated: { selection: false, visibleText: false },
    url: "https://example.com/",
    visibleText: "Visible page text"
  };
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      injections.push(injection);
      return injection.files ? [] : [{ result: contextResult }];
    }
  });

  const result = await harness.execute("tabContext", {
    maxChars: 3210,
    maxSelectionChars: 456,
    tabId: 7
  });

  assert.equal(result.tabId, 7);
  assert.equal(result.visibleText, "Visible page text");
  assert.deepEqual([...result.selectedElementRefs], ["e4"]);
  assert.ok(injections.some((injection) => injection.files?.[0] === "content-scripts/a11y.js"));
  const funcCall = injections.find((injection) => typeof injection.func === "function");
  assert.deepEqual({ ...funcCall.args[0] }, { maxChars: 3210, maxSelectionChars: 456 });
});

test("readPage returns one combined context and accessibility result with an optional screenshot", async () => {
  const injections = [];
  const captures = [];
  const combined = {
    accessibility: {
      nodeCount: 1,
      title: "Example",
      tree: '[e1] button "Continue"',
      truncated: false,
      url: "https://example.com/"
    },
    context: {
      dimensions: {
        document: { height: 1200, width: 900 },
        viewport: { deviceScaleFactor: 1, height: 720, scrollX: 0, scrollY: 0, width: 900 }
      },
      mimeType: "text/html",
      selectedElementRefs: [],
      selection: { refs: [], text: "" },
      title: "Example",
      truncated: { selection: false, visibleText: false },
      url: "https://example.com/",
      visibleText: "Page text"
    }
  };
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      injections.push(injection);
      return injection.files ? [] : [{ result: combined }];
    },
    tabsCaptureVisibleTab: async (windowId, options) => {
      captures.push({ options, windowId });
      return "data:image/jpeg;base64,/9j/2Q==";
    }
  });

  const result = await harness.execute("readPage", {
    includeScreenshot: true,
    interactiveOnly: false,
    maxChars: 4000,
    maxNodes: 200,
    maxSelectionChars: 300,
    screenshotFormat: "jpeg",
    screenshotQuality: 72,
    tabId: 7
  });

  assert.equal(result.tabId, 7);
  assert.equal(result.context.visibleText, "Page text");
  assert.match(result.accessibility.tree, /Continue/u);
  assert.equal(result.screenshot.dataUrl, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(
    JSON.stringify(captures),
    JSON.stringify([{ options: { format: "jpeg", quality: 72 }, windowId: 1 }])
  );
  assert.equal(injections.filter((injection) => injection.files).length, 1);
  assert.equal(injections.filter((injection) => typeof injection.func === "function").length, 1);
  const funcCall = injections.find((injection) => typeof injection.func === "function");
  assert.deepEqual({ ...funcCall.args[0] }, {
    interactiveOnly: false,
    maxChars: 4000,
    maxNodes: 200,
    maxSelectionChars: 300
  });
});

test("readPage omits screenshot capture unless explicitly requested", async () => {
  let captures = 0;
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{
      result: {
        accessibility: { nodeCount: 0, tree: "", truncated: false },
        context: { visibleText: "Page text" }
      }
    }],
    tabsCaptureVisibleTab: async () => {
      captures += 1;
      return "data:image/png;base64,iVBORw0KGgo=";
    }
  });

  const result = await harness.execute("readPage", { tabId: 7 });

  assert.equal(result.screenshot, null);
  assert.equal(captures, 0);
});

test("tabContext and readPage fail closed on malformed isolated-world results", async () => {
  const malformedContext = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{ result: { visibleText: 42 } }]
  });
  await assert.rejects(
    malformedContext.execute("tabContext", { tabId: 7 }),
    /tab context result is invalid/u
  );

  const malformedRead = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files
      ? []
      : [{ result: { accessibility: null, context: null } }]
  });
  await assert.rejects(
    malformedRead.execute("readPage", { tabId: 7 }),
    /read page result is invalid/u
  );
});

test("clickElement locates the reference and clicks its center through CDP", async () => {
  const mouseEvents = [];
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent") mouseEvents.push(params);
      return {};
    },
    scriptingExecuteScript: async (injection) => injection.files
      ? []
      : [{ result: { found: true, visible: true, x: 40, y: 60, width: 120, height: 32, role: "button", name: "Go" } }]
  });

  const result = await harness.execute("clickElement", { tabId: 7, ref: "e1" });

  assert.equal(result.clicked, true);
  assert.equal(result.ref, "e1");
  assert.equal(result.role, "button");
  assert.ok(mouseEvents.some((event) => event.type === "mousePressed" && event.x === 40 && event.y === 60));
});

test("clickElement rejects stale element references", async () => {
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{ result: { found: false } }]
  });

  await assert.rejects(
    harness.execute("clickElement", { tabId: 7, ref: "e99" }),
    /was not found/u
  );
});

test("clickElement rejects hidden or zero-size elements", async () => {
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files
      ? []
      : [{ result: { found: true, visible: false, x: 0, y: 0, width: 0, height: 0 } }]
  });

  await assert.rejects(
    harness.execute("clickElement", { tabId: 7, ref: "e2" }),
    /is not visible/u
  );
});

test("fillElement rejects non-editable or unfocusable elements", async () => {
  const nonEditable = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files
      ? []
      : [{ result: { found: true, editable: false, focused: false } }]
  });
  await assert.rejects(
    nonEditable.execute("fillElement", { tabId: 7, ref: "e2", text: "x" }),
    /not an editable field/u
  );

  const unfocusable = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files
      ? []
      : [{ result: { found: true, editable: true, focused: false } }]
  });
  await assert.rejects(
    unfocusable.execute("fillElement", { tabId: 7, ref: "e2", text: "x" }),
    /could not be focused/u
  );
});

test("fillElement focuses the reference and inserts the text", async () => {
  const inserted = [];
  let scriptCalls = 0;
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.insertText") inserted.push(params.text);
      return {};
    },
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      scriptCalls += 1;
      return scriptCalls === 1
        ? [{ result: { found: true, editable: true, focused: true } }]
        : [{ result: { found: true, verified: true } }];
    }
  });

  const result = await harness.execute("fillElement", { tabId: 7, ref: "e3", text: "hello world" });

  assert.equal(result.filled, true);
  assert.equal(result.cleared, true);
  assert.equal(JSON.stringify(inserted), JSON.stringify(["hello world"]));
});

test("fillElement fails instead of reporting success when the value did not change", async () => {
  let scriptCalls = 0;
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      scriptCalls += 1;
      return scriptCalls === 1
        ? [{ result: { found: true, editable: true, focused: true } }]
        : [{ result: { found: true, verified: false } }];
    }
  });

  await assert.rejects(
    harness.execute("fillElement", { tabId: 7, ref: "e3", text: "hello world" }),
    /did not update the field/u
  );
});

test("navigation respects blockedUrlPatterns from extension storage", async () => {
  const harness = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: ["example.com/admin/*", "blocked.test"] })
  });

  await assert.rejects(
    harness.execute("navigate", { tabId: 7, url: "https://www.example.com/Admin/settings" }),
    /blocked by policy/u
  );
  await assert.rejects(
    harness.execute("createTab", { url: "https://blocked.test/anything" }),
    /blocked by policy/u
  );
  const allowed = await harness.execute("navigate", { tabId: 7, url: "https://example.com/public" });
  assert.equal(allowed.url, "https://example.com/public");

  const patterns = await harness.execute("getBlockedUrlPatterns", {});
  assert.equal(JSON.stringify(patterns.patterns), JSON.stringify(["example.com/admin/*", "blocked.test"]));
});

test("navigation policy fails closed when configured storage cannot be read", async () => {
  const harness = createBackgroundHarness({
    storageLocalGet: async () => { throw new Error("local storage unavailable"); }
  });

  await assert.rejects(
    harness.execute("navigate", { tabId: 7, url: "https://example.com/public" }),
    /Could not read blockedUrlPatterns from local storage/u
  );
});

test("navigation policy fails closed when configured storage is malformed", async () => {
  const harness = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: "example.com/admin" })
  });

  await assert.rejects(
    harness.execute("navigate", { tabId: 7, url: "https://example.com/public" }),
    /blockedUrlPatterns in local storage must be an array/u
  );
});

test("navigation policy rejects null and empty normalized patterns", async () => {
  const nullPolicy = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: null })
  });
  await assert.rejects(
    nullPolicy.execute("navigate", { tabId: 7, url: "https://example.com/public" }),
    /blockedUrlPatterns in local storage must be an array/u
  );

  const emptyPattern = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: ["https://"] })
  });
  await assert.rejects(
    emptyPattern.execute("navigate", { tabId: 7, url: "https://example.com/public" }),
    /contains an invalid pattern/u
  );
});

test("navigation policy reads managed storage fail closed", async () => {
  const harness = createBackgroundHarness({
    storageManagedGet: async () => { throw new Error("managed policy unavailable"); }
  });

  await assert.rejects(
    harness.execute("navigate", { tabId: 7, url: "https://example.com/public" }),
    /Could not read blockedUrlPatterns from managed storage/u
  );
});

test("navigation patterns canonicalize trailing slashes and encoded paths", async () => {
  const trailingSlash = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: ["example.com/admin/"] })
  });
  await assert.rejects(
    trailingSlash.execute("navigate", { tabId: 7, url: "https://example.com/admin/settings" }),
    /blocked by policy/u
  );

  const encodedPath = createBackgroundHarness({
    storageLocalGet: async () => ({ blockedUrlPatterns: ["example.com/admin"] })
  });
  await assert.rejects(
    encodedPath.execute("navigate", { tabId: 7, url: "https://example.com/%61dmin/settings" }),
    /blocked by policy/u
  );
});

test("click makes overlay controls transparent until input cleanup completes", async () => {
  const harness = createBackgroundHarness();

  await harness.execute("click", { tabId: 7, x: 20, y: 30 });

  assert.equal(
    JSON.stringify(harness.calls.overlayMessages.map((message) => message.type)),
    JSON.stringify(["agent-input-start", "cursor-click", "agent-input-end"])
  );
});

test("click restores overlay input handling after a CDP failure", async () => {
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        throw new Error("click failed");
      }
      return {};
    }
  });

  await assert.rejects(
    harness.execute("click", { tabId: 7, x: 20, y: 30 }),
    /click failed/u
  );
  assert.equal(harness.calls.overlayMessages.at(-1)?.type, "agent-input-end");
});

test("stop requests from the page are forwarded as bridge events", async () => {
  const harness = createBackgroundHarness();
  let response;

  await harness.events.runtimeOnMessage.emit({ type: "STOP_AGENT_REQUEST" }, { tab: { id: 7 } }, (value) => { response = value; });

  assert.equal(response?.ok, true);
  assert.ok(harness.calls.nativeMessages.some(
    (message) => message.type === "event" && message.event?.type === "stopRequested" && message.event.tabId === 7
  ));
});

test("bridge status verifies a ready host with a ping round trip", async () => {
  const harness = createBackgroundHarness();
  await harness.events.nativeOnMessage.emit({ type: "event", event: { type: "bridgeReady" } });

  assert.equal(await harness.bridgeStatus(), true);
  assert.ok(harness.calls.nativeMessages.some((message) => message.type === "ping"));
});

test("bridge status reports disconnected when a ready native host does not answer ping", async () => {
  const harness = createBackgroundHarness();
  await harness.events.nativeOnMessage.emit({ type: "event", event: { type: "bridgeReady" } });

  assert.equal(await harness.bridgeStatus({ answerPing: false }), false);
});

test("unsubscribing CDP events preserves persistent console collection", async () => {
  const harness = createBackgroundHarness();

  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("subscribeCdpEvents", { tabId: 7, methods: ["Network.responseReceived"] });
  await harness.execute("unsubscribeCdpEvents", { tabId: 7 });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Console.messageAdded",
    { message: { level: "error", text: "still captured" } }
  );

  const result = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(result.attached, true);
  assert.equal(result.count, 1);
  assert.equal(result.logs[0].text, "still captured");
});

test("console logs and forwarded CDP events are bounded before buffering or native messaging", async () => {
  const harness = createBackgroundHarness();
  const oversizedText = "x".repeat(600_000);

  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Console.messageAdded",
    { message: { level: "error", text: oversizedText } }
  );

  const result = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(result.logs[0].text.length, 20_000);
  assert.equal(harness.calls.nativeMessages.length, 0, "oversized CDP events must not reach native messaging");
});

test("CDP subscriptions enforce a per-tab total limit across repeated calls", async () => {
  const harness = createBackgroundHarness();
  const firstBatch = Array.from({ length: 100 }, (_, index) => `Domain.event${index}`);

  await harness.execute("subscribeCdpEvents", { tabId: 7, methods: firstBatch });
  await assert.rejects(
    harness.execute("subscribeCdpEvents", { tabId: 7, methods: ["Other.extra"] }),
    /at most 100 CDP methods per tab/u
  );
});

test("CDP unsubscription batches are bounded", async () => {
  const harness = createBackgroundHarness();
  const methods = Array.from({ length: 101 }, (_, index) => `Domain.event${index}`);

  await assert.rejects(
    harness.execute("unsubscribeCdpEvents", { tabId: 7, methods }),
    /at most 100 CDP methods/u
  );
});

test("CDP command names enforce the same bounded format as subscriptions", async () => {
  const harness = createBackgroundHarness();
  const oversizedMethod = `${"A".repeat(100)}.method`;

  await assert.rejects(
    harness.execute("cdpCommand", { tabId: 7, method: oversizedMethod, commandParams: {} }),
    /CDP method string/u
  );
});

test("navigation permits about:blank but rejects other about aliases", async () => {
  const harness = createBackgroundHarness();

  const blank = await harness.execute("navigate", { tabId: 7, url: "about:blank" });
  assert.equal(blank.url, "about:blank");
  await assert.rejects(
    harness.execute("navigate", { tabId: 7, url: "about:settings" }),
    /only about:blank is allowed/u
  );
});

test("move sequences inject the overlay once and bound total interpolated events", async () => {
  const harness = createBackgroundHarness();

  await harness.execute("moveSequence", {
    tabId: 7,
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    steps: 3,
    stepDelayMs: 0,
    drag: false
  });
  assert.equal(harness.calls.executeScript, 1);
  assert.ok(harness.calls.sendMessage > 1);

  const excessivePoints = Array.from({ length: 6 }, (_, index) => ({ x: index, y: index }));
  await assert.rejects(
    harness.execute("moveSequence", {
      tabId: 7,
      points: excessivePoints,
      steps: 500,
      stepDelayMs: 0,
      drag: false
    }),
    /too many interpolated events/u
  );
});

test("oversized screenshot payloads fail inside the extension before native messaging", async () => {
  const oversizedBase64 = "A".repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4);
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => method === "Page.captureScreenshot"
      ? { data: oversizedBase64 }
      : {}
  });

  await assert.rejects(
    harness.execute("screenshotRegion", {
      tabId: 7,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      format: "png"
    }),
    /screenshot response is too large/u
  );
});

test("drag sequences release the mouse button when movement fails", async () => {
  let pressed = false;
  let released = false;
  let failed = false;
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method !== "Input.dispatchMouseEvent") return {};
      if (params.type === "mousePressed") pressed = true;
      if (params.type === "mouseReleased") released = true;
      if (pressed && params.type === "mouseMoved" && !failed) {
        failed = true;
        throw new Error("tab navigated during drag");
      }
      return {};
    }
  });

  await assert.rejects(
    harness.execute("moveSequence", {
      tabId: 7,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      steps: 2,
      stepDelayMs: 0,
      drag: true
    }),
    /tab navigated during drag/u
  );
  assert.equal(released, true, "a failed drag must send mouseReleased in cleanup");
});

test("click and keypress retry release events after a partial input failure", async () => {
  let mouseReleaseAttempts = 0;
  let keyUpAttempts = 0;
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        mouseReleaseAttempts += 1;
        if (mouseReleaseAttempts === 1) throw new Error("mouse release interrupted");
      }
      if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
        keyUpAttempts += 1;
        if (keyUpAttempts === 1) throw new Error("key release interrupted");
      }
      return {};
    }
  });

  await assert.rejects(
    harness.execute("click", { tabId: 7, x: 1, y: 2, button: "left" }),
    /mouse release interrupted/u
  );
  await assert.rejects(
    harness.execute("keypress", { tabId: 7, key: "Shift" }),
    /key release interrupted/u
  );
  assert.equal(mouseReleaseAttempts, 2);
  assert.equal(keyUpAttempts, 2);
});

test("oversized command results are rejected before native messaging", async () => {
  const oversizedResult = "x".repeat(16 * 1024 * 1024);
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => method === "Runtime.evaluate"
      ? { result: { type: "string", value: oversizedResult } }
      : {}
  });

  await harness.events.nativeOnMessage.emit({
    type: "command",
    id: "large-response",
    method: "evaluate",
    params: { tabId: 7, expression: "largeValue" }
  });

  assert.equal(harness.calls.nativeMessages.length, 1);
  assert.equal(harness.calls.nativeMessages[0].ok, false);
  assert.match(harness.calls.nativeMessages[0].error, /too large/u);
});

test("window state reports the populated tab count", async () => {
  const getCalls = [];
  const harness = createBackgroundHarness({
    windowsGet: async (windowId, getInfo) => {
      getCalls.push({ windowId, getInfo });
      return {
        id: windowId,
        focused: true,
        tabs: getInfo?.populate ? [{ id: 1 }, { id: 2 }] : undefined
      };
    }
  });

  const result = await harness.execute("getWindowState", { windowId: 3 });

  assert.equal(result.tabsCount, 2);
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].windowId, 3);
  assert.equal(getCalls[0].getInfo?.populate, true);
});

test("setting window state returns the populated tab count", async () => {
  const harness = createBackgroundHarness({
    windowsGet: async (windowId, getInfo) => ({
      id: windowId,
      state: "maximized",
      tabs: getInfo?.populate ? [{ id: 1 }, { id: 2 }, { id: 3 }] : undefined
    })
  });

  const result = await harness.execute("setWindowState", { windowId: 4, state: "maximized" });

  assert.equal(result.tabsCount, 3);
});

test("failed CDP domain enables are retried on the next console request", async () => {
  let consoleEnableAttempts = 0;
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Console.enable") {
        consoleEnableAttempts += 1;
        if (consoleEnableAttempts === 1) throw new Error("target was temporarily unavailable");
      }
      return {};
    }
  });

  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("getConsoleLogs", { tabId: 7 });

  assert.equal(consoleEnableAttempts, 2);
});

test("a native disconnect while replying does not create an unhandled command rejection", async () => {
  const harness = createBackgroundHarness({
    nativePostMessage: () => {
      throw new Error("native port disconnected");
    }
  });

  await assert.doesNotReject(() => harness.events.nativeOnMessage.emit({
    type: "command",
    id: "disconnect-race",
    method: "status",
    params: {}
  }));
});

test("showDownload opens the default folder when downloadId is omitted", async () => {
  let defaultFolderCalls = 0;
  const harness = createBackgroundHarness({
    downloadsShowDefaultFolder: async () => { defaultFolderCalls += 1; }
  });

  const result = await harness.execute("showDownload", {});

  assert.equal(result.showed, "defaultFolder");
  assert.equal(defaultFolderCalls, 1);
});

test("tab creation rejects partial lease identifiers before opening a tab", async () => {
  let createCalls = 0;
  const harness = createBackgroundHarness({
    tabsCreate: async () => { createCalls += 1; return { id: 8 }; }
  });

  await assert.rejects(
    harness.execute("createTab", { url: "about:blank", sessionId: "session-a" }),
    /sessionId and turnId must be provided together/u
  );
  assert.equal(createCalls, 0);
});

test("window creation rejects empty lease identifiers before opening a window", async () => {
  let createCalls = 0;
  const harness = createBackgroundHarness({
    windowsCreate: async () => { createCalls += 1; return { id: 2, tabs: [] }; }
  });

  await assert.rejects(
    harness.execute("createWindow", { sessionId: "", turnId: "turn-a" }),
    /sessionId must be a non-empty string/u
  );
  assert.equal(createCalls, 0);
});

function createBackgroundHarness({
  storageGet = async () => ({}),
  storageSet = async () => {},
  debuggerSendCommand = async () => ({}),
  consoleError = () => {},
  downloadsShowDefaultFolder = async () => {},
  nativePostMessage = null,
  scriptingExecuteScript = null,
  storageLocalGet = async () => ({}),
  storageManagedGet = null,
  tabsCaptureVisibleTab = async () => "data:image/png;base64,iVBORw0KGgo=",
  tabsCreate = async () => ({ active: false, id: 8, index: 0, title: "", url: "about:blank", windowId: 1 }),
  tabsGet = async (tabId) => ({ active: true, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 }),
  tabsRemove = async () => {},
  windowsCreate = async () => ({ id: 2, tabs: [] }),
  windowsGet = async (windowId) => ({ id: windowId })
} = {}) {
  const calls = { executeScript: 0, nativeMessages: [], overlayMessages: [], sendMessage: 0 };
  let debuggerTargets = [];
  const events = {
    debuggerOnDetach: createEvent(),
    debuggerOnEvent: createEvent(),
    nativeOnMessage: createEvent(),
    runtimeOnMessage: createEvent(),
    tabsOnRemoved: createEvent(),
    tabsOnReplaced: createEvent()
  };
  const nativePort = {
    onDisconnect: createEvent(),
    onMessage: events.nativeOnMessage,
    postMessage(message) {
      if (nativePostMessage) return nativePostMessage(message);
      calls.nativeMessages.push(message);
    }
  };
  const storage = {
    local: { get: storageLocalGet },
    session: {
      get: storageGet,
      set: storageSet
    }
  };
  if (storageManagedGet) storage.managed = { get: storageManagedGet };
  const chrome = {
    alarms: {
      clear: async () => true,
      create: async () => {},
      onAlarm: createEvent()
    },
    bookmarks: { search: async () => [] },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      getTargets: async () => debuggerTargets,
      onDetach: events.debuggerOnDetach,
      onEvent: events.debuggerOnEvent,
      sendCommand: debuggerSendCommand
    },
    downloads: {
      onChanged: createEvent(),
      onCreated: createEvent(),
      search: async () => [],
      showDefaultFolder: downloadsShowDefaultFolder
    },
    history: { search: async () => [] },
    runtime: {
      connectNative: () => nativePort,
      getManifest: () => ({ name: "OpenCode Chrome Bridge", version: "1.1.0" }),
      id: "test-extension",
      onInstalled: createEvent(),
      onMessage: events.runtimeOnMessage,
      onStartup: createEvent()
    },
    scripting: {
      executeScript: async (injection) => {
        calls.executeScript += 1;
        return scriptingExecuteScript ? scriptingExecuteScript(injection) : [];
      }
    },
    storage,
    tabGroups: { onCreated: createEvent(), onMoved: createEvent(), onRemoved: createEvent(), onUpdated: createEvent() },
    tabs: {
      captureVisibleTab: tabsCaptureVisibleTab,
      create: tabsCreate,
      get: tabsGet,
      onActivated: createEvent(),
      onCreated: createEvent(),
      onRemoved: events.tabsOnRemoved,
      onReplaced: events.tabsOnReplaced,
      onUpdated: createEvent(),
      query: async () => [],
      remove: tabsRemove,
      sendMessage: async (_tabId, message) => {
        calls.sendMessage += 1;
        calls.overlayMessages.push(message);
      },
      update: async (tabId, update) => ({ active: true, id: tabId, index: 0, title: "Example", url: update.url, windowId: 1 })
    },
    windows: {
      create: windowsCreate,
      get: windowsGet,
      getCurrent: async () => ({ id: 1 }),
      onFocusChanged: createEvent(),
      update: async (windowId) => ({ id: windowId })
    }
  };
  const harnessConsole = Object.create(console);
  harnessConsole.error = consoleError;
  const context = vm.createContext({
    chrome,
    console: harnessConsole,
    navigator: { platform: "MacIntel" },
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL
  });
  vm.runInContext(backgroundSource, context, { filename: "extension/background.js" });

  return {
    calls,
    events,
    setDebuggerTargets(targets) {
      debuggerTargets = targets;
    },
    async bridgeStatus({ answerPing = true } = {}) {
      let response;
      const answeredPings = new Set();
      await events.runtimeOnMessage.emit({ type: "GET_BRIDGE_STATUS" }, {}, (value) => { response = value; });
      // Ready hosts are verified with a ping round trip; answer it so the
      // asynchronous sendResponse can settle.
      for (let attempt = 0; attempt < 50 && response === undefined; attempt += 1) {
        if (answerPing) {
          const ping = [...calls.nativeMessages].reverse().find((message) => message.type === "ping");
          if (ping && !answeredPings.has(ping.id)) {
            answeredPings.add(ping.id);
            await events.nativeOnMessage.emit({ type: "pong", id: ping.id });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return response?.connected === true;
    },
    execute(method, params) {
      context.__testMethod = method;
      context.__testParams = params;
      return vm.runInContext("executeCommand(__testMethod, __testParams)", context);
    },
    reloadTabLeases() {
      return vm.runInContext(
        "tabLeasesLoaded = false; tabLeasesLoadPromise = null; loadTabLeases()",
        context
      );
    },
    awaitTabLeaseQueue() {
      return vm.runInContext("tabLeaseMutationQueue", context);
    }
  };
}

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    }
  };
}
