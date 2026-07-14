// OpenCode accessibility snapshot — injected on demand by background.js.
// Runs in the extension's isolated world. Element references (e1, e2, ...)
// persist per document until navigation, so the agent can act on elements
// by reference instead of raw coordinates.
// Sensitive fields (passwords, hidden inputs, payment autocomplete) are
// always redacted before any value leaves the page.

if (!window.__opencodeA11yInstalled) {
  window.__opencodeA11yInstalled = true;

  const elementByRef = new Map();
  const refByElement = new WeakMap();
  let refCounter = 0;

  const ROLE_BY_TAG = {
    a: "link",
    article: "article",
    aside: "complementary",
    button: "button",
    footer: "contentinfo",
    form: "form",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    header: "banner",
    img: "image",
    label: "label",
    li: "listitem",
    main: "main",
    nav: "navigation",
    ol: "list",
    section: "region",
    select: "combobox",
    summary: "button",
    table: "table",
    textarea: "textbox",
    ul: "list"
  };

  const SENSITIVE_AUTOCOMPLETE = [
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year"
  ];

  const INTERACTIVE_ROLES = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox",
    "slider", "spinbutton", "switch", "tab", "textbox"
  ]);

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"]);

  function roleFor(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/u)[0].toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    return ROLE_BY_TAG[tag] || "generic";
  }

  function isSensitiveField(element) {
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    return SENSITIVE_AUTOCOMPLETE.some((token) => autocomplete.includes(token));
  }

  function isVisible(element) {
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isDisabled(element) {
    return element.disabled === true || element.getAttribute("aria-disabled") === "true";
  }

  function ownText(element) {
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }

  function labelText(element) {
    if (!element.id) return "";
    const label = element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    return label ? ownText(label) || label.textContent.trim() : "";
  }

  function truncate(value, max = 120) {
    const text = value.replace(/\s+/gu, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function accessibleName(element, role) {
    const aria = element.getAttribute("aria-label");
    if (aria && aria.trim()) return truncate(aria);
    const tag = element.tagName.toLowerCase();

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const external = labelText(element)
        || (element.getAttribute("placeholder") || "").trim()
        || (element.getAttribute("title") || "").trim();
      if (isSensitiveField(element)) return external ? truncate(external) : "";
      if (external) return truncate(external);
      if (tag === "select") {
        const selected = element.options?.[element.selectedIndex];
        if (selected?.textContent) return truncate(selected.textContent);
      }
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (type === "submit" && element.value) return truncate(element.value);
      return "";
    }
    const alt = element.getAttribute("alt");
    if (alt && alt.trim()) return truncate(alt);
    const title = element.getAttribute("title");
    if (title && title.trim()) return truncate(title);
    // Structural containers would otherwise inherit the whole page text as
    // their name; only leaf-like roles fall back to full textContent.
    const CONTAINER_ROLES = ["main", "form", "navigation", "region", "article", "banner", "contentinfo", "table", "list", "complementary", "generic"];
    const text = CONTAINER_ROLES.includes(role) ? ownText(element) : (ownText(element) || element.textContent || "");
    return truncate(text);
  }

  function fieldValue(element) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return null;
    if (isSensitiveField(element)) return element.value ? "[redacted]" : "";
    return typeof element.value === "string" && element.value ? truncate(element.value, 80) : null;
  }

  function refFor(element) {
    const existing = refByElement.get(element);
    if (existing) return existing;
    refCounter += 1;
    const ref = `e${refCounter}`;
    refByElement.set(element, ref);
    elementByRef.set(ref, new WeakRef(element));
    return ref;
  }

  function derefElement(ref) {
    const weak = elementByRef.get(String(ref));
    const element = weak?.deref?.();
    if (!element || !element.isConnected) return null;
    return element;
  }

  function shadowRootOf(element) {
    try {
      if (typeof chrome?.dom?.openOrClosedShadowRoot === "function") {
        const root = chrome.dom.openOrClosedShadowRoot(element);
        if (root) return root;
      }
    } catch {}
    return element.shadowRoot ?? null;
  }

  window.__opencodeA11yGenerate = function (options) {
    const maxNodes = clampInt(options?.maxNodes, 1, 2000, 800);
    const maxChars = clampInt(options?.maxChars, 100, 200000, 50000);
    const interactiveOnly = options?.interactiveOnly === true;
    const lines = [];
    let emitted = 0;
    let truncated = false;
    let chars = 0;

    function emit(depth, element, role) {
      if (emitted >= maxNodes) {
        truncated = true;
        return false;
      }
      const name = accessibleName(element, role);
      const value = fieldValue(element);
      const parts = [`${"  ".repeat(depth)}[${refFor(element)}] ${role}`];
      if (name) parts.push(`"${name}"`);
      if (value !== null && value !== name) parts.push(`value="${value}"`);
      if (isDisabled(element)) parts.push("(disabled)");
      if (element.tagName.toLowerCase() === "input") {
        const type = (element.getAttribute("type") || "text").toLowerCase();
        if (type !== "text") parts.push(`type=${type}`);
      }
      const line = parts.join(" ");
      chars += line.length + 1;
      if (chars > maxChars) {
        truncated = true;
        return false;
      }
      lines.push(line);
      emitted += 1;
      return true;
    }

    function shouldEmit(element, role) {
      if (role === "hidden") return false;
      const interactive = INTERACTIVE_ROLES.has(role) || element.hasAttribute("onclick") || element.tabIndex >= 0;
      if (interactiveOnly) return interactive;
      if (interactive) return true;
      if (role === "generic") return false;
      if (role === "listitem") return ownText(element).length > 0;
      return true;
    }

    function walk(root, depth) {
      if (truncated) return;
      for (const element of root.children ?? []) {
        if (truncated) return;
        if (SKIP_TAGS.has(element.tagName)) continue;
        if (!isVisible(element)) continue;
        const role = roleFor(element);
        let nextDepth = depth;
        if (shouldEmit(element, role)) {
          if (!emit(depth, element, role)) return;
          nextDepth = depth + 1;
        }
        const shadow = shadowRootOf(element);
        if (shadow) walk(shadow, nextDepth);
        walk(element, nextDepth);
      }
    }

    walk(document.body ?? document.documentElement, 0);
    return {
      title: document.title,
      url: location.href,
      nodeCount: emitted,
      truncated,
      tree: lines.join("\n")
    };
  };

  window.__opencodeA11yLocate = function (ref) {
    const element = derefElement(ref);
    if (!element) return { found: false };
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      visible: isVisible(element),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      role: roleFor(element),
      name: accessibleName(element, roleFor(element))
    };
  };

  window.__opencodeA11yFocus = function (ref, selectAll) {
    const element = derefElement(ref);
    if (!element) return { found: false };
    element.focus();
    const tag = element.tagName.toLowerCase();
    const editable = tag === "input" || tag === "textarea" || element.isContentEditable === true;
    if (selectAll && editable) {
      try {
        if (typeof element.select === "function") {
          element.select();
        } else if (element.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {}
    }
    return { found: true, editable, focused: element.ownerDocument.activeElement === element };
  };

  function clampInt(value, min, max, fallback) {
    if (!Number.isInteger(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }
}
