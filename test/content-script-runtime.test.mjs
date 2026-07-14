import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const repoRoot = path.resolve(import.meta.dirname, "..");
const contentScriptSource = await readFile(
  path.join(repoRoot, "extension", "content-scripts", "opencode.js"),
  "utf8"
);

test("hidden cursor state remains hidden during later browser actions", () => {
  const harness = createContentScriptHarness();

  harness.send({ source: "opencode-bridge", type: "cursor-state", state: "hidden" });
  harness.send({ source: "opencode-bridge", type: "cursor-move", x: 10, y: 20 });
  harness.send({ source: "opencode-bridge", type: "cursor-click", x: 10, y: 20 });

  assert.equal(harness.cursor.classList.contains("oc-visible"), false);
  assert.equal(harness.badge.classList.contains("oc-badge-visible"), false);
  assert.equal(harness.elements.some((element) => element.classList.contains("oc-ripple")), false);
});

test("active cursor state shows the agent border and stop button, hidden removes them", () => {
  const harness = createContentScriptHarness();

  harness.send({ source: "opencode-bridge", type: "cursor-state", state: "active" });
  const border = harness.elements.find((element) => element.classList.contains("oc-border"));
  const stop = harness.elements.find((element) => element.classList.contains("oc-stop"));
  assert.ok(border, "missing agent border element");
  assert.ok(stop, "missing stop button element");
  assert.equal(border.classList.contains("oc-visible"), true);
  assert.equal(stop.classList.contains("oc-visible"), true);

  harness.send({ source: "opencode-bridge", type: "cursor-state", state: "hidden" });
  assert.equal(border.classList.contains("oc-visible"), false);
  assert.equal(stop.classList.contains("oc-visible"), false);
});

function createContentScriptHarness() {
  const elements = [];
  const listeners = [];
  const documentElement = createElement("html", elements);
  const head = createElement("head", elements);
  const document = {
    documentElement,
    head,
    createElement: (tagName) => createElement(tagName, elements),
    querySelectorAll: () => []
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL: (relativePath) => `chrome-extension://test-extension/${relativePath}`,
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
  const window = {};
  const context = vm.createContext({
    cancelAnimationFrame: () => {},
    chrome,
    clearTimeout: () => {},
    document,
    encodeURIComponent,
    Math,
    parseFloat,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    window
  });
  vm.runInContext(contentScriptSource, context, { filename: "extension/content-scripts/opencode.js" });

  return {
    elements,
    get cursor() {
      return elements.find((element) => element.classList.contains("oc-cursor"));
    },
    get badge() {
      return elements.find((element) => element.classList.contains("oc-favicon-badge"));
    },
    send(message) {
      for (const listener of listeners) listener(message, { id: chrome.runtime.id });
    }
  };
}

function createElement(tagName, elements) {
  const classes = new Set();
  const attributes = new Map();
  const element = {
    tagName,
    children: [],
    style: {},
    isConnected: true,
    classList: {
      add(...values) {
        for (const value of values) classes.add(value);
      },
      remove(...values) {
        for (const value of values) classes.delete(value);
      },
      contains(value) {
        return classes.has(value);
      }
    },
    appendChild(child) {
      this.children.push(child);
      child.isConnected = true;
      return child;
    },
    attachShadow() {
      const shadowRoot = createElement("shadow-root", elements);
      this.shadowRoot = shadowRoot;
      return shadowRoot;
    },
    addEventListener() {},
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    remove() {
      this.isConnected = false;
    }
  };
  Object.defineProperty(element, "className", {
    get() {
      return [...classes].join(" ");
    },
    set(value) {
      classes.clear();
      for (const className of String(value).split(/\s+/u).filter(Boolean)) classes.add(className);
    }
  });
  elements.push(element);
  return element;
}
