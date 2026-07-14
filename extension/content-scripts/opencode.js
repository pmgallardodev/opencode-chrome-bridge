// OpenCode browser control visual overlay — injected on demand by background.js
// Idempotent: re-injection from background.js is safe, only one overlay is created.
// States: active (default), handoff, deliverable, hidden, abort.

if (!window.__opencodeOverlayInstalled) {
  window.__opencodeOverlayInstalled = true;

  const HOST_ID = "opencode-agent-overlay-root";
  const OVERLAY_SOURCE = "opencode-bridge";
  const FAVICON_BADGE_ATTR = "data-opencode-favicon-badge";
  const FAVICON_LINK_SELECTOR = 'link[rel~="icon"], link[rel="shortcut icon"]';
  const HIDE_DELAY_MS = 2000;
  const BEZIER_DURATION_MS = 220;

  const STATE_COLORS = {
    active: { ring: "rgba(99,102,241,0.55)" },
    handoff: { ring: "rgba(245,158,11,0.55)" },
    deliverable: { ring: "rgba(34,197,94,0.55)" },
    abort: { ring: "rgba(239,68,68,0.55)" },
    hidden: { ring: "rgba(99,102,241,0.55)" }
  };

  let shadowRoot = null;
  let cursorEl = null;
  let faviconBadge = null;
  let borderEl = null;
  let stopButton = null;
  let hideTimer = null;
  let currentRaf = null;
  let currentState = "active";
  let faviconRecords = [];
  let iconDataUrlPromise = null;
  let faviconUpdateSeq = 0;
  let agentInputDepth = 0;

  function ensureOverlay() {
    if (shadowRoot) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    shadowRoot = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .oc-cursor {
        position: fixed;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: rgba(99, 102, 241, 0.92);
        border: 2.5px solid rgba(255,255,255,0.95);
        box-shadow: 0 0 0 2px rgba(99,102,241,0.35), 0 2px 10px rgba(0,0,0,0.28);
        transform: translate(-50%, -50%);
        transition: background 0.18s ease, box-shadow 0.18s ease, opacity 0.2s ease;
        pointer-events: none;
        opacity: 0;
        will-change: left, top, transform;
      }
      .oc-cursor.oc-visible { opacity: 1; }
      .oc-cursor.oc-clicking {
        transform: translate(-50%, -50%) scale(0.72);
        transition: transform 0.08s ease, background 0.18s ease, box-shadow 0.18s ease, opacity 0.2s ease;
      }
      .oc-cursor.oc-state-handoff {
        background: rgba(245, 158, 11, 0.92);
        box-shadow: 0 0 0 2px rgba(245,158,11,0.35), 0 2px 10px rgba(0,0,0,0.28);
      }
      .oc-cursor.oc-state-deliverable {
        background: rgba(34, 197, 94, 0.92);
        box-shadow: 0 0 0 2px rgba(34,197,94,0.35), 0 2px 10px rgba(0,0,0,0.28);
      }
      .oc-cursor.oc-state-abort {
        background: rgba(239, 68, 68, 0.92);
        box-shadow: 0 0 0 2px rgba(239,68,68,0.35), 0 2px 10px rgba(0,0,0,0.28);
      }
      .oc-ripple {
        position: fixed;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 2px solid rgba(99, 102, 241, 0.55);
        transform: translate(-50%, -50%) scale(0);
        animation: oc-ripple-anim 0.45s ease-out forwards;
        pointer-events: none;
      }
      @keyframes oc-ripple-anim {
        to { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
      }
      .oc-favicon-badge {
        position: fixed;
        top: 6px;
        right: 6px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: rgba(99, 102, 241, 0.95);
        border: 2px solid rgba(255,255,255,0.9);
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        animation: oc-badge-pulse 1.6s ease-in-out infinite;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.25s ease, background 0.18s ease;
      }
      .oc-favicon-badge.oc-badge-visible { opacity: 1; }
      .oc-favicon-badge.oc-state-handoff { background: rgba(245, 158, 11, 0.95); }
      .oc-favicon-badge.oc-state-deliverable { background: rgba(34, 197, 94, 0.95); }
      .oc-favicon-badge.oc-state-abort { background: rgba(239, 68, 68, 0.95); }
      @keyframes oc-badge-pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.18); }
      }
      .oc-border {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .oc-border-inner {
        position: absolute;
        inset: 0;
        box-shadow:
          inset 0 0 15px rgba(99, 102, 241, 0.55),
          inset 0 0 30px rgba(99, 102, 241, 0.25);
        animation: oc-border-pulse 2s ease-in-out infinite;
      }
      .oc-border.oc-visible { opacity: 1; }
      @keyframes oc-border-pulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }
      .oc-stop {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%) translateY(80px);
        padding: 10px 16px;
        background: #171717;
        color: #e8e8e8;
        border: 1px solid rgba(99, 102, 241, 0.6);
        border-radius: 10px;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);
        opacity: 0;
        pointer-events: none;
        transition: transform 0.3s ease, opacity 0.3s ease;
        user-select: none;
        white-space: nowrap;
      }
      .oc-stop.oc-visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
        pointer-events: auto;
      }
      .oc-stop.oc-visible.oc-input-pass-through { pointer-events: none; }
      @media (prefers-reduced-motion: reduce) {
        .oc-border-inner { animation: none; }
        .oc-favicon-badge { animation: none; }
      }
    `;
    shadowRoot.appendChild(style);

    cursorEl = document.createElement("div");
    cursorEl.className = "oc-cursor";
    shadowRoot.appendChild(cursorEl);

    faviconBadge = document.createElement("div");
    faviconBadge.className = "oc-favicon-badge";
    shadowRoot.appendChild(faviconBadge);

    borderEl = document.createElement("div");
    borderEl.className = "oc-border";
    const borderInner = document.createElement("div");
    borderInner.className = "oc-border-inner";
    borderEl.appendChild(borderInner);
    shadowRoot.appendChild(borderEl);

    stopButton = document.createElement("button");
    stopButton.className = "oc-stop";
    stopButton.type = "button";
    stopButton.textContent = "Stop OpenCode";
    stopButton.addEventListener("click", () => {
      // Let the user halt the agent from the controlled page itself. The
      // background forwards this as a stopRequested bridge event.
      try {
        chrome.runtime.sendMessage({ type: "STOP_AGENT_REQUEST" });
      } catch {}
      hideAgentChrome();
    });
    shadowRoot.appendChild(stopButton);

    document.documentElement.appendChild(host);
  }

  function showAgentChrome() {
    ensureOverlay();
    borderEl.classList.add("oc-visible");
    stopButton.classList.add("oc-visible");
  }

  function hideAgentChrome() {
    if (borderEl) borderEl.classList.remove("oc-visible");
    if (stopButton) stopButton.classList.remove("oc-visible");
  }

  function beginAgentInput() {
    ensureOverlay();
    agentInputDepth += 1;
    stopButton.classList.add("oc-input-pass-through");
  }

  function endAgentInput() {
    agentInputDepth = Math.max(0, agentInputDepth - 1);
    if (agentInputDepth === 0 && stopButton) stopButton.classList.remove("oc-input-pass-through");
  }

  function applyState(state) {
    if (!state || !STATE_COLORS[state]) return;
    currentState = state;
    ensureOverlay();
    cursorEl.classList.remove("oc-state-active", "oc-state-handoff", "oc-state-deliverable", "oc-state-abort");
    faviconBadge.classList.remove("oc-state-active", "oc-state-handoff", "oc-state-deliverable", "oc-state-abort");
    if (state !== "active" && state !== "hidden") {
      cursorEl.classList.add(`oc-state-${state}`);
      faviconBadge.classList.add(`oc-state-${state}`);
    }
    if (state === "active") showAgentChrome();
    else hideAgentChrome();
  }

  function animateBezier(fromX, fromY, toX, toY, duration, onDone) {
    if (currentRaf) cancelAnimationFrame(currentRaf);
    const start = performance.now();
    const cp1x = fromX + (toX - fromX) * 0.35;
    const cp1y = fromY - 30;
    const cp2x = fromX + (toX - fromX) * 0.75;
    const cp2y = toY + 20;

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = bezier(e, fromX, cp1x, cp2x, toX);
      const y = bezier(e, fromY, cp1y, cp2y, toY);
      cursorEl.style.left = `${x}px`;
      cursorEl.style.top = `${y}px`;
      if (t < 1) {
        currentRaf = requestAnimationFrame(step);
      } else {
        currentRaf = null;
        if (onDone) onDone();
      }
    }
    currentRaf = requestAnimationFrame(step);
  }

  function bezier(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  }

  function currentPos() {
    const left = parseFloat(cursorEl.style.left);
    const top = parseFloat(cursorEl.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) return { x: left, y: top };
    return null;
  }

  function showAt(x, y) {
    ensureOverlay();
    clearHideTimer();
    if (currentState === "hidden") {
      cursorEl.style.left = `${x}px`;
      cursorEl.style.top = `${y}px`;
      cursorEl.classList.remove("oc-visible");
      hideBadge();
      return;
    }
    const from = currentPos();
    if (from && (Math.abs(from.x - x) > 3 || Math.abs(from.y - y) > 3)) {
      animateBezier(from.x, from.y, x, y, BEZIER_DURATION_MS);
    } else {
      cursorEl.style.left = `${x}px`;
      cursorEl.style.top = `${y}px`;
    }
    cursorEl.classList.add("oc-visible");
    showBadge();
  }

  function animateClick(x, y) {
    showAt(x, y);
    if (currentState === "hidden") return;
    cursorEl.classList.add("oc-clicking");
    const ripple = document.createElement("div");
    ripple.className = "oc-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    const colors = STATE_COLORS[currentState] || STATE_COLORS.active;
    ripple.style.borderColor = colors.ring;
    shadowRoot.appendChild(ripple);
    setTimeout(() => cursorEl.classList.remove("oc-clicking"), 130);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    scheduleHide();
  }

  function showBadge() {
    ensureOverlay();
    if (currentState === "hidden") return;
    faviconBadge.classList.add("oc-badge-visible");
  }

  function hideBadge() {
    if (faviconBadge) faviconBadge.classList.remove("oc-badge-visible");
  }

  // SVG rendered as an image (which favicons are) blocks all external resource
  // loads, including chrome-extension:// URLs. Inline the icon as a data: URI —
  // the only kind of reference an SVG image is allowed to load.
  function fetchIconDataUrl() {
    if (!iconDataUrlPromise) {
      iconDataUrlPromise = (async () => {
        try {
          const response = await fetch(chrome.runtime.getURL("images/cursor-chat.png"));
          const blob = await response.blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      })();
    }
    return iconDataUrlPromise;
  }

  async function setDocumentFaviconBadge(state) {
    const seq = ++faviconUpdateSeq;
    clearDocumentFaviconBadge();
    if (!state || !["active", "handoff", "deliverable"].includes(state)) return;

    const iconHref = await fetchIconDataUrl();
    if (seq !== faviconUpdateSeq) return;
    const badgedHref = makeFaviconBadgeDataUrl(state, iconHref);
    const links = [...document.querySelectorAll(FAVICON_LINK_SELECTOR)];
    const targets = links.length > 0 ? links : [createFaviconLink()];

    faviconRecords = targets.map((link) => {
      const record = {
        created: links.length === 0,
        href: link.getAttribute("href"),
        link
      };
      link.href = badgedHref;
      link.setAttribute(FAVICON_BADGE_ATTR, "true");
      return record;
    });
  }

  function clearDocumentFaviconBadge() {
    const records = faviconRecords;
    faviconRecords = [];
    for (const record of records) {
      if (!record.link.isConnected) continue;
      record.link.removeAttribute(FAVICON_BADGE_ATTR);
      if (record.created) {
        record.link.remove();
      } else if (record.href == null) {
        record.link.removeAttribute("href");
      } else {
        record.link.setAttribute("href", record.href);
      }
    }
    for (const link of document.querySelectorAll(`link[${FAVICON_BADGE_ATTR}="true"]`)) {
      link.removeAttribute(FAVICON_BADGE_ATTR);
    }
  }

  function createFaviconLink() {
    const link = document.createElement("link");
    link.rel = "icon";
    (document.head || document.documentElement).appendChild(link);
    return link;
  }

  function makeFaviconBadgeDataUrl(state, iconHref) {
    const badge = state === "deliverable" ? "#22c55e" : state === "handoff" ? "#f59e0b" : "#111827";
    const opacity = state === "active" ? ' opacity="0.35"' : "";
    const icon = iconHref ? `<image href="${escapeSvg(iconHref)}" width="32" height="32"${opacity}/>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${icon}<circle cx="24" cy="24" r="7" fill="${badge}" stroke="white" stroke-width="2"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function escapeSvg(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("\"", "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer = setTimeout(() => {
      if (cursorEl) cursorEl.classList.remove("oc-visible");
    }, HIDE_DELAY_MS);
  }

  function clearHideTimer() {
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.source !== OVERLAY_SOURCE) return;
    switch (message.type) {
      case "cursor-move":
        showAt(message.x, message.y);
        scheduleHide();
        break;
      case "cursor-click":
        animateClick(message.x, message.y);
        break;
      case "agent-input-start":
        beginAgentInput();
        break;
      case "agent-input-end":
        endAgentInput();
        break;
      case "cursor-state":
        applyState(message.state);
        setDocumentFaviconBadge(message.state === "hidden" || message.state === "abort" ? null : message.state).catch(() => {});
        if (message.state === "hidden") {
          clearHideTimer();
          if (cursorEl) cursorEl.classList.remove("oc-visible");
          hideBadge();
        }
        break;
      case "favicon-badge":
        setDocumentFaviconBadge(message.badge).catch(() => {});
        break;
      case "cursor-arrived":
        ensureOverlay();
        showAt(message.x, message.y);
        showBadge();
        break;
      case "cursor-hide":
        clearHideTimer();
        if (cursorEl) cursorEl.classList.remove("oc-visible");
        hideBadge();
        break;
    }
  });
}
