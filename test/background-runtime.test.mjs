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
  await assert.rejects(
    harness.events.tabsOnRemoved.emit(7, { windowId: 1, isWindowClosing: false }),
    /session storage write failed/u
  );
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

function createBackgroundHarness({
  storageGet = async () => ({}),
  storageSet = async () => {},
  debuggerSendCommand = async () => ({}),
  consoleError = () => {},
  tabsRemove = async () => {}
} = {}) {
  const calls = { executeScript: 0, nativeMessages: [], sendMessage: 0 };
  const events = {
    debuggerOnDetach: createEvent(),
    debuggerOnEvent: createEvent(),
    tabsOnRemoved: createEvent(),
    tabsOnReplaced: createEvent()
  };
  const nativePort = {
    onDisconnect: createEvent(),
    onMessage: createEvent(),
    postMessage(message) { calls.nativeMessages.push(message); }
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
      search: async () => []
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
