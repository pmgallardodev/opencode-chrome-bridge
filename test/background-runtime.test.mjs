import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

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
  tabsCreate = async () => ({ active: false, id: 8, index: 0, title: "", url: "about:blank", windowId: 1 }),
  tabsRemove = async () => {},
  windowsCreate = async () => ({ id: 2, tabs: [] }),
  windowsGet = async (windowId) => ({ id: windowId })
} = {}) {
  const calls = { executeScript: 0, nativeMessages: [], sendMessage: 0 };
  const events = {
    debuggerOnDetach: createEvent(),
    debuggerOnEvent: createEvent(),
    nativeOnMessage: createEvent(),
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
      getTargets: async () => [],
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
      id: "test-extension",
      onInstalled: createEvent(),
      onMessage: createEvent(),
      onStartup: createEvent()
    },
    scripting: { executeScript: async () => { calls.executeScript += 1; return []; } },
    storage: {
      session: {
        get: storageGet,
        set: storageSet
      }
    },
    tabGroups: { onCreated: createEvent(), onMoved: createEvent(), onRemoved: createEvent(), onUpdated: createEvent() },
    tabs: {
      create: tabsCreate,
      get: async (tabId) => ({ active: true, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 }),
      onActivated: createEvent(),
      onCreated: createEvent(),
      onRemoved: events.tabsOnRemoved,
      onReplaced: events.tabsOnReplaced,
      onUpdated: createEvent(),
      query: async () => [],
      remove: tabsRemove,
      sendMessage: async () => { calls.sendMessage += 1; },
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
