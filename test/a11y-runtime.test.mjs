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
  assert.deepEqual({ ...context.truncated }, {
    selectedElementRefs: false,
    selection: false,
    visibleText: false
  });
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

test("tab context visible text never exports live form control values", () => {
  const liveSelect = createElement("select");
  liveSelect.options = [{ textContent: "selected-live-secret" }];
  liveSelect.selectedIndex = 0;
  const harness = createA11yHarness([
    createElement("input", {
      attributes: { name: "password", type: "text" },
      value: "name-password-secret"
    }),
    createElement("input", {
      attributes: { name: "api_token", type: "text" },
      value: "token-field-secret"
    }),
    createElement("input", { attributes: { type: "text" }, value: "ordinary-live-value" }),
    createElement("textarea", { value: "textarea-live-value" }),
    liveSelect,
    createElement("input", { attributes: { type: "password" }, value: "direct-password-secret" })
  ]);

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.visibleText, "[redacted]");
  for (const secret of [
    "name-password-secret",
    "token-field-secret",
    "ordinary-live-value",
    "textarea-live-value",
    "selected-live-secret",
    "direct-password-secret"
  ]) {
    assert.doesNotMatch(context.visibleText, new RegExp(secret, "u"));
  }
});

test("tab context bounds visible text scans by node count", () => {
  const trailing = createElement("p", { text: "after-node-limit" });
  const elements = [
    ...Array.from({ length: 10000 }, () => createElement("div")),
    trailing
  ];
  const context = createA11yHarness(elements).tabContext({ maxChars: 500 });

  assert.equal(context.truncated.visibleText, true);
  assert.doesNotMatch(context.visibleText, /after-node-limit/u);
});

test("tab context bounds visible text scans by nesting depth", () => {
  let nested = createElement("span", { text: "after-depth-limit" });
  for (let depth = 0; depth < 300; depth += 1) {
    nested = createElement("div", { children: [nested] });
  }
  const context = createA11yHarness([nested]).tabContext({ maxChars: 500 });

  assert.equal(context.truncated.visibleText, true);
  assert.doesNotMatch(context.visibleText, /after-depth-limit/u);
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

test("tab context redacts an active control nested inside a sensitive ancestor", () => {
  const nestedInput = createElement("input", {
    attributes: { type: "text" },
    selectionEnd: 16,
    selectionStart: 0,
    value: "5555444433331111"
  });
  const sensitiveContainer = createElement("div", {
    attributes: { autocomplete: "cc-number" },
    children: [nestedInput]
  });
  const harness = createA11yHarness([sensitiveContainer], { activeElement: nestedInput });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.selection.text, "[redacted]");
  assert.doesNotMatch(JSON.stringify(context), /5555444433331111/u);
});

test("tab context redacts a range that crosses a sensitive intermediate element", () => {
  const first = createElement("button", { text: "Start" });
  const sensitive = createElement("input", {
    attributes: { autocomplete: "new-password", type: "text" },
    value: "intermediate-secret"
  });
  const last = createElement("button", { text: "Finish" });
  const harness = createA11yHarness([first, sensitive, last], {
    selection: {
      anchorNode: first.childNodes[0],
      focusNode: last.childNodes[0],
      intersectedElements: [first, sensitive, last],
      text: "Start intermediate-secret Finish"
    }
  });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.selection.text, "[redacted]");
  assert.doesNotMatch(JSON.stringify(context), /intermediate-secret/u);
});

test("tab context returns meaningful selected refs in DOM order with a strict cap", () => {
  const elements = Array.from({ length: 105 }, (_, index) => createElement("button", { text: `Choice ${index}` }));
  const harness = createA11yHarness(elements, {
    selection: {
      anchorNode: elements[0].childNodes[0],
      focusNode: elements.at(-1).childNodes[0],
      intersectedElements: elements,
      text: "all choices"
    }
  });

  const context = harness.tabContext({ maxChars: 20000 });

  assert.equal(context.selectedElementRefs.length, 100);
  assert.deepEqual([...context.selectedElementRefs.slice(0, 3)], ["e1", "e2", "e3"]);
  assert.equal(context.selection.refs.at(-1), "e100");
  assert.equal(context.truncated.selectedElementRefs, true);
});

test("tab context reports truncated refs when the selected range exceeds the scan limit", () => {
  const selectedButton = createElement("button", { text: "After scan limit" });
  const elements = [
    ...Array.from({ length: 10000 }, () => createElement("div")),
    selectedButton
  ];
  const harness = createA11yHarness(elements, {
    selection: {
      anchorNode: selectedButton.childNodes[0],
      focusNode: selectedButton.childNodes[0],
      intersectedElements: [selectedButton],
      text: "After scan limit"
    }
  });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.selection.text, "[redacted]");
  assert.deepEqual([...context.selectedElementRefs], ["e1"]);
  assert.equal(context.truncated.selectedElementRefs, true);
});

test("tab context preserves fractional DPR and negative scroll offsets", () => {
  const harness = createA11yHarness([createElement("main", { text: "Page" })], {
    deviceScaleFactor: 1.25,
    scrollX: -8.5,
    scrollY: -12.25
  });

  const context = harness.tabContext({ maxChars: 500 });

  assert.equal(context.dimensions.viewport.deviceScaleFactor, 1.25);
  assert.equal(context.dimensions.viewport.scrollX, -8.5);
  assert.equal(context.dimensions.viewport.scrollY, -12.25);
});

test("tab context redacts credential query variants and URL credentials", () => {
  const harness = createA11yHarness([createElement("main", { text: "Page" })], {
    url: "https://user:pass@example.test/?client_secret=a&refresh-token=b&id_token=c&password_reset_token=d&X-Amz-Credential=e&X-Amz-Signature=f&X-Amz-Security-Token=g&GoogleAccessId=h&Signature=i&sig=j&X-Goog-Credential=k&X-Goog-Signature=l&AWSAccessKeyId=m&safe=value#private"
  });

  const context = harness.tabContext({ maxChars: 500 });
  const sanitized = new URL(context.url);

  assert.equal(sanitized.username, "");
  assert.equal(sanitized.password, "");
  assert.equal(sanitized.hash, "");
  for (const key of [
    "client_secret",
    "refresh-token",
    "id_token",
    "password_reset_token",
    "X-Amz-Credential",
    "X-Amz-Signature",
    "X-Amz-Security-Token",
    "GoogleAccessId",
    "Signature",
    "sig",
    "X-Goog-Credential",
    "X-Goog-Signature",
    "AWSAccessKeyId"
  ]) {
    assert.equal(sanitized.searchParams.get(key), "[redacted]");
  }
  assert.equal(sanitized.searchParams.get("safe"), "value");
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

test("findElements ranks normalized token matches and preserves document order for ties", () => {
  const harness = createA11yHarness([
    createElement("a", { attributes: { "aria-label": "Account settings" }, text: "Open" }),
    createElement("button", { text: "Save account" }),
    createElement("button", { text: "Save account" }),
    createElement("button", { attributes: { placeholder: "Account search" }, text: "Search" })
  ]);

  const ranked = harness.find({ query: "ACCOUNT settings", limit: 10 });
  assert.equal(ranked.matches[0].ref, "e1");
  assert.equal(ranked.matches[0].name, "Account settings");

  const ties = harness.find({ query: "save account", role: "button", limit: 10 });
  assert.deepEqual([...ties.matches.map((match) => match.ref)], ["e2", "e3"]);
  assert.equal(ties.matches[0].score, ties.matches[1].score);
});

test("findElements applies visibility and interactivity filters without indexing sensitive values", () => {
  const hidden = createElement("button", { text: "Private report", visible: false });
  const generic = createElement("div", { text: "Private report" });
  const interactive = createElement("button", { text: "Private report" });
  const sensitive = createElement("input", {
    attributes: { autocomplete: "current-password", type: "text" },
    value: "private report secret"
  });
  const nestedSecret = createElement("span", { text: "deep nested secret" });
  const sensitiveContainer = createElement("div", {
    attributes: { autocomplete: "cc-number" },
    children: [nestedSecret]
  });
  const harness = createA11yHarness([hidden, generic, interactive, sensitive, sensitiveContainer]);

  const visibleInteractive = harness.find({
    query: "private report",
    interactiveOnly: true,
    visibleOnly: true,
    limit: 10
  });
  assert.deepEqual([...visibleInteractive.matches.map((match) => match.ref)], ["e1"]);

  const withHidden = harness.find({
    query: "private report",
    interactiveOnly: true,
    visibleOnly: false,
    limit: 10
  });
  assert.equal(withHidden.matches.length, 2);
  assert.equal(withHidden.matches.some((match) => match.visible === false), true);

  const secret = harness.find({ query: "secret", visibleOnly: false, limit: 10 });
  assert.equal(secret.matches.length, 0);
  const deepSecret = harness.find({ query: "deep nested secret", visibleOnly: false, limit: 10 });
  assert.equal(deepSecret.matches.length, 0);
  assert.doesNotMatch(JSON.stringify(withHidden), /secret/u);
});

test("findElements and accessibility names omit sensitive descendant text from normal ancestors", () => {
  const sensitiveDescendant = createElement("div", {
    attributes: { autocomplete: "cc-number" },
    children: [createElement("span", { text: "4111 ancestor secret" })]
  });
  const button = createElement("button", {
    children: [createElement("span", { text: "Public checkout" }), sensitiveDescendant]
  });
  button.textContent = "Public checkout4111 ancestor secret";
  const harness = createA11yHarness([button]);

  const publicResult = harness.find({ query: "public checkout", role: "button", visibleOnly: false });
  const secretResult = harness.find({ query: "4111 ancestor secret", visibleOnly: false });
  const snapshot = harness.generate();

  assert.equal(publicResult.matches.length, 1);
  assert.equal(publicResult.matches[0].name, "Public checkout");
  assert.equal(publicResult.matches[0].text, "Public checkout");
  assert.equal(secretResult.matches.length, 0);
  assert.doesNotMatch(JSON.stringify(publicResult), /4111 ancestor secret/u);
  assert.doesNotMatch(snapshot.tree, /4111 ancestor secret/u);
});

test("findElements does not score a visible ancestor from hidden or non-rendered descendant text", () => {
  const button = createElement("button", {
    children: [
      createElement("span", { text: "Public action" }),
      createElement("span", { text: "hidden ranking phrase", visible: false }),
      createElement("script", { text: "script ranking phrase" }),
      createElement("template", { text: "template ranking phrase" })
    ]
  });
  const harness = createA11yHarness([button]);

  const publicResult = harness.find({ query: "public action", role: "button", visibleOnly: true });
  const hiddenResult = harness.find({ query: "hidden ranking phrase", visibleOnly: true });
  const scriptResult = harness.find({ query: "script ranking phrase", visibleOnly: true });
  const templateResult = harness.find({ query: "template ranking phrase", visibleOnly: true });

  assert.equal(publicResult.matches[0]?.name, "Public action");
  assert.equal(publicResult.matches[0]?.text, "Public action");
  assert.equal(hiddenResult.matches.length, 0);
  assert.equal(scriptResult.matches.length, 0);
  assert.equal(templateResult.matches.length, 0);
});

test("findElements resolves aria-labelledby, element.labels, explicit labels, wrapping labels, and placeholders", () => {
  const ariaFirst = createElement("span", { attributes: { id: "billing" }, text: "Billing" });
  const ariaSecond = createElement("span", { attributes: { id: "email" }, text: "email" });
  const ariaInput = createElement("input", {
    attributes: { "aria-labelledby": "billing email", type: "text" }
  });
  const ariaHarness = createA11yHarness([ariaFirst, ariaSecond, ariaInput]);
  assert.equal(
    ariaHarness.find({ query: "billing email", role: "textbox" }).matches[0]?.name,
    "Billing email"
  );

  const associatedLabel = createElement("label", { text: "Account alias" });
  const labelsInput = createElement("input", {
    attributes: { type: "text" },
    labels: [associatedLabel]
  });
  const labelsHarness = createA11yHarness([associatedLabel, labelsInput]);
  assert.equal(
    labelsHarness.find({ query: "account alias", role: "textbox" }).matches[0]?.name,
    "Account alias"
  );

  const explicitLabel = createElement("label", {
    attributes: { for: "customer-id" },
    text: "Customer identifier"
  });
  const explicitInput = createElement("input", {
    attributes: { id: "customer-id", type: "text" }
  });
  const explicitHarness = createA11yHarness([explicitLabel, explicitInput]);
  assert.equal(
    explicitHarness.find({ query: "customer identifier", role: "textbox" }).matches[0]?.name,
    "Customer identifier"
  );

  const wrappedInput = createElement("input", { attributes: { type: "text" } });
  const wrappingLabel = createElement("label", {
    children: [createElement("span", { text: "Delivery address" }), wrappedInput]
  });
  const wrappingHarness = createA11yHarness([wrappingLabel]);
  assert.equal(
    wrappingHarness.find({ query: "delivery address", role: "textbox" }).matches[0]?.name,
    "Delivery address"
  );

  const placeholderHarness = createA11yHarness([
    createElement("input", { attributes: { placeholder: "Search invoices", type: "text" } })
  ]);
  assert.equal(
    placeholderHarness.find({ query: "search invoices", role: "textbox" }).matches[0]?.name,
    "Search invoices"
  );
});

test("findElements bounds hostile nesting without overflowing the isolated world", () => {
  let nested = createElement("button", { text: "Target beyond scan bound" });
  for (let index = 0; index < 10001; index += 1) {
    nested = createElement("div", { children: [nested] });
  }
  const harness = createA11yHarness([nested]);

  const result = harness.find({ query: "target beyond scan bound", visibleOnly: false, limit: 10 });

  assert.equal(result.matches.length, 0);
  assert.equal(result.truncated, true);
});

test("wait checks page text, selectors, and live refs without evaluating page JavaScript", () => {
  const button = createElement("button", { text: "Report ready" });
  const harness = createA11yHarness([button], { selectors: { "[data-ready]": button } });
  harness.generate();

  assert.equal(harness.check({ type: "text", value: "report READY", caseSensitive: false }).matched, true);
  assert.equal(harness.check({ type: "selector", selector: "[data-ready]", visibleOnly: true }).matched, true);
  assert.equal(harness.check({ type: "ref", ref: "e1", visibleOnly: true }).matched, true);

  button.isConnected = false;
  assert.equal(harness.check({ type: "ref", ref: "e1", visibleOnly: true }).matched, false);
});

test("case-insensitive text waits do not depend on the runtime locale", () => {
  assert.doesNotMatch(a11ySource, /toLocaleLowerCase/u);
});

function createA11yHarness(elements, {
  activeElement = null,
  contentType = "text/html",
  deviceScaleFactor = 1,
  documentHeight = 900,
  documentWidth = 1200,
  scrollX = 0,
  scrollY = 0,
  selection = null,
  selectors = {},
  url = "https://example.test/",
  viewportHeight = 768,
  viewportWidth = 1024
} = {}) {
  const allElements = [];
  const collectStack = [...elements].reverse();
  while (collectStack.length > 0) {
    const element = collectStack.pop();
    allElements.push(element);
    for (let index = (element.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      collectStack.push(element.children[index]);
    }
  }
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
    getElementById: (id) => allElements.find((element) => element.id === id) ?? null,
    querySelector: (selector) => {
      if (selectors[selector]) return selectors[selector];
      const labelFor = /^label\[for="(.+)"\]$/u.exec(selector);
      if (labelFor) {
        return allElements.find((element) => element.tagName === "LABEL" && element.getAttribute("for") === labelFor[1]) ?? null;
      }
      return null;
    },
    title: "A11y test"
  };
  for (const element of elements) attachElement(element, document, null);
  const window = {
    devicePixelRatio: deviceScaleFactor,
    getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
    getSelection: () => selection
      ? {
          addRange() {},
          anchorNode: selection.anchorNode,
          focusNode: selection.focusNode,
          getRangeAt: () => ({
            intersectsNode: (element) => (selection.intersectedElements ?? []).includes(element)
          }),
          rangeCount: 1,
          removeAllRanges() {},
          toString: () => selection.text
        }
      : { addRange() {}, anchorNode: null, focusNode: null, rangeCount: 0, removeAllRanges() {}, toString: () => "" },
    innerHeight: viewportHeight,
    innerWidth: viewportWidth,
    scrollX,
    scrollY
  };
  const context = vm.createContext({
    chrome: {},
    CSS: { escape: (value) => String(value) },
    document,
    location: { href: url },
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
    find(options) {
      return window.__opencodeA11yFind(options);
    },
    check(condition) {
      return window.__opencodeA11yCheck(condition);
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
  labels = [],
  readOnly = false,
  selectionEnd = 0,
  selectionStart = 0,
  text = "",
  value = "",
  visible = true
} = {}) {
  const attrs = new Map(Object.entries(attributes));
  const textNode = text ? { nodeType: 3, parentElement: null, textContent: text } : null;
  const element = {
    childNodes: [...(textNode ? [textNode] : []), ...children],
    children,
    disabled,
    id: attributes.id ?? "",
    isConnected: true,
    isContentEditable: false,
    labels,
    ownerDocument: null,
    readOnly,
    selectionEnd,
    selectionStart,
    tabIndex: ["a", "button", "input", "select", "textarea"].includes(tagName.toLowerCase()) ? 0 : -1,
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
      return visible ? [{ height: 20, width: 100 }] : [];
    },
    getRootNode() {
      return this.ownerDocument;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === "label" && current.tagName === "LABEL") return current;
        current = current.parentElement;
      }
      return null;
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
  const stack = [{ element, parentElement }];
  while (stack.length > 0) {
    const current = stack.pop();
    current.element.ownerDocument = document;
    current.element.parentElement = current.parentElement;
    const children = current.element.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ element: children[index], parentElement: current.element });
    }
  }
}
