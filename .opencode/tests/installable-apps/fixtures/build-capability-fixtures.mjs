#!/usr/bin/env node
/**
 * build-capability-fixtures.mjs -- capability-declaration fixtures for Spec #3146
 * ("an installed application reaches only the backend surface it declared").
 *
 * WHY A SIBLING GENERATOR (not an extension of build-behaviour-fixtures.mjs)
 * -------------------------------------------------------------------------
 * build-behaviour-fixtures.mjs ships a COMMITTED expected-output manifest
 * (behaviour-fixtures.expected.json) holding each archive's sha256, and its
 * `--verify` mode fails when a built fixture is absent from that manifest. Adding
 * fixtures there would redden that committed gate until someone re-ran the
 * generator with --write-expected. The QA Expert who authors these fixtures holds
 * NO shell (G-460), so it cannot compute the new hashes and will not ship a
 * manifest whose hashes it cannot derive. This generator therefore owns its own
 * fixtures and commits no hash manifest: it SELF-CHECKS every archive it writes
 * (re-parse, CRC, manifest round-trip, capability-block round-trip) and exits
 * non-zero on any problem, and the determinism claim is proven by running it
 * twice and comparing the printed sha256 column (the suite row does exactly
 * that). Nothing here is a stub: every archive is re-read from its own bytes.
 *
 * WHAT IT EMITS
 * -------------
 *   qa3146-app-a            declares data.tables{notes, shared_log}   (AC1 happy path)
 *   qa3146-app-b            declares data.tables{records}             (AC3 "another app")
 *   mission                 declares data.tables{monitor_sessions}    (AC3 THE named
 *                           collision: composes to feature_mission_monitor_sessions,
 *                           the same physical table as built-in mission-monitor + sessions)
 *   orbit                   declares data.tables{lab_notes, orbit_own} (AC3 second,
 *                           constructed collision: orbit + lab_notes vs orbit-lab + notes)
 *   orbit-lab               declares data.tables{notes}               (the other side)
 *   qa3146-consent-a        highRisk{database-query, database-reset}  (AC4 A)
 *   qa3146-consent-b        highRisk{database-query}                  (AC4 B; same
 *                           capability as A, so "grant to A never enables B" is real)
 *   qa3146-no-capabilities  NO `capabilities` key at all              (fail-safe default)
 *   qa3146-source-projection declares a table carrying `source`       (install refusal:
 *                           manifest_invalid_field at
 *                           capabilities.data.tables[0].source -- the SECOND door)
 *   qa3146-unknown-capability highRisk{high-risk.root-shell}          (install refusal:
 *                           unknown capability id)
 *
 * The three refusal fixtures are DELIBERATELY invalid manifests: they exist to be
 * refused. They carry `expectedInstallRefusal` so the suite (and this script's own
 * self-check) assert the exact code + field path instead of "some error".
 *
 * DETERMINISM CONTRACT (same as the sibling generator)
 *   - Node built-ins only. No network, no npm package, no shell-out.
 *   - Stored (method 0) zip entries in a fixed order with a fixed 1980-01-01 DOS
 *     timestamp, so two runs write byte-identical archives.
 *   - Nothing derives from the clock or from randomness.
 *
 * SCOPE: never touches product code. Writes only under the output directory
 * (default .opencode/tmp/3146/fixtures/capabilities, gitignored).
 *
 * Usage:
 *   node .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs
 *   node ... --out <dir>     override the output directory
 *   node ... --quiet         print only the summary table
 *   node ... --help
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.opencode', 'tmp', '3146', 'fixtures', 'capabilities');

/* ==========================================================================
 * Manifest rules -- the ones the plan fixes for the `capabilities` key.
 * ========================================================================== */

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The closed capability-id vocabulary (Spec #3146 `CAPABILITY_IDS`). */
const CAPABILITY_IDS = [
  'data.tables',
  'high-risk.database-query',
  'high-risk.database-reset',
  'high-risk.process-spawn',
];

/** Keys allowed inside `capabilities`. */
const CAPABILITY_KEYS = ['version', 'data', 'highRisk'];
/** Keys allowed inside `capabilities.data`. */
const CAPABILITY_DATA_KEYS = ['tables'];

/** A declared table, as the plan's API contract spells it. */
function table(name, columns, primaryKey) {
  return { name, primaryKey: primaryKey || ['id'], columns };
}

function col(name, type, owner, nullable) {
  return { name, type, nullable: Boolean(nullable), owner: owner || 'application' };
}

/* ==========================================================================
 * Catalog -- single source of truth for packages AND the printed summary.
 * ========================================================================== */

const FIXTURES = [
  {
    id: 'qa3146-app-a',
    displayName: 'QA3146 App A',
    version: '1.0.0',
    description: 'AC1 happy path: declares data.tables{notes, shared_log} and drives them.',
    capabilities: {
      version: 1,
      data: {
        tables: [
          table('notes', [col('id', 'TEXT', 'application'), col('body', 'TEXT', 'application', true)]),
          table('shared_log', [col('id', 'TEXT', 'application'), col('note', 'TEXT', 'application', true)]),
        ],
      },
    },
    openable: true,
    declares: ['data.tables'],
    asserts: [
      'AC1 / R-1.1,R-1.2,R-1.3: application_data_read / _write / _delete / _declare on',
      'its OWN declared tables succeed through window.__FREDO_INSTALLED__.invoke, with the',
      'caller identity derived from the installed-qa3146-app-a window label (never from the',
      'payload). Its own reads back what it wrote, so "everything refused" cannot pass.',
    ],
    dom: [
      '[data-qa3146-panel] -- probe panel',
      '[data-call-log] -- JSON array of { action, ok, value | refusal } per call (the record)',
      '[data-qa3146-summary] -- calls=<n> rejected=<n>',
      '[data-refusal-code] / [data-refusal-json] -- the LAST refusal, verbatim',
      '[data-last-outcome] -- ready | running | done',
      '[data-qa3146-ready] -- set on ctx.root after the API is installed',
      '[data-mounted-at] / [data-mount-id] -- per-document stamps (prove no reload happened',
      '  across a grant/revoke: the SAME values must survive the consent change)',
      'window.__QA3146.run(calls) -- drives actions through window.__FREDO_INSTALLED__.invoke',
      'window.__QA3146.runRaw(calls) -- drives RAW command names through',
      '  window.__TAURI_INTERNALS__.invoke (the ACL row only; never a capability row)',
    ],
  },
  {
    id: 'qa3146-app-b',
    displayName: 'QA3146 App B',
    version: '1.0.0',
    description: 'AC3 counterpart: declares data.tables{records}; A must never reach it.',
    capabilities: {
      version: 1,
      data: { tables: [table('records', [col('id', 'TEXT', 'application'), col('value', 'TEXT', 'application', true)])] },
    },
    openable: true,
    declares: ['data.tables'],
    asserts: [
      'AC3 / R-3.1,R-3.4: B names its own id and reaches its own table in the SAME round in',
      'which A is refused; after A attempts B, B reads back the ORIGINAL value (nothing of',
      "B's changed). Run in both install orders (A first, then B first).",
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'mission',
    displayName: 'QA3146 Mission Probe',
    version: '1.0.0',
    description:
      'AC3 THE decisive collision: id `mission` + table `monitor_sessions` composes to the built-in `mission-monitor` namespace.',
    capabilities: {
      version: 1,
      data: {
        tables: [table('monitor_sessions', [col('id', 'TEXT', 'application'), col('label', 'TEXT', 'application', true)])],
      },
    },
    openable: true,
    declares: ['data.tables'],
    asserts: [
      'AC3 / R-3.2: the canonical physical name of mission + monitor_sessions is',
      'feature_mission_monitor_sessions -- byte-identical to built-in mission-monitor +',
      'sessions. The call MUST be refused scope_denied WITHOUT the caller ever naming that',
      'application, and no rows may come back. The row also records (non-gating) whether',
      'feature_mission_monitor_sessions exists in the env database, so "the collision target',
      'is real" is a reading rather than an assumption.',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'orbit',
    displayName: 'QA3146 Orbit',
    version: '1.0.0',
    description:
      'AC3 second (constructed) collision: orbit + lab_notes composes to the same table as orbit-lab + notes.',
    capabilities: {
      version: 1,
      data: {
        tables: [
          table('lab_notes', [col('id', 'TEXT', 'application'), col('body', 'TEXT', 'application', true)]),
          table('orbit_own', [col('id', 'TEXT', 'application'), col('body', 'TEXT', 'application', true)]),
        ],
      },
    },
    openable: true,
    declares: ['data.tables'],
    asserts: [
      'AC3 / R-3.2,R-3.4: two INSTALLED applications collide (not installed-vs-built-in).',
      'orbit + lab_notes and orbit-lab + notes both compose to feature_orbit_lab_notes.',
      'EXPECT: orbit is refused scope_denied for lab_notes while orbit_own (canonical',
      'feature_orbit_orbit_own, which no other known id prefixes) is served normally IN THE',
      'SAME RUN. That pair is the discriminator: an implementation that denies everything',
      'fails the orbit_own leg, and an implementation that only checks identity-equality',
      'passes lab_notes.',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'orbit-lab',
    displayName: 'QA3146 Orbit Lab',
    version: '1.0.0',
    description: 'AC3 the other side of the constructed collision: declares data.tables{notes}.',
    capabilities: {
      version: 1,
      data: { tables: [table('notes', [col('id', 'TEXT', 'application'), col('body', 'TEXT', 'application', true)])] },
    },
    openable: true,
    declares: ['data.tables'],
    asserts: [
      'AC3 / R-3.2: orbit-lab + notes composes to feature_orbit_lab_notes, which the known id',
      '`orbit` already prefixes (feature_orbit_), so the call is refused scope_denied.',
      'RECORDED CONSEQUENCE (not a defect): an application whose id extends another known',
      "id's sanitized form is shadowed on EVERY table. Resolve to refuse is the documented",
      'fail-safe direction (the Architect: a stale id index can only produce a FALSE REFUSAL,',
      'never a false permit) -- the row records the observation, it does not fail it.',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'qa3146-consent-a',
    displayName: 'QA3146 Consent A',
    version: '1.0.0',
    description: 'AC4 A: declares two high-risk capabilities, neither consented at install.',
    capabilities: { version: 1, highRisk: ['high-risk.database-query', 'high-risk.database-reset'] },
    openable: true,
    declares: ['high-risk.database-query', 'high-risk.database-reset'],
    asserts: [
      'AC4 / R-4.1,R-4.3: declared-but-unconsented is SHOWN for this application only',
      '(installed-apps-consent-row), and invoking db_query_execute is refused consent_required',
      'before any side effect. NOTE: high-risk.database-reset is NEVER invoked by any row --',
      'pg_database_reset destroys the environment database. It is exercised only as a',
      'declared capability (projection + per-capability specificity).',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'qa3146-consent-b',
    displayName: 'QA3146 Consent B',
    version: '1.0.0',
    description:
      'AC4 B: declares the SAME high-risk query capability as A and NO reset capability, so both the cross-app and the undeclared-grant legs are real.',
    capabilities: { version: 1, highRisk: ['high-risk.database-query'] },
    openable: true,
    declares: ['high-risk.database-query'],
    asserts: [
      'AC4 / R-4.2,R-4.5: a grant to A never enables B, while B is open with the same',
      'declaration; and a grant request for high-risk.database-reset on B (which B did NOT',
      'declare) is refused and records nothing.',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'qa3146-no-capabilities',
    displayName: 'QA3146 No Capabilities',
    version: '1.0.0',
    description: 'NFR fail-safe: a package with NO `capabilities` key reaches nothing at all.',
    capabilities: null,
    openable: true,
    declares: [],
    asserts: [
      'NFR fail-safe default: absence of the key yields zero declared capabilities (never',
      '"everything except a deny list"). Every action is refused action_not_declared and the',
      'projection carries a capabilities block with three EMPTY arrays.',
    ],
    dom: ['[data-call-log] and the refusal hooks, identical to qa3146-app-a'],
  },
  {
    id: 'qa3146-source-projection',
    displayName: 'QA3146 Source Projection',
    version: '1.0.0',
    description:
      'AC3 second door: declares a table carrying a `source` projection, i.e. a read of the canonical chat/session tables. MUST be refused at install.',
    capabilities: {
      version: 1,
      data: {
        tables: [
          {
            name: 'sessions_view',
            primaryKey: ['id'],
            columns: [col('id', 'TEXT', 'backend'), col('session_id', 'TEXT', 'backend', true)],
            source: { kind: 'row', from: 'chat', select: { id: { field: 'id' }, sessionId: { field: 'sessionId' } } },
          },
        ],
      },
    },
    openable: false,
    declares: ['data.tables'],
    expectedInstallRefusal: {
      code: 'manifest_invalid_field',
      fieldPath: 'capabilities.data.tables[0].source',
    },
    asserts: [
      'AC3 / R-3.3 (install half): refused before anything is written, with code',
      'manifest_invalid_field naming capabilities.data.tables[0].source. The runtime half of',
      'the same door (ref.source === "canonical") is asserted separately by an openable',
      'fixture driving the canonical ref -- two doors, two locks.',
    ],
    dom: ['(never opened -- install is refused, no window exists)'],
  },
  {
    id: 'qa3146-unknown-capability',
    displayName: 'QA3146 Unknown Capability',
    version: '1.0.0',
    description: 'Closed-vocabulary refusal: declares a capability id that is not in CAPABILITY_IDS.',
    capabilities: { version: 1, highRisk: ['high-risk.root-shell'] },
    openable: false,
    declares: [],
    expectedInstallRefusal: {
      code: 'manifest_invalid_field',
      fieldPath: 'capabilities.highRisk[0]',
    },
    asserts: [
      'NFR additive-only contract evolution: an unknown capability id is refused LOUDLY at',
      'install with the exact field path, never ignored (an ignored id reads to the author as',
      'accepted consent). Same frozen 22-code vocabulary -- no 23rd code.',
    ],
    dom: ['(never opened -- install is refused, no window exists)'],
  },
];

/* ==========================================================================
 * The document. The host scheme handler owns the real shell; this file carries
 * no script at all, so a fixture can never double-mount.
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
  <title>${escapeHtml(displayName)} - Fredo QA fixture (Spec #3146)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    /* Host-written custom properties only -- no colour literal appears here. */
    html, body { margin: 0; padding: 0; }
    body { background: var(--body-bg); color: var(--text-primary);
           font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    section { margin: 16px; padding: 16px; border-radius: 8px;
              background: var(--card-bg); border: 1px solid var(--accent-primary); }
    h1 { font-size: 16px; margin: 0 0 8px; }
    p { font-size: 13px; line-height: 1.5; margin: 0 0 8px; }
    pre { font-family: ui-monospace, Consolas, monospace; font-size: 12px;
          white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
  </style>
</head>
<body data-fixture-document="${escapeHtml(fixtureId)}">
  <noscript>This fixture needs JavaScript.</noscript>
</body>
</html>
`;
}

/* ==========================================================================
 * The one child module. Every openable fixture shares it: the capability
 * behaviour under test lives in the HOST, so the fixture only needs a
 * programmable, DOM-readable call surface.
 * ========================================================================== */

const CAPABILITY_PROBE_MODULE = `// Generated by .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs
// (Spec #3146). Plain ESM: the host bootstrap imports this file and calls the
// exported mount(ctx).
//
// The fixture NEVER bundles a Tauri API. It calls exactly one thing --
// window.__FREDO_INSTALLED__.invoke(action, args), the host-authored child
// client -- and writes every outcome (the resolved value, or the refusal object
// verbatim) to [data-call-log] so the tester reads the result from the DOM
// instead of depending on whether this driver awaits a promise returned by
// execute_js.
//
// If the shim is absent the fixture records the refusal code "no-invoke-shim",
// which is exactly what the PRE-CHANGE tree produces: that is the redden
// control for every [NEW] row bound to this fixture.

function safeString(value) {
  try {
    var text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text;
  } catch (e) {
    return String(value);
  }
}

function mountPanel(root, doc) {
  var existing = root.querySelector("[data-qa3146-panel]");
  if (existing) return existing;
  var panel = doc.createElement("section");
  panel.setAttribute("data-qa3146-panel", "");
  panel.innerHTML =
    "<h1>Spec #3146 capability probe</h1>" +
    "<p>This fixture drives <code>window.__FREDO_INSTALLED__.invoke(action, args)</code> and " +
    "publishes every outcome below. The host -- not this document -- decides what the call reaches.</p>" +
    "<p>calls/refusals: <span data-qa3146-summary>(idle)</span></p>" +
    "<p>last outcome: <span data-last-outcome>idle</span></p>" +
    "<p>last refusal code: <span data-refusal-code></span></p>" +
    "<pre data-refusal-json>(no refusal yet)</pre>" +
    "<pre data-call-log>(no calls yet)</pre>";
  root.appendChild(panel);
  return panel;
}

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError("capability-probe: ctx.root is missing from InstalledAppContext");
  }
  root.setAttribute("data-fixture", "capability-probe");

  var doc = root.ownerDocument || document;
  var panel = mountPanel(root, doc);

  var logEl = panel.querySelector("[data-call-log]");
  var summaryEl = panel.querySelector("[data-qa3146-summary]");
  var codeEl = panel.querySelector("[data-refusal-code]");
  var refusalEl = panel.querySelector("[data-refusal-json]");
  var outcomeEl = panel.querySelector("[data-last-outcome]");

  var results = [];

  function publish() {
    logEl.textContent = JSON.stringify(results, null, 2);
    var rejected = 0;
    for (var i = 0; i < results.length; i++) {
      if (!results[i].ok) rejected++;
    }
    summaryEl.textContent = "calls=" + results.length + " rejected=" + rejected;
  }

  function showRefusal(refusal) {
    var code = "";
    if (refusal && typeof refusal === "object" && typeof refusal.code === "string") {
      code = refusal.code;
    } else if (typeof refusal === "string") {
      code = refusal;
    }
    /* The refusal must be DISPLAYABLE, so both the code and the whole object are
       rendered as text -- never colour-only, never swallowed. */
    codeEl.textContent = code || "(no code on the caught value)";
    codeEl.setAttribute("data-refusal-code", code || "none");
    refusalEl.textContent = safeString(refusal);
  }

  function clearRefusal() {
    codeEl.textContent = "";
    codeEl.setAttribute("data-refusal-code", "");
    refusalEl.textContent = "(no refusal yet)";
  }

  function invoke(action, args) {
    var api = typeof window !== "undefined" ? window.__FREDO_INSTALLED__ : null;
    if (!api || typeof api.invoke !== "function") {
      return Promise.reject({
        code: "no-invoke-shim",
        appId: null,
        action: action,
        detail: "window.__FREDO_INSTALLED__.invoke is not a function in this document"
      });
    }
    return Promise.resolve().then(function () {
      return api.invoke(action, args === undefined || args === null ? {} : args);
    });
  }

  /* The RAW handle, deliberately. One row (the least-privilege / ACL row) must
     call registered commands DIRECTLY to prove the ACL is the second lock: a row
     that only ever uses the shim cannot see it. Kept separate from run() so no
     capability row can drift onto the raw path by accident. */
  function invokeRaw(command, args) {
    var internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject({
        code: "no-raw-handle",
        appId: null,
        action: command,
        detail: "window.__TAURI_INTERNALS__.invoke is not a function in this document"
      });
    }
    return Promise.resolve().then(function () {
      return internals.invoke(command, args === undefined || args === null ? {} : args);
    });
  }

  function runOne(call, resolver) {
    var action = call && call.action;
    return resolver(action, call && call.args).then(
      function (value) {
        results.push({ action: action, ok: true, value: value });
        publish();
        return { action: action, ok: true };
      },
      function (refusal) {
        results.push({ action: action, ok: false, refusal: refusal });
        showRefusal(refusal);
        publish();
        return { action: action, ok: false, code: refusal && refusal.code };
      }
    );
  }

  function runSequence(calls, resolver) {
    results = [];
    publish();
    clearRefusal();
    outcomeEl.textContent = "running";
    var chain = Promise.resolve();
    var list = calls || [];
    for (var i = 0; i < list.length; i++) {
      (function (call) {
        chain = chain.then(function () {
          return runOne(call, resolver);
        });
      })(list[i]);
    }
    return chain.then(
      function () {
        outcomeEl.textContent = "done";
        return results;
      },
      function (error) {
        outcomeEl.textContent = "error: " + String(error);
        return results;
      }
    );
  }

  /* The tester drives these with one execute_js call each:
       window.__QA3146.run([{action:"application_data_read", args:{...}}, ...])
       window.__QA3146.runRaw([{action:"get_control_setting", args:{...}}, ...])
     Calls are awaited SEQUENTIALLY, so the log order is the drive order. The
     DOM is the record; the tester polls [data-last-outcome] and then reads
     [data-call-log] rather than relying on the driver awaiting a promise. */
  window.__QA3146 = {
    run: function (calls) {
      return runSequence(calls, invoke);
    },
    runRaw: function (calls) {
      return runSequence(calls, invokeRaw);
    },
    results: function () {
      return results;
    }
  };

  var now = new Date();
  root.setAttribute("data-mounted-at", now.toISOString());
  root.setAttribute(
    "data-mount-id",
    String(now.getTime()) + "-" + Math.random().toString(36).slice(2, 10)
  );
  root.setAttribute("data-qa3146-ready", "true");
  outcomeEl.textContent = "ready";
  publish();
}
`;

/* ==========================================================================
 * Deterministic zip writer (stored entries, fixed 1980-01-01 timestamp).
 * ========================================================================== */

const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;

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

function buildZip(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(VERSION_NEEDED, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centralParts.push(cd, name);
    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirectory, eocd]);
}

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
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central header at ' + cursor);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header for ' + name);
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

function readZipEntry(buf, wantedName) {
  const eocdOffset = buf.length - 22;
  const count = buf.readUInt16LE(eocdOffset + 10);
  let cursor = buf.readUInt32LE(eocdOffset + 16);
  for (let i = 0; i < count; i++) {
    const compressed = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt32LE(cursor + 32);
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

/* ==========================================================================
 * Manifest construction + the capability rules this generator asserts.
 * ========================================================================== */

function manifestFor(fixture) {
  const manifest = {
    manifestVersion: 1,
    id: fixture.id,
    displayName: fixture.displayName,
    version: fixture.version,
    engines: { fredo: '>=0.0.0' },
    entry: { document: 'index.html', module: 'main.js' },
    description: fixture.description,
  };
  /* Absent key (not null) is the fail-safe fixture's whole point. */
  if (fixture.capabilities) manifest.capabilities = fixture.capabilities;
  return manifest;
}

/** Base-schema rules (shared with the #3147 generators, restated here so this
 *  script validates its own output rather than trusting a sibling). */
function validateBase(m) {
  const errors = [];
  if (m.manifestVersion !== 1) errors.push('manifestVersion must be the number 1');
  if (typeof m.id !== 'string' || m.id.length > 96 || !ID_RE.test(m.id)) {
    errors.push('id must match ' + ID_RE + ' and be at most 96 chars');
  }
  if (typeof m.displayName !== 'string' || m.displayName.length < 1 || m.displayName.length > 64) {
    errors.push('displayName must be a string of 1..64 chars');
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    errors.push('version must be SemVer 2.0.0');
  }
  if (!m.engines || typeof m.engines.fredo !== 'string' || m.engines.fredo.length === 0) {
    errors.push('engines.fredo must be a non-empty semver RANGE string');
  }
  if (!m.entry || typeof m.entry.document !== 'string' || typeof m.entry.module !== 'string') {
    errors.push('entry.document and entry.module must be strings');
  }
  return errors;
}

/** The capability rules the plan fixes. Returns error strings; a fixture that
 *  is SUPPOSED to be refused is checked the other way (see selfCheck). */
function validateCapabilities(caps) {
  const errors = [];
  if (caps === undefined) return errors;
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) {
    errors.push('capabilities must be an object');
    return errors;
  }
  for (const key of Object.keys(caps)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push('capabilities has an unknown key: ' + key);
  }
  if (caps.version !== 1) errors.push('capabilities.version must be the number 1');
  if (caps.data !== undefined) {
    if (caps.data === null || typeof caps.data !== 'object' || Array.isArray(caps.data)) {
      errors.push('capabilities.data must be an object');
    } else {
      for (const key of Object.keys(caps.data)) {
        if (!CAPABILITY_DATA_KEYS.includes(key)) errors.push('capabilities.data has an unknown key: ' + key);
      }
      if (!Array.isArray(caps.data.tables) || caps.data.tables.length === 0) {
        errors.push('capabilities.data.tables must be a non-empty array when present');
      } else {
        caps.data.tables.forEach((t, i) => {
          if (!t || typeof t.name !== 'string' || t.name.length === 0) {
            errors.push('capabilities.data.tables[' + i + '].name is required');
          }
          /* The plan REUSES the shipped declaration validator, whose only
             recorded violation we can assert here is the `source` door. */
          if (t && t.source !== undefined) {
            errors.push(
              'capabilities.data.tables[' + i + '].source is FORBIDDEN for an installed package'
            );
          }
        });
      }
    }
  }
  if (caps.highRisk !== undefined) {
    if (!Array.isArray(caps.highRisk)) {
      errors.push('capabilities.highRisk must be an array');
    } else {
      caps.highRisk.forEach((id, i) => {
        if (!CAPABILITY_IDS.includes(id)) {
          errors.push('capabilities.highRisk[' + i + '] is not a known capability id: ' + id);
        }
      });
    }
  }
  return errors;
}

/**
 * Self-check one built archive. For an EXPECTED-REFUSAL fixture the capability
 * errors are the deliverable: assert the exact one fired and nothing else did.
 */
function selfCheck(item) {
  const fixture = item.fixture;
  const problems = [];

  const manifestBytes = readZipEntry(item.archive, 'fredo-app.json');
  if (!manifestBytes) {
    problems.push('fredo-app.json is not in the archive');
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      problems.push('fredo-app.json is not valid JSON: ' + error.message);
    }
    if (parsed) {
      const base = validateBase(parsed);
      for (const error of base) problems.push('base schema: ' + error);

      const capErrors = validateCapabilities(parsed.capabilities);
      if (fixture.expectedInstallRefusal) {
        /* The refusal IS the point: exactly one capability defect, and it names
           the field path the suite row asserts. */
        const wanted = fixture.expectedInstallRefusal.fieldPath;
        if (capErrors.length !== 1) {
          problems.push(
            'expected exactly ONE capability defect for ' + fixture.id + ', got ' + capErrors.length +
              ': ' + JSON.stringify(capErrors)
          );
        } else if (!capErrors[0].includes(wanted)) {
          problems.push('capability defect does not name ' + wanted + ': ' + capErrors[0]);
        }
      } else {
        for (const error of capErrors) problems.push('capability schema: ' + error);
      }

      /* Round-trip: the archive's capabilities block must equal the authored one. */
      if (!fixture.expectedInstallRefusal) {
        const authored = manifestFor(fixture).capabilities;
        if (JSON.stringify(parsed.capabilities) !== JSON.stringify(authored)) {
          problems.push('capabilities block drifted inside the archive');
        }
      } else if (parsed.capabilities === undefined) {
        problems.push('expected-refusal fixture lost its capabilities block');
      }
    }
  }

  const documentBytes = readZipEntry(item.archive, 'index.html');
  if (!documentBytes || documentBytes.length === 0) {
    problems.push('index.html is missing or empty');
  } else if (!documentBytes.toString('utf8').includes('<!doctype html>')) {
    problems.push('index.html is not an HTML document');
  }

  const moduleBytes = readZipEntry(item.archive, 'main.js');
  if (!moduleBytes || moduleBytes.length === 0) {
    problems.push('main.js is missing or empty');
  } else if (fixture.openable && !/export function mount\s*\(/.test(moduleBytes.toString('utf8'))) {
    problems.push('main.js does not export the mount function the host calls');
  }

  return problems;
}

function packageEntries(fixture) {
  return [
    { name: 'fredo-app.json', data: Buffer.from(JSON.stringify(manifestFor(fixture), null, 2) + '\n', 'utf8') },
    { name: 'index.html', data: Buffer.from(documentHtml(fixture.displayName, fixture.id), 'utf8') },
    { name: 'main.js', data: Buffer.from(CAPABILITY_PROBE_MODULE, 'utf8') },
  ];
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ==========================================================================
 * CLI
 * ========================================================================== */

const HELP = `build-capability-fixtures.mjs -- Spec #3146 capability fixtures.

Usage:
  node .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs [options]

Options:
  --out <dir>   output directory (default: .opencode/tmp/3146/fixtures/capabilities)
  --quiet       print only the summary table
  --help        this text

Every archive is self-checked before it is written (re-parse, CRC, manifest and
capabilities round-trip, mount export, and the EXACT capability defect for a
refusal fixture). Exit code is non-zero if any self-check fails.

Output is deterministic: run it twice and compare the sha256 column. That
comparison is the determinism receipt -- this generator commits no hash manifest,
so nothing can go stale.`;

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--quiet') options.quiet = true;
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

function buildAll() {
  const built = [];
  for (const fixture of FIXTURES) {
    const archive = buildZip(packageEntries(fixture));
    const listed = verifyZip(archive);
    if (listed.length !== 3) {
      throw new Error(fixture.id + ': archive read back ' + listed.length + ' entries, expected 3');
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

function summary(built) {
  return {
    description:
      'Spec #3146 capability fixtures. Written next to the archives so the output directory is ' +
      'self-describing. This file is NOT a committed expectation: it is regenerated on every run, ' +
      'and determinism is proven by running the generator twice and comparing sha256.',
    generator: '.opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs',
    manifestVersion: 1,
    capabilityIds: CAPABILITY_IDS,
    zipPolicy: {
      method: 'stored (0)',
      dosTimestamp: '1980-01-01T00:00:00 (dosTime 0x0000, dosDate 0x0021)',
      entryOrder: 'fredo-app.json, index.html, main.js',
    },
    fixtures: built.map((item) => ({
      id: item.fixture.id,
      displayName: item.fixture.displayName,
      version: item.fixture.version,
      file: item.fileName,
      bytes: item.bytes,
      sha256: item.sha256,
      openable: item.fixture.openable,
      declares: item.fixture.declares,
      capabilities: item.fixture.capabilities,
      expectedInstallRefusal: item.fixture.expectedInstallRefusal || null,
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

  let built;
  try {
    built = buildAll();
  } catch (error) {
    console.error('FIXTURE BUILD FAILED: ' + error.message);
    process.exitCode = 1;
    return;
  }

  mkdirSync(options.out, { recursive: true });
  for (const item of built) {
    writeFileSync(path.join(options.out, item.fileName), item.archive);
  }
  writeFileSync(
    path.join(options.out, 'CAPABILITY-FIXTURES.json'),
    JSON.stringify(summary(built), null, 2) + '\n',
    'utf8'
  );

  const lines = [
    'Spec #3146 capability fixtures',
    'generated by .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs',
    '',
    'output directory: ' + options.out,
    '',
    pad('id', 24) + pad('zip', 32) + pad('bytes', 8) + pad('openable', 10) + pad('refusal', 24) + 'sha256',
    pad('--', 24) + pad('---', 32) + pad('-----', 8) + pad('--------', 10) + pad('-------', 24) + '------',
  ];
  for (const item of built) {
    const refusal = item.fixture.expectedInstallRefusal
      ? item.fixture.expectedInstallRefusal.code
      : '-';
    lines.push(
      pad(item.fixture.id, 24) +
        pad(item.fileName, 32) +
        pad(item.bytes, 8) +
        pad(item.fixture.openable ? 'yes' : 'no', 10) +
        pad(refusal, 24) +
        item.sha256
    );
  }
  lines.push('');
  lines.push(
    'refusal field paths: ' +
      built
        .filter((item) => item.fixture.expectedInstallRefusal)
        .map((item) => item.fixture.id + ' -> ' + item.fixture.expectedInstallRefusal.fieldPath)
        .join('; ')
  );
  const text = lines.join('\n') + '\n';
  writeFileSync(path.join(options.out, 'CAPABILITY-FIXTURES.txt'), text, 'utf8');

  if (!options.quiet) {
    for (const item of built) {
      console.log('');
      console.log(item.fixture.id + '  (' + item.fileName + ')');
      for (const evidence of item.fixture.asserts) console.log('  ' + evidence);
    }
    console.log('');
  }
  console.log(text);
  console.log(
    'SELF-CHECK OK: ' +
      built.length +
      ' archives re-parsed, CRC-verified, manifest + capabilities round-tripped, ' +
      'and every expected install refusal asserted at its exact field path.'
  );
  console.log('DETERMINISM: run again and compare the sha256 column (must be identical).');
}

main();
