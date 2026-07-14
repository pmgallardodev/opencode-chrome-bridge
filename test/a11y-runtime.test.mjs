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

function createA11yHarness(elements) {
  const document = {
    activeElement: null,
    body: { children: elements },
    createRange: () => ({ selectNodeContents() {} }),
    documentElement: { children: elements },
    querySelector: () => null,
    title: "A11y test"
  };
  for (const element of elements) element.ownerDocument = document;
  const window = {
    getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
    getSelection: () => ({ addRange() {}, removeAllRanges() {} })
  };
  const context = vm.createContext({
    chrome: {},
    CSS: { escape: (value) => String(value) },
    document,
    location: { href: "https://example.test/" },
    Node: { TEXT_NODE: 3 },
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
    verify(ref, text, clear) {
      return window.__opencodeA11yVerifyFill(ref, text, clear);
    }
  };
}

function createElement(tagName, {
  attributes = {},
  disabled = false,
  readOnly = false,
  selectionEnd = 0,
  selectionStart = 0,
  value = ""
} = {}) {
  const attrs = new Map(Object.entries(attributes));
  const element = {
    childNodes: [],
    children: [],
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
    textContent: "",
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
  return element;
}
