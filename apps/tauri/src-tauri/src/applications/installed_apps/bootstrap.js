/*!
 * Fredo installed-application bootstrap (Spec #3147, ST-3).
 *
 * Host-authored, embedded into the binary with `include_str!` and served from
 * the reserved `__fredo/bootstrap.js` path of the `fredoapp` origin. It is the
 * ONLY executable code the host puts inside an installed application's
 * document, and it exists so the document's own lifecycle — loading -> usable,
 * loading -> failure (with Retry) — lives at the same origin as the application.
 *
 * Contracts this file implements (see `scheme.rs` for the document that
 * loads it, and `.opencode/tests/installable-apps/README.md` for the fixture
 * side):
 *
 *  1. `INSTALLED_APP_MOUNT_TIMEOUT_MS = 10000`, measured from document commit
 *     to `mount` resolution.
 *  2. `window.onerror` / `window.onunhandledrejection` render the failure panel.
 *  3. `window.__FREDO_APPLY_THEME__(json)` applies a theme payload idempotently
 *     and dispatches `fredo-theme-change` on `document.documentElement` — this
 *     is the function ST-5's live push `eval`s into an open window.
 *  4. The loading panel (`installed-app-loading`) is a polite live region whose
 *     visible text is exactly `Loading <displayName>`.
 *  5. The mount watchdog: at the budget the failure panel renders with
 *     `mount_timeout`.
 *  6. `entry.module` is fetched (so a refused/absent file is detectable with
 *     its reason), then `import()`-ed and its `mount(ctx)` called.
 *  7. The failure panel (`installed-app-failure`) names the app, gives a
 *     plain-language reason, the reason CODE, and a "Try again" button that
 *     reloads the SAME document.
 *  8. `installed-app-root` is the region the app mounts into; both panels are
 *     fixed-position SIBLINGS of it, so a half-painted app can never hide them.
 *  9. `window.__FREDO_INSTALLED__.invoke(action, args)` is the ONE call route an
 *     application has: it forwards `{request: {action, args}}` to the dispatcher
 *     command this tier's capability grants. `action` is an ACTION the host's
 *     own table validates — never a command name — and the transport's promise
 *     (including a structured refusal) is returned unwrapped.
 *
 * Colour rules: only `var(--...)` reads with CSS system-colour fallbacks. No
 * hex, no rgb/hsl literals, and never an alpha suffix appended to a `var()`
 * reference (that is invalid CSS). Tints are written as `color-mix(...)`.
 *
 * No framework, no bundled Tauri API, no external stylesheet or icon request:
 * the warning glyph is inline SVG and every style lives in the document's
 * injected `<style>` block.
 */
(function () {
  "use strict";

  // 1. The derived mount budget: document commit -> usable.
  var INSTALLED_APP_MOUNT_TIMEOUT_MS = 10000;

  // The five host-owned DOM hooks. The unit pin in `scheme.rs` asserts each
  // literal is present in this source.
  var HOOK_ROOT = "installed-app-root";
  var HOOK_LOADING = "installed-app-loading";
  var HOOK_FAILURE = "installed-app-failure";
  var HOOK_FAILURE_REASON = "installed-app-failure-reason";
  var HOOK_RETRY = "installed-app-retry";

  // Plain-language reason sentences (UI/UX §3.3, one per cause).
  var REASON_TEXT = {
    mount_timeout: "It didn't finish loading within 10 seconds.",
    mount_threw: "It hit an error while starting.",
    load_failed: "One of its files couldn't be read.",
    integrity_mismatch: "Its files changed after it was installed, so Fredo won't run it."
  };
  var KNOWN_REASONS = ["mount_timeout", "mount_threw", "load_failed", "integrity_mismatch"];

  // The host-authored config block the served document carries (a JSON data
  // block, never an inline script — the child policy allows no inline script).
  var CONFIG_ELEMENT_ID = "__fredo-config";

  var state = {
    config: { appId: "", version: "", displayName: "", module: "", theme: { tokens: [], colorScheme: "light" } },
    mounted: false,
    failed: false,
    watchdog: null
  };

  var panels = { loading: null, failure: null };

  function isKnownReason(value) {
    if (typeof value !== "string") {
      return false;
    }
    for (var index = 0; index < KNOWN_REASONS.length; index += 1) {
      if (KNOWN_REASONS[index] === value) {
        return true;
      }
    }
    return false;
  }

  function readConfig() {
    var node = document.getElementById(CONFIG_ELEMENT_ID);
    if (!node || !node.textContent) {
      return;
    }
    try {
      var parsed = JSON.parse(node.textContent);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      if (typeof parsed.appId === "string") {
        state.config.appId = parsed.appId;
      }
      if (typeof parsed.version === "string") {
        state.config.version = parsed.version;
      }
      if (typeof parsed.displayName === "string" && parsed.displayName.length > 0) {
        state.config.displayName = parsed.displayName;
      }
      if (typeof parsed.module === "string") {
        state.config.module = parsed.module;
      }
      if (parsed.theme && typeof parsed.theme === "object") {
        state.config.theme = parsed.theme;
      }
      // A host-authored failure document carries the reason the load was refused
      // BEFORE an application document existed (e.g. the entry document's bytes
      // no longer match the install record). The bootstrap then renders the
      // failure panel and never imports anything.
      if (typeof parsed.startupFailure === "string" && isKnownReason(parsed.startupFailure)) {
        state.config.startupFailure = parsed.startupFailure;
      }
    } catch (error) {
      // A malformed config block is a host defect, not an application failure:
      // the app still mounts with the fallback theme and an id-based name.
    }
    if (!state.config.displayName) {
      state.config.displayName = state.config.appId || "This application";
    }
  }

  // 3. Theme application — idempotent by construction (setting the same
  // property to the same value is a no-op for the style system).
  function applyTheme(theme) {
    if (!theme || !Array.isArray(theme.tokens)) {
      return;
    }
    var root = document.documentElement;
    for (var index = 0; index < theme.tokens.length; index += 1) {
      var token = theme.tokens[index];
      if (!token || typeof token.name !== "string" || typeof token.value !== "string") {
        continue;
      }
      if (token.name.indexOf("--") !== 0) {
        continue;
      }
      try {
        root.style.setProperty(token.name, token.value);
      } catch (error) {
        // A name the CSSOM rejects is skipped; the CSS fallback still applies.
      }
    }
    if (typeof theme.colorScheme === "string") {
      root.style.colorScheme = theme.colorScheme === "dark" ? "dark" : "light";
    }
  }

  function dispatchThemeChange(theme) {
    var event;
    try {
      event = new CustomEvent("fredo-theme-change", { detail: theme, bubbles: false });
    } catch (error) {
      event = document.createEvent("CustomEvent");
      event.initCustomEvent("fredo-theme-change", false, false, theme);
    }
    document.documentElement.dispatchEvent(event);
  }

  // The function ST-5's live push calls (via Webview::eval) in an open window.
  window.__FREDO_APPLY_THEME__ = function (payload) {
    var theme = payload;
    if (typeof payload === "string") {
      try {
        theme = JSON.parse(payload);
      } catch (error) {
        return;
      }
    }
    if (!theme || typeof theme !== "object") {
      return;
    }
    applyTheme(theme);
    if (window.__FREDO_INSTALLED__ && typeof window.__FREDO_INSTALLED__ === "object") {
      window.__FREDO_INSTALLED__.theme = theme;
    }
    dispatchThemeChange(theme);
  };

  // ---------------------------------------------------------------------------
  // 3b. The child client — the ONE call route an application has
  // ---------------------------------------------------------------------------

  // `action` is an ACTION, not a command: the host validates it against its own
  // ordered action table and decides on the caller's capability, scope and
  // consent. Deliberately NO vocabulary here — no allowlist, no rename, no
  // refusal code — so this can never become a second, drifting authority, and a
  // refusal the host decided reaches the caller exactly as the transport
  // serialised it (the promise is returned unwrapped).
  function invokeAction(action, args) {
    var payload = args === undefined || args === null ? {} : args;
    // Resolved at call time, and called with the handle as its receiver.
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      // The transport is the host's; its absence is a load condition, not an
      // authority decision, so it carries no refusal code.
      return Promise.reject(
        new Error("Fredo's transport is not available in this document, so the call was not made.")
      );
    }
    return internals.invoke("installed_app_invoke", {
      request: { action: action, args: payload }
    });
  }

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------

  function element(tagName, className) {
    var node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    return node;
  }

  function cancelWatchdog() {
    if (state.watchdog !== null) {
      clearTimeout(state.watchdog);
      state.watchdog = null;
    }
  }

  function removeLoading() {
    var panel = panels.loading;
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
    panels.loading = null;
    return panel;
  }

  // 4. The loading panel. Its visible text node is exactly `Loading <name>`;
  // deliberately NO aria-label, so the painted and announced names cannot drift.
  function showLoading() {
    if (panels.loading) {
      return panels.loading;
    }
    var panel = element("div", "fredo-panel");
    panel.setAttribute("data-testid", HOOK_LOADING);
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.setAttribute("tabindex", "-1");

    var card = element("div", "fredo-panel-card");

    var statusText = element("div", "fredo-status-text");
    statusText.textContent = "Loading " + state.config.displayName;

    var note = element("p", "fredo-panel-note");
    note.textContent =
      "An installed application starts when you first open it, so this first load can take a moment.";

    var track = element("div", "fredo-progress");
    track.setAttribute("aria-hidden", "true");
    var segment = element("div", "fredo-progress-segment");
    track.appendChild(segment);

    card.appendChild(statusText);
    card.appendChild(note);
    card.appendChild(track);
    panel.appendChild(card);
    document.body.appendChild(panel);

    panels.loading = panel;
    try {
      panel.focus();
    } catch (error) {
      // Focus is the announcement guarantee; a refusal is not fatal.
    }
    return panel;
  }

  function warningGlyph() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "fredo-glyph");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var triangle = document.createElementNS("http://www.w3.org/2000/svg", "path");
    triangle.setAttribute("d", "M12 3.2 22 20.4H2Z");
    triangle.setAttribute("fill", "none");
    triangle.setAttribute("stroke", "currentColor");
    triangle.setAttribute("stroke-width", "1.6");
    var stem = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stem.setAttribute("d", "M12 9.2v5");
    stem.setAttribute("stroke", "currentColor");
    stem.setAttribute("stroke-width", "1.6");
    var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "17.1");
    dot.setAttribute("r", "0.9");
    dot.setAttribute("fill", "currentColor");
    svg.appendChild(triangle);
    svg.appendChild(stem);
    svg.appendChild(dot);
    return svg;
  }

  // 7. The failure panel. Sibling of the root, fixed over the whole viewport,
  // so whatever the app half-painted can never cover it.
  function showFailure(reason) {
    if (state.failed) {
      return;
    }
    state.failed = true;
    cancelWatchdog();
    removeLoading();

    var code = isKnownReason(reason) ? reason : "load_failed";

    var panel = element("div", "fredo-panel");
    panel.setAttribute("data-testid", HOOK_FAILURE);
    panel.setAttribute("role", "alert");
    panel.setAttribute("aria-live", "assertive");
    panel.setAttribute("tabindex", "-1");

    var card = element("div", "fredo-panel-card");
    card.appendChild(warningGlyph());

    var heading = element("h1", "fredo-failure-heading");
    heading.textContent = "Couldn't open " + state.config.displayName;

    var reasonNode = element("p", "fredo-failure-reason");
    reasonNode.setAttribute("data-testid", HOOK_FAILURE_REASON);
    reasonNode.textContent = REASON_TEXT[code];

    var codeNode = element("p", "fredo-reason-code");
    codeNode.textContent = code;

    var retry = element("button", "fredo-retry");
    retry.setAttribute("data-testid", HOOK_RETRY);
    retry.setAttribute("type", "button");
    retry.textContent = "Try again";
    retry.addEventListener("click", function () {
      // Retry re-runs the WHOLE bootstrap in the SAME document: a fresh module
      // registry, the theme as it is now, a fresh watchdog. No host restart.
      window.location.reload();
    });

    card.appendChild(heading);
    card.appendChild(reasonNode);
    card.appendChild(codeNode);
    card.appendChild(retry);
    panel.appendChild(card);
    document.body.appendChild(panel);

    panels.failure = panel;
    try {
      panel.focus();
    } catch (error) {
      // Announcement still happens through the alert role.
    }
  }

  // 2. A throw or a rejection while loading renders the failure panel. Once the
  // app has mounted, its own errors are its business: overlaying a working
  // application would be worse than letting the error surface in its console.
  window.onerror = function () {
    if (state.mounted) {
      return false;
    }
    showFailure("mount_threw");
    return false;
  };

  window.onunhandledrejection = function () {
    if (state.mounted) {
      return;
    }
    showFailure("mount_threw");
  };

  // 5. The watchdog.
  function startWatchdog() {
    cancelWatchdog();
    state.watchdog = window.setTimeout(function () {
      state.watchdog = null;
      if (state.mounted || state.failed) {
        return;
      }
      showFailure("mount_timeout");
    }, INSTALLED_APP_MOUNT_TIMEOUT_MS);
  }

  function rootElement() {
    var root = document.querySelector('[data-testid="' + HOOK_ROOT + '"]');
    if (root) {
      return root;
    }
    // Defensive: the served document always injects the root, but an app whose
    // markup replaced the body would otherwise mount into nothing.
    root = element("div", null);
    root.setAttribute("data-testid", HOOK_ROOT);
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", state.config.displayName);
    root.setAttribute("tabindex", "-1");
    document.body.appendChild(root);
    return root;
  }

  function finishMount() {
    state.mounted = true;
    cancelWatchdog();

    // Capture focus BEFORE removing the panel: removing the focused node moves
    // focus to `body`, which would make the hand-off test indistinguishable.
    var focusBefore = document.activeElement;
    var loadingPanel = panels.loading;
    removeLoading();

    var root = rootElement();
    var focusWasOnPanel =
      !focusBefore ||
      focusBefore === document.body ||
      focusBefore === loadingPanel ||
      (loadingPanel && typeof loadingPanel.contains === "function" && loadingPanel.contains(focusBefore));

    if (focusWasOnPanel) {
      try {
        root.focus();
      } catch (error) {
        // A non-focusable app root is not a load failure.
      }
    }
  }

  // 6. Import -> mount.
  //
  // The module is loaded with `import()` directly, NOT fetched first. The child
  // policy's `connect-src` deliberately allows only the IPC transport, so a
  // `fetch()` of the module would be blocked by our OWN policy — the load path
  // must not depend on a directive we chose to keep narrow. `script-src 'self'`
  // is what authorises the import, from the same origin the document came from.
  //
  // Verify-at-serve is the HOST's job and it happens on both sides of this
  // call: the document was served only after its bytes matched the install
  // record, and the module request is re-verified by the handler the same way.
  // A changed module therefore fails the import, which is `load_failed`.
  function beginMount() {
    var root = rootElement();
    showLoading();
    startWatchdog();

    var moduleUrl = state.config.module;
    if (!moduleUrl) {
      showFailure("load_failed");
      return;
    }

    import(moduleUrl)
      .then(function (module) {
        var mountFn = module && (module.mount || (module.default && module.default.mount));
        if (typeof mountFn !== "function") {
          throw new Error("the installed application does not export mount(ctx)");
        }
        var context = {
          appId: state.config.appId,
          version: state.config.version,
          theme: state.config.theme,
          root: root
        };
        return Promise.resolve(mountFn(context));
      })
      .then(function () {
        finishMount();
      })
      .catch(function (error) {
        if (state.mounted) {
          return;
        }
        // A module the browser could not load (absent, refused, or a parse
        // failure inside it) rejects with a load error; anything the app raised
        // itself — during evaluation after parsing, or from `mount` — is a
        // start failure. The DOMException/TypeError split is the observable
        // difference: a module-fetch failure surfaces as an instanceof Error
        // whose message names the URL and "Failed to fetch dynamically
        // imported module", which is why this test is on the message shape
        // rather than on a class the platform owns.
        var message = error && typeof error.message === "string" ? error.message : "";
        var reason = /dynamically imported module|Importing a module script failed|NetworkError|Failed to fetch/i.test(
          message
        )
          ? "load_failed"
          : "mount_threw";
        showFailure(reason);
      });
  }

  function start() {
    if (window.__FREDO_BOOTSTRAP_STARTED__) {
      return;
    }
    window.__FREDO_BOOTSTRAP_STARTED__ = true;

    readConfig();

    // The theme is already inlined as CSS custom properties by the scheme
    // handler, so the first paint is correctly themed even if this script were
    // slow. Applying it again here makes the runtime APIs agree with the CSS.
    applyTheme(state.config.theme);

    // 3 (continued). The context minus `root`, exactly as the app-author contract
    // describes it. No IPC is required to be correctly themed.
    window.__FREDO_INSTALLED__ = {
      appId: state.config.appId,
      version: state.config.version,
      theme: state.config.theme,
      // The single call route — present on the ONE assignment, so the global is
      // never observable in a partially-built state.
      invoke: invokeAction
    };

    if (state.config.startupFailure) {
      // The host refused this load before any application document existed.
      // Render the failure panel alone — no loading state, no watchdog, no
      // import: nothing of the application runs.
      showFailure(state.config.startupFailure);
      return;
    }

    beginMount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
