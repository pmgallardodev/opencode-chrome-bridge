import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ALL_TOOL_REQUIRED_CAPABILITIES } from "../src/opencode-plugin.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const backgroundSource = await readFile(path.join(repoRoot, "extension", "background.js"), "utf8");
const pageBinding = (tabId = 7, scope = "https://example.com:443/", documentId = `document-${tabId}`) => ({
  documentId, navigationGeneration: 0, pageScope: scope, tabId
});
let runtimeContextSequence = 1_000;

async function emitCurrentRuntimeConsole(harness, text, { level = "log", url = "https://example.com/" } = {}) {
  const contextId = runtimeContextSequence++;
  const frameId = `main-frame-${contextId}`;
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: frameId, loaderId: `loader-${contextId}`, url }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: {
      auxData: { frameId, isDefault: true, type: "default" },
      id: contextId, origin: new URL(url).origin, uniqueId: `context-${contextId}`
    }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: text }], executionContextId: contextId, type: level
  });
}

test("scoped page commands fail before a read when the tab navigated after approval", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async () => ({ active: true, id: 7, url: "https://other.example/private", windowId: 1 }),
    scriptingExecuteScript: async () => { throw new Error("page read must not start"); }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedScopes: ["https://example.com:443/app"],
    method: "tabContext",
    params: { tabId: 7, maxChars: 100, maxSelectionChars: 10 }
  }), /scope.*changed|origin.*changed|not authorized/iu);
  assert.equal(harness.calls.executeScript, 0);
});

test("scoped CDP blocks cross-target Target methods and unauthorized Page.navigate", async () => {
  const harness = createBackgroundHarness();
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedScopes: ["https://example.com:443/"],
    method: "cdpCommand",
    params: { tabId: 7, method: "Target.getTargets" }
  }), /Target.*not allowed|browser-wide/iu);
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedScopes: ["https://example.com:443/"],
    method: "cdpCommand",
    params: { tabId: 7, method: "Page.navigate", commandParams: { url: "https://evil.example/" } }
  }), /destination.*not authorized|scope/iu);
  assert.equal(harness.calls.debuggerCommands.length, 0);
});

test("scoped raw CDP rejects DOM and DOMSnapshot traversal before debugger dispatch", async () => {
  const harness = createBackgroundHarness();
  for (const method of ["DOM.getDocument", "DOM.querySelector", "DOM.getOuterHTML", "DOMSnapshot.captureSnapshot"]) {
    await assert.rejects(() => harness.execute("scopedCommand", {
      expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
      method: "cdpCommand", params: { commandParams: {}, method, tabId: 7 }
    }), /CDP method.*not allowed|dedicated/iu, method);
  }
  assert.equal(harness.calls.debuggerAttach.length, 0);
  assert.equal(harness.calls.debuggerCommands.length, 0);
});

test("scoped native input preserves CDP mouse, keyboard, text, scroll, evaluate, and drag semantics", async () => {
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => method === "Runtime.evaluate"
      ? { result: { value: "evaluated" } }
      : {}
  });
  const execute = (method, params) => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"], method, params: { tabId: 7, ...params }
  });
  await execute("click", { button: "right", modifiers: ["Shift"], x: 11, y: 12 });
  await execute("doubleClick", { button: "left", modifiers: ["Control"], x: 13, y: 14 });
  await execute("keypress", { key: "Enter", modifiers: [] });
  await execute("keypress", { key: "Tab", modifiers: [] });
  await execute("type", { text: "native text" });
  await execute("scroll", { deltaX: 4, deltaY: 9, x: 15, y: 16 });
  assert.equal(await execute("evaluate", { expression: "Promise.resolve('evaluated')" }), "evaluated");
  await execute("moveSequence", {
    button: "middle", drag: true, modifiers: ["Alt"], points: [{ x: 1, y: 2 }, { x: 5, y: 6 }], stepDelayMs: 0, steps: 2
  });

  const commands = harness.calls.debuggerCommands;
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && params.button === "right" && params.modifiers === 8));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.clickCount === 2));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchKeyEvent" && params.key === "Enter" && params.windowsVirtualKeyCode === 13 && params.text === "\r"));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchKeyEvent" && params.key === "Tab" && params.windowsVirtualKeyCode === 9));
  assert.ok(commands.some(({ method, params }) => method === "Input.insertText" && params.text === "native text"));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseWheel" && params.x === 15 && params.y === 16 && params.deltaX === 4 && params.deltaY === 9));
  assert.ok(commands.some(({ method, params }) => method === "Runtime.evaluate" && params.awaitPromise === true && params.returnByValue === true));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && params.button === "middle" && params.modifiers === 1));
  assert.ok(commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && params.x === 5 && params.y === 6));
});

test("every native mutation family emits zero CDP effects after document identity changes", async () => {
  const cases = [
    ["click", { button: "left", x: 1, y: 2 }],
    ["doubleClick", { button: "left", x: 1, y: 2 }],
    ["hover", { x: 1, y: 2 }],
    ["keypress", { key: "Enter" }],
    ["type", { text: "blocked" }],
    ["scroll", { deltaY: 5, x: 1, y: 2 }],
    ["evaluate", { expression: "window.mutated = true" }],
    ["moveSequence", { button: "left", drag: true, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], stepDelayMs: 0, steps: 1 }]
  ];
  for (const [method, params] of cases) {
    let bindingReads = 0;
    const harness = createBackgroundHarness({
      webNavigationGetFrame: async () => ({
        documentId: bindingReads++ === 0 ? "approved-document" : "replacement-document",
        frameId: 0
      })
    });
    await assert.rejects(() => harness.execute("scopedCommand", {
      expectedBindings: [pageBinding(7, "https://example.com:443/", "approved-document")],
      expectedScopes: ["https://example.com:443/"], method, params: { tabId: 7, ...params }
    }), /document changed|not authorized/iu, method);
    assert.equal(
      harness.calls.debuggerCommands.filter(({ method: cdpMethod }) => /^(?:Input|Runtime|Emulation)\./u.test(cdpMethod)).length,
      0,
      `${method} emitted a native effect after document replacement`
    );
  }
});

test("scoped Fetch barrier keeps an IPC-entry navigation from moving native input onto B", async () => {
  let harness;
  let documentId = "document-a";
  const effectDocuments = [];
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        effectDocuments.push({ documentId, type: params.type });
        if (params.type === "mouseMoved") {
          await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
          await harness.events.debuggerOnEvent.emit(
            { tabId: 7 }, "Fetch.requestPaused",
            { requestId: "nav-b", resourceType: "Document", request: { url: "https://b.example/" } }
          );
        }
      }
      if (method === "Fetch.continueRequest") documentId = "document-b";
      return {};
    },
    webNavigationGetFrame: async () => ({ documentId, frameId: 0 })
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding(7, "https://example.com:443/", "document-a")],
    expectedScopes: ["https://example.com:443/"], method: "click",
    params: { button: "left", tabId: 7, x: 10, y: 10 }
  }), /document changed|not authorized/iu);
  assert.ok(effectDocuments.every((entry) => entry.documentId === "document-a"));
  assert.equal(effectDocuments.some((entry) => entry.type === "mousePressed"), false);
  assert.ok(harness.calls.debuggerCommands.some(({ method }) => method === "Fetch.continueRequest"));
});

test("scoped Fetch cleanup owns and releases requests arriving while the barrier drains", async () => {
  let harness;
  let emittedDuringContinue = false;
  let emittedDuringDisable = false;
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
        await harness.events.debuggerOnEvent.emit(
          { tabId: 7 }, "Fetch.requestPaused",
          { requestId: "nav-first", resourceType: "Document", request: { url: "https://b.example/" } }
        );
      }
      if (method === "Fetch.continueRequest" && params.requestId === "nav-first" && !emittedDuringContinue) {
        emittedDuringContinue = true;
        await harness.events.debuggerOnEvent.emit(
          { tabId: 7 }, "Fetch.requestPaused",
          { requestId: "nav-during-drain", resourceType: "Document", request: { url: "https://c.example/" } }
        );
      }
      if (method === "Fetch.disable" && !emittedDuringDisable) {
        emittedDuringDisable = true;
        await harness.events.debuggerOnEvent.emit(
          { tabId: 7 }, "Fetch.requestPaused",
          { requestId: "nav-during-disable", resourceType: "Document", request: { url: "https://d.example/" } }
        );
      }
      return {};
    }
  });
  await harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"], method: "click",
    params: { button: "left", tabId: 7, x: 10, y: 10 }
  });
  assert.deepEqual(
    harness.calls.debuggerCommands
      .filter(({ method }) => method === "Fetch.continueRequest")
      .map(({ params }) => params.requestId),
    ["nav-first", "nav-during-drain", "nav-during-disable"]
  );
  assert.equal(harness.navigationBarrierCount(), 0);
});

test("scoped one-action native browserBatch uses the navigation barrier", async () => {
  let harness;
  let documentId = "document-a";
  const effectDocuments = [];
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { found: true, point: { x: 10, y: 10 } } } };
      }
      if (method === "Input.dispatchMouseEvent") {
        effectDocuments.push({ documentId, type: params.type });
        if (params.type === "mouseMoved") {
          await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
          await harness.events.debuggerOnEvent.emit(
            { tabId: 7 }, "Fetch.requestPaused",
            { requestId: "batch-nav-b", resourceType: "Document", request: { url: "https://b.example/" } }
          );
        }
      }
      if (method === "Fetch.continueRequest") documentId = "document-b";
      return {};
    },
    scriptingExecuteScript: async () => [{ result: {
      found: true, height: 20, name: "Continue", role: "button", visible: true, width: 20, x: 10, y: 10
    } }],
    webNavigationGetFrame: async () => ({ documentId, frameId: 0 })
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding(7, "https://example.com:443/", "document-a")],
    expectedScopes: ["https://example.com:443/"], method: "browserBatch",
    params: { actions: [{ type: "clickElement", params: { tabId: 7, ref: "e1" } }], totalTimeoutMs: 1000 }
  }), /document changed|not authorized/iu);
  assert.ok(effectDocuments.every((entry) => entry.documentId === "document-a"));
  assert.equal(effectDocuments.some((entry) => entry.type === "mousePressed"), false);
  assert.ok(harness.calls.debuggerCommands.some(({ method }) => method === "Fetch.continueRequest"));
});

test("Fetch-domain subscriptions fail before debugger ownership or enable side effects", async () => {
  const harness = createBackgroundHarness();
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "subscribeCdpEvents", params: { tabId: 7, methods: ["Fetch.requestPaused"] }
  }), /Fetch.*not allowed|navigation barrier/iu);
  assert.equal(harness.calls.debuggerAttach.length, 0);
  assert.equal(harness.calls.debuggerCommands.length, 0);
  assert.deepEqual(harness.persistentDebuggerState(7), {
    console: false, domains: [], events: false, network: false, subscriptions: []
  });
});

test("scoped persistent debugger acquisition rolls back when navigation starts during domain enable", async () => {
  for (const [method, params, enabledDomain] of [
    ["getConsoleLogs", { autoAttach: true, tabId: 7 }, "Page"],
    ["networkRequests", { autoAttach: true, tabId: 7 }, "Network"],
    ["subscribeCdpEvents", { methods: ["Console.messageAdded"], tabId: 7 }, "Console"]
  ]) {
    let harness;
    let navigated = false;
    harness = createBackgroundHarness({
      debuggerSendCommand: async (_target, cdpMethod) => {
        if (cdpMethod === `${enabledDomain}.enable` && !navigated) {
          navigated = true;
          await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
          await harness.events.debuggerOnEvent.emit(
            { tabId: 7 }, "Fetch.requestPaused",
            { requestId: `${method}-nav`, resourceType: "Document", request: { url: "https://b.example/" } }
          );
        }
        return {};
      }
    });
    await assert.rejects(() => harness.execute("scopedCommand", {
      expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"], method, params
    }), /document changed|not authorized/iu, method);
    const state = harness.persistentDebuggerState(7);
    assert.deepEqual(state, {
      console: false, domains: [], events: false, network: false, subscriptions: []
    }, method);
    assert.ok(harness.calls.debuggerCommands.some(({ method: command }) => command === `${enabledDomain}.disable`), method);
    assert.equal(harness.calls.debuggerDetach.length, 1, method);
  }
});

test("scoped unsubscription rolls back ownership when navigation starts before mutation", async () => {
  let harness;
  let navigateOnBarrierEnable = false;
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Fetch.enable" && navigateOnBarrierEnable) {
        await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
      }
      return {};
    }
  });
  await harness.execute("subscribeCdpEvents", { tabId: 7, methods: ["Console.messageAdded"] });
  navigateOnBarrierEnable = true;
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "unsubscribeCdpEvents", params: { tabId: 7, methods: ["Console.messageAdded"] }
  }), /document changed|not authorized/iu);
  assert.deepEqual(harness.persistentDebuggerState(7), {
    console: false, domains: ["Console", "Page"], events: true, network: false, subscriptions: ["Console.messageAdded"]
  });
  assert.equal(harness.calls.debuggerDetach.length, 0);
});

test("cancelling a scoped barrier during Fetch enable drains ownership without hanging", async () => {
  let releaseEnable;
  const enableStarted = new Promise((resolve) => { releaseEnable = resolve; });
  let notifyEnableStarted;
  const started = new Promise((resolve) => { notifyEnableStarted = resolve; });
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Fetch.enable") {
        notifyEnableStarted();
        await enableStarted;
      }
      return {};
    }
  });
  const controller = new AbortController();
  const pending = harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "getConsoleLogs", params: { autoAttach: true, tabId: 7 }
  }, { signal: controller.signal });
  await started;
  controller.abort(new Error("cancelled scoped debugger acquisition"));
  releaseEnable();
  await assert.rejects(pending, /cancelled/u);
  assert.equal(harness.navigationBarrierCount(), 0);
  assert.equal(harness.calls.debuggerDetach.length, 1);
  assert.deepEqual(harness.persistentDebuggerState(7), {
    console: false, domains: [], events: false, network: false, subscriptions: []
  });
});

test("cleanup never releases mouse input into a changed document", async () => {
  let harness;
  let documentId = "document-a";
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
        await harness.events.debuggerOnEvent.emit(
          { tabId: 7 }, "Fetch.requestPaused",
          { requestId: "nav-after-press", resourceType: "Document", request: { url: "https://b.example/" } }
        );
      }
      if (method === "Fetch.continueRequest") documentId = "document-b";
      return {};
    },
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: documentId === "document-a" ? "https://example.com/" : "https://b.example/", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId, frameId: 0 })
  });
  const result = await harness.execute("scopedCommand", {
    expectedBindings: [pageBinding(7, "https://example.com:443/", "document-a")],
    expectedScopes: ["https://example.com:443/"], method: "click",
    params: { button: "left", tabId: 7, x: 10, y: 10 }
  });
  assert.equal(result.transition.documentId, "document-b");
  assert.equal(harness.calls.debuggerCommands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), false);
});

test("cleanup never sends keyUp or drag release after navigation invalidation", async () => {
  for (const [method, params, downType, releaseType] of [
    ["keypress", { key: "Enter" }, "keyDown", "keyUp"],
    ["moveSequence", { button: "left", drag: true, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], stepDelayMs: 0, steps: 1 }, "mousePressed", "mouseReleased"]
  ]) {
    let harness;
    let invalidated = false;
    harness = createBackgroundHarness({
      debuggerSendCommand: async (_target, cdpMethod, cdpParams) => {
        if (!invalidated && ((cdpMethod === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown"].includes(cdpParams.type))
          || (cdpMethod === "Input.dispatchMouseEvent" && cdpParams.type === downType))) {
          invalidated = true;
          await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://b.example/" });
        }
        return {};
      }
    });
    await assert.rejects(() => harness.execute("scopedCommand", {
      expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
      method, params: { tabId: 7, ...params }
    }), /document changed|not authorized/iu);
    assert.equal(
      harness.calls.debuggerCommands.some(({ params: cdpParams }) => cdpParams?.type === releaseType),
      false,
      `${method} sent ${releaseType} after invalidation`
    );
  }
});

test("scoped native click reports one structured document transition after navigation", async () => {
  let currentUrl = "https://example.com/start";
  let documentId = "document-start";
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        currentUrl = "https://redirect.example/next";
        documentId = "document-next";
      }
      return {};
    },
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: currentUrl, windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId, frameId: 0 })
  });
  const result = await harness.execute("scopedCommand", {
    expectedBindings: [pageBinding(7, "https://example.com:443/start", "document-start")],
    expectedScopes: ["https://example.com:443/start"],
    method: "click", params: { button: "left", tabId: 7, x: 10, y: 10 }
  });
  assert.equal(result.clicked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.transition)), {
    documentId: "document-next", navigationGeneration: 0,
    pageScope: "https://redirect.example:443/next", tabId: 7
  });
  assert.equal(harness.calls.debuggerCommands.filter(({ params }) => params?.type === "mousePressed").length, 1);
});

test("scoped screenshot discards A to B to A activation races inside captureVisibleTab", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabsCaptureVisibleTab: async () => {
      await harness.events.tabsOnActivated.emit({ tabId: 8, windowId: 1 });
      await harness.events.tabsOnActivated.emit({ tabId: 7, windowId: 1 });
      return "data:image/png;base64,iVBORw0KGgo=";
    }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "screenshot", params: { tabId: 7, format: "png" }
  }), /discarded.*active tab|changed during capture/iu);
});

test("scoped readPage discards A to B to A activation races before returning screenshot data", async () => {
  let harness;
  harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{ result: {
      accessibility: { tree: "button Continue" },
      context: { visibleText: "Page", returnedChars: 4, totalChars: 4 }
    } }],
    tabsCaptureVisibleTab: async () => {
      await harness.events.tabsOnActivated.emit({ tabId: 8, windowId: 1 });
      await harness.events.tabsOnActivated.emit({ tabId: 7, windowId: 1 });
      return "data:image/png;base64,iVBORw0KGgo=";
    }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "readPage", params: { includeScreenshot: true, tabId: 7 }
  }), /discarded.*active tab|changed during capture/iu);
});

test("scoped screenshotRegion discards A to B to A activation races during CDP capture", async () => {
  let harness;
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Page.captureScreenshot") {
        await harness.events.tabsOnActivated.emit({ tabId: 8, windowId: 1 });
        await harness.events.tabsOnActivated.emit({ tabId: 7, windowId: 1 });
        return { data: "iVBORw0KGgo=" };
      }
      return {};
    }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedBindings: [pageBinding()], expectedScopes: ["https://example.com:443/"],
    method: "screenshotRegion",
    params: { height: 20, tabId: 7, width: 20, x: 0, y: 0 }
  }), /region discarded|active tab or document changed/iu);
});

test("scoped coordinate click has zero effect when navigation wins the precheck race", async () => {
  let currentUrl = "https://example.com/app";
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: currentUrl, windowId: 1 }),
    scriptingExecuteScript: async () => { currentUrl = "https://other.example/private"; return []; }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedScopes: ["https://example.com:443/app"],
    method: "click",
    params: { tabId: 7, x: 10, y: 10, button: "left" }
  }), /scope.*changed|not authorized/iu);
  assert.equal(harness.calls.debuggerCommands.length, 0, "no CDP input effect may occur after the raced navigation");
});

test("scoped batch mutation has zero effect when navigation wins the action race", async () => {
  let currentUrl = "https://example.com/app";
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: currentUrl, windowId: 1 }),
    scriptingExecuteScript: async () => { currentUrl = "https://other.example/private"; return []; }
  });
  await assert.rejects(() => harness.execute("scopedCommand", {
    expectedScopes: ["https://example.com:443/app"],
    method: "browserBatch",
    params: { actions: [{ type: "clickElement", params: { tabId: 7, ref: "e1" } }], totalTimeoutMs: 1000 }
  }), /scope.*changed|not authorized/iu);
  assert.equal(
    harness.calls.debuggerCommands.some(({ method }) => /^(?:Input|Runtime)\./u.test(method)),
    false
  );
});

test("top-level B to A navigation cannot expose old or late B console entries", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Console.messageAdded",
    { message: { level: "log", text: "secret-B", url: "https://b.example/private" } }
  );
  await harness.events.tabsOnUpdated.emit(7, { status: "loading", url: "https://a.example/" }, {
    active: true, id: 7, url: "https://a.example/", windowId: 1
  });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Console.messageAdded",
    { message: { level: "log", text: "late-secret-B", url: "https://b.example/private" } }
  );
  const result = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(result.logs.length, 0);
});

test("A1 to B to A3 drops URL-only late console data and accepts only the current exact document context", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.execute("subscribeCdpEvents", {
    tabId: 7, methods: ["Console.messageAdded", "Runtime.consoleAPICalled"]
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "frame-main", loaderId: "loader-a1", url: "https://example.com/" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: {
      auxData: { frameId: "frame-main", isDefault: true, type: "default" },
      id: 101, origin: "https://example.com", uniqueId: "context-a1"
    }
  });

  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-b", frameId: 0, tabId: 7, url: "https://b.example/"
  });
  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-a3", frameId: 0, tabId: 7, url: "https://example.com/"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "frame-main", loaderId: "loader-a3", url: "https://example.com/" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: {
      auxData: { frameId: "frame-main", isDefault: true, type: "default" },
      id: 303, origin: "https://example.com", uniqueId: "context-a3"
    }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Console.messageAdded", {
    message: { level: "error", text: "secret-from-a1", url: "https://example.com/" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "context-secret-from-a1" }], executionContextId: 101, type: "log"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-a3" }], executionContextId: 303, type: "log"
  });

  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-a3");
  const forwarded = harness.calls.nativeMessages
    .filter((message) => message.type === "event" && message.event?.category === "cdp")
    .map((message) => message.event);
  assert.equal(JSON.stringify(forwarded).includes("secret-from-a1"), false);
  assert.equal(JSON.stringify(forwarded).includes("context-secret-from-a1"), false);
  const current = forwarded.find((event) => JSON.stringify(event.params ?? "").includes("current-a3"));
  assert.equal(current.documentId, "document-a3");
  assert.ok(current.navigationGeneration >= 2);
});

test("Runtime origin-only contexts retain the exact current pathname scope", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: "document-app", frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "frame-app", loaderId: "loader-app", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: {
      auxData: { frameId: "frame-app", isDefault: true, type: "default" },
      id: 404, origin: "https://example.com", uniqueId: "context-app"
    }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-app" }], executionContextId: 404, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-app");
});

test("Page frame before webNavigation commit reconciles to the committed exact document", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await emitCurrentRuntimeConsole(harness, "old-a");
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "frame-b", loaderId: "loader-b", url: "https://b.example/redirected" }
  });
  await harness.events.tabsOnUpdated.emit(7, { status: "loading", url: "https://b.example/redirected" }, {
    active: true, id: 7, url: "https://b.example/redirected", windowId: 1
  });
  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-b", frameId: 0, tabId: 7, url: "https://b.example/redirected"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: {
      auxData: { frameId: "frame-b", isDefault: true, type: "default" },
      id: 505, origin: "https://b.example", uniqueId: "context-b"
    }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-b" }], executionContextId: 505, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-b");
  const current = harness.calls.nativeMessages
    .filter((message) => message.type === "event" && message.event?.category === "cdp")
    .map((message) => message.event)
    .find((event) => JSON.stringify(event.params ?? "").includes("current-b"));
  assert.equal(current.documentId, "document-b");
  assert.equal(current.pageScope, "https://b.example:443/redirected");
  assert.ok(current.navigationGeneration > 0);
});

test("same-scope commit before CDP frame never relabels the old loader as the reloaded document", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: "document-a1", frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 601, origin: "https://example.com" }
  });

  await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://example.com/app" });
  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-a2", frameId: 0, tabId: 7, url: "https://example.com/app"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 602, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "late-a1" }], executionContextId: 601, type: "log"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "premature-a2" }], executionContextId: 602, type: "log"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a2", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 603, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-a2" }], executionContextId: 603, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-a2");
});

test("same-scope CDP frame before commit stays pending and drops every precommit context", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: "document-a1", frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 701, origin: "https://example.com" }
  });

  await harness.events.webNavigationOnBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://example.com/app" });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a2", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 702, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "late-a1-before-commit" }], executionContextId: 701, type: "log"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "premature-a2-before-commit" }], executionContextId: 702, type: "log"
  });
  const precommit = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(precommit.logs.length, 0);
  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-a2", frameId: 0, tabId: 7, url: "https://example.com/app"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 703, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-a2-after-commit" }], executionContextId: 703, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-a2-after-commit");
});

test("aborted top-frame navigation restores only the proven A1 loader and requires a fresh context", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: "document-a1", frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 801, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "initial-a1" }], executionContextId: 801, type: "log"
  });
  await harness.events.webNavigationOnBeforeNavigate.emit({
    documentId: "document-a1", frameId: 0, tabId: 7, timeStamp: 10, url: "https://next.example/"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "late-old-a1" }], executionContextId: 801, type: "log"
  });
  await harness.events.webNavigationOnErrorOccurred.emit({
    documentId: "document-a1", error: "net::ERR_ABORTED", frameId: 0,
    tabId: 7, timeStamp: 11, url: "https://next.example/"
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 802, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-a1-after-abort" }], executionContextId: 802, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-a1-after-abort");
});

test("stale and subframe errors cannot recover a superseded top-frame attempt", async () => {
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: "document-a1", frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.webNavigationOnBeforeNavigate.emit({
    documentId: "document-a1", frameId: 0, tabId: 7, timeStamp: 10, url: "https://next.example/"
  });
  await harness.events.webNavigationOnBeforeNavigate.emit({
    documentId: "document-a1", frameId: 0, tabId: 7, timeStamp: 20, url: "https://next.example/"
  });
  await harness.events.webNavigationOnErrorOccurred.emit({
    error: "net::ERR_ABORTED", frameId: 0, tabId: 7, timeStamp: 15, url: "https://next.example/"
  });
  await harness.events.webNavigationOnErrorOccurred.emit({
    error: "net::ERR_ABORTED", frameId: 3, tabId: 7, timeStamp: 21, url: "https://next.example/"
  });
  await harness.events.webNavigationOnErrorOccurred.emit({
    error: "net::ERR_ABORTED", frameId: 0, tabId: 7, timeStamp: 22, url: "https://next.example/"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 803, origin: "https://example.com" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-a1-after-latest-abort" }], executionContextId: 803, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-a1-after-latest-abort");
});

test("unproven navigation failure clears debugger provenance before auto-attach reseeds", async () => {
  let currentDocumentId = "document-a1";
  let currentUrl = "https://example.com/app";
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: currentUrl, windowId: 1 }),
    webNavigationGetFrame: async () => ({ documentId: currentDocumentId, frameId: 0 })
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: currentUrl }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 804, origin: "https://example.com" }
  });
  await harness.events.webNavigationOnBeforeNavigate.emit({
    documentId: "document-a1", frameId: 0, tabId: 7, timeStamp: 30, url: "https://next.example/"
  });
  currentDocumentId = "document-b";
  currentUrl = "https://next.example/";
  await harness.events.webNavigationOnErrorOccurred.emit({
    error: "net::ERR_FAILED", frameId: 0, tabId: 7, timeStamp: 31, url: currentUrl
  });
  assert.equal(harness.calls.debuggerDetach.length, 1);
  assert.deepEqual(harness.persistentDebuggerState(7), {
    console: false, domains: [], events: false, network: false, subscriptions: []
  });

  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  assert.equal(harness.calls.debuggerAttach.length, 2);
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-b", url: currentUrl }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 805, origin: "https://next.example" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "late-a1" }], executionContextId: 804, type: "log"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-b" }], executionContextId: 805, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-b");
});

test("a committed navigation wins an in-flight error recovery for the same attempt", async () => {
  let blockFrameLookup = false;
  let releaseFrameLookup;
  let signalFrameLookup;
  const frameLookupStarted = new Promise((resolve) => { signalFrameLookup = resolve; });
  const frameLookupGate = new Promise((resolve) => { releaseFrameLookup = resolve; });
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => ({ active: true, id: tabId, url: "https://example.com/app", windowId: 1 }),
    webNavigationGetFrame: async () => {
      if (blockFrameLookup) {
        signalFrameLookup();
        await frameLookupGate;
      }
      return { documentId: "document-a1", frameId: 0 };
    }
  });
  await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-a1", url: "https://example.com/app" }
  });
  await harness.events.webNavigationOnBeforeNavigate.emit({
    documentId: "document-a1", frameId: 0, tabId: 7, timeStamp: 40, url: "https://next.example/"
  });
  blockFrameLookup = true;
  const failedNavigation = harness.events.webNavigationOnErrorOccurred.emit({
    error: "net::ERR_ABORTED", frameId: 0, tabId: 7, timeStamp: 41, url: "https://next.example/"
  });
  await frameLookupStarted;
  await harness.events.webNavigationOnCommitted.emit({
    documentId: "document-b", frameId: 0, tabId: 7, timeStamp: 42, url: "https://next.example/"
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
    frame: { id: "persistent-main", loaderId: "loader-b", url: "https://next.example/" }
  });
  releaseFrameLookup();
  await failedNavigation;
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.executionContextCreated", {
    context: { auxData: { frameId: "persistent-main", isDefault: true }, id: 806, origin: "https://next.example" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Runtime.consoleAPICalled", {
    args: [{ type: "string", value: "current-b-after-commit" }], executionContextId: 806, type: "log"
  });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs.map((entry) => entry.text).join("\n"), "current-b-after-commit");
});

test("top-level B to A navigation cannot expose old or late B network entries", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7, autoAttach: true });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 }, "Network.requestWillBeSent",
    { requestId: "b-1", request: { method: "GET", url: "https://b.example/private" }, timestamp: 1, type: "Document" }
  );
  await harness.events.tabsOnUpdated.emit(7, { status: "loading", url: "https://a.example/" }, {
    active: true, id: 7, url: "https://a.example/", windowId: 1
  });
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 }, "Network.requestWillBeSent",
    { requestId: "b-late", request: { method: "GET", url: "https://b.example/late" }, timestamp: 2, type: "XHR" }
  );
  const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });
  assert.equal(result.requests.length, 0);
});

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

test("claimed tabs reuse one named colored group per browser session", async () => {
  let stored = {};
  const grouped = [];
  const groupUpdates = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGroup: async (options) => {
      grouped.push(options);
      return options.groupId ?? 41;
    },
    tabGroupsUpdate: async (groupId, update) => {
      groupUpdates.push({ groupId, update });
      return { id: groupId, ...update };
    }
  });

  await harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" });
  await harness.execute("claimTab", { tabId: 8, sessionId: "session-a", turnId: "turn-a", origin: "agent" });

  assert.equal(JSON.stringify(grouped[0].tabIds), JSON.stringify([7]));
  assert.equal(grouped[0].createProperties.windowId, 1);
  assert.equal(grouped[0].groupId, undefined);
  assert.equal(JSON.stringify(grouped[1].tabIds), JSON.stringify([8]));
  assert.equal(grouped[1].groupId, 41);
  assert.equal(groupUpdates.length, 2);
  for (const entry of groupUpdates) {
    assert.equal(entry.groupId, 41);
    assert.equal(entry.update.color, "blue");
    assert.equal(entry.update.title, "OpenCode · session-a");
  }
  assert.equal(stored.opencodeTabLeases["7"].groupId, 41);
  assert.equal(stored.opencodeTabLeases["8"].groupId, 41);
});

test("claimTab restores the original UI group and leaves no lease when group styling fails", async () => {
  let stored = {};
  let failUpdate = true;
  const ungrouped = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ groupId: -1, id: tabId, url: "https://example.com", windowId: 1 }),
    tabsGroup: async (options) => options.groupId ?? 41,
    tabsUngroup: async (tabIds) => { ungrouped.push(...tabIds); },
    tabGroupsUpdate: async (groupId, update) => {
      if (failUpdate) throw new Error("group update failed");
      return { id: groupId, ...update };
    }
  });

  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" }),
    /group update failed/u
  );
  assert.equal(stored.opencodeTabLeases, undefined);
  assert.deepEqual(ungrouped, [7]);

  failUpdate = false;
  const claimed = await harness.execute("claimTab", {
    tabId: 7, sessionId: "session-b", turnId: "turn-b", origin: "user"
  });
  assert.equal(claimed.sessionId, "session-b");
});

test("claimTab recreates a deleted original group with its metadata when managed styling fails", async () => {
  let stored = {};
  const groupCalls = [];
  const updates = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ groupId: 9, id: tabId, url: "https://example.com", windowId: 3 }),
    tabGroupsGet: async (groupId) => {
      if (groupId !== 9) throw new Error("missing group");
      return { collapsed: true, color: "red", id: 9, title: "Original", windowId: 3 };
    },
    tabsGroup: async (options) => {
      groupCalls.push(structuredClone(options));
      if (options.groupId === 9) throw new Error("No group with id: 9");
      if (options.createProperties?.windowId === 3 && groupCalls.length === 1) return 41;
      return 77;
    },
    tabGroupsUpdate: async (groupId, update) => {
      updates.push({ groupId, update: structuredClone(update) });
      if (groupId === 41) throw new Error("managed style failed");
      return { id: groupId, ...update };
    }
  });

  await assert.rejects(
    harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" }),
    /managed style failed/u
  );

  assert.equal(stored.opencodeTabLeases, undefined);
  assert.ok(groupCalls.some((entry) => entry.groupId === 9));
  assert.ok(groupCalls.some((entry) => entry.createProperties?.windowId === 3 && entry.groupId === undefined));
  assert.deepEqual(updates.at(-1), {
    groupId: 77,
    update: { collapsed: true, color: "red", title: "Original" }
  });
});

test("created navigation targets are adopted only from their own leased web session", async () => {
  let stored = {};
  const grouped = [];
  const tabs = new Map([
    [7, { id: 7, url: "https://source.example", windowId: 1 }],
    [8, { id: 8, url: "https://child.example", windowId: 1 }],
    [9, { id: 9, url: "https://other.example", windowId: 1 }],
    [10, { id: 10, url: "chrome://settings", windowId: 1 }]
  ]);
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => tabs.get(tabId),
    tabsGroup: async (options) => {
      grouped.push(options);
      return options.groupId ?? 41;
    }
  });
  await harness.execute("claimTab", { tabId: 7, sessionId: "session-a", turnId: "turn-a", origin: "user" });
  await harness.execute("claimTab", { tabId: 9, sessionId: "session-b", turnId: "turn-b", origin: "user" });

  await harness.events.webNavigationOnCreatedNavigationTarget.emit({ sourceTabId: 7, tabId: 8, url: "https://child.example" });
  await harness.events.webNavigationOnCreatedNavigationTarget.emit({ sourceTabId: 7, tabId: 9, url: "https://other.example" });
  await harness.events.webNavigationOnCreatedNavigationTarget.emit({ sourceTabId: 7, tabId: 10, url: "chrome://settings" });
  await harness.awaitTabLeaseQueue();

  assert.equal(stored.opencodeTabLeases["8"].sessionId, "session-a");
  assert.equal(stored.opencodeTabLeases["8"].origin, "agent");
  assert.equal(stored.opencodeTabLeases["9"].sessionId, "session-b");
  assert.equal(stored.opencodeTabLeases["10"], undefined);
  assert.ok(grouped.some((entry) => entry.groupId === 41 && entry.tabIds[0] === 8));
});

for (const failureStage of ["group", "update"]) {
  test(`child adoption rolls back completely when managed group ${failureStage} fails`, async () => {
    const sourceLease = {
      claimedAt: 1, groupId: 41, origin: "user", sessionId: "session-a",
      state: "active", tabId: 7, turnId: "turn-a"
    };
    let stored = { opencodeTabLeases: { "7": sourceLease } };
    let groupAttempts = 0;
    let updateAttempts = 0;
    let adoptionPhase = true;
    const ungrouped = [];
    const harness = createBackgroundHarness({
      storageGet: async () => stored,
      storageSet: async (value) => { stored = structuredClone(value); },
      tabsGet: async (tabId) => ({ id: tabId, url: "https://example.com", windowId: 1 }),
      tabsGroup: async (options) => {
        groupAttempts += 1;
        if (failureStage === "group" && adoptionPhase) throw new Error("group failed");
        return options.groupId ?? 55;
      },
      tabsUngroup: async (tabIds) => { ungrouped.push(...tabIds); },
      tabGroupsUpdate: async (groupId, update) => {
        updateAttempts += 1;
        if (failureStage === "update" && updateAttempts === 1) throw new Error("group update failed");
        return { id: groupId, ...update };
      },
      consoleError: () => {}
    });

    await harness.events.webNavigationOnCreatedNavigationTarget.emit({
      sourceTabId: 7, tabId: 8, url: "https://child.example"
    });
    await harness.awaitTabLeaseQueue();
    adoptionPhase = false;

    assert.equal(stored.opencodeTabLeases["8"], undefined);
    assert.ok(ungrouped.includes(8));
    const claimed = await harness.execute("claimTab", {
      tabId: 8, sessionId: "session-b", turnId: "turn-b", origin: "user"
    });
    assert.equal(claimed.sessionId, "session-b");
    assert.equal(stored.opencodeTabLeases["8"].sessionId, "session-b");
  });
}

test("created navigation targets adopt a legitimate about:blank popup", async () => {
  const sourceLease = {
    claimedAt: 1, groupId: 41, origin: "user", sessionId: "session-a",
    state: "active", tabId: 7, turnId: "turn-a"
  };
  let stored = { opencodeTabLeases: { "7": sourceLease } };
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ id: tabId, url: "about:blank", windowId: 1 }),
    tabsGroup: async (options) => options.groupId ?? 41
  });

  await harness.events.webNavigationOnCreatedNavigationTarget.emit({
    sourceTabId: 7, tabId: 8, url: "about:blank"
  });
  await harness.awaitTabLeaseQueue();

  assert.equal(stored.opencodeTabLeases["8"].sessionId, "session-a");
  assert.equal(stored.opencodeTabLeases["8"].groupId, 41);
});

test("created navigation targets ignore handoff sources", async () => {
  const sourceLease = {
    claimedAt: 1, groupId: 41, origin: "user", sessionId: "session-a",
    state: "handoff", handoffStatus: "handoff", tabId: 7, turnId: "turn-a"
  };
  let stored = { opencodeTabLeases: { "7": sourceLease } };
  let grouped = 0;
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ id: tabId, url: "https://example.com", windowId: 1 }),
    tabsGroup: async () => { grouped += 1; return 41; }
  });

  await harness.events.webNavigationOnCreatedNavigationTarget.emit({
    sourceTabId: 7, tabId: 8, url: "https://child.example"
  });
  await harness.awaitTabLeaseQueue();

  assert.equal(stored.opencodeTabLeases["8"], undefined);
  assert.equal(grouped, 0);
});

test("resumeSession recovers handoff tabs after restart and removes stale leases", async () => {
  const lease = (tabId, state, extra = {}) => ({
    claimedAt: 1, groupId: 41, origin: "agent", sessionId: "session-a",
    state, tabId, turnId: "turn-old", ...extra
  });
  let stored = {
    opencodeTabLeases: {
      "7": lease(7, "handoff", { handoffStatus: "handoff" }),
      "8": lease(8, "handoff", { handoffStatus: "deliverable" })
    }
  };
  const activated = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => {
      if (tabId === 8) throw new Error("No tab with id: 8");
      return { id: tabId, url: "https://live.example", windowId: 1 };
    },
    tabsGroup: async (options) => options.groupId ?? 41,
    tabsUpdate: async (tabId, update) => {
      activated.push({ tabId, update });
      return { active: true, id: tabId, index: 0, title: "Live", url: "https://live.example", windowId: 1 };
    }
  });

  const result = await harness.execute("resumeSession", { sessionId: "session-a", turnId: "turn-new" });

  assert.equal(JSON.stringify(result.recoveredTabIds), JSON.stringify([7]));
  assert.equal(JSON.stringify(result.skipped), JSON.stringify([{ reason: "missing", tabId: 8 }]));
  assert.equal(stored.opencodeTabLeases["8"], undefined);
  assert.equal(stored.opencodeTabLeases["7"].state, "active");
  assert.equal(stored.opencodeTabLeases["7"].turnId, "turn-new");
  assert.equal(activated.length, 1);
  assert.equal(activated[0].tabId, 7);
  assert.equal(activated[0].update.active, true);
});

for (const failureStage of ["group", "groupUpdate", "activate", "persist"]) {
  test(`resumeSession preserves handoff and succeeds on retry after ${failureStage} failure`, async () => {
    const handoff = {
      claimedAt: 1, groupId: 41, origin: "agent", sessionId: "session-a",
      state: "handoff", handoffStatus: "handoff", tabId: 7, turnId: "turn-old"
    };
    let stored = { opencodeTabLeases: { "7": handoff } };
    let failureEnabled = true;
    const harness = createBackgroundHarness({
      storageGet: async () => stored,
      storageSet: async (value) => {
        if (failureStage === "persist" && failureEnabled) throw new Error("persist failed");
        stored = structuredClone(value);
      },
      tabsGet: async (tabId) => ({ groupId: 41, id: tabId, url: "https://live.example", windowId: 1 }),
      tabsGroup: async (options) => {
        if (failureStage === "group" && failureEnabled) throw new Error("group failed");
        return options.groupId ?? 51;
      },
      tabGroupsUpdate: async (groupId, update) => {
        if (failureStage === "groupUpdate" && failureEnabled) throw new Error("group update failed");
        return { id: groupId, ...update };
      },
      tabsUpdate: async (tabId, update) => {
        if (failureStage === "activate" && failureEnabled) throw new Error("activate failed");
        return { active: true, id: tabId, url: "https://live.example", windowId: 1, ...update };
      }
    });

    await assert.rejects(
      harness.execute("resumeSession", { sessionId: "session-a", turnId: "turn-new" }),
      /failed/u
    );
    assert.equal(stored.opencodeTabLeases["7"].state, "handoff");
    assert.equal(stored.opencodeTabLeases["7"].turnId, "turn-old");

    failureEnabled = false;
    const retry = await harness.execute("resumeSession", { sessionId: "session-a", turnId: "turn-new" });
    assert.equal(JSON.stringify(retry.recoveredTabIds), JSON.stringify([7]));
    assert.equal(stored.opencodeTabLeases["7"].state, "active");
    assert.equal(stored.opencodeTabLeases["7"].turnId, "turn-new");
  });
}

test("resumeSession creates one managed group per window and repairs stale group ids", async () => {
  const handoff = (tabId, groupId) => ({
    claimedAt: 1, groupId, origin: "agent", sessionId: "session-a",
    state: "handoff", handoffStatus: "handoff", tabId, turnId: "turn-old"
  });
  let stored = { opencodeTabLeases: { "7": handoff(7, 41), "8": handoff(8, 42) } };
  const grouped = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ groupId: tabId === 7 ? -1 : 42, id: tabId, url: "https://live.example", windowId: tabId === 7 ? 1 : 2 }),
    tabGroupsGet: async (groupId) => {
      if (groupId === 41) return { color: "blue", id: 41, title: "OpenCode · session-a", windowId: 9 };
      return { color: "blue", id: groupId, title: "OpenCode · session-a", windowId: 2 };
    },
    tabsGroup: async (options) => {
      grouped.push(structuredClone(options));
      return options.groupId ?? 51;
    }
  });

  const result = await harness.execute("resumeSession", { sessionId: "session-a", turnId: "turn-new" });

  assert.equal(JSON.stringify(result.groups), JSON.stringify([
    { groupId: 51, windowId: 1 },
    { groupId: 42, windowId: 2 }
  ]));
  assert.equal(stored.opencodeTabLeases["7"].groupId, 51);
  assert.equal(stored.opencodeTabLeases["7"].windowId, 1);
  assert.equal(stored.opencodeTabLeases["8"].groupId, 42);
  assert.equal(stored.opencodeTabLeases["8"].windowId, 2);
  assert.equal(grouped.some((entry) => entry.tabIds.includes(7) && entry.tabIds.includes(8)), false);
  assert.equal(grouped.some((entry) => entry.groupId === 41), false);
  assert.ok(grouped.some((entry) => entry.createProperties?.windowId === 1));
});

test("resumeSession removes malformed and internal tabs without activating them", async () => {
  const handoff = (tabId) => ({
    claimedAt: 1, groupId: 41, origin: "agent", sessionId: "session-a",
    state: "handoff", handoffStatus: "handoff", tabId, turnId: "turn-old"
  });
  let stored = { opencodeTabLeases: Object.fromEntries([7, 8, 9, 10, 11].map((tabId) => [String(tabId), handoff(tabId)])) };
  const urls = new Map([[7, undefined], [8, "not a url"], [9, "devtools://devtools/bundled/inspector.html"], [10, "chrome-untrusted://new-tab-page"], [11, "https://safe.example"]]);
  const activated = [];
  const harness = createBackgroundHarness({
    storageGet: async () => stored,
    storageSet: async (value) => { stored = structuredClone(value); },
    tabsGet: async (tabId) => ({ groupId: 41, id: tabId, url: urls.get(tabId), windowId: 1 }),
    tabsGroup: async (options) => options.groupId ?? 41,
    tabsUpdate: async (tabId, update) => { activated.push(tabId); return { id: tabId, ...update }; }
  });

  const result = await harness.execute("resumeSession", { sessionId: "session-a", turnId: "turn-new" });

  assert.equal(JSON.stringify(result.recoveredTabIds), JSON.stringify([11]));
  assert.equal(JSON.stringify(activated), JSON.stringify([11]));
  for (const tabId of [7, 8, 9, 10]) assert.equal(stored.opencodeTabLeases[String(tabId)], undefined);
});

test("child adoption remains grouped and fail closed when session storage cannot persist", async () => {
  const sourceLease = {
    claimedAt: 1, groupId: 41, origin: "user", sessionId: "session-a",
    state: "active", tabId: 7, turnId: "turn-a"
  };
  let grouped = 0;
  const ungrouped = [];
  const harness = createBackgroundHarness({
    storageGet: async () => ({ opencodeTabLeases: { "7": sourceLease } }),
    storageSet: async () => { throw new Error("session storage write failed"); },
    tabsGet: async (tabId) => ({ id: tabId, url: "https://example.com", windowId: 1 }),
    tabsGroup: async () => { grouped += 1; return 41; },
    tabsUngroup: async (tabIds) => { ungrouped.push(...tabIds); },
    consoleError: () => {}
  });

  await harness.events.webNavigationOnCreatedNavigationTarget.emit({ sourceTabId: 7, tabId: 8, url: "https://child.example" });
  await harness.awaitTabLeaseQueue();

  assert.equal(grouped, 1);
  assert.deepEqual(ungrouped, []);
  await assert.rejects(
    harness.execute("claimTab", { tabId: 8, sessionId: "session-b", turnId: "turn-b", origin: "user" }),
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
  assert.equal(result.extensionVersion, "1.3.0");
  assert.equal(result.hostName, "com.opencode.chrome_bridge");
  assert.match(result.protocolVersion, /^\d+\.\d+\.\d+$/u);
  assert.ok(result.capabilities.includes("bridge.handshake"));
  assert.equal(JSON.stringify(result.capabilities), JSON.stringify([...result.capabilities].sort()));
  assert.equal(new Set(result.capabilities).size, result.capabilities.length);
  assert.equal(JSON.stringify(result.capabilities), JSON.stringify(ALL_TOOL_REQUIRED_CAPABILITIES));
});

test("popup status compares actual extension capabilities with host client requirements", () => {
  const harness = createBackgroundHarness();
  const status = harness.popupStatus({
    name: "com.opencode.chrome_bridge",
    version: "1.3.0",
    protocolMin: "1.0.0",
    protocolMax: "1.0.0",
    requiredCapabilities: ["browser.tabs", "browser.future", "bridge.handshake"]
  });
  assert.equal(status.compatible, false);
  assert.deepEqual(Array.from(status.missingCapabilities), ["browser.future"]);
  assert.equal(status.diagnostics[0].code, "MISSING_CAPABILITIES");
  assert.ok(Array.from(status.extension.capabilities).includes("browser.tabs"));
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
  const order = [];
  let tabReads = 0;
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
      order.push(injection.files ? "inject" : "read");
      injections.push(injection);
      return injection.files ? [] : [{ result: combined }];
    },
    tabsCaptureVisibleTab: async (windowId, options) => {
      order.push("capture");
      captures.push({ options, windowId });
      return "data:image/jpeg;base64,/9j/2Q==";
    },
    tabsGet: async (tabId) => {
      tabReads += 1;
      order.push("get");
      return { active: tabReads > 1, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 };
    },
    tabsUpdate: async (tabId) => {
      order.push("activate");
      return { active: true, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 };
    },
    windowsUpdate: async (windowId) => {
      order.push("focus");
      return { id: windowId };
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
  assert.deepEqual(order, ["get", "focus", "activate", "inject", "read", "get", "get", "capture", "get"]);
  const funcCall = injections.find((injection) => typeof injection.func === "function");
  assert.deepEqual({ ...funcCall.args[0] }, {
    interactiveOnly: false,
    maxChars: 4000,
    maxNodes: 200,
    maxSelectionChars: 300
  });
});

test("readPage fails before capture when the activated tab changes", async () => {
  let captures = 0;
  let tabReads = 0;
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
    },
    tabsGet: async (tabId) => {
      tabReads += 1;
      return {
        active: false,
        id: tabId,
        index: 0,
        title: "Example",
        url: "https://example.com",
        windowId: 1
      };
    }
  });

  await assert.rejects(
    harness.execute("readPage", { includeScreenshot: true, tabId: 7 }),
    /target tab changed before screenshot capture/u
  );
  assert.equal(tabReads, 2);
  assert.equal(captures, 0);
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

test("readPage cancellation stops browser work before screenshot capture", async () => {
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const delayedRead = new Promise((resolve) => { releaseRead = resolve; });
  let captures = 0;
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      markReadStarted();
      await delayedRead;
      return [{
        result: {
          accessibility: { nodeCount: 0, tree: "", truncated: false },
          context: { visibleText: "Page text" }
        }
      }];
    },
    tabsCaptureVisibleTab: async () => {
      captures += 1;
      return "data:image/png;base64,iVBORw0KGgo=";
    }
  });
  const controller = new AbortController();

  const result = harness.execute(
    "readPage",
    { includeScreenshot: true, tabId: 7 },
    { signal: controller.signal }
  );
  await readStarted;
  controller.abort(new Error("read page cancelled"));
  releaseRead();

  await assert.rejects(result, /cancelled/u);
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

test("findElements injects the isolated finder and returns bounded ranked matches", async () => {
  const injections = [];
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      injections.push(injection);
      return injection.files ? [] : [{
        result: {
          matches: [{
            interactive: true,
            name: "Save account",
            ref: "e2",
            role: "button",
            score: 2200,
            text: "Save account",
            visible: true
          }],
          query: "save account",
          totalMatches: 1,
          truncated: false
        }
      }];
    }
  });

  const result = await harness.execute("findElements", {
    interactiveOnly: true,
    limit: 7,
    query: "save account",
    role: "button",
    tabId: 7,
    visibleOnly: true
  });

  assert.equal(result.tabId, 7);
  assert.equal(result.matches[0].ref, "e2");
  const funcCall = injections.find((injection) => typeof injection.func === "function");
  assert.deepEqual({ ...funcCall.args[0] }, {
    interactiveOnly: true,
    limit: 7,
    query: "save account",
    role: "button",
    visibleOnly: true
  });
});

test("findElements validates query limits and isolated-world output", async () => {
  let injectionCalls = 0;
  const invalidInput = createBackgroundHarness({
    scriptingExecuteScript: async () => { injectionCalls += 1; return []; }
  });
  await assert.rejects(
    invalidInput.execute("findElements", { tabId: 7, query: "" }),
    /query must be a non-empty string/u
  );
  await assert.rejects(
    invalidInput.execute("findElements", { tabId: 7, query: "x".repeat(501) }),
    /query is too large/u
  );
  assert.equal(injectionCalls, 0);

  const malformedOutput = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{ result: { matches: [{ ref: "e1", score: "high" }] } }]
  });
  await assert.rejects(
    malformedOutput.execute("findElements", { tabId: 7, query: "save" }),
    /find elements result is invalid/u
  );
});

test("waitFor validates one typed condition and bounds its timing controls", async () => {
  const harness = createBackgroundHarness();

  await assert.rejects(
    harness.execute("waitFor", {
      condition: { type: "url", value: "https://example.com", selector: "#also" },
      pollIntervalMs: 10,
      tabId: 7,
      timeoutMs: 50
    }),
    /url condition contains unsupported fields/u
  );
  await assert.rejects(
    harness.execute("waitFor", { condition: { type: "text" }, tabId: 7, timeoutMs: 50 }),
    /text condition value must be a non-empty string/u
  );
  await assert.rejects(
    harness.execute("waitFor", { condition: { type: "unknown" }, tabId: 7, timeoutMs: 50 }),
    /condition type must be one of/u
  );
  for (const condition of [
    { type: "text", value: "ready", caseSensitive: "false" },
    { type: "ref", ref: "e1", visibleOnly: 1 },
    { type: "selector", selector: "button", visibleOnly: "true" }
  ]) {
    await assert.rejects(
      harness.execute("waitFor", { condition, tabId: 7, timeoutMs: 50 }),
      /must be a boolean/u
    );
  }
  for (const idleMs of [9, 30_001]) {
    await assert.rejects(
      harness.execute("waitFor", {
        condition: { type: "networkIdle", idleMs },
        tabId: 7,
        timeoutMs: 50
      }),
      /idleMs must be an integer from 10 to 30000/u
    );
  }
});

test("waitFor observes URL and only navigation that starts after the wait baseline", async () => {
  let urlReads = 0;
  const urlHarness = createBackgroundHarness({
    tabsGet: async (tabId) => ({
      active: true,
      id: tabId,
      status: "complete",
      url: ++urlReads < 2 ? "https://example.com/start" : "https://example.com/ready",
      windowId: 1
    })
  });
  const urlResult = await urlHarness.execute("waitFor", {
    condition: { type: "url", value: "/ready", match: "contains" },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 200
  });
  assert.equal(urlResult.matched, true);
  assert.equal(urlResult.type, "url");
  assert.match(urlResult.url, /\/ready$/u);

  const alreadyComplete = createBackgroundHarness({
    tabsGet: async (tabId) => ({ id: tabId, status: "complete", url: "https://example.com/ready", windowId: 1 })
  });
  await assert.rejects(alreadyComplete.execute("waitFor", {
    condition: { type: "navigation" },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 50
  }), /timed out waiting for navigation/u);

  let status = "complete";
  const navigationHarness = createBackgroundHarness({
    tabsGet: async (tabId) => ({
      active: true,
      id: tabId,
      status,
      url: "https://example.com/same-url",
      windowId: 1
    })
  });
  const navigationWaiting = navigationHarness.execute("waitFor", {
    condition: { type: "navigation" },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 200
  });
  status = "loading";
  await navigationHarness.events.tabsOnUpdated.emit(7, { status: "loading" }, {
    id: 7, status, url: "https://example.com/same-url", windowId: 1
  });
  status = "complete";
  await navigationHarness.events.tabsOnUpdated.emit(7, { status: "complete" }, {
    id: 7, status, url: "https://example.com/same-url", windowId: 1
  });
  const navigationResult = await navigationWaiting;
  assert.equal(navigationResult.type, "navigation");
  assert.equal(navigationResult.status, "complete");
  assert.equal(navigationResult.url, "https://example.com/same-url");
});

test("waitFor navigation fails promptly when its tab closes", async () => {
  let closed = false;
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => {
      if (closed) throw new Error(`No tab with id: ${tabId}`);
      return { id: tabId, status: "complete", url: "https://example.com", windowId: 1 };
    }
  });

  const waiting = harness.execute("waitFor", {
    condition: { type: "navigation" },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 200
  });
  closed = true;
  await harness.events.tabsOnRemoved.emit(7, { windowId: 1, isWindowClosing: false });

  await assert.rejects(waiting, /tab 7 closed while waiting for navigation/iu);
});

test("waitFor checks text, live refs, and selectors only through the isolated helper", async () => {
  const callsByType = new Map();
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      const condition = injection.args[0];
      callsByType.set(condition.type, (callsByType.get(condition.type) ?? 0) + 1);
      if (condition.type === "selector" && condition.selector === "[") {
        return [{ result: { invalid: true, matched: false, type: "selector" } }];
      }
      return [{ result: {
        matched: condition.type === "ref" ? false : (callsByType.get(condition.type) >= 2),
        type: condition.type
      } }];
    }
  });

  for (const condition of [
    { type: "text", value: "Ready", caseSensitive: false },
    { type: "selector", selector: "[data-ready]", visibleOnly: true }
  ]) {
    const result = await harness.execute("waitFor", {
      condition,
      pollIntervalMs: 10,
      tabId: 7,
      timeoutMs: 200
    });
    assert.equal(result.type, condition.type);
    assert.equal(result.matched, true);
  }

  await assert.rejects(
    harness.execute("waitFor", {
      condition: { type: "ref", ref: "e99", visibleOnly: true },
      pollIntervalMs: 10,
      tabId: 7,
      timeoutMs: 50
    }),
    /timed out waiting for ref after 50ms/u
  );
  await assert.rejects(
    harness.execute("waitFor", {
      condition: { type: "selector", selector: "[", visibleOnly: true },
      pollIntervalMs: 10,
      tabId: 7,
      timeoutMs: 100
    }),
    /selector is invalid/u
  );
});

test("network-idle waits reset on activity and preserve console debugger consumers", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7 });

  const waiting = harness.execute("waitFor", {
    condition: { type: "networkIdle", idleMs: 40 },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 500
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.requestWillBeSent",
    { requestId: "request-1", timestamp: 1 }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.loadingFinished",
    { requestId: "request-1", timestamp: 2 }
  );

  const result = await waiting;
  assert.equal(result.type, "networkIdle");
  assert.equal(result.inFlight, 0);
  assert.ok(result.idleForMs >= 40);
  assert.ok(Number.isFinite(result.trackingSince), "network waits must disclose when request observation began");
  assert.equal(harness.calls.debuggerDetach.length, 0, "network wait cleanup must preserve the console debugger");

  await emitCurrentRuntimeConsole(harness, "still collecting", { level: "info" });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.logs[0].text, "still collecting");
});

test("network request summaries merge lifecycle events and redact sensitive URLs", async () => {
  const harness = createBackgroundHarness();
  const initial = await harness.execute("networkRequests", { tabId: 7 });
  assert.equal(initial.attached, true);
  assert.equal(initial.count, 0);
  assert.equal(initial.cursor.next, 0);

  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.requestWillBeSent",
    {
      requestId: "request-1",
      timestamp: 10,
      initiator: { type: "script" },
      type: "Fetch",
      request: {
        method: "POST",
        url: "https://alice:secret@example.com/api/items?token=abc&query=visible&password=hunter2&client_secret=hidden#private"
      }
    }
  );
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.responseReceived",
    {
      requestId: "request-1",
      timestamp: 11,
      type: "Fetch",
      response: { status: 201, mimeType: "application/json", encodedDataLength: 123 }
    }
  );
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.loadingFinished",
    { requestId: "request-1", timestamp: 12, encodedDataLength: 456 }
  );

  const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });
  assert.equal(result.count, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.requests[0])), {
    cursor: 3,
    encodedLength: 456,
    failure: null,
    finishedAt: 12,
    initiatorType: "script",
    method: "POST",
    mimeType: "application/json",
    requestId: "request-1",
    resourceType: "Fetch",
    startedAt: 10,
    status: 201,
    url: "https://example.com/api/items?token=%5BREDACTED%5D&query=visible&password=%5BREDACTED%5D&client_secret=%5BREDACTED%5D"
  });
  assert.equal(JSON.stringify(result).includes("alice"), false);
  assert.equal(JSON.stringify(result).includes("alice:secret"), false);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.equal(result.cursor.next, 3);
  assert.equal(result.cursor.latest, 3);
  assert.equal(result.cursor.oldest, 3);

  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "request-2",
    timestamp: 13,
    type: "Other",
    request: { method: "GET", url: "data:text/plain,private-body-content" },
    initiator: { type: "other" }
  });
  const withDataUrl = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, since: result.cursor.next });
  assert.equal(withDataUrl.requests[0].url, "data:[REDACTED]");
  assert.equal(JSON.stringify(withDataUrl).includes("private-body-content"), false);
});

test("network request cursors advance on every lifecycle mutation", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "lifecycle", timestamp: 1, type: "Fetch",
    request: { method: "GET", url: "https://example.com/api" }, initiator: { type: "script" }
  });
  const started = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });
  assert.equal(started.requests[0].cursor, 1);
  assert.equal(started.cursor.next, 1);

  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.responseReceived", {
    requestId: "lifecycle", timestamp: 2, type: "Fetch",
    response: { status: 202, mimeType: "application/json", encodedDataLength: 10 }
  });
  const responded = await harness.execute("networkRequests", {
    tabId: 7, autoAttach: false, since: started.cursor.next
  });
  assert.equal(responded.count, 1);
  assert.equal(responded.requests[0].cursor, 2);
  assert.equal(responded.requests[0].status, 202);
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "lifecycle", timestamp: 3, encodedDataLength: 20
  });
  const completed = await harness.execute("networkRequests", {
    tabId: 7, autoAttach: false, since: responded.cursor.next
  });
  assert.equal(completed.count, 1, "a poll after request start must observe the final mutation");
  assert.equal(completed.requests[0].cursor, 3);
  assert.equal(completed.requests[0].status, 202);
  assert.equal(completed.requests[0].finishedAt, 3);
  assert.equal(completed.cursor.next, 3);
  assert.equal(completed.cursor.latest, 3);

  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "failed", timestamp: 4, type: "Fetch",
    request: { method: "GET", url: "https://example.com/fail" }, initiator: { type: "script" }
  });
  const failing = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, since: 3 });
  assert.equal(failing.requests[0].cursor, 4);
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFailed", {
    requestId: "failed", timestamp: 5, errorText: "blocked"
  });
  const failed = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, since: 4 });
  assert.equal(failed.requests[0].cursor, 5);
  assert.equal(failed.requests[0].failure, "blocked");
});

test("redirected request ids reset stale response state and move to the newest cursor", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "redirect", timestamp: 1, type: "Document",
    request: { method: "GET", url: "https://example.com/old" }, initiator: { type: "parser" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.responseReceived", {
    requestId: "redirect", timestamp: 2, type: "Document",
    response: { status: 301, mimeType: "text/html", encodedDataLength: 99 }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFailed", {
    requestId: "redirect", timestamp: 3, errorText: "old redirect failure"
  });
  const beforeRedirect = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });

  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "redirect", timestamp: 4, type: "Document",
    request: { method: "GET", url: "https://example.com/new" }, initiator: { type: "redirect" }
  });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "other", timestamp: 5, type: "Fetch",
    request: { method: "POST", url: "https://example.com/other" }, initiator: { type: "script" }
  });
  const afterRedirect = await harness.execute("networkRequests", {
    tabId: 7, autoAttach: false, since: beforeRedirect.cursor.next
  });
  assert.equal(JSON.stringify(afterRedirect.requests.map((entry) => entry.requestId)), JSON.stringify(["redirect", "other"]));
  assert.deepEqual(JSON.parse(JSON.stringify(afterRedirect.requests[0])), {
    cursor: 4,
    encodedLength: 0,
    failure: null,
    finishedAt: null,
    initiatorType: "redirect",
    method: "GET",
    mimeType: "",
    requestId: "redirect",
    resourceType: "Document",
    startedAt: 4,
    status: null,
    url: "https://example.com/new"
  });
  assert.equal(afterRedirect.requests[1].cursor, 5);
});

test("network cursor metadata reports discarded all-in-flight overflow", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  for (let index = 0; index <= 1_000; index += 1) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: `in-flight-${index}`, timestamp: index, type: "Fetch",
      request: { method: "GET", url: `https://example.com/${index}` }, initiator: { type: "script" }
    });
  }
  const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, limit: 1 });
  assert.equal(result.cursor.overflowed, true);
  assert.equal(result.cursor.dropped, 1);
  assert.equal(result.cursor.latest, 1_001, "discarded incoming events still consume the high-water cursor");
  await harness.execute("networkRequests", { tabId: 7, autoAttach: false, clear: true, limit: 1 });
  const afterClear = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });
  assert.equal(afterClear.cursor.overflowed, true, "clear must not erase unknown in-flight overflow");
  assert.equal(afterClear.cursor.dropped, 1);
  assert.equal(afterClear.cursor.latest, 1_001, "clear must preserve the monotonic high-water cursor");
  for (let index = 0; index < 1_000; index += 1) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFinished", {
      requestId: `in-flight-${index}`, timestamp: 2_000 + index, encodedDataLength: 1
    });
  }
  await assert.rejects(
    harness.execute("waitFor", {
      condition: { type: "networkIdle", idleMs: 10 }, pollIntervalMs: 10, tabId: 7, timeoutMs: 50
    }),
    /timed out waiting for networkIdle/u,
    "unknown overflow must remain fail-closed even after known requests finish"
  );
});

test("network clear hides history but preserves in-flight requests for network-idle", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "still-running", timestamp: 1, type: "Fetch",
    request: { method: "GET", url: "https://example.com/slow" }, initiator: { type: "script" }
  });
  const cleared = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, clear: true });
  assert.equal(cleared.count, 1);
  assert.equal(cleared.cursor.clearedThroughCursor, 1);
  assert.equal(cleared.cursor.hasMore, false);
  assert.equal(cleared.cursor.oldest, null);
  const hidden = await harness.execute("networkRequests", { tabId: 7, autoAttach: false });
  assert.equal(hidden.count, 0);
  assert.equal(hidden.cursor.clearedThroughCursor, 1);

  let settled = false;
  const waiting = harness.execute("waitFor", {
    condition: { type: "networkIdle", idleMs: 30 }, pollIntervalMs: 10, tabId: 7, timeoutMs: 300
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false, "clear must not make an active request disappear from network-idle");
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "still-running", timestamp: 2, encodedDataLength: 10
  });
  const result = await waiting;
  assert.equal(result.inFlight, 0);
  const finished = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, since: hidden.cursor.next });
  assert.equal(finished.count, 1);
  assert.equal(finished.cursor.clearedThroughCursor, 1);
  assert.equal(finished.cursor.oldest, 2);
});

test("network capture cancellation during attach rolls back without late state", async () => {
  let releaseAttach;
  const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
  const harness = createBackgroundHarness({ debuggerAttach: async () => attachGate });
  const controller = new AbortController();
  const capture = harness.execute("networkRequests", { tabId: 7 }, { signal: controller.signal });
  for (let attempt = 0; attempt < 50 && harness.calls.debuggerAttach.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  controller.abort(new Error("cancel attach"));
  releaseAttach();
  await assert.rejects(capture, /cancel|cancelled/u);
  assert.equal(harness.calls.debuggerDetach.length, 1);
  assert.equal(harness.networkTrackerState(7), null);
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "late", timestamp: 1, request: { method: "GET", url: "https://example.com/late" }
  });
  assert.equal((await harness.execute("networkRequests", { tabId: 7, autoAttach: false })).count, 0);
});

test("network capture cancellation during enable preserves prior debugger consumers", async () => {
  let releaseEnable;
  const enableGate = new Promise((resolve) => { releaseEnable = resolve; });
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => method === "Network.enable" ? enableGate : {}
  });
  await harness.execute("getConsoleLogs", { tabId: 7 });
  const controller = new AbortController();
  const capture = harness.execute("networkRequests", { tabId: 7 }, { signal: controller.signal });
  for (let attempt = 0; attempt < 50
    && !harness.calls.debuggerCommands.some((entry) => entry.method === "Network.enable"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  controller.abort(new Error("cancel enable"));
  releaseEnable({});
  await assert.rejects(capture, /cancel|cancelled/u);
  assert.equal(harness.calls.debuggerDetach.length, 0, "a reused console debugger must remain attached");
  assert.ok(harness.calls.debuggerCommands.some((entry) => entry.method === "Network.disable"));
  assert.equal(harness.networkTrackerState(7), null);
  await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "late-after-enable", timestamp: 1,
    request: { method: "GET", url: "https://example.com/late-enable" }
  });
  assert.equal(harness.networkTrackerState(7), null, "cancelled enable must not leave late capture active");

  await emitCurrentRuntimeConsole(harness, "console survived", { level: "info" });
  const logs = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(logs.attached, true);
  assert.equal(logs.logs[0].text, "console survived");
});

test("network URL redaction normalizes encoded sensitive query names", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  const sensitiveKeys = [
    "%53AML_Response", "saml-request", "Assertion", "JWT", "Bearer", "ticket",
    "Relay-State", "oauth", "access_token", "refresh-token", "id.token",
    "authorization%5Fcode", "client_secret", "api-key", "session_id", "x-api-key",
    "X-Amz-Credential", "X-Amz-Signature", "X-Amz-Security-Token",
    "X-Goog-Credential", "X-Goog-Signature", "client_assertion"
  ];
  for (const [index, key] of sensitiveKeys.entries()) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: `sensitive-${index}`, timestamp: index, type: "Fetch",
      request: { method: "GET", url: `https://example.com/api?${key}=private-${index}&query=visible-${index}` },
      initiator: { type: "script" }
    });
  }
  const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, limit: 100 });
  assert.equal(result.count, sensitiveKeys.length);
  for (const [index, entry] of result.requests.entries()) {
    assert.equal(entry.url.includes(`private-${index}`), false, `sensitive key ${sensitiveKeys[index]} leaked`);
    assert.equal(entry.url.includes(`query=visible-${index}`), true, "benign query values must remain useful");
    assert.equal(entry.url.includes("%5BREDACTED%5D"), true);
  }
});

test("raw Network.enable remains shared when a network summary request is cancelled", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("cdpCommand", { tabId: 7, method: "Network.enable", commandParams: {} });
  assert.equal(
    harness.calls.debuggerCommands.filter((entry) => entry.method === "Network.enable").length,
    1
  );

  const controller = new AbortController();
  controller.abort(new Error("cancel shared capture"));
  await assert.rejects(
    harness.execute("networkRequests", { tabId: 7 }, { signal: controller.signal }),
    /cancel|cancelled/u
  );
  assert.equal(
    harness.calls.debuggerCommands.some((entry) => entry.method === "Network.disable"),
    false,
    "cancelled capture must not disable a raw CDP Network consumer"
  );

  await harness.execute("networkRequests", { tabId: 7 });
  assert.equal(
    harness.calls.debuggerCommands.filter((entry) => entry.method === "Network.enable").length,
    1,
    "network capture must reuse the raw enabled domain instead of claiming exclusive ownership"
  );
});

test("temporary raw Network.enable is forgotten after its debugger detaches", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("cdpCommand", { tabId: 7, method: "Network.enable", commandParams: {} });
  assert.equal(harness.calls.debuggerDetach.length, 1);
  await harness.execute("networkRequests", { tabId: 7 });
  assert.equal(
    harness.calls.debuggerCommands.filter((entry) => entry.method === "Network.enable").length,
    2,
    "a new persistent attachment must re-enable Network after the temporary raw attachment detached"
  );
});

test("raw Network.disable invalidates the shared domain state for the next capture", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("networkRequests", { tabId: 7 });
  await harness.execute("cdpCommand", { tabId: 7, method: "Network.disable", commandParams: {} });
  await harness.execute("networkRequests", { tabId: 7 });
  assert.equal(
    harness.calls.debuggerCommands.filter((entry) => entry.method === "Network.enable").length,
    2,
    "capture must restore Network after an explicit raw disable"
  );
});

test("network cursor pagination advances only through the last returned entry", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  for (let index = 1; index <= 5; index += 1) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: `page-${index}`, timestamp: index, type: "Fetch",
      request: { method: "GET", url: `https://example.com/${index}` }, initiator: { type: "script" }
    });
  }
  const seen = [];
  let since = 0;
  for (let page = 0; page < 3; page += 1) {
    const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, limit: 2, since });
    seen.push(...result.requests.map((entry) => entry.requestId));
    assert.equal(result.cursor.latest, 5);
    since = result.cursor.next;
  }
  assert.equal(JSON.stringify(seen), JSON.stringify(["page-1", "page-2", "page-3", "page-4", "page-5"]));
  assert.equal(since, 5);
});

test("network request summaries filter stably, clear atomically, and coexist with debugger consumers", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("subscribeCdpEvents", { tabId: 7, methods: ["Network.responseReceived"] });
  await harness.execute("networkRequests", { tabId: 7 });
  assert.equal(harness.calls.debuggerAttach.length, 1, "persistent consumers must share one debugger");
  assert.equal(
    harness.calls.debuggerCommands.filter((entry) => entry.method === "Network.enable").length,
    1,
    "Network must be enabled once per tab"
  );

  for (const [requestId, method, url, type, status] of [
    ["b", "GET", "https://example.com/assets/b.js", "Script", 200],
    ["a", "POST", "https://example.com/api/a", "Fetch", 503],
    ["c", "GET", "https://example.com/api/c", "Fetch", 204]
  ]) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId, timestamp: requestId === "b" ? 3 : requestId === "a" ? 1 : 2,
      type, request: { method, url }, initiator: { type: "parser" }
    });
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.responseReceived", {
      requestId, timestamp: 4, type, response: { status, mimeType: "text/plain", encodedDataLength: 10 }
    });
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFinished", {
      requestId, timestamp: 5, encodedDataLength: 20
    });
  }

  const filtered = await harness.execute("networkRequests", {
    tabId: 7,
    autoAttach: false,
    methods: ["GET"],
    resourceTypes: ["Fetch"],
    statusMin: 200,
    statusMax: 299,
    urlContains: "/api/",
    since: 0,
    limit: 10
  });
  assert.equal(JSON.stringify(filtered.requests.map((entry) => entry.requestId)), JSON.stringify(["c"]));
  assert.equal(filtered.cursor.next, 9);
  assert.equal(filtered.cursor.latest, 9);
  assert.equal(filtered.cursor.hasMore, false);

  const cleared = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, clear: true });
  assert.equal(JSON.stringify(cleared.requests.map((entry) => entry.requestId)), JSON.stringify(["b", "a", "c"]));
  assert.equal((await harness.execute("networkRequests", { tabId: 7, autoAttach: false })).count, 0);
  await harness.execute("unsubscribeCdpEvents", { tabId: 7 });
  assert.equal(harness.calls.debuggerDetach.length, 0, "network capture must keep the shared debugger attached");
  await harness.execute("releaseDebuggers", { tabIds: [7] });
  assert.equal(harness.calls.debuggerDetach.length, 1);
  assert.equal(await harness.networkTrackerState(7), null, "release must remove network state");
});

test("network request summaries enforce count, string, and filter bounds", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("networkRequests", { tabId: 7 });
  for (let index = 0; index < 1_005; index += 1) {
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: `request-${index}`,
      timestamp: index,
      type: "Fetch",
      request: { method: "GET", url: `https://example.com/${index}/${"x".repeat(3_000)}` },
      initiator: { type: "script" }
    });
    await harness.events.debuggerOnEvent.emit({ tabId: 7 }, "Network.loadingFailed", {
      requestId: `request-${index}`,
      timestamp: index + 0.5,
      errorText: "failure".repeat(2_000)
    });
  }
  const result = await harness.execute("networkRequests", { tabId: 7, autoAttach: false, limit: 500 });
  assert.ok(result.cursor.dropped >= 5);
  assert.ok(result.cursor.oldest > 1);
  assert.ok(result.requests.length <= 500);
  assert.ok(result.requests.every((entry) => entry.url.length <= 2_048));
  assert.ok(result.requests.every((entry) => entry.failure.length <= 500));

  for (const invalid of [
    { methods: "GET" },
    { methods: Array.from({ length: 21 }, () => "GET") },
    { resourceTypes: [""] },
    { urlContains: "x".repeat(501) },
    { limit: 501 },
    { since: -1 },
    { clear: "yes" },
    { autoAttach: 1 }
  ]) {
    await assert.rejects(
      harness.execute("networkRequests", { tabId: 7, autoAttach: false, ...invalid }),
      /methods|resourceTypes|urlContains|limit|since|clear|autoAttach/iu
    );
  }
});

test("network-idle tracks requests emitted while Network.enable is in flight", async () => {
  let harness;
  harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Network.enable") {
        await harness.events.debuggerOnEvent.emit(
          { tabId: 7 },
          "Network.requestWillBeSent",
          { requestId: "during-enable", timestamp: 1 }
        );
      }
      return {};
    }
  });

  await assert.rejects(
    harness.execute("waitFor", {
      condition: { type: "networkIdle", idleMs: 30 },
      pollIntervalMs: 10,
      tabId: 7,
      timeoutMs: 80
    }),
    /timed out waiting for networkIdle after 80ms/u
  );
});

test("network-idle request accounting is bounded and overflow fails closed", async () => {
  const harness = createBackgroundHarness();
  const waiting = harness.execute("waitFor", {
    condition: { type: "networkIdle", idleMs: 30 },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 100
  });
  const rejection = assert.rejects(waiting, /timed out waiting for networkIdle after 100ms/u);
  for (let attempt = 0; attempt < 50 && harness.calls.debuggerAttach.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  for (let index = 0; index <= 1_000; index += 1) {
    await harness.events.debuggerOnEvent.emit(
      { tabId: 7 },
      "Network.requestWillBeSent",
      { requestId: `request-${index}`, timestamp: index }
    );
  }

  const state = harness.networkTrackerState(7);
  assert.equal(state.inFlight, 1_000);
  assert.equal(state.overflowed, true);
  assert.equal(state.requestCount, 1_000);
  await rejection;
});

test("native cancel aborts waitFor promptly, releases its debugger, and suppresses a late response", async () => {
  const harness = createBackgroundHarness();
  const commandHandling = harness.events.nativeOnMessage.emit({
    type: "command",
    id: "command-cancel-1",
    method: "waitFor",
    params: {
      condition: { type: "networkIdle", idleMs: 30_000 },
      pollIntervalMs: 1_000,
      tabId: 7,
      timeoutMs: 5_000
    }
  });
  for (let attempt = 0; attempt < 50 && harness.calls.debuggerAttach.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.calls.debuggerAttach.length, 1);

  const cancelledAt = Date.now();
  await harness.events.nativeOnMessage.emit({ type: "cancel", id: "command-cancel-1" });
  await commandHandling;

  assert.ok(Date.now() - cancelledAt < 200, "cancel must not wait for the next polling deadline");
  assert.equal(harness.calls.debuggerDetach.length, 1);
  assert.equal(harness.activeNativeCommandCount(), 0);
  assert.equal(
    harness.calls.nativeMessages.some((message) => message.type === "response" && message.id === "command-cancel-1"),
    false,
    "a cancelled command must not post a response after the host has timed out"
  );
});

test("native cancel ignores unknown or already completed command ids", async () => {
  const harness = createBackgroundHarness();

  await assert.doesNotReject(() => harness.events.nativeOnMessage.emit({ type: "cancel", id: "unknown-command" }));
  await harness.events.nativeOnMessage.emit({ type: "command", id: "completed-command", method: "status", params: {} });
  await assert.doesNotReject(() => harness.events.nativeOnMessage.emit({ type: "cancel", id: "completed-command" }));
  assert.equal(harness.activeNativeCommandCount(), 0);
});

test("native disconnect aborts active waits and releases debugger resources promptly", async () => {
  const harness = createBackgroundHarness();
  const commandHandling = harness.events.nativeOnMessage.emit({
    type: "command",
    id: "disconnect-active-wait",
    method: "waitFor",
    params: {
      condition: { type: "networkIdle", idleMs: 30_000 },
      pollIntervalMs: 1_000,
      tabId: 7,
      timeoutMs: 200
    }
  });
  for (let attempt = 0; attempt < 50 && harness.calls.debuggerAttach.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const disconnectedAt = Date.now();
  await harness.events.nativeOnDisconnect.emit();
  await commandHandling;

  assert.ok(Date.now() - disconnectedAt < 100, "disconnect cleanup must not wait for the command timeout");
  assert.equal(harness.activeNativeCommandCount(), 0);
  assert.equal(harness.calls.debuggerDetach.length, 1);
});

test("CDP unsubscription does not detach an active network-idle consumer", async () => {
  const harness = createBackgroundHarness();
  await harness.execute("subscribeCdpEvents", { tabId: 7, methods: ["Network.responseReceived"] });
  const waiting = harness.execute("waitFor", {
    condition: { type: "networkIdle", idleMs: 40 },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 200
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  await harness.execute("unsubscribeCdpEvents", { tabId: 7 });
  assert.equal(harness.calls.debuggerDetach.length, 0, "CDP cleanup must leave the network consumer attached");

  await waiting;
  assert.equal(harness.calls.debuggerDetach.length, 1, "the final network consumer owns the eventual detach");
});

test("network-idle timeout cleans its debugger consumer in finally", async () => {
  const harness = createBackgroundHarness();
  const waiting = harness.execute("waitFor", {
    condition: { type: "networkIdle", idleMs: 40 },
    pollIntervalMs: 10,
    tabId: 7,
    timeoutMs: 80
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await harness.events.debuggerOnEvent.emit(
    { tabId: 7 },
    "Network.requestWillBeSent",
    { requestId: "never-finishes", timestamp: 1 }
  );

  await assert.rejects(waiting, /timed out waiting for networkIdle after 80ms/u);
  assert.equal(harness.calls.debuggerDetach.length, 1);
});

test("waitFor returns completed downloads and rejects interrupted downloads", async () => {
  const completeHarness = createBackgroundHarness({
    downloadsSearch: async ({ id }) => [{
      id,
      bytesReceived: 100,
      filename: "/tmp/report.pdf",
      state: "complete",
      totalBytes: 100,
      url: "https://example.com/report.pdf"
    }]
  });
  const complete = await completeHarness.execute("waitFor", {
    condition: { type: "download", downloadId: 42 },
    pollIntervalMs: 10,
    timeoutMs: 100
  });
  assert.equal(complete.type, "download");
  assert.equal(complete.download.id, 42);
  assert.equal(complete.download.state, "complete");

  const interruptedHarness = createBackgroundHarness({
    downloadsSearch: async ({ id }) => [{
      id,
      error: "NETWORK_FAILED",
      filename: "/tmp/report.pdf",
      state: "interrupted",
      url: "https://example.com/report.pdf"
    }]
  });
  await assert.rejects(
    interruptedHarness.execute("waitFor", {
      condition: { type: "download", downloadId: 42 },
      pollIntervalMs: 10,
      timeoutMs: 100
    }),
    /Download 42 was interrupted: NETWORK_FAILED/u
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
  await emitCurrentRuntimeConsole(harness, "still captured", { level: "error" });

  const result = await harness.execute("getConsoleLogs", { tabId: 7, autoAttach: false });
  assert.equal(result.attached, true);
  assert.equal(result.count, 1);
  assert.equal(result.logs[0].text, "still captured");
});

test("console logs and forwarded CDP events are bounded before buffering or native messaging", async () => {
  const harness = createBackgroundHarness();
  const oversizedText = "x".repeat(600_000);

  await harness.execute("getConsoleLogs", { tabId: 7 });
  await emitCurrentRuntimeConsole(harness, oversizedText, { level: "error" });

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
  let runtimeEnableAttempts = 0;
  const harness = createBackgroundHarness({
    debuggerSendCommand: async (_target, method) => {
      if (method === "Runtime.enable") {
        runtimeEnableAttempts += 1;
        if (runtimeEnableAttempts === 1) throw new Error("target was temporarily unavailable");
      }
      return {};
    }
  });

  await harness.execute("getConsoleLogs", { tabId: 7 });
  await harness.execute("getConsoleLogs", { tabId: 7 });

  assert.equal(runtimeEnableAttempts, 2);
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

test("typed browser batches execute actions sequentially and preserve result order", async () => {
  const order = [];
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => {
      order.push(`get:${tabId}`);
      return { active: true, id: tabId, index: 0, title: `Tab ${tabId}`, url: "https://example.com", windowId: 1 };
    },
    tabsUpdate: async (tabId, update) => {
      order.push(`navigate:${tabId}`);
      return { active: true, id: tabId, index: 0, title: "Navigated", url: update.url, windowId: 1 };
    }
  });

  const result = await harness.execute("browserBatch", {
    actions: [
      { type: "getTab", params: { tabId: 7 } },
      { type: "navigate", params: { tabId: 8, url: "https://example.com/next" } },
      { type: "getTab", params: { tabId: 9 } }
    ],
    stopOnError: true,
    totalTimeoutMs: 5_000
  });

  assert.deepEqual(order, ["get:7", "navigate:8", "get:9"]);
  assert.equal(result.ok, true);
  assert.equal(result.completed, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.results.map(({ index, type, ok }) => ({ index, type, ok })))), [
    { index: 0, type: "getTab", ok: true },
    { index: 1, type: "navigate", ok: true },
    { index: 2, type: "getTab", ok: true }
  ]);
});

test("browser batches continue or stop on action-indexed failures", async () => {
  const calls = [];
  const makeHarness = () => createBackgroundHarness({
    tabsGet: async (tabId) => {
      calls.push(tabId);
      if (tabId === 7) throw new Error("tab unavailable");
      return { active: true, id: tabId, index: 0, title: "Ready", url: "https://example.com", windowId: 1 };
    }
  });
  const actions = [
    { type: "getTab", params: { tabId: 7 } },
    { type: "getTab", params: { tabId: 8 } }
  ];

  const stopped = await makeHarness().execute("browserBatch", { actions, stopOnError: true });
  assert.deepEqual(calls, [7]);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stoppedAt, 0);
  assert.equal(stopped.results[0].index, 0);
  assert.equal(stopped.results[0].ok, false);
  assert.match(stopped.results[0].error, /tab unavailable/u);

  calls.length = 0;
  const continued = await makeHarness().execute("browserBatch", { actions, stopOnError: false });
  assert.deepEqual(calls, [7, 8]);
  assert.equal(continued.ok, false);
  assert.equal(continued.stoppedAt, null);
  assert.deepEqual(JSON.parse(JSON.stringify(continued.results.map(({ index, ok }) => ({ index, ok })))), [
    { index: 0, ok: false },
    { index: 1, ok: true }
  ]);
});

test("browser batches enforce per-action and total timeouts", async () => {
  const pending = new Promise((resolve) => setTimeout(() => resolve({ id: 7 }), 500));
  const harness = createBackgroundHarness({ tabsGet: async () => pending });

  const perActionStarted = Date.now();
  const perAction = await harness.execute("browserBatch", {
    actions: [{ type: "getTab", params: { tabId: 7 }, timeoutMs: 50 }],
    totalTimeoutMs: 1_000
  });
  assert.ok(Date.now() - perActionStarted < 300, "per-action timeout should not await a late Chrome callback");
  assert.equal(perAction.results[0].index, 0);
  assert.match(perAction.results[0].error, /action 0.*timed out.*50ms/iu);

  const totalStarted = Date.now();
  const total = await harness.execute("browserBatch", {
    actions: [
      { type: "getTab", params: { tabId: 7 }, timeoutMs: 1_000 },
      { type: "getTab", params: { tabId: 8 }, timeoutMs: 1_000 }
    ],
    stopOnError: false,
    totalTimeoutMs: 50
  });
  assert.ok(Date.now() - totalStarted < 300, "total timeout should bound the batch");
  assert.equal(total.results.length, 1);
  assert.equal(total.results[0].index, 0);
  assert.match(total.results[0].error, /total timeout.*50ms/iu);
  assert.equal(total.stoppedAt, 0);
});

test("a timed-out batch action never overlaps a later action", async () => {
  const calls = [];
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => {
      calls.push(tabId);
      if (tabId === 7) return new Promise((resolve) => setTimeout(() => resolve({ id: tabId }), 500));
      return { id: tabId };
    }
  });

  const result = await harness.execute("browserBatch", {
    actions: [
      { type: "getTab", params: { tabId: 7 }, timeoutMs: 50 },
      { type: "getTab", params: { tabId: 8 }, timeoutMs: 1_000 }
    ],
    stopOnError: false,
    totalTimeoutMs: 1_000
  });

  assert.deepEqual(calls, [7]);
  assert.equal(result.stoppedAt, 0);
  assert.match(result.results[0].error, /action 0.*timed out/iu);
});

test("a timed-out batch action cannot start mutations after delayed preparation resolves", async () => {
  let resolveTabLookup;
  const delayedTabLookup = new Promise((resolve) => { resolveTabLookup = resolve; });
  let tabActivations = 0;
  let windowFocuses = 0;
  const harness = createBackgroundHarness({
    tabsGet: async () => delayedTabLookup,
    tabsUpdate: async (tabId) => {
      tabActivations += 1;
      return { active: true, id: tabId, index: 0, title: "Late", url: "https://example.com", windowId: 1 };
    },
    windowsUpdate: async (windowId) => {
      windowFocuses += 1;
      return { id: windowId };
    }
  });

  const result = await harness.execute("browserBatch", {
    actions: [{ type: "activateTab", params: { tabId: 7 }, timeoutMs: 50 }],
    totalTimeoutMs: 1_000
  });
  assert.equal(result.stoppedAt, 0);
  resolveTabLookup({ active: false, id: 7, index: 0, title: "Ready", url: "https://example.com", windowId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(windowFocuses, 0, "a late tab lookup must not focus the window after timeout");
  assert.equal(tabActivations, 0, "a late tab lookup must not activate the tab after timeout");
});

test("browser batches reject forbidden and malformed actions before side effects", async () => {
  let getCalls = 0;
  const harness = createBackgroundHarness({
    tabsGet: async (tabId) => {
      getCalls += 1;
      return { id: tabId };
    }
  });
  for (const type of ["browserBatch", "workflow", "scheduler", "meta", "cdpCommand"]) {
    await assert.rejects(
      harness.execute("browserBatch", {
        actions: [
          { type: "getTab", params: { tabId: 7 } },
          { type, params: {} }
        ]
      }),
      /batch action 1.*not allowed/iu
    );
  }
  await assert.rejects(
    harness.execute("browserBatch", {
      actions: [{ type: "getTab", params: { tabId: 7, unexpected: true } }]
    }),
    /batch action 0.*unsupported fields.*unexpected/iu
  );
  for (const condition of [
    { type: "text", value: "ready", caseSensitive: "false" },
    { type: "selector", selector: "button", visibleOnly: 1 },
    { type: "networkIdle", idleMs: 30_001 }
  ]) {
    await assert.rejects(
      harness.execute("browserBatch", {
        actions: [
          { type: "getTab", params: { tabId: 7 } },
          { type: "waitFor", params: { tabId: 7, condition } }
        ]
      }),
      /batch action 1|must be a boolean|idleMs must be an integer from 10 to 30000/iu
    );
  }
  for (const modifiers of ["Shift", ["Shift", "Shift", "Shift", "Shift", "Shift", "Shift"]]) {
    await assert.rejects(
      harness.execute("browserBatch", {
        actions: [
          { type: "getTab", params: { tabId: 7 } },
          { type: "clickElement", params: { tabId: 7, ref: "e1", modifiers } }
        ]
      }),
      /batch action 1.*modifiers/iu
    );
  }
  assert.equal(getCalls, 0, "the complete batch must validate before its first action");
});

test("browser batches bound action count and serialized payload size", async () => {
  const harness = createBackgroundHarness();
  await assert.rejects(
    harness.execute("browserBatch", {
      actions: Array.from({ length: 26 }, () => ({ type: "getTab", params: { tabId: 7 } }))
    }),
    /at most 25 actions/iu
  );
  await assert.rejects(
    harness.execute("browserBatch", {
      actions: [{ type: "fillElement", params: { tabId: 7, ref: "e1", text: "x".repeat(100_001) } }]
    }),
    /payload is too large|text is too large/iu
  );
});

test("file upload staging uses opaque ids and rejects duplicate or out-of-order chunks", async () => {
  const isolatedCalls = [];
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      isolatedCalls.push(injection.args);
      return [{ result: { accepted: true } }];
    }
  });

  const begun = await harness.execute("fileUploadBegin", {
    tabId: 7,
    files: [{ chunkCount: 2, name: "hello.txt", size: 5, type: "text/plain" }],
    totalBytes: 5
  });
  assert.match(begun.transferId, /^[A-Za-z0-9_-]{32,}$/u);
  assert.doesNotMatch(begun.transferId, /^(?:\d+|transfer-)/u);
  await harness.execute("fileUploadChunk", {
    transferId: begun.transferId, fileIndex: 0, chunkIndex: 0, data: "aGVs"
  });
  await assert.rejects(
    harness.execute("fileUploadChunk", {
      transferId: begun.transferId, fileIndex: 0, chunkIndex: 0, data: "aGVs"
    }),
    /duplicate|out of order/iu
  );
  await assert.rejects(
    harness.execute("fileUploadChunk", {
      transferId: begun.transferId, fileIndex: 0, chunkIndex: 2, data: "bG8="
    }),
    /out of order/iu
  );
  assert.ok(isolatedCalls.length >= 2);
});

test("file upload commit requires every chunk and abort removes staging", async () => {
  const actions = [];
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      actions.push(injection.args?.[0]);
      return [{ result: injection.args?.[0] === "commit"
        ? { committed: true, count: 1, names: ["hello.txt"] }
        : { accepted: true } }];
    }
  });
  const begun = await harness.execute("fileUploadBegin", {
    tabId: 7,
    files: [{ chunkCount: 1, name: "hello.txt", size: 5, type: "text/plain" }],
    totalBytes: 5
  });
  await assert.rejects(
    harness.execute("fileUploadCommit", { transferId: begun.transferId, tabId: 7, ref: "e1" }),
    /missing chunk/iu
  );
  await harness.execute("fileUploadAbort", { transferId: begun.transferId });
  await assert.rejects(
    harness.execute("fileUploadChunk", {
      transferId: begun.transferId, fileIndex: 0, chunkIndex: 0, data: "aGVsbG8="
    }),
    /unknown|expired/iu
  );
  assert.ok(actions.includes("abort"));
});

test("file upload staging bounds concurrent declared bytes and enforces global file order", async () => {
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => injection.files ? [] : [{ result: { accepted: true } }]
  });
  const begun = await harness.execute("fileUploadBegin", {
    tabId: 7,
    files: [
      { chunkCount: 1, name: "first.bin", size: 1, type: "application/octet-stream" },
      { chunkCount: 1, name: "second.bin", size: 1, type: "application/octet-stream" }
    ],
    totalBytes: 2
  });
  await assert.rejects(
    harness.execute("fileUploadChunk", {
      transferId: begun.transferId, fileIndex: 1, chunkIndex: 0, data: "AA=="
    }),
    /out of order/iu
  );

  for (let index = 0; index < 3; index += 1) {
    await harness.execute("fileUploadBegin", {
      tabId: 7,
      files: [{ chunkCount: 1, name: `pending-${index}.bin`, size: 1, type: "application/octet-stream" }],
      totalBytes: 1
    });
  }
  await assert.rejects(
    harness.execute("fileUploadBegin", {
      tabId: 7,
      files: [{ chunkCount: 1, name: "too-many.bin", size: 1, type: "application/octet-stream" }],
      totalBytes: 1
    }),
    /concurrent|staging limit/iu
  );
});

test("file upload cancellation after isolated preparation never reaches the DOM commit", async () => {
  const actions = [];
  let releasePrepare;
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async (injection) => {
      if (injection.files) return [];
      const action = injection.args?.[0];
      actions.push(action);
      if (action === "prepare") {
        await prepareGate;
        return [{ result: { prepared: true, count: 1, names: ["hello.txt"] } }];
      }
      if (action === "commit") return [{ result: { committed: true, count: 1, names: ["hello.txt"] } }];
      return [{ result: { accepted: true } }];
    }
  });
  const begun = await harness.execute("fileUploadBegin", {
    tabId: 7,
    files: [{ chunkCount: 1, name: "hello.txt", size: 5, type: "text/plain" }],
    totalBytes: 5
  });
  await harness.execute("fileUploadChunk", {
    transferId: begun.transferId, fileIndex: 0, chunkIndex: 0, data: "aGVsbG8="
  });
  const controller = new AbortController();
  const pending = harness.execute(
    "fileUploadCommit",
    { transferId: begun.transferId, tabId: 7, ref: "e1" },
    { signal: controller.signal }
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error("upload cancelled"));
  releasePrepare();

  await assert.rejects(pending, /cancelled/u);
  assert.equal(actions.filter((action) => action === "commit").length, 0);
});

test("page assets merge DOM and CDP inventories, dedupe URLs, and return bounded content", async () => {
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async () => [{ result: [
      { url: "https://example.com/app.js", kind: "script", mimeType: "text/javascript" },
      { url: "https://example.com/image.png", kind: "image", mimeType: "image/png" }
    ] }],
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Page.getResourceTree") return { frameTree: {
        frame: { id: "main", url: "https://example.com/" },
        resources: [
          { url: "https://example.com/app.js", type: "Script", mimeType: "text/javascript" },
          { url: "https://example.com/style.css", type: "Stylesheet", mimeType: "text/css" }
        ]
      } };
      if (method === "Page.getResourceContent") {
        return { content: params.url.endsWith("style.css") ? "body{}" : "console.log(1)", base64Encoded: false };
      }
      return {};
    }
  });
  const result = await harness.execute("pageAssets", { tabId: 7, includeContent: true, maxTotalBytes: 1000 });
  assert.deepEqual(Array.from(result.assets, (asset) => asset.url), [
    "https://example.com/app.js",
    "https://example.com/image.png",
    "https://example.com/style.css"
  ]);
  assert.equal(result.assets[0].content, "console.log(1)");
  assert.equal(result.assets[1].error, "Content is unavailable through CDP");
  assert.equal(result.assets[2].content, "body{}");
  assert.ok(result.totalBytes <= 1000);
});

test("page assets redact signed URLs and skip cross-origin CDP content", async () => {
  const contentRequests = [];
  const harness = createBackgroundHarness({
    scriptingExecuteScript: async () => [{ result: { assets: [], sawOverflow: false } }],
    debuggerSendCommand: async (_target, method, params) => {
      if (method === "Page.getResourceTree") return { frameTree: {
        frame: { id: "main", url: "https://example.com/" },
        resources: [{
          url: "https://user:password@example.com/app.js?X-Amz-Credential=AKIA-SECRET&X-Amz-Signature=raw-signature&token=raw-token#private",
          type: "Script", mimeType: "text/javascript"
        }],
        childFrames: [{
          frame: { id: "third-party", url: "https://cdn.example.net/frame" },
          resources: [{ url: "https://cdn.example.net/third.js?api_key=third-secret", type: "Script", mimeType: "text/javascript" }]
        }]
      } };
      if (method === "Page.getResourceContent") {
        contentRequests.push(params.url);
        return { content: "console.log('safe')", base64Encoded: false };
      }
      return {};
    }
  });
  const result = await harness.execute("pageAssets", { tabId: 7, includeContent: true, maxTotalBytes: 1000 });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /user|password|AKIA-SECRET|raw-signature|raw-token|third-secret|#private/u);
  assert.match(result.assets[0].url, /X-Amz-Credential=%5BREDACTED%5D/iu);
  assert.match(result.assets[1].error, /cross-origin.*not fetched/iu);
  assert.equal(contentRequests.length, 1);
  assert.match(contentRequests[0], /^https:\/\/user:password@example\.com/u);
});

test("page asset inventory reports overflow only after the exact 2000-entry boundary", async () => {
  const makeAssets = (count) => Array.from({ length: Math.min(count, 2000) }, (_, index) => ({
    url: `https://example.com/${index}.js`, kind: "script", mimeType: "text/javascript"
  }));
  for (const [count, expectedTruncated] of [[2000, false], [2001, true]]) {
    const harness = createBackgroundHarness({
      scriptingExecuteScript: async () => [{ result: { assets: makeAssets(count), sawOverflow: count > 2000 } }],
      debuggerSendCommand: async (_target, method) => method === "Page.getResourceTree"
        ? { frameTree: { frame: { id: "main", url: "https://example.com/" }, resources: [] } }
        : {}
    });
    const result = await harness.execute("pageAssets", { tabId: 7 });
    assert.equal(result.count, 2000);
    assert.equal(result.truncated, expectedTruncated);
  }
});

test("page asset collectors use bounded iterative traversal without combined-array accumulation", () => {
  assert.match(backgroundSource, /function flattenCdpResourceTree[\s\S]*while\s*\(/u);
  assert.doesNotMatch(backgroundSource, /\[\.\.\.domAssets,\s*\.\.\.cdpAssets\]/u);
  assert.match(backgroundSource, /MAX_PAGE_ASSET_SCAN_NODES/u);
});

test("notifications enforce title and message bounds and use packaged branded icons", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.execute("notify", { title: "Build complete", message: "Ready for review" });
  assert.equal(result.notified, true);
  assert.equal(harness.calls.notifications.length, 1);
  assert.equal(harness.calls.notifications[0].options.iconUrl, "images/icon128.png");
  await assert.rejects(() => harness.execute("notify", { title: "x".repeat(121), message: "ok" }), /title.*120/iu);
  await assert.rejects(() => harness.execute("notify", { title: "ok", message: "x".repeat(1001) }), /message.*1000/iu);
});

function createBackgroundHarness({
  storageGet = async () => ({}),
  storageSet = async () => {},
  debuggerAttach = async () => {},
  debuggerSendCommand = async () => ({}),
  consoleError = () => {},
  downloadsSearch = async () => [],
  downloadsShowDefaultFolder = async () => {},
  nativePostMessage = null,
  notificationsCreate = async () => "notification-id",
  scriptingExecuteScript = null,
  storageLocalGet = async () => ({}),
  storageManagedGet = null,
  tabsCaptureVisibleTab = async () => "data:image/png;base64,iVBORw0KGgo=",
  tabsCreate = async () => ({ active: false, id: 8, index: 0, title: "", url: "about:blank", windowId: 1 }),
  tabsGet = async (tabId) => ({ active: true, id: tabId, index: 0, title: "Example", url: "https://example.com", windowId: 1 }),
  tabsQuery = async () => [{ active: true, id: 7, index: 0, title: "Example", url: "https://example.com", windowId: 1 }],
  tabsRemove = async () => {},
  tabsGroup = async (options) => options.groupId ?? 1,
  tabsUngroup = async () => {},
  tabsUpdate = async (tabId, update) => ({ active: true, id: tabId, index: 0, title: "Example", url: update.url, windowId: 1 }),
  tabGroupsUpdate = async (groupId, update) => ({ id: groupId, ...update }),
  tabGroupsGet = async (groupId) => ({
    color: "blue", id: groupId, title: "OpenCode · session-a", windowId: groupId === 42 ? 2 : 1
  }),
  windowsCreate = async () => ({ id: 2, tabs: [] }),
  windowsGet = async (windowId) => ({ id: windowId }),
  windowsUpdate = async (windowId) => ({ id: windowId }),
  webNavigationGetFrame = async ({ tabId }) => ({ documentId: `document-${tabId}`, frameId: 0 })
} = {}) {
  const calls = { debuggerAttach: [], debuggerCommands: [], debuggerDetach: [], executeScript: 0, nativeMessages: [], notifications: [], overlayMessages: [], sendMessage: 0 };
  let debuggerTargets = [];
  const events = {
    debuggerOnDetach: createEvent(),
    debuggerOnEvent: createEvent(),
    nativeOnDisconnect: createEvent(),
    nativeOnMessage: createEvent(),
    runtimeOnMessage: createEvent(),
    tabsOnRemoved: createEvent(),
    tabsOnActivated: createEvent(),
    tabsOnReplaced: createEvent(),
    tabsOnUpdated: createEvent(),
    webNavigationOnCommitted: createEvent(),
    webNavigationOnBeforeNavigate: createEvent(),
    webNavigationOnErrorOccurred: createEvent(),
    webNavigationOnCreatedNavigationTarget: createEvent()
  };
  const nativePort = {
    onDisconnect: events.nativeOnDisconnect,
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
      attach: async (target) => {
        calls.debuggerAttach.push(target);
        return debuggerAttach(target);
      },
      detach: async (target) => { calls.debuggerDetach.push(target); },
      getTargets: async () => debuggerTargets,
      onDetach: events.debuggerOnDetach,
      onEvent: events.debuggerOnEvent,
      sendCommand: async (target, method, params) => {
        calls.debuggerCommands.push({ target, method, params });
        return debuggerSendCommand(target, method, params);
      }
    },
    downloads: {
      onChanged: createEvent(),
      onCreated: createEvent(),
      search: downloadsSearch,
      showDefaultFolder: downloadsShowDefaultFolder
    },
    history: { search: async () => [] },
    notifications: {
      create: async (id, options) => {
        calls.notifications.push({ id, options });
        return notificationsCreate(id, options);
      }
    },
    runtime: {
      connectNative: () => nativePort,
      getManifest: () => ({ name: "OpenCode Chrome Bridge", version: "1.3.0" }),
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
    tabGroups: {
      onCreated: createEvent(), onMoved: createEvent(), onRemoved: createEvent(), onUpdated: createEvent(),
      get: tabGroupsGet,
      update: tabGroupsUpdate
    },
    tabs: {
      captureVisibleTab: tabsCaptureVisibleTab,
      create: tabsCreate,
      get: tabsGet,
      group: tabsGroup,
      onActivated: events.tabsOnActivated,
      onCreated: createEvent(),
      onRemoved: events.tabsOnRemoved,
      onReplaced: events.tabsOnReplaced,
      onUpdated: events.tabsOnUpdated,
      query: tabsQuery,
      remove: tabsRemove,
      sendMessage: async (_tabId, message) => {
        calls.sendMessage += 1;
        calls.overlayMessages.push(message);
        return message.expectedScopes ? { authorized: true, scope: message.expectedScopes[0] } : undefined;
      },
      update: tabsUpdate,
      ungroup: tabsUngroup
    },
    windows: {
      create: windowsCreate,
      get: windowsGet,
      getCurrent: async () => ({ id: 1 }),
      onFocusChanged: createEvent(),
      update: windowsUpdate
    },
    webNavigation: {
      getFrame: webNavigationGetFrame,
      onBeforeNavigate: events.webNavigationOnBeforeNavigate,
      onCommitted: events.webNavigationOnCommitted,
      onErrorOccurred: events.webNavigationOnErrorOccurred,
      onCreatedNavigationTarget: events.webNavigationOnCreatedNavigationTarget
    }
  };
  const harnessConsole = Object.create(console);
  harnessConsole.error = consoleError;
  const context = vm.createContext({
    AbortController,
    atob,
    chrome,
    console: harnessConsole,
    crypto: webcrypto,
    navigator: { platform: "MacIntel" },
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL
  });
  vm.runInContext(backgroundSource, context, { filename: "extension/background.js" });

  return {
    activeNativeCommandCount() {
      return vm.runInContext("activeNativeCommands.size", context);
    },
    networkTrackerState(tabId) {
      context.__testTabId = tabId;
      return vm.runInContext(`(() => {
        const state = networkRequestStates.get(__testTabId);
        return state ? {
          inFlight: [...state.requests.values()].filter((request) => request.inFlight === true).length,
          overflowed: state.overflowed,
          requestCount: state.requests.size
        } : null;
      })()`, context);
    },
    navigationBarrierCount() {
      return vm.runInContext("navigationBarriers.size", context);
    },
    persistentDebuggerState(tabId) {
      context.__testTabId = tabId;
      return JSON.parse(vm.runInContext(`JSON.stringify({
        console: consoleLogAttached.has(__testTabId),
        domains: [...(cdpEnabledDomains.get(__testTabId) ?? [])].sort(),
        events: cdpEventAttached.has(__testTabId),
        network: networkCaptureAttached.has(__testTabId),
        subscriptions: [...(cdpSubscriptions.get(__testTabId) ?? [])].sort()
      })`, context));
    },
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
    popupStatus(host) {
      context.__testPopupHost = host;
      return vm.runInContext("popupStatusFromPong(__testPopupHost)", context);
    },
    execute(method, params, options = {}) {
      context.__testMethod = method;
      context.__testParams = params;
      context.__testOptions = options;
      return vm.runInContext("executeCommand(__testMethod, __testParams, __testOptions)", context);
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
