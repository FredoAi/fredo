#!/usr/bin/env node
/**
 * build-behaviour-fixtures.mjs -- runtime-behaviour fixtures for Spec #3147 (ST-7).
 *
 * Generates the installable-application packages the QA suite drives for the
 * negative and timing claims:
 *
 *   qa3147-probe           -- attempts two real shipped commands and exposes the
 *                             caught outcome on [data-probe-result] /
 *                             [data-probe-error] (AC-2 / R-2.2 / F-2.2)
 *   qa3147-lazy-trace      -- mount stamps data-mounted-at + a per-document
 *                             mount id on ctx.root (R-5.1 / F-5.1 / F-5.3 / F-5.4)
 *   qa3147-crash-on-load   -- synchronous throw from mount (R-4.1 / F-4.1)
 *   qa3147-crash-on-import -- OPTIONAL variant: throw during module evaluation
 *   qa3147-hang-on-load    -- mount returns a promise that never settles, so the
 *                             host's 10 s watchdog renders the failure panel
 *                             (R-4.2 / F-4.2 / R-5.2)
 *   qa3147-fail-once       -- throws on the FIRST document load, mounts on the
 *                             reload (R-4.3 / F-4.3). Lever: a sessionStorage
 *                             counter, which survives location.reload() because
 *                             a reload reuses the browsing context.
 *
 * DETERMINISM CONTRACT
 *   - Node built-ins only (node:fs, node:path, node:crypto, node:url). No
 *     network, no npm package, no toolchain, no shell-out.
 *   - Zip entries are written in a fixed order with a fixed DOS timestamp
 *     (1980-01-01 00:00:00 -> dosTime 0x0000, dosDate 0x0021) and method 0
 *     (stored), so two runs produce byte-identical archives. The script prints
 *     each archive's sha256; run it twice and compare.
 *   - Nothing is generated from the clock or from randomness at build time. The
 *     per-RUN values a fixture needs (mount stamps, probe uuids) are produced in
 *     the child document at MOUNT time, never here.
 *
 * SCOPE: this script never touches product code. It writes only under the
 * output directory (default .opencode/tmp/3147/fixtures/behaviour, gitignored)
 * and, with --write-expected, the committed expected-output manifest that sits
 * beside it.
 *
 * Usage:
 *   node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs
 *   node ... --out <dir>            override the output directory
 *   node ... --verify               exit 1 unless the committed expected
 *                                   manifest matches the bytes just produced
 *   node ... --write-expected       (re)write behaviour-fixtures.expected.json
 *   node ... --help
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const EXPECTED_PATH = path.join(HERE, 'behaviour-fixtures.expected.json');
const DEFAULT_OUT = path.join(REPO_ROOT, '.opencode', 'tmp', '3147', 'fixtures', 'behaviour');

/* ==========================================================================
 * Manifest schema -- fixed by the plan. Consumed here, never invented.
 * ========================================================================== */

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Validate a manifest against the plan's schema rules; returns error strings. */
function validateManifest(m) {
  const errors = [];
  if (m.manifestVersion !== 1) errors.push('manifestVersion must be the number 1');
  if (typeof m.id !== 'string' || m.id.length > 96 || !ID_RE.test(m.id)) {
    errors.push('id must match ' + ID_RE + ' and be at most 96 chars');
  }
  if (typeof m.displayName !== 'string' || m.displayName.length < 1 || m.displayName.length > 64) {
    errors.push('displayName must be a string of 1..64 chars');
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    errors.push('version must be SemVer 2.0.0 with no "v" prefix');
  }
  if (!m.engines || typeof m.engines.fredo !== 'string' || m.engines.fredo.length === 0) {
    errors.push('engines.fredo must be a non-empty semver RANGE string');
  }
  if (!m.entry || typeof m.entry.document !== 'string' || typeof m.entry.module !== 'string') {
    errors.push('entry.document and entry.module must be strings');
  } else {
    const unsafe = (p) =>
      p.length === 0 || p.includes('..') || p.startsWith('/') || p.includes('\\');
    if (unsafe(m.entry.document) || !m.entry.document.endsWith('.html')) {
      errors.push('entry.document must be a relative POSIX .html path without ".."');
    }
    if (unsafe(m.entry.module) || !m.entry.module.endsWith('.js')) {
      errors.push('entry.module must be a relative POSIX .js path without ".."');
    }
  }
  if (m.description !== undefined) {
    if (typeof m.description !== 'string' || m.description.length > 280) {
      errors.push('description must be a string of at most 280 chars when present');
    }
  }
  return errors;
}

/* ==========================================================================
 * The document. The host scheme handler owns the real shell (bootstrap,
 * theme <style>, window.__FREDO_INSTALLED__, [data-testid="installed-app-root"],
 * the import of entry.module and the mount(ctx) call). This file carries NO
 * script at all, so a fixture can never double-mount.
 * ========================================================================== */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function documentHtml(displayName, fixtureId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(displayName)} - Fredo QA fixture</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    /* Every colour here is a host-written CSS custom property (the installed-app
       theme contract). No hex/rgb/hsl literal appears in this document. */
    html, body { margin: 0; padding: 0; }
    body { background: var(--body-bg); color: var(--text-primary);
           font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    section { margin: 16px; padding: 16px; border-radius: 8px;
              background: var(--card-bg); border: 1px solid var(--accent-primary); }
    h1 { font-size: 16px; margin: 0 0 8px; }
    p { font-size: 13px; line-height: 1.5; margin: 0 0 8px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
    dt { font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
  </style>
</head>
<body data-fixture-document="${escapeHtml(fixtureId)}">
  <!-- The Fredo host scheme handler owns this shell: it injects its bootstrap and
       theme style, sets window.__FREDO_INSTALLED__ = { appId, version, theme },
       writes the theme tokens as CSS custom properties on documentElement,
       creates [data-testid="installed-app-root"], then imports entry.module and
       calls its exported mount(ctx). This file deliberately ships no script. -->
  <noscript>This fixture needs JavaScript.</noscript>
</body>
</html>
`;
}

/* ==========================================================================
 * Shared child-side prelude, inlined into every module that needs it. Each
 * module is standalone: the host imports exactly ONE file (entry.module).
 * ========================================================================== */

const MODULE_PRELUDE = `// Generated by .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs
// (Spec #3147, ST-7). Plain ESM: the host bootstrap imports this file and calls
// the exported mount(ctx). No Tauri API is bundled and no global is assumed
// beyond what the host document itself provides.

function makeId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* fall through */
  }
  return String(Date.now().toString(36)) + "-" + Math.random().toString(36).slice(2, 10);
}

function mountRoot(ctx, fixture) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError(fixture + ": ctx.root is missing from InstalledAppContext");
  }
  root.setAttribute("data-fixture", fixture);
  return root;
}
`;

/* ==========================================================================
 * 1) PROBE APP -- AC-2 / R-2.2 / F-2.2.
 *
 * The invoke path is a CLAIM TO CONFIRM (G-407), never an assumption: the child
 * bundles no Tauri API and withGlobalTauri is false, so the module probes for a
 * directly-callable handle first, falls back to the raw wire request, and
 * RECORDS which mechanism it used. The caught error's name + text is written
 * verbatim so the tester can tell an ACL/authority refusal (the desired AC-2
 * proof) from a transport/CSP failure (a probe defect).
 * ========================================================================== */

const PROBE_MODULE = MODULE_PRELUDE + `
var PROBE_TIMEOUT_MS = 5000;

/*
 * Resolve the invoke mechanism this document actually exposes.
 * Ladder -- first hit wins, and the winner is recorded verbatim:
 *   1. window.__TAURI_INTERNALS__.invoke  (the handle the shipped frontend uses)
 *   2. window.__TAURI__.core.invoke       (only when withGlobalTauri is true)
 *   3. a raw wire POST to http://ipc.localhost/<cmd>
 */
function resolveInvoke() {
  var view = typeof window !== "undefined" ? window : null;
  if (view && view.__TAURI_INTERNALS__ && typeof view.__TAURI_INTERNALS__.invoke === "function") {
    return {
      id: "window.__TAURI_INTERNALS__.invoke",
      kind: "handle",
      invoke: function (cmd, args) {
        return view.__TAURI_INTERNALS__.invoke(cmd, args || {});
      }
    };
  }
  if (
    view &&
    view.__TAURI__ &&
    view.__TAURI__.core &&
    typeof view.__TAURI__.core.invoke === "function"
  ) {
    return {
      id: "window.__TAURI__.core.invoke",
      kind: "global-handle",
      invoke: function (cmd, args) {
        return view.__TAURI__.core.invoke(cmd, args || {});
      }
    };
  }
  if (typeof fetch === "function") {
    return { id: "wire POST http://ipc.localhost/<cmd>", kind: "wire", invoke: wireInvoke };
  }
  return null;
}

/*
 * Raw IPC wire attempt. Tauri v2 answers the \`ipc\` custom protocol; on Windows
 * the host form is http://ipc.localhost/. This reproduces the request shape the
 * Tauri init script normally issues. A malformed request surfaces as a
 * transport error in [data-probe-error] -- which is exactly the distinction the
 * tester needs, so the outcome is reported rather than swallowed.
 */
async function wireInvoke(cmd, args) {
  var url = "http://ipc.localhost/" + encodeURIComponent(cmd);
  var res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ cmd: cmd, callback: 0, error: 0, payload: args || {} })
  });
  var text = await res.text();
  if (!res.ok) {
    throw new Error(
      "wire HTTP " + res.status + " " + res.statusText + ": " + String(text).slice(0, 300)
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

function describeError(err) {
  if (!err) return { name: "Unknown", text: "no error object" };
  var name =
    typeof err.name === "string" && err.name
      ? err.name
      : (err.constructor && err.constructor.name) || "Error";
  var text = typeof err.message === "string" && err.message ? err.message : String(err);
  return { name: name, text: text };
}

function describeValue(value) {
  try {
    var json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > 300 ? json.slice(0, 300) + "..." : json;
  } catch (e) {
    return String(value);
  }
}

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      var err = new Error("probe timeout after " + ms + "ms waiting for " + label);
      err.name = "ProbeTimeoutError";
      reject(err);
    }, ms);
    promise.then(
      function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function attempt(mechanism, call) {
  try {
    var value = await withTimeout(
      Promise.resolve().then(function () {
        return mechanism.invoke(call.cmd, call.args);
      }),
      PROBE_TIMEOUT_MS,
      call.cmd
    );
    return { cmd: call.cmd, ok: true, value: describeValue(value) };
  } catch (err) {
    var described = describeError(err);
    return { cmd: call.cmd, ok: false, name: described.name, text: described.text };
  }
}

export function mount(ctx) {
  var root = mountRoot(ctx, "probe");
  var doc = root.ownerDocument || document;

  var uuid = makeId();
  var childKey = "qa3147-probe-child-" + uuid;
  var hostKey = "qa3147-probe-host-" + uuid;

  /* The identity data also lives on ctx.root, so the tester can read the child
     key even if the invoke leg never settles. */
  root.setAttribute("data-probe-child-key", childKey);
  root.setAttribute("data-probe-host-key", hostKey);
  root.setAttribute("data-probe-state", "pending");

  var panel = doc.createElement("section");
  panel.setAttribute("data-probe-panel", "");
  panel.innerHTML =
    "<h1>AC-2 probe</h1>" +
    "<p>This fixture attempts two real Fredo commands from inside the installed document " +
    "and writes the caught outcome below. That text is the AC-2 discrimination evidence, " +
    "never an assumed result.</p>" +
    "<dl>" +
    "<dt>mechanism</dt><dd data-probe-mechanism>(resolving)</dd>" +
    "<dt>result</dt><dd data-probe-result>(pending)</dd>" +
    "<dt>caught error</dt><dd data-probe-error>(none caught yet)</dd>" +
    "<dt>child key</dt><dd><code data-probe-child-key-mirror></code></dd>" +
    "<dt>suggested host control key</dt><dd><code data-probe-host-key-mirror></code></dd>" +
    "</dl>" +
    "<pre data-probe-log></pre>";
  root.appendChild(panel);

  var mechanismEl = panel.querySelector("[data-probe-mechanism]");
  var resultEl = panel.querySelector("[data-probe-result]");
  var errorEl = panel.querySelector("[data-probe-error]");
  var logEl = panel.querySelector("[data-probe-log]");
  panel.querySelector("[data-probe-child-key-mirror]").textContent = childKey;
  panel.querySelector("[data-probe-host-key-mirror]").textContent = hostKey;

  function log(line) {
    logEl.textContent = logEl.textContent ? logEl.textContent + "\\n" + line : line;
  }

  function settle(resultText, errorText, outcome) {
    resultEl.textContent = resultText;
    errorEl.textContent = errorText;
    root.setAttribute("data-probe-outcome", outcome);
    root.setAttribute("data-probe-state", "settled");
    log("outcome: " + outcome);
  }

  /* Deliberately floating: mount returns synchronously, so a probe waiting on a
     hanging transport can never be mistaken for a mount-timeout failure. Poll
     [data-probe-state] / [data-probe-result]. */
  void (async function run() {
    var mechanism = resolveInvoke();
    if (!mechanism) {
      mechanismEl.textContent = "none reachable";
      settle(
        "no-invoke-mechanism",
        "No invoke handle (__TAURI_INTERNALS__.invoke / __TAURI__.core.invoke) and no " +
          "fetch transport is reachable from this installed document.",
        "no-invoke-mechanism"
      );
      log("no invoke mechanism reachable from the child");
      return;
    }

    root.setAttribute("data-probe-mechanism", mechanism.id);
    mechanismEl.textContent = mechanism.id + " (" + mechanism.kind + ")";
    log("mechanism: " + mechanism.id);

    var calls = [
      { cmd: "save_control_setting", args: { key: childKey, value: "probe-sentinel" } },
      { cmd: "installed_apps_list", args: {} }
    ];

    var summary = [];
    var details = [];
    var rejected = 0;
    var resolved = 0;

    for (var i = 0; i < calls.length; i++) {
      var outcome = await attempt(mechanism, calls[i]);
      if (outcome.ok) {
        resolved++;
        summary.push(outcome.cmd + "=resolved: " + outcome.value);
        details.push(outcome.cmd + " -> resolved: " + outcome.value);
        log(outcome.cmd + " resolved: " + outcome.value);
      } else {
        rejected++;
        summary.push(outcome.cmd + "=rejected (" + outcome.name + ")");
        details.push(outcome.cmd + " -> " + outcome.name + ": " + outcome.text);
        log(outcome.cmd + " rejected: " + outcome.name + ": " + outcome.text);
      }
    }

    var overall;
    if (rejected === calls.length) overall = "all-rejected";
    else if (resolved === calls.length) overall = "all-resolved";
    else overall = "mixed";

    /* The mechanism is part of the result text as well as its own attribute, so a
       tester who reads only [data-probe-result] still sees which path ran. */
    settle(
      "mechanism=" + mechanism.id + " | " + summary.join("; "),
      details.join("\\n"),
      overall
    );
  })();
}
`;

/* ==========================================================================
 * 2) LAZY-TRACE APP -- R-5.1 / R-5.3 / R-5.4 / F-5.1 / F-5.3 / F-5.4.
 *    data-mounted-at can only exist AFTER a first open; that is the positive
 *    half of the laziness discriminator. A re-open must produce a NEW stamp.
 * ========================================================================== */

const LAZY_TRACE_MODULE = MODULE_PRELUDE + `
export function mount(ctx) {
  var root = mountRoot(ctx, "lazy-trace");
  var doc = root.ownerDocument || document;

  var now = new Date();
  var mountId = makeId();

  /* Three forms so a re-open is unambiguously a NEW document: an ISO stamp, an
     epoch-ms number and a random id. The suite reads data-mounted-at. */
  root.setAttribute("data-mounted-at", now.toISOString());
  root.setAttribute("data-mount-ms", String(now.getTime()));
  root.setAttribute("data-mount-id", mountId);

  var panel = doc.createElement("section");
  panel.setAttribute("data-lazy-trace-panel", "");
  panel.innerHTML =
    "<h1>Lazy-trace app</h1>" +
    "<p>This document mounted at <code data-mounted-at-mirror></code> " +
    "(epoch ms <code data-mount-ms-mirror></code>).</p>" +
    "<p>Mount id: <code data-mount-id-mirror></code> -- it MUST change on every re-open, " +
    "because each open is a fresh document.</p>" +
    "<p data-installed-context></p>" +
    "<p data-theme-readout></p>";
  root.appendChild(panel);

  panel.querySelector("[data-mounted-at-mirror]").textContent = now.toISOString();
  panel.querySelector("[data-mount-ms-mirror]").textContent = String(now.getTime());
  panel.querySelector("[data-mount-id-mirror]").textContent = mountId;

  var bits = [];
  bits.push("ctx.appId=" + String((ctx && ctx.appId) || ""));
  bits.push("ctx.version=" + String((ctx && ctx.version) || ""));
  if (ctx && ctx.theme) bits.push("ctx.theme.colorScheme=" + String(ctx.theme.colorScheme));

  var injected = typeof window !== "undefined" ? window.__FREDO_INSTALLED__ : null;
  if (injected) {
    bits.push("window.__FREDO_INSTALLED__.appId=" + String(injected.appId));
    bits.push("window.__FREDO_INSTALLED__.version=" + String(injected.version));
    if (injected.theme) {
      bits.push("window.__FREDO_INSTALLED__.theme.colorScheme=" + String(injected.theme.colorScheme));
    }
  } else {
    bits.push("window.__FREDO_INSTALLED__=absent");
  }
  panel.querySelector("[data-installed-context]").textContent = bits.join("; ");

  /* Theme corroboration: read the host-written custom properties exactly as the
     child sees them (the same read F-1.4 / F-1.5 / F-1.6 performs). */
  try {
    var docEl = doc.documentElement;
    var view = doc.defaultView || window;
    var cs = view.getComputedStyle(docEl);
    var names = ["--body-bg", "--card-bg", "--text-primary", "--accent-primary"];
    var reads = names.map(function (name) {
      return name + "=" + String(cs.getPropertyValue(name) || "").trim();
    });
    panel.querySelector("[data-theme-readout]").textContent = "theme: " + reads.join(" | ");
  } catch (e) {
    panel.querySelector("[data-theme-readout]").textContent =
      "theme read failed: " + String(e && e.message ? e.message : e);
  }
}
`;

/* ==========================================================================
 * 3) CRASH-ON-LOAD APP -- R-4.1 / F-4.1. Synchronous throw from mount, caught
 *    nowhere: containment is the HOST's obligation, so the fixture must not
 *    soften the failure.
 * ========================================================================== */

const CRASH_ON_LOAD_MODULE = MODULE_PRELUDE + `
export function mount(ctx) {
  /* Mark the root first so the failure is attributable to THIS fixture, then
     throw. Nothing below catches it. */
  mountRoot(ctx, "crash-on-load");
  throw new Error(
    "qa3147-crash-on-load: intentional synchronous throw from mount (Spec #3147 ST-7)"
  );
}
`;

/* ==========================================================================
 * 3b) OPTIONAL VARIANT -- crash-on-import. The throw happens during MODULE
 *     EVALUATION, so the host's import() rejects and no mount export exists.
 * ========================================================================== */

const CRASH_ON_IMPORT_MODULE = `// Generated by .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs
// (Spec #3147, ST-7). OPTIONAL variant of qa3147-crash-on-load: the throw happens
// during MODULE EVALUATION, so the host's import() rejects before any mount can
// exist. Nothing is exported and nothing is caught here.

throw new Error(
  "qa3147-crash-on-import: intentional module-evaluation throw (Spec #3147 ST-7)"
);
`;

/* ==========================================================================
 * 4) HANG-ON-LOAD APP -- R-4.2 / F-4.2 / R-5.2. Never settles, never spins.
 * ========================================================================== */

const HANG_ON_LOAD_MODULE = MODULE_PRELUDE + `
export function mount(ctx) {
  mountRoot(ctx, "hang-on-load");
  /* A promise that never settles and schedules NO work: zero CPU, zero timers.
     The host's own INSTALLED_APP_MOUNT_TIMEOUT_MS (10 000 ms) is the only thing
     that can end this load. Do not resolve it -- a fixture that eventually
     mounts would destroy the timing observation. */
  return new Promise(function () {
    /* never settles */
  });
}
`;

/* ==========================================================================
 * 5) FAIL-ONCE-THEN-MOUNT APP -- R-4.3 / F-4.3.
 *
 * Throws on the FIRST document load, mounts on the reload. Lever: a
 * sessionStorage counter. sessionStorage is scoped to the top-level browsing
 * context, which location.reload() REUSES -- so it survives the reload, whereas
 * in-memory module state cannot. Both facts are recorded on the DOM
 * (data-fail-once-load / data-fail-once-storage) so a broken lever is
 * diagnosable rather than silent.
 * ========================================================================== */

const FAIL_ONCE_MODULE = MODULE_PRELUDE + `
var COUNTER_KEY = "qa3147-fail-once-loads";

export function mount(ctx) {
  var root = mountRoot(ctx, "fail-once-then-mount");
  var doc = root.ownerDocument || document;

  var previous = null;
  var storage = "sessionStorage";
  try {
    previous = window.sessionStorage.getItem(COUNTER_KEY);
  } catch (e) {
    storage = "unavailable";
  }

  var parsed = previous === null || previous === "" ? 0 : Number(previous);
  if (!isFinite(parsed) || parsed < 0) parsed = 0;
  var loads = parsed + 1;

  if (storage === "sessionStorage") {
    try {
      window.sessionStorage.setItem(COUNTER_KEY, String(loads));
    } catch (e) {
      storage = "unavailable";
    }
  }

  root.setAttribute("data-fail-once-load", String(loads));
  root.setAttribute("data-fail-once-storage", storage);

  if (loads === 1) {
    /* First document load: fail on purpose. The host's "Try again" control must
       re-load THIS document in the SAME browsing context, where the counter
       above reads back as 2. */
    throw new Error(
      "qa3147-fail-once: intentional failure on document load #1 (the retry must mount)"
    );
  }

  var now = new Date();
  var mountId = makeId();
  root.setAttribute("data-mounted-at", now.toISOString());
  root.setAttribute("data-mount-id", mountId);

  var panel = doc.createElement("section");
  panel.setAttribute("data-fail-once-panel", "");
  panel.innerHTML =
    "<h1>Fail-once app</h1>" +
    "<p>This document is load <code data-fail-once-load-mirror></code> and mounted " +
    "successfully AFTER the intentional first-load throw.</p>" +
    "<p>Mounted at <code data-mounted-at-mirror></code> (mount id " +
    "<code data-mount-id-mirror></code>).</p>" +
    "<p>Counter location: <code data-fail-once-storage-mirror></code> -- sessionStorage " +
    "survives location.reload() because a reload reuses the browsing context.</p>";
  root.appendChild(panel);

  panel.querySelector("[data-fail-once-load-mirror]").textContent = String(loads);
  panel.querySelector("[data-fail-once-storage-mirror]").textContent = storage;
  panel.querySelector("[data-mounted-at-mirror]").textContent = now.toISOString();
  panel.querySelector("[data-mount-id-mirror]").textContent = mountId;
}
`;

/* ==========================================================================
 * The fixture catalog -- the single source of truth for the packages AND for
 * the committed expected-output manifest.
 * ========================================================================== */

const FIXTURES = [
  {
    id: 'qa3147-probe',
    displayName: 'QA3147 Probe',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-7 AC-2 probe: attempts two real shipped commands and exposes the caught outcome on the DOM.',
    optional: false,
    module: PROBE_MODULE,
    asserts: [
      'AC-2 / R-2.2 / F-2.2: save_control_setting (key qa3147-probe-child-<uuid>) and',
      'installed_apps_list BOTH reject. [data-probe-error] carries the caught error name +',
      'text verbatim, so an ACL/authority "not allowed" refusal is distinguishable from a',
      'transport/CSP failure. [data-probe-mechanism] records which invoke path was used.',
      'The host must confirm NO side effect exists for the child key (get_control_setting',
      'returns null) while the same-round host control key reads back -- that pair proves the',
      'child null is refusal, not a broken probe.',
      'If no invoke mechanism is reachable at all the fixture records "no-invoke-mechanism" on',
      '[data-probe-result]: report that to the Orchestrator -- it is a stronger structural',
      'isolation fact, but it is NOT a substitute for a refusal observation.',
    ],
    dom: [
      '[data-probe-result] -- mechanism used + resolved/rejected per command',
      '[data-probe-error] -- caught error name + text, verbatim',
      '[data-probe-mechanism] -- the invoke mechanism resolved',
      '[data-probe-outcome] -- all-rejected | all-resolved | mixed | no-invoke-mechanism',
      '[data-probe-state] -- pending | settled',
      '[data-probe-child-key] -- the key passed to save_control_setting',
      '[data-probe-host-key] -- a suggested control key for the host non-vacuity leg',
      '[data-probe-log] -- append-only trace',
    ],
  },
  {
    id: 'qa3147-lazy-trace',
    displayName: 'QA3147 Lazy Trace',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-7 laziness discriminator: mount stamps data-mounted-at plus a per-document mount id on ctx.root.',
    optional: false,
    module: LAZY_TRACE_MODULE,
    asserts: [
      'R-5.1 / F-5.1: no [data-mounted-at] exists anywhere before a first open (there is no',
      'child document to carry it); after the first open the stamp is a non-empty ISO',
      'timestamp. R-5.3 / F-5.3: closing the window destroys the context, so the stamp can',
      'no longer be read. R-5.4 / F-5.4: a re-open yields NEW data-mounted-at / data-mount-ms /',
      'data-mount-id values (a fresh document, never a reused one). R-1.5 / F-1.8: a theme',
      'change pushed while the app is open MUST leave data-mounted-at unchanged.',
    ],
    dom: [
      '[data-mounted-at] -- ISO stamp written on ctx.root (the discriminator)',
      '[data-mount-ms] -- epoch-ms form of the same stamp',
      '[data-mount-id] -- random per-document id (changes on every open)',
      '[data-installed-context] -- ctx + window.__FREDO_INSTALLED__ readout',
      '[data-theme-readout] -- getComputedStyle reads of the four theme custom properties',
    ],
  },
  {
    id: 'qa3147-crash-on-load',
    displayName: 'QA3147 Crash On Load',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description: 'ST-7 containment fixture: throws synchronously from mount and never catches it.',
    optional: false,
    module: CRASH_ON_LOAD_MODULE,
    asserts: [
      'R-4.1 / F-4.1: the host stays alive and responsive, and its OWN',
      '[data-testid="installed-app-failure"] panel renders naming THIS app',
      '(heading "Couldn\'t open QA3147 Crash On Load") with a plain-language',
      '[data-testid="installed-app-failure-reason"]. No host error dialog, no host crash, and',
      'the other windows are untouched.',
    ],
    dom: [
      '[data-fixture="crash-on-load"] -- set on ctx.root immediately before the throw, so the',
      'failure is attributable to this fixture',
    ],
  },
  {
    id: 'qa3147-crash-on-import',
    displayName: 'QA3147 Crash On Import',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'OPTIONAL variant of crash-on-load: throws during module evaluation, so import() rejects before mount.',
    optional: true,
    module: CRASH_ON_IMPORT_MODULE,
    asserts: [
      'OPTIONAL extra containment variant for R-4.1: exercises the import-rejection leg (the',
      'module never evaluates, so no mount export exists) rather than the mount-call leg. The',
      'suite names crash-on-load as the required fixture; use this one only if the round wants',
      'both throw shapes.',
    ],
    dom: [
      '(none -- the module never evaluates, so the host failure panel is the only surface)',
    ],
  },
  {
    id: 'qa3147-hang-on-load',
    displayName: 'QA3147 Hang On Load',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-7 timing fixture: mount returns a promise that never settles (no CPU spin, no timers).',
    optional: false,
    module: HANG_ON_LOAD_MODULE,
    asserts: [
      'R-4.2 / F-4.2: the host failure panel appears with reason mount_timeout and the',
      'measured open -> panel interval lies in [9000, 20000] ms (watchdog',
      'INSTALLED_APP_MOUNT_TIMEOUT_MS = 10 000 ms). R-5.2 / F-5.2:',
      '[data-testid="installed-app-loading"] is observable for the whole window and is',
      'REPLACED by (never coexists with) the failure panel. N-3: the host stays interactive',
      'throughout the wait.',
    ],
    dom: [
      '[data-fixture="hang-on-load"] -- set on ctx.root; no other child markup by design, so',
      'the loading state is the only thing the child contributes',
    ],
  },
  {
    id: 'qa3147-fail-once',
    displayName: 'QA3147 Fail Once',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description: 'ST-7 retry fixture: throws on the first document load, mounts on the reload.',
    optional: false,
    module: FAIL_ONCE_MODULE,
    asserts: [
      'R-4.3 / F-4.3: the first open fails and the host failure panel offers "Try again"; ONE',
      'retry click lands the app\'s own interface with a data-mounted-at stamp, the host PIDs',
      'and the window label (installed-<id>) are unchanged, and the whole cycle repeats a',
      'second time (so a one-shot in-memory fluke cannot pass).',
      '[data-fail-once-load] proves which document load this is and [data-fail-once-storage]',
      'proves whether the sessionStorage lever was live.',
    ],
    dom: [
      '[data-fail-once-load] -- 1 on the failing load, 2 on the recovery load',
      '[data-fail-once-storage] -- sessionStorage | unavailable (lever liveness)',
      '[data-mounted-at] -- on the recovery load only',
      '[data-mount-id] -- random per-document id',
      '[data-fail-once-panel] -- the recovered app interface',
    ],
  },
];

/* ==========================================================================
 * Deterministic zip writer.
 *
 *   - method 0 (stored): no deflate stream, so the bytes are a pure function of
 *     the inputs and need no compressor library.
 *   - fixed DOS timestamp 1980-01-01 00:00:00 (dosTime 0x0000, dosDate 0x0021),
 *     the earliest representable DOS date -- a zip with no wall-clock time.
 *   - entries emitted in the fixed order the caller passed them, so the central
 *     directory is stable too.
 * ========================================================================== */

const DOS_TIME = 0x0000; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01 (DOS epoch: year 0, month 1, day 1)
const VERSION_NEEDED = 20; // 2.0
const FLAG_UTF8 = 0x0800; // EFS bit -- names are ASCII, but fixed for determinism

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cd.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    cd.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(0, 10); // method: stored
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(cd, name);
    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralDirectory, eocd]);
}

/**
 * Read an archive back from its own bytes and verify every entry's CRC. This is
 * the script's own "is this a valid zip" proof -- the tester never has to trust
 * the writer, and the entry list it returns is what the generator prints.
 */
function verifyZip(buf) {
  if (buf.length < 22) throw new Error('archive too short to hold an EOCD');
  const eocdOffset = buf.length - 22;
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) throw new Error('EOCD signature missing');

  const count = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('central directory out of bounds');

  const entries = [];
  let cursor = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('bad central header at offset ' + cursor);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('bad local header for ' + name);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.slice(dataStart, dataStart + compressed);

    if (method !== 0) throw new Error('unexpected compression method ' + method + ' for ' + name);
    if (data.length !== uncompressed) throw new Error('size mismatch for ' + name);
    if (crc32(data) !== crc) throw new Error('crc mismatch for ' + name);

    entries.push({ name, bytes: uncompressed, crc32: crc.toString(16).padStart(8, '0') });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Locate one entry's payload by name and return it (used by the self-check). */
function readZipEntry(buf, wantedName) {
  const eocdOffset = buf.length - 22;
  const count = buf.readUInt16LE(eocdOffset + 10);
  let cursor = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < count; i++) {
    const compressed = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    if (name === wantedName) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      return buf.slice(start, start + compressed);
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

/**
 * Full self-check of one built archive: re-parse it and confirm the manifest
 * inside round-trips to the object we meant to write, that the entry files are
 * present and non-empty, and that the fixture module actually exports `mount`.
 * This runs on every build (G-314: a gate that is never executed is not a gate).
 */
function selfCheck(item) {
  const fixture = item.fixture;
  const problems = [];

  const manifestBytes = readZipEntry(item.archive, 'fredo-app.json');
  if (!manifestBytes) {
    problems.push('fredo-app.json is not in the archive');
  } else {
    let parsed;
    try {
      parsed = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      problems.push('fredo-app.json is not valid JSON: ' + error.message);
      parsed = null;
    }
    if (parsed) {
      const expectedManifest = manifestFor(fixture);
      for (const key of Object.keys(expectedManifest)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(expectedManifest[key])) {
          problems.push('manifest field drifted inside the archive: ' + key);
        }
      }
      const schemaErrors = validateManifest(parsed);
      for (const error of schemaErrors) problems.push('archived manifest: ' + error);
    }
  }

  const documentBytes = readZipEntry(item.archive, 'index.html');
  if (!documentBytes || documentBytes.length === 0) {
    problems.push('index.html is missing or empty in the archive');
  } else if (!documentBytes.toString('utf8').includes('<!doctype html>')) {
    problems.push('index.html is not an HTML document');
  }

  const moduleBytes = readZipEntry(item.archive, 'main.js');
  if (!moduleBytes || moduleBytes.length === 0) {
    problems.push('main.js is missing or empty in the archive');
  } else {
    const moduleText = moduleBytes.toString('utf8');
    const exportsMount = /export function mount\s*\(/.test(moduleText);
    if (fixture.module === CRASH_ON_IMPORT_MODULE) {
      /* The whole point of this variant: nothing is exported, because the module
         throws while it evaluates. Assert the absence rather than the presence. */
      if (exportsMount) problems.push('crash-on-import must NOT export mount');
      if (!/^\s*throw\b/m.test(moduleText)) {
        problems.push('crash-on-import does not throw at module evaluation');
      }
    } else if (!exportsMount) {
      problems.push('main.js does not export the mount function the host calls');
    }
  }

  return problems;
}

/* ==========================================================================
 * Package assembly
 * ========================================================================== */

function manifestFor(fixture) {
  return {
    manifestVersion: 1,
    id: fixture.id,
    displayName: fixture.displayName,
    version: fixture.version,
    engines: { fredo: fixture.enginesFredo },
    entry: { document: 'index.html', module: 'main.js' },
    description: fixture.description,
  };
}

/** The archive body: fredo-app.json at the root plus exactly what `entry` names. */
function packageEntries(fixture) {
  return [
    {
      name: 'fredo-app.json',
      data: Buffer.from(JSON.stringify(manifestFor(fixture), null, 2) + '\n', 'utf8'),
    },
    {
      name: 'index.html',
      data: Buffer.from(documentHtml(fixture.displayName, fixture.id), 'utf8'),
    },
    {
      name: 'main.js',
      data: Buffer.from(fixture.module, 'utf8'),
    },
  ];
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ==========================================================================
 * CLI
 * ========================================================================== */

const HELP = `build-behaviour-fixtures.mjs -- Spec #3147 (ST-7) behaviour fixtures.

Usage:
  node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs [options]

Options:
  --out <dir>       output directory (default: .opencode/tmp/3147/fixtures/behaviour)
  --verify          exit 1 unless the committed expected manifest matches these bytes
  --write-expected  (re)write behaviour-fixtures.expected.json beside this script
  --help            this text

Output is deterministic: two runs write byte-identical archives (fixed entry order,
fixed 1980-01-01 DOS timestamp, stored entries). Compare the sha256 column across
runs. The generator also prints each archive's entry list.`;

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, verify: false, writeExpected: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--write-expected') options.writeExpected = true;
    else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a directory');
      options.out = path.resolve(process.cwd(), value);
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  return options;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Build every archive in memory. Pure -- no filesystem writes. */
function buildAll() {
  const built = [];
  for (const fixture of FIXTURES) {
    const entries = packageEntries(fixture);
    const archive = buildZip(entries);
    const listed = verifyZip(archive);
    if (listed.length !== entries.length) {
      throw new Error(
        fixture.id +
          ': archive read back ' +
          listed.length +
          ' entries, expected ' +
          entries.length
      );
    }
    const item = {
      fixture,
      fileName: fixture.id + '-' + fixture.version + '.zip',
      archive,
      bytes: archive.length,
      sha256: sha256(archive),
      entries: listed,
    };
    const problems = selfCheck(item);
    if (problems.length > 0) {
      throw new Error(item.fileName + ' failed its self-check:\n  - ' + problems.join('\n  - '));
    }
    built.push(item);
  }
  return built;
}

/** The committed expected-output manifest (ids, displayNames, hashes, entries). */
function expectedManifest(built) {
  return {
    description:
      'Committed expected-output manifest for the Spec #3147 ST-7 behaviour fixtures. ' +
      'Read ids / displayNames / hashes from HERE, never from an assumption: regenerate with ' +
      'node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs ' +
      'and confirm with --verify.',
    generator: '.opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs',
    schemaVersion: 1,
    zipPolicy: {
      method: 'stored (0)',
      dosTimestamp: '1980-01-01T00:00:00 (dosTime 0x0000, dosDate 0x0021)',
      entryOrder: 'fredo-app.json, index.html, main.js',
    },
    fixtures: built.map((item) => ({
      id: item.fixture.id,
      displayName: item.fixture.displayName,
      version: item.fixture.version,
      enginesFredo: item.fixture.enginesFredo,
      optional: item.fixture.optional,
      file: item.fileName,
      bytes: item.bytes,
      sha256: item.sha256,
      entry: { document: 'index.html', module: 'main.js' },
      entries: item.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
      asserts: item.fixture.asserts,
      dom: item.fixture.dom,
    })),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  /* Validate every generated manifest against the plan's schema BEFORE writing
     anything: a typo in a fixture id or a bad entry path fails here, not inside
     the Rust installer. */
  let schemaErrors = 0;
  for (const fixture of FIXTURES) {
    const errors = validateManifest(manifestFor(fixture));
    if (errors.length > 0) {
      schemaErrors += errors.length;
      console.error('SCHEMA ERROR in ' + fixture.id + ':');
      for (const error of errors) console.error('  - ' + error);
    }
  }
  if (schemaErrors > 0) {
    console.error('');
    console.error('Refusing to build: ' + schemaErrors + ' manifest schema error(s).');
    process.exitCode = 1;
    return;
  }

  const built = buildAll();
  const expected = expectedManifest(built);

  if (options.verify) {
    let committed;
    try {
      committed = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
    } catch (error) {
      console.error('VERIFY FAILED: cannot read ' + EXPECTED_PATH + ': ' + error.message);
      process.exitCode = 1;
      return;
    }
    const committedById = new Map(committed.fixtures.map((item) => [item.id, item]));
    const problems = [];
    for (const item of expected.fixtures) {
      const known = committedById.get(item.id);
      if (!known) {
        problems.push('missing from the committed manifest: ' + item.id);
        continue;
      }
      if (known.sha256 !== item.sha256) {
        problems.push(
          'sha256 drift for ' + item.id + ': committed ' + known.sha256 + ', built ' + item.sha256
        );
      }
      if (known.displayName !== item.displayName) {
        problems.push(
          'displayName drift for ' + item.id + ': ' + known.displayName + ' -> ' + item.displayName
        );
      }
    }
    if (problems.length > 0) {
      console.error('VERIFY FAILED:');
      for (const problem of problems) console.error('  - ' + problem);
      process.exitCode = 1;
      return;
    }
    console.log('VERIFY OK: ' + expected.fixtures.length + ' fixtures match ' + EXPECTED_PATH);
    return;
  }

  if (options.writeExpected) {
    writeFileSync(EXPECTED_PATH, JSON.stringify(expected, null, 2) + '\n', 'utf8');
    console.log('WROTE ' + EXPECTED_PATH);
    console.log('');
  }

  mkdirSync(options.out, { recursive: true });
  for (const item of built) {
    writeFileSync(path.join(options.out, item.fileName), item.archive);
  }

  /* A human-readable summary next to the archives, so the output directory is
     self-describing even if the console scrolls away. */
  const summaryLines = [
    'Spec #3147 (ST-7) behaviour fixtures',
    'generated by .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs',
    '',
    'output directory: ' + options.out,
    '',
    pad('id', 24) + pad('zip', 28) + pad('bytes', 8) + 'sha256',
    pad('--', 24) + pad('---', 28) + pad('-----', 8) + '------',
  ];
  for (const item of built) {
    summaryLines.push(
      pad(item.fixture.id, 24) + pad(item.fileName, 28) + pad(item.bytes, 8) + item.sha256
    );
  }
  writeFileSync(
    path.join(options.out, 'BEHAVIOUR-FIXTURES.txt'),
    summaryLines.join('\n') + '\n',
    'utf8'
  );

  const required = built.filter((item) => !item.fixture.optional).length;
  const optional = built.filter((item) => item.fixture.optional).length;

  console.log('BEHAVIOUR FIXTURES (Spec #3147 ST-7)');
  console.log('output directory: ' + options.out);
  console.log('');
  console.log(pad('id', 24) + pad('zip', 28) + pad('bytes', 8) + 'sha256');
  console.log(pad('--', 24) + pad('---', 28) + pad('-----', 8) + '------');
  for (const item of built) {
    console.log(
      pad(item.fixture.id, 24) + pad(item.fileName, 28) + pad(item.bytes, 8) + item.sha256
    );
  }
  console.log('');
  for (const item of built) {
    console.log(item.fileName + ' entries (' + item.entries.length + '):');
    for (const entry of item.entries) {
      console.log('  ' + entry.name + '  ' + entry.bytes + ' bytes  crc32=' + entry.crc32);
    }
  }
  console.log('');
  console.log(
    'built ' +
      built.length +
      ' archives (' +
      required +
      ' required, ' +
      optional +
      ' optional)'
  );
}

try {
  main();
} catch (error) {
  console.error('BUILD FAILED: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
}
