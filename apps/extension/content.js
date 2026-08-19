(() => {
  const loadedKey = "__TABWARD_CONTENT_LOADED__";
  if (window[loadedKey]) {
    return;
  }
  window[loadedKey] = true;

  const rootId = "tabward-agent-overlay-root";
  const titlePrefix = "[TabWard] ";
  const originalTitleKey = "tabwardOriginalTitle";
  const faviconSelector = "link[rel~='icon'], link[rel='shortcut icon']";
  let cursorHideTimer = null;
  let latestSiteTitle = document.title.startsWith(titlePrefix)
    ? document.title.slice(titlePrefix.length)
    : document.title;
  let mutationObserver = null;
  let visualMutationGuard = false;
  let currentFaviconStatus = null;

  function clearCursorHideTimer() {
    if (cursorHideTimer !== null) {
      window.clearTimeout(cursorHideTimer);
      cursorHideTimer = null;
    }
  }

  function ensureOverlay() {
    let root = document.getElementById(rootId);
    if (root && root.shadowRoot) {
      return root;
    }
    if (root) {
      root.remove();
    }

    root = document.createElement("div");
    root.id = rootId;
    root.setAttribute("aria-hidden", "true");
    root.dataset.visible = "false";
    document.documentElement.appendChild(root);

    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        inset: 0;
        pointer-events: none;
        position: fixed;
        z-index: 2147483646;
      }
      .cursor {
        left: 0;
        opacity: 0;
        position: fixed;
        top: 0;
        transform: translate3d(56vw, 56vh, 0);
        transition:
          opacity 140ms ease,
          transform 360ms cubic-bezier(.2, .9, .2, 1);
        will-change: opacity, transform;
      }
      :host([data-visible="true"]) .cursor {
        opacity: 1;
      }
      .arrow {
        background: linear-gradient(135deg, #38bdf8, #2563eb);
        clip-path: polygon(0 0, 0 22px, 6px 16px, 10px 25px, 15px 23px, 11px 14px, 20px 14px);
        filter: drop-shadow(0 0 5px rgba(37, 99, 235, .85)) drop-shadow(0 4px 10px rgba(15, 23, 42, .35));
        height: 26px;
        transform: rotate(-8deg);
        width: 22px;
      }
      .label {
        background: rgba(15, 23, 42, .88);
        border: 1px solid rgba(255, 255, 255, .18);
        border-radius: 999px;
        color: white;
        font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        left: 18px;
        max-width: 180px;
        overflow: hidden;
        padding: 4px 8px;
        position: absolute;
        text-overflow: ellipsis;
        top: 19px;
        white-space: nowrap;
      }
      :host([data-pulse="true"]) .arrow {
        animation: tabwardCursorPulse 680ms ease-out 1;
      }
      @keyframes tabwardCursorPulse {
        0% { transform: rotate(-8deg) scale(1); }
        45% { transform: rotate(-8deg) scale(.82); }
        100% { transform: rotate(-8deg) scale(1); }
      }
      @media print {
        .cursor {
          display: none;
        }
      }
    `;

    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.dataset.tabwardCursor = "true";

    const arrow = document.createElement("div");
    arrow.className = "arrow";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "TabWard";

    cursor.append(arrow, label);
    shadow.append(style, cursor);
    return root;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function setCursor(cursorState = {}) {
    clearCursorHideTimer();
    const root = ensureOverlay();
    const cursor = root.shadowRoot.querySelector(".cursor");
    const label = root.shadowRoot.querySelector(".label");
    const width = window.visualViewport?.width || window.innerWidth || 1;
    const height = window.visualViewport?.height || window.innerHeight || 1;
    const x = clamp(Number(cursorState.x ?? Math.round(width * 0.58)), 0, width);
    const y = clamp(Number(cursorState.y ?? Math.round(height * 0.55)), 0, height);

    label.textContent = String(cursorState.label || "TabWard").slice(0, 80);
    cursor.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    root.dataset.visible = cursorState.visible === false ? "false" : "true";
    root.dataset.pulse = cursorState.pulse ? "true" : "false";
    if (cursorState.pulse) {
      window.setTimeout(() => {
        if (root.isConnected) {
          root.dataset.pulse = "false";
        }
      }, 750);
    }
    if (Number.isFinite(cursorState.autoHideMs) && cursorState.autoHideMs > 0) {
      cursorHideTimer = window.setTimeout(() => {
        hideCursor();
      }, cursorState.autoHideMs);
    }
    return { ok: true };
  }

  function hideCursor() {
    clearCursorHideTimer();
    const root = document.getElementById(rootId);
    if (root) {
      root.dataset.visible = "false";
    }
    return { ok: true };
  }

  function setTitleBadge() {
    const root = document.documentElement;
    if (!document.title.startsWith(titlePrefix)) {
      latestSiteTitle = document.title;
    }
    root.dataset[originalTitleKey] = latestSiteTitle;
    if (document.title !== `${titlePrefix}${latestSiteTitle}`) {
      visualMutationGuard = true;
      document.title = `${titlePrefix}${latestSiteTitle}`;
      visualMutationGuard = false;
    }
  }

  function restoreTitle() {
    const root = document.documentElement;
    if (root.dataset[originalTitleKey] !== undefined || document.title.startsWith(titlePrefix)) {
      visualMutationGuard = true;
      document.title = latestSiteTitle;
      delete root.dataset[originalTitleKey];
      visualMutationGuard = false;
    }
  }

  function faviconDataUrl(status) {
    const styles = {
      working: { fill: "#2563eb", dot: "#22c55e", letter: "D" },
      handoff: { fill: "#eab308", dot: "#f97316", letter: "H" },
      deliverable: { fill: "#22c55e", dot: "#86efac", letter: "\u2713" },
      idle: { fill: "#64748b", dot: "#94a3b8", letter: "D" }
    };
    const s = styles[status] || styles.idle;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${s.fill}"/><text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="white">${s.letter}</text><circle cx="24" cy="24" r="7" fill="${s.dot}"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function setFaviconBadge(status) {
    currentFaviconStatus = status;
    let links = Array.from(document.querySelectorAll(faviconSelector));
    if (links.length === 0) {
      const created = document.createElement("link");
      created.rel = "icon";
      created.dataset.tabwardFaviconCreated = "true";
      document.head.appendChild(created);
      links = [created];
    }
    for (const link of links) {
      if (!link.dataset.tabwardFaviconBadge) {
        link.dataset.tabwardOriginalHref = link.getAttribute("href") || "";
      } else if (!String(link.getAttribute("href") || "").startsWith("data:image/svg+xml")) {
        link.dataset.tabwardOriginalHref = link.getAttribute("href") || "";
      }
      link.dataset.tabwardFaviconBadge = "true";
      const nextHref = faviconDataUrl(status);
      if (link.getAttribute("href") !== nextHref) {
        visualMutationGuard = true;
        link.setAttribute("href", nextHref);
        visualMutationGuard = false;
      }
    }
  }

  function restoreFavicons() {
    visualMutationGuard = true;
    for (const link of document.querySelectorAll("link[data-tabward-favicon-badge='true']")) {
      const originalHref = link.dataset.tabwardOriginalHref;
      const created = link.dataset.tabwardFaviconCreated === "true";
      delete link.dataset.tabwardFaviconBadge;
      delete link.dataset.tabwardOriginalHref;
      delete link.dataset.tabwardFaviconCreated;
      if (created) {
        link.remove();
      } else if (originalHref) {
        link.setAttribute("href", originalHref);
      } else {
        link.removeAttribute("href");
      }
    }
    currentFaviconStatus = null;
    visualMutationGuard = false;
  }

  function ensureMutationObserver() {
    if (mutationObserver || !document.head) {
      return;
    }
    mutationObserver = new MutationObserver(() => {
      if (visualMutationGuard) {
        return;
      }
      const working = document.documentElement.dataset[originalTitleKey] !== undefined;
      if (working && !document.title.startsWith(titlePrefix)) {
        latestSiteTitle = document.title;
        setTitleBadge();
      }
      if (currentFaviconStatus) {
        const desired = faviconDataUrl(currentFaviconStatus);
        const links = Array.from(document.querySelectorAll(faviconSelector));
        if (links.some((link) => link.dataset.tabwardFaviconBadge !== "true" || link.getAttribute("href") !== desired)) {
          setFaviconBadge(currentFaviconStatus);
        }
      }
    });
    mutationObserver.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href"]
    });
  }

  function markWorking(state = {}) {
    ensureMutationObserver();
    setTitleBadge();
    setFaviconBadge("working");
    if (state.cursor) {
      setCursor(state.cursor);
    }
    return { ok: true };
  }

  function markIdle(state = {}) {
    setFaviconBadge("idle");
    const hideAfterMs = Number.isFinite(state.hideCursorAfterMs) ? state.hideCursorAfterMs : 2500;
    if (hideAfterMs <= 0) {
      hideCursor();
    } else {
      clearCursorHideTimer();
      cursorHideTimer = window.setTimeout(() => {
        hideCursor();
      }, hideAfterMs);
    }
    return { ok: true };
  }

  function cleanupPage() {
    hideCursor();
    restoreTitle();
    restoreFavicons();
    const root = document.getElementById(rootId);
    if (root) {
      root.remove();
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    return { ok: true };
  }

  function markTransfer(status) {
    hideCursor();
    restoreTitle();
    const root = document.getElementById(rootId);
    if (root) {
      root.remove();
    }
    setFaviconBadge(status);
    ensureMutationObserver();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (message.type === "TABWARD_CONTENT_PING") {
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "TABWARD_CURSOR_SET") {
      sendResponse(setCursor(message.cursor || {}));
      return true;
    }
    if (message.type === "TABWARD_CURSOR_HIDE") {
      sendResponse(hideCursor());
      return true;
    }
    if (message.type === "TABWARD_PAGE_MARK_WORKING") {
      sendResponse(markWorking(message.state || {}));
      return true;
    }
    if (message.type === "TABWARD_PAGE_MARK_IDLE") {
      sendResponse(markIdle(message.state || {}));
      return true;
    }
    if (message.type === "TABWARD_PAGE_MARK_HANDOFF") {
      sendResponse(markTransfer("handoff"));
      return true;
    }
    if (message.type === "TABWARD_PAGE_MARK_DELIVERABLE") {
      sendResponse(markTransfer("deliverable"));
      return true;
    }
    if (message.type === "TABWARD_PAGE_CLEANUP") {
      sendResponse(cleanupPage());
      return true;
    }
    return false;
  });
})();
