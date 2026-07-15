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
  const pendingFills = new Map();
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

  const SENSITIVE_AUTOCOMPLETE = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "transaction-amount",
    "transaction-currency"
  ]);

  const WRITABLE_INPUT_TYPES = new Set([
    "email", "number", "password", "search", "tel", "text", "url"
  ]);

  const INTERACTIVE_ROLES = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox",
    "slider", "spinbutton", "switch", "tab", "textbox"
  ]);

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"]);
  const MAX_SELECTED_ELEMENT_REFS = 100;
  const MAX_SELECTION_SCAN_ELEMENTS = 10000;

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
    const autocompleteTokens = (element.getAttribute("autocomplete") || "")
      .toLowerCase()
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    return autocompleteTokens.some((token) => token.startsWith("cc-") || SENSITIVE_AUTOCOMPLETE.has(token));
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
    if (isSensitiveField(element)) return "[redacted]";
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

  function sanitizePageUrl(value) {
    try {
      const url = new URL(String(value));
      url.username = "";
      url.password = "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        const normalizedKey = key.toLowerCase().replace(/[_-]/gu, "");
        if (["apikey", "auth", "authorization", "code", "credential", "key", "pass", "password", "session"].includes(normalizedKey)
          || normalizedKey.endsWith("token")
          || normalizedKey.endsWith("secret")
          || normalizedKey.includes("password")) {
          url.searchParams.set(key, "[redacted]");
        }
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function boundedText(value, maxChars) {
    const text = String(value ?? "").replace(/\s+/gu, " ").trim();
    return {
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars
    };
  }

  function visiblePageText(root, maxChars) {
    let text = "";
    let truncated = false;

    function append(value) {
      if (truncated) return;
      const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
      if (!normalized) return;
      const separator = text ? " " : "";
      const available = maxChars - text.length;
      if (available <= separator.length) {
        truncated = true;
        return;
      }
      const candidate = `${separator}${normalized}`;
      if (candidate.length > available) {
        text += candidate.slice(0, available);
        truncated = true;
        return;
      }
      text += candidate;
    }

    function walkElement(element) {
      if (truncated || !element || SKIP_TAGS.has(element.tagName)) return;
      if (typeof element.getClientRects === "function" && !isVisible(element)) return;

      if (isSensitiveField(element)) {
        if (element.value || element.textContent || (element.childNodes?.length ?? 0) > 0) append("[redacted]");
        return;
      }

      const tag = String(element.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const rawValue = tag === "select"
          ? element.options?.[element.selectedIndex]?.textContent
          : element.value;
        if (rawValue) append(rawValue);
      }

      for (const node of element.childNodes ?? []) {
        if (truncated) return;
        if (node.nodeType === Node.TEXT_NODE) append(node.textContent);
        else if (node?.tagName) walkElement(node);
      }
      const shadow = shadowRootOf(element);
      if (shadow) {
        for (const child of shadow.children ?? []) walkElement(child);
      }
    }

    for (const element of root?.children ?? []) walkElement(element);
    return { text, truncated };
  }

  function elementFromSelectionNode(node) {
    if (!node) return null;
    return node.tagName ? node : node.parentElement ?? null;
  }

  function hasSensitiveAncestor(element) {
    let current = element;
    while (current) {
      if (isSensitiveField(current)) return true;
      current = current.parentElement ?? null;
    }
    return false;
  }

  function isMeaningfulSelectionElement(element) {
    if (!element?.tagName || SKIP_TAGS.has(element.tagName)) return false;
    if (typeof element.getClientRects === "function" && !isVisible(element)) return false;
    const role = roleFor(element);
    return isSensitiveField(element)
      || INTERACTIVE_ROLES.has(role)
      || ownText(element).length > 0
      || ((element.children?.length ?? 0) === 0 && String(element.textContent ?? "").trim().length > 0);
  }

  function rangeSelectionDetails(browserSelection) {
    if (typeof browserSelection.getRangeAt !== "function") {
      return { intersected: false, refs: [], refsTruncated: false, sensitive: false };
    }
    const ranges = [];
    for (let index = 0; index < browserSelection.rangeCount; index += 1) {
      try {
        const range = browserSelection.getRangeAt(index);
        if (range && typeof range.intersectsNode === "function") ranges.push(range);
      } catch {}
    }
    if (ranges.length === 0) {
      return { intersected: false, refs: [], refsTruncated: false, sensitive: false };
    }

    const refs = [];
    const seenRefs = new Set();
    let intersected = false;
    let refsTruncated = false;
    let sensitive = false;
    let visited = 0;

    function walk(root) {
      for (const element of root?.children ?? []) {
        visited += 1;
        if (visited > MAX_SELECTION_SCAN_ELEMENTS) {
          // Fail closed if a hostile page makes the selected range too large
          // to inspect completely.
          refsTruncated = true;
          sensitive = true;
          return false;
        }
        if (SKIP_TAGS.has(element.tagName)) continue;
        let selected = false;
        for (const range of ranges) {
          try {
            if (range.intersectsNode(element)) {
              selected = true;
              break;
            }
          } catch {}
        }
        if (selected) {
          intersected = true;
          if (hasSensitiveAncestor(element)) sensitive = true;
          if (isMeaningfulSelectionElement(element)) {
            const ref = refFor(element);
            if (!seenRefs.has(ref)) {
              seenRefs.add(ref);
              if (refs.length < MAX_SELECTED_ELEMENT_REFS) refs.push(ref);
              else refsTruncated = true;
            }
          }
        }
        const shadow = shadowRootOf(element);
        if (shadow && walk(shadow) === false) return false;
        if (walk(element) === false) return false;
      }
      return true;
    }

    walk(document.body ?? document.documentElement);
    return { intersected, refs, refsTruncated, sensitive };
  }

  function selectionContext(maxSelectionChars) {
    const active = document.activeElement;
    const tag = String(active?.tagName ?? "").toLowerCase();
    if ((tag === "input" || tag === "textarea")
      && Number.isInteger(active.selectionStart)
      && Number.isInteger(active.selectionEnd)
      && active.selectionEnd > active.selectionStart) {
      const selection = hasSensitiveAncestor(active)
        ? { text: "[redacted]", truncated: false }
        : boundedText(String(active.value ?? "").slice(active.selectionStart, active.selectionEnd), maxSelectionChars);
      const ref = refFor(active);
      return { ...selection, refs: [ref], refsTruncated: false };
    }

    const browserSelection = window.getSelection?.();
    if (!browserSelection || browserSelection.rangeCount === 0) {
      return { refs: [], refsTruncated: false, text: "", truncated: false };
    }
    const selectedElements = [
      elementFromSelectionNode(browserSelection.anchorNode),
      elementFromSelectionNode(browserSelection.focusNode)
    ].filter(Boolean);
    const rangeDetails = rangeSelectionDetails(browserSelection);
    const refs = rangeDetails.intersected
      ? rangeDetails.refs
      : [...new Set(selectedElements.map((element) => refFor(element)))].slice(0, MAX_SELECTED_ELEMENT_REFS);
    const sensitive = rangeDetails.sensitive
      || selectedElements.some((element) => hasSensitiveAncestor(element));
    const selection = sensitive
      ? { text: "[redacted]", truncated: false }
      : boundedText(browserSelection.toString(), maxSelectionChars);
    return {
      ...selection,
      refs,
      refsTruncated: rangeDetails.refsTruncated
    };
  }

  function finiteDimension(...values) {
    const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    return finite.length > 0 ? Math.round(Math.max(...finite)) : 0;
  }

  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  window.__opencodeTabContext = function (options) {
    const maxChars = clampInt(options?.maxChars, 100, 200000, 50000);
    const maxSelectionChars = clampInt(options?.maxSelectionChars, 1, 10000, 2000);
    const visible = visiblePageText(document.body ?? document.documentElement, maxChars);
    const selection = selectionContext(maxSelectionChars);
    const documentElement = document.documentElement ?? {};
    const body = document.body ?? {};
    return {
      url: sanitizePageUrl(location.href),
      title: boundedText(document.title, 1000).text,
      mimeType: boundedText(document.contentType || "", 200).text,
      visibleText: visible.text,
      returnedChars: visible.text.length,
      totalChars: visible.truncated ? null : visible.text.length,
      selection: {
        text: selection.text,
        refs: selection.refs
      },
      selectedElementRefs: selection.refs,
      dimensions: {
        viewport: {
          width: finiteDimension(window.innerWidth, documentElement.clientWidth),
          height: finiteDimension(window.innerHeight, documentElement.clientHeight),
          scrollX: finiteNumber(window.scrollX, 0),
          scrollY: finiteNumber(window.scrollY, 0),
          deviceScaleFactor: finiteNumber(window.devicePixelRatio, 1) > 0
            ? finiteNumber(window.devicePixelRatio, 1)
            : 1
        },
        document: {
          width: finiteDimension(documentElement.scrollWidth, documentElement.clientWidth, body.scrollWidth, body.clientWidth),
          height: finiteDimension(documentElement.scrollHeight, documentElement.clientHeight, body.scrollHeight, body.clientHeight)
        }
      },
      truncated: {
        selectedElementRefs: selection.refsTruncated,
        visibleText: visible.truncated,
        selection: selection.truncated
      }
    };
  };

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
    try {
      // "instant" avoids smooth-scroll animations skewing the rect below, but
      // older Chrome releases reject it as an invalid enum value.
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
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
    const tag = element.tagName.toLowerCase();
    const readOnly = element.readOnly === true || element.getAttribute("aria-readonly") === "true";
    const editable = !isDisabled(element) && !readOnly && (
      (tag === "input" && WRITABLE_INPUT_TYPES.has((element.getAttribute("type") || "text").toLowerCase()))
      || tag === "textarea"
      || element.isContentEditable === true
    );
    if (!editable) {
      pendingFills.delete(String(ref));
      return { found: true, editable: false, focused: false };
    }
    element.focus();
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
    // getRootNode() keeps the check correct for elements inside shadow roots,
    // where document.activeElement only reports the shadow host.
    const root = element.getRootNode();
    const active = root && "activeElement" in root ? root.activeElement : element.ownerDocument.activeElement;
    const focused = active === element;
    if (focused) {
      const usesValue = tag === "input" || tag === "textarea";
      pendingFills.set(String(ref), {
        before: usesValue ? String(element.value ?? "") : String(element.textContent ?? ""),
        element,
        selectionEnd: usesValue && Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
        selectionStart: usesValue && Number.isInteger(element.selectionStart) ? element.selectionStart : null,
        usesValue
      });
    } else {
      pendingFills.delete(String(ref));
    }
    return { found: true, editable, focused };
  };

  window.__opencodeA11yVerifyFill = function (ref, text, selectedAll) {
    const refKey = String(ref);
    const element = derefElement(refKey);
    const pending = pendingFills.get(refKey);
    pendingFills.delete(refKey);
    if (!element || !pending || pending.element !== element) return { found: element !== null, verified: false };

    const current = pending.usesValue ? String(element.value ?? "") : String(element.textContent ?? "");
    if (pending.usesValue) {
      const start = selectedAll ? 0 : (pending.selectionStart ?? pending.before.length);
      const end = selectedAll ? pending.before.length : (pending.selectionEnd ?? start);
      const expected = `${pending.before.slice(0, start)}${text}${pending.before.slice(end)}`;
      return { found: true, verified: current === expected };
    }
    if (selectedAll) return { found: true, verified: current === text };
    if (text.length === 0) return { found: true, verified: current === pending.before };
    return { found: true, verified: current !== pending.before && current.includes(text) };
  };

  function clampInt(value, min, max, fallback) {
    if (!Number.isInteger(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }
}
