import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const repoRoot = path.resolve(import.meta.dirname, "..");
const a11ySource = await readFile(
  path.join(repoRoot, "extension", "content-scripts", "a11y.js"),
  "utf8"
);

test("accessibility snapshots redact every payment autocomplete token", () => {
  const harness = createA11yHarness([
    createElement("input", {
      attributes: { autocomplete: "section-checkout cc-name", type: "text" },
      value: "Ada Lovelace"
    })
  ]);

  const snapshot = harness.generate();

  assert.match(snapshot.tree, /value="\[redacted\]"/u);
  assert.doesNotMatch(snapshot.tree, /Ada Lovelace/u);
});

test("only writable text controls can be fill targets", () => {
  const harness = createA11yHarness([
    createElement("input", { attributes: { type: "checkbox" } }),
    createElement("input", { attributes: { type: "file" } }),
    createElement("input", { attributes: { type: "text" }, readOnly: true }),
    createElement("textarea", { disabled: true }),
    createElement("input", { attributes: { type: "text" }, value: "ready" })
  ]);
  harness.generate();

  for (const ref of ["e1", "e2", "e3", "e4"]) {
    assert.equal(harness.focus(ref, true).editable, false, `${ref} must not be editable`);
  }
  assert.equal(harness.focus("e5", true).editable, true);
});

test("fill verification compares the resulting value with the intended edit", () => {
  const input = createElement("input", {
    attributes: { type: "text" },
    selectionEnd: 2,
    selectionStart: 2,
    value: "hi"
  });
  const harness = createA11yHarness([input]);
  harness.generate();

  assert.equal(harness.focus("e1", false).editable, true);
  assert.equal(harness.verify("e1", " there", false).verified, false);

  harness.focus("e1", false);
  input.value = "hi there";
  assert.equal(harness.verify("e1", " there", false).verified, true);

  harness.focus("e1", true);
  input.value = "replacement";
  assert.equal(harness.verify("e1", "replacement", true).verified, true);
});

test("tab context returns bounded page metadata and selected element references", () => {
  const selectedButton = createElement("button", { text: "Continue checkout" });
  const harness = createA11yHarness([
    createElement("main", { text: "Public account summary" }),
    selectedButton
  ], {
    contentType: "text/html",
    documentHeight: 1800,
    documentWidth: 1440,
    selection: {
      anchorNode: selectedButton.childNodes[0],
      focusNode: selectedButton.childNodes[0],
      text: "Continue checkout"
    },
    viewportHeight: 720,
    viewportWidth: 1280
  });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.url, "https://example.test/");
  assert.equal(context.title, "A11y test");
  assert.equal(context.mimeType, "text/html");
  assert.match(context.visibleText, /Public account summary/u);
  assert.equal(context.returnedChars, context.visibleText.length);
  assert.equal(context.totalChars, context.visibleText.length);
  assert.equal(context.selection.text, "Continue checkout");
  assert.deepEqual([...context.selection.refs], ["e1"]);
  assert.deepEqual([...context.selectedElementRefs], ["e1"]);
  assert.deepEqual({ ...context.dimensions.viewport }, {
    height: 720,
    width: 1280,
    scrollX: 0,
    scrollY: 0,
    deviceScaleFactor: 1
  });
  assert.deepEqual({ ...context.dimensions.document }, { height: 1800, width: 1440 });
  assert.deepEqual({ ...context.truncated }, { selection: false, visibleText: false });
});

test("tab context redacts sensitive controls and ignores non-visible document text", () => {
  const password = createElement("input", {
    attributes: { type: "password" },
    selectionEnd: 12,
    selectionStart: 0,
    value: "secret-value"
  });
  const harness = createA11yHarness([
    createElement("p", { text: "Visible profile" }),
    password,
    createElement("input", {
      attributes: { autocomplete: "section-payment cc-number", type: "text" },
      value: "4111111111111111"
    }),
    createElement("script", { text: "script-secret" }),
    createElement("style", { text: "style-secret" }),
    createElement("template", { text: "template-secret" })
  ], { activeElement: password });

  const context = harness.tabContext({ maxChars: 500 });

  assert.match(context.visibleText, /Visible profile/u);
  assert.match(context.visibleText, /\[redacted\]/u);
  assert.equal(context.selection.text, "[redacted]");
  for (const secret of ["secret-value", "4111111111111111", "script-secret", "style-secret", "template-secret"]) {
    assert.doesNotMatch(context.visibleText, new RegExp(secret, "u"));
    assert.doesNotMatch(context.selection.text, new RegExp(secret, "u"));
  }
});

test("tab context redacts custom sensitive fields and selections inside their descendants", () => {
  const nestedText = createElement("span", { text: "5555444433331111" });
  const sensitiveContainer = createElement("div", {
    attributes: { autocomplete: "cc-number" },
    children: [nestedText]
  });
  const harness = createA11yHarness([sensitiveContainer], {
    selection: {
      anchorNode: nestedText.childNodes[0],
      focusNode: nestedText.childNodes[0],
      text: "5555444433331111"
    }
  });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.visibleText, "[redacted]");
  assert.equal(context.selection.text, "[redacted]");
  assert.doesNotMatch(JSON.stringify(context), /5555444433331111/u);
});

test("tab context reports visible text and selection truncation", () => {
  const selected = createElement("p", { text: "s".repeat(400) });
  const harness = createA11yHarness([
    createElement("main", { text: "v".repeat(400) }),
    selected
  ], {
    selection: {
      anchorNode: selected.childNodes[0],
      focusNode: selected.childNodes[0],
      text: "s".repeat(400)
    }
  });

  const context = harness.tabContext({ maxChars: 100, maxSelectionChars: 80 });

  assert.equal(context.visibleText.length, 100);
  assert.equal(context.returnedChars, 100);
  assert.equal(context.totalChars, null);
  assert.equal(context.selection.text.length, 80);
  assert.equal(context.truncated.visibleText, true);
  assert.equal(context.truncated.selection, true);
});

function createA11yHarness(elements, {
  activeElement = null,
  contentType = "text/html",
  documentHeight = 900,
  documentWidth = 1200,
  selection = null,
  viewportHeight = 768,
  viewportWidth = 1024
} = {}) {
  const document = {
    activeElement,
    body: {
      childNodes: elements,
      children: elements,
      clientHeight: viewportHeight,
      clientWidth: viewportWidth,
      scrollHeight: documentHeight,
      scrollWidth: documentWidth
    },
    contentType,
    createRange: () => ({ selectNodeContents() {} }),
    documentElement: {
      childNodes: elements,
      children: elements,
      clientHeight: viewportHeight,
      clientWidth: viewportWidth,
      scrollHeight: documentHeight,
      scrollWidth: documentWidth
    },
    querySelector: () => null,
    title: "A11y test"
  };
  for (const element of elements) attachElement(element, document, null);
  const window = {
    devicePixelRatio: 1,
    getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
    getSelection: () => selection
      ? {
          addRange() {},
          anchorNode: selection.anchorNode,
          focusNode: selection.focusNode,
          rangeCount: 1,
          removeAllRanges() {},
          toString: () => selection.text
        }
      : { addRange() {}, anchorNode: null, focusNode: null, rangeCount: 0, removeAllRanges() {}, toString: () => "" },
    innerHeight: viewportHeight,
    innerWidth: viewportWidth,
    scrollX: 0,
    scrollY: 0
  };
  const context = vm.createContext({
    chrome: {},
    CSS: { escape: (value) => String(value) },
    document,
    location: { href: "https://example.test/" },
    Node: { TEXT_NODE: 3 },
    URL,
    WeakRef,
    window
  });
  vm.runInContext(a11ySource, context, { filename: "extension/content-scripts/a11y.js" });

  return {
    focus(ref, selectAll) {
      return window.__opencodeA11yFocus(ref, selectAll);
    },
    generate() {
      return window.__opencodeA11yGenerate({ maxChars: 50_000, maxNodes: 800 });
    },
    tabContext(options) {
      return window.__opencodeTabContext(options);
    },
    verify(ref, text, clear) {
      return window.__opencodeA11yVerifyFill(ref, text, clear);
    }
  };
}

function createElement(tagName, {
  attributes = {},
  children = [],
  disabled = false,
  readOnly = false,
  selectionEnd = 0,
  selectionStart = 0,
  text = "",
  value = ""
} = {}) {
  const attrs = new Map(Object.entries(attributes));
  const textNode = text ? { nodeType: 3, parentElement: null, textContent: text } : null;
  const element = {
    childNodes: [...(textNode ? [textNode] : []), ...children],
    children,
    disabled,
    id: "",
    isConnected: true,
    isContentEditable: false,
    ownerDocument: null,
    readOnly,
    selectionEnd,
    selectionStart,
    tabIndex: 0,
    tagName: tagName.toUpperCase(),
    textContent: text,
    value,
    focus() {
      if (!this.disabled) this.ownerDocument.activeElement = this;
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    getBoundingClientRect() {
      return { height: 20, left: 0, top: 0, width: 100 };
    },
    getClientRects() {
      return [{ height: 20, width: 100 }];
    },
    getRootNode() {
      return this.ownerDocument;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    scrollIntoView() {},
    select() {
      this.selectionStart = 0;
      this.selectionEnd = this.value.length;
    }
  };
  if (textNode) textNode.parentElement = element;
  return element;
}

function attachElement(element, document, parentElement) {
  element.ownerDocument = document;
  element.parentElement = parentElement;
  for (const child of element.children ?? []) attachElement(child, document, element);
}
