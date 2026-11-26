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
 *   qa3146-mirror-control   declares data.tables{control_probe}       (NEGATIVE CONTROL:
 *                           its single probe carries a KNOWINGLY FALSE expectation, so a
 *                           working mirror MUST print a FAIL line -- see below)
 *   qa3146-source-projection declares a table carrying `source`       (install refusal:
 *                           manifest_invalid_field at
 *                           capabilities.data.tables[0].source -- the SECOND door)
 *   qa3146-unknown-capability highRisk{high-risk.root-shell}          (install refusal:
 *                           unknown capability id)
 *
 * The two refusal fixtures are DELIBERATELY invalid manifests: they exist to be
 * refused. They carry `expectedInstallRefusal` so the suite (and this script's own
 * self-check) assert the exact code + field path instead of "some error".
 *
 * SELF-DRIVING (the #3147 precedent, applied in #3146 round 2)
 * -----------------------------------------------------------
 * The installed `installed-*` window is unreachable by EVERY `tauri_webview_*` tool:
 * `execute_js`, `dom_snapshot`, `find_element`, `screenshot` and `console` all return
 * `Request timeout after 2000ms`, because the bridge's result channel is ACL-denied
 * inside the child (`withGlobalTauri:false` and no grant for the bridge command). A
 * fixture that waits to be driven through `execute_js` therefore cannot be driven at
 * all. So every openable package is SELF-DRIVING: on `mount` it runs its own probe
 * plan and mirrors EVERY outcome as VISIBLE TEXT, and the tester reads that text with
 * a capability-independent instrument -- a native accessibility (UIA) read of the
 * installed window's own a11y tree, corroborated by a native window capture.
 *
 * The mirror is a fixed, host-readable grammar:
 *   [data-qa3146-header]      ONE deterministic line, identical on every run --
 *                             "QA3146-FIXTURE app=<id> version=<v> capabilities=<set> tables=<csv> probes=<ids>"
 *   [data-qa3146-document]    ONE per-document line --
 *                             "QA3146-DOCUMENT app= version= ready=true mount=<id> loaded=<iso> origin=<origin>"
 *   [data-qa3146-assertions]  one line per probe, rendered as its own <p> --
 *                             "PASS <id> codes=<c1>,<c2> ..."  /  "FAIL <id> codes=... <reason>"
 *                             (every line carries the refusal codes it observed, so a
 *                             reader scores AC2/AC3/AC4 without touching the child)
 *   [data-qa3146-consent]     the live consent state line (consent fixtures only)
 *   [data-refusal-code] / [data-refusal-json] / [data-call-log] / [data-qa3146-summary]
 *                             the last refusal and the full ordered call record, as text
 *
 * NEGATIVE CONTROL. `qa3146-mirror-control` declares a table and then asserts the
 * OPPOSITE of the true outcome (that a read of its own declared table is refused).
 * A working mirror always prints `FAIL MIRROR-CONTROL ...`; if that line is missing
 * the mirror never ran, and if it ever reads PASS either the declared read really was
 * refused (a product defect) or the mirror is lying. That is how a reader tells
 * "every probe said PASS" from "nothing executed".
 *
 * No build-time input comes from the clock or randomness: the probe plan is a pure
 * function of the catalog, and every per-run value (mount id, child key, timestamps)
 * is produced inside the child document at mount time.
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
      '[data-qa3146-panel] -- the probe panel (rendered, self-driving)',
      '[data-qa3146-header] -- ONE deterministic line: app= version= capabilities= tables= probes=',
      '[data-qa3146-document] -- ONE per-document line: app= version= ready= mount= loaded= origin=',
      '  (read mount= / loaded= from this TEXT; the [data-mounted-at] / [data-mount-id] attributes',
      '  exist on ctx.root but a native a11y read exposes text, not attributes)',
      '[data-qa3146-assertions] -- one <p data-assertion="<id>" data-status="PASS|FAIL"> line per probe:',
      '  "PASS <id> codes=<c1>,<c2> ..." or "FAIL <id> codes=... <reason>"',
      '[data-refusal-code] / [data-refusal-json] -- the LAST refusal, verbatim text',
      '[data-call-log] -- JSON array of { action, raw, ok, value | refusal } per call (the record)',
      '[data-qa3146-summary] -- QA3146-SUMMARY calls=<n> rejected=<n> probes=<n> done=<state>',
      '[data-mounted-at] / [data-mount-id] -- per-document stamps (prove no reload happened',
      '  across a grant/revoke: the SAME values must survive the consent change)',
      'Read the whole mirror with a native UIA text read / native window capture -- never',
      'with tauri_webview_* (unreachable on installed-<id>, #3147).',
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
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
    dom: ['the full rendered mirror (header / document / assertions / refusal / call log), identical in shape to qa3146-app-a'],
  },
  {
    id: 'qa3146-mirror-control',
    displayName: 'QA3146 Mirror Control',
    version: '1.0.0',
    description:
      'NEGATIVE CONTROL for the rendered mirror: its probe asserts a KNOWINGLY FALSE expectation, so a working mirror MUST print a FAIL line.',
    capabilities: {
      version: 1,
      data: {
        tables: [table('control_probe', [col('id', 'TEXT', 'application'), col('body', 'TEXT', 'application', true)])],
      },
    },
    openable: true,
    declares: ['data.tables'],
    mustPrintFail: true,
    asserts: [
      'INSTRUMENT CONTROL (never graded as a product row): this package declares its own',
      'table and then expects a read of that table to be refused action_not_declared. The',
      'true outcome is a resolve, so a working mirror prints',
      '"FAIL MIRROR-CONTROL codes=ok step 1 expected refusal action_not_declared, resolved".',
      'A MISSING line means the mirror never ran; a PASS line means either the declared read',
      'was wrongly refused (a real product defect) or the mirror fabricates results. In every',
      'one of those three cases the round has no usable child evidence.',
    ],
    dom: ['the full rendered mirror, identical to qa3146-app-a, with one MIRROR-CONTROL line'],
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
 * Probe plans -- what each self-driving fixture drives on mount.
 *
 * A plan is DATA, interpreted by one generic runner in the child module, so the
 * generator can assert (in its own self-check) that every probe id it promises is
 * actually embedded in the shipped module. Step shapes:
 *   pstep(action, args, expect, raw)
 *     expect: 'ok' | 'refuse' | 'refuse:<code>' | 'any'
 *   checks (evaluated on the recorded outcomes, 1-based `on`):
 *     { kind:'pathEq',          on, path, eq, name }
 *     { kind:'present',         on, path, name }
 *     { kind:'containsRow',     on, path, field, value, name }
 *     { kind:'textExcludes',    on, tokens, name, onlyCodes? }
 *     { kind:'textIncludesAny', on, tokens, name, onlyCodes? }
 *     { kind:'notCode',         on, codes, name }
 *     { kind:'sameExcept',      a, b, strip, name }
 *   facts:   { name, on, path } rendered as "name=value" on the PASS line
 *   extraFacts: { name, value } with the runtime token $CHILD_KEY resolved at mount
 *
 * Determinism: a plan is derived from the catalog only (no clock, no randomness).
 * `$CHILD_KEY` is the ONE runtime token, resolved inside the child at mount time.
 * ========================================================================== */

/** The authority vocabulary (six codes) -- never the installer's frozen 22. */
const AUTHORITY_CODES = [
  'action_not_declared',
  'action_not_grantable',
  'consent_required',
  'scope_denied',
  'caller_unknown',
  'app_not_installed',
];

function pcall(action, args, raw) {
  return { action: action, args: args === undefined ? {} : args, raw: Boolean(raw) };
}

function pstep(action, args, expect, raw) {
  return { call: pcall(action, args, raw), expect: expect || 'ok' };
}

function appRef(applicationId, table) {
  return { source: 'application', applicationId: applicationId, table: table };
}

function capabilityIdsOf(capabilities) {
  if (!capabilities) return [];
  const ids = [];
  if (capabilities.data && Array.isArray(capabilities.data.tables) && capabilities.data.tables.length > 0) {
    ids.push('data.tables');
  }
  if (Array.isArray(capabilities.highRisk)) {
    for (const id of capabilities.highRisk) ids.push(id);
  }
  return ids;
}

function tableNamesOf(capabilities) {
  if (!capabilities || !capabilities.data || !Array.isArray(capabilities.data.tables)) return [];
  return capabilities.data.tables.map((t) => t.name);
}

/** The query leg F-7.17 / F-7.18 / F-7.19 / F-7.20 / F-7.27 all drive. It names a
 *  connection that cannot exist so a GRANTED call stops at the connection lookup --
 *  the row only ever asserts the consent gate, never a successful query. */
const CONSENT_QUERY = {
  connectionId: 'qa3146-no-such-connection',
  sql: 'SELECT 1',
  mode: 'Single',
  selection: null,
  confirmedStatementHashes: [],
};

function probePlanFor(fixture) {
  const id = fixture.id;
  const capabilities = fixture.capabilities;
  const declaredTables =
    capabilities && capabilities.data && Array.isArray(capabilities.data.tables) ? capabilities.data.tables : [];
  const firstTable = declaredTables.length > 0 ? declaredTables[0] : null;

  if (id === 'qa3146-app-a') {
    const notes = appRef('qa3146-app-a', 'notes');
    const notesKey = { applicationId: 'qa3146-app-a', table: 'notes' };
    const otherRecords = appRef('qa3146-app-b', 'records');
    return {
      probes: [
        {
          id: 'F-7.5',
          steps: [
            /* Pre-clean both keys this fixture itself uses, so a re-open of the
               document re-runs the same assertions instead of inheriting rows from
               the previous load (the row binds rows.length === 0 after the delete). */
            pstep('application_data_delete', { ref: notesKey, key: ['n2'] }, 'any'),
            pstep('application_data_delete', { ref: notesKey, key: ['n1'] }, 'any'),
            pstep('application_data_write', { ref: notes, key: ['n1'], set: { body: 'hello-a' } }),
            pstep('application_data_read', { ref: notes, where: [], limit: 10 }),
            pstep('application_data_delete', { ref: notesKey, key: ['n1'] }),
            pstep('application_data_read', { ref: notes, where: [], limit: 10 }),
            pstep(
              'application_data_declare',
              {
                declarations: [
                  {
                    applicationId: 'qa3146-app-a',
                    declarationRevision: 'qa3146-probe-r1',
                    tables: firstTable ? [firstTable] : [],
                  },
                ],
              },
              'any'
            ),
          ],
          checks: [
            { kind: 'pathEq', on: 4, path: 'rows.length', eq: 1, name: 'rowsAfterWrite' },
            { kind: 'pathEq', on: 4, path: 'rows.0.body', eq: 'hello-a', name: 'wroteBody' },
            { kind: 'pathEq', on: 6, path: 'rows.length', eq: 0, name: 'rowsAfterDelete' },
            { kind: 'notCode', on: 7, codes: AUTHORITY_CODES, name: 'declareNotCapabilityRefused' },
          ],
          facts: [
            { name: 'rowsAfterWrite', on: 4, path: 'rows.length' },
            { name: 'rowsAfterDelete', on: 6, path: 'rows.length' },
          ],
        },
        {
          id: 'F-7.6',
          steps: [
            pstep('application_data_write', { ref: notes, key: ['n2'], set: { body: 'no-identity' } }),
            pstep('application_data_read', { ref: { source: 'application', table: 'notes' }, where: [], limit: 10 }),
            /* Self-cleaning: leaves the table as it found it, so F-7.5 stays re-runnable. */
            pstep('application_data_delete', { ref: notesKey, key: ['n2'] }, 'any'),
          ],
          checks: [{ kind: 'containsRow', on: 2, path: 'rows', field: 'body', value: 'no-identity', name: 'derivedId' }],
        },
        {
          id: 'F-7.7',
          steps: [pstep('application_data_read', { ref: notes, where: [], limit: 10 })],
          facts: [{ name: 'rowsAfterReopen', on: 1, path: 'rows.length' }],
        },
        {
          id: 'F-7.8',
          steps: [pstep('pg_database_reset', {}, 'refuse:action_not_declared')],
          checks: [
            { kind: 'pathEq', on: 1, path: 'appId', eq: 'qa3146-app-a', name: 'derivedAppId' },
            { kind: 'pathEq', on: 1, path: 'action', eq: 'pg_database_reset', name: 'action' },
            { kind: 'present', on: 1, path: 'detail', name: 'detail' },
          ],
          facts: [{ name: 'appId', on: 1, path: 'appId' }],
        },
        {
          id: 'F-7.9',
          steps: [
            pstep('save_control_setting', { key: '$CHILD_KEY', value: 'probe-sentinel' }, 'refuse:action_not_grantable'),
            pstep('installed_apps_list', {}, 'refuse:action_not_grantable'),
            pstep(
              'installed_app_consent_grant',
              { appId: 'qa3146-app-a', capability: 'high-risk.database-reset' },
              'refuse:action_not_grantable'
            ),
          ],
          extraFacts: [{ name: 'childKey', value: '$CHILD_KEY' }],
        },
        {
          id: 'F-7.10',
          steps: [
            pstep('get_control_setting', { key: 'app_window_presentation' }, 'refuse', true),
            pstep(
              'installed_app_consent_grant',
              { appId: 'qa3146-app-a', capability: 'high-risk.database-query' },
              'refuse',
              true
            ),
            pstep('installed_app_install', { archivePath: 'C:/nonexistent.zip' }, 'refuse', true),
            pstep(
              'installed_app_invoke',
              {
                request: {
                  action: 'application_data_read',
                  args: { ref: appRef('qa3146-app-a', 'notes'), where: [], limit: 5 },
                },
              },
              'any',
              true
            ),
          ],
          checks: [
            { kind: 'textIncludesAny', on: 1, tokens: ['not allowed', 'permission', 'capability'], name: 's1Acl' },
            { kind: 'textExcludes', on: 1, tokens: ['net::ERR', 'content security policy', 'timed out'], name: 's1Transport' },
            { kind: 'textIncludesAny', on: 2, tokens: ['not allowed', 'permission', 'capability'], name: 's2Acl' },
            { kind: 'textExcludes', on: 2, tokens: ['net::ERR', 'content security policy', 'timed out'], name: 's2Transport' },
            { kind: 'textIncludesAny', on: 3, tokens: ['not allowed', 'permission', 'capability'], name: 's3Acl' },
            { kind: 'textExcludes', on: 3, tokens: ['net::ERR', 'content security policy', 'timed out'], name: 's3Transport' },
            { kind: 'textExcludes', on: 4, tokens: ['not allowed', 'permission:'], name: 's4NotAcl' },
          ],
        },
        {
          id: 'F-7.13',
          steps: [
            pstep('application_data_read', { ref: otherRecords, where: [], limit: 10 }, 'refuse:scope_denied'),
            pstep('application_data_write', { ref: { applicationId: 'qa3146-app-b', table: 'records' }, key: ['r1'], set: { value: 'pwned' } }, 'refuse:scope_denied'),
            pstep('application_data_delete', { ref: { applicationId: 'qa3146-app-b', table: 'records' }, key: ['r1'] }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: notes, where: [], limit: 10 }),
          ],
          checks: [
            { kind: 'pathEq', on: 1, path: 'appId', eq: 'qa3146-app-a', name: 'readAppId' },
            { kind: 'pathEq', on: 2, path: 'appId', eq: 'qa3146-app-a', name: 'writeAppId' },
            { kind: 'pathEq', on: 3, path: 'appId', eq: 'qa3146-app-a', name: 'deleteAppId' },
          ],
        },
        {
          id: 'F-7.14',
          steps: [
            pstep('application_data_read', { ref: { source: 'canonical', table: 'chat' }, where: [], limit: 10 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: { source: 'canonical', table: 'agentSession' }, where: [], limit: 10 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: { source: 'canonical', table: 'toolUse' }, where: [], limit: 10 }, 'refuse:scope_denied'),
          ],
        },
        {
          id: 'F-7.24',
          steps: [
            pstep('application_data_read', { ref: { source: 'application', table: 'notes' }, where: [], limit: 5 }),
            pstep('application_data_read', { ref: otherRecords, where: [], limit: 5 }, 'refuse:scope_denied'),
            /* A NON-EXISTENT id: the row binds only "refused" + the DERIVED appId, never a
               code -- the taxonomy for an unknown target is the product's, not this row's. */
            pstep('application_data_read', { ref: appRef('qa3146-ghost', 'records'), where: [], limit: 5 }, 'refuse'),
          ],
          checks: [
            { kind: 'pathEq', on: 2, path: 'appId', eq: 'qa3146-app-a', name: 'otherAppId' },
            { kind: 'pathEq', on: 3, path: 'appId', eq: 'qa3146-app-a', name: 'ghostAppId' },
          ],
        },
        {
          id: 'F-7.31',
          steps: [
            pstep('application_data_read', { ref: otherRecords, where: [], limit: 5 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: appRef('qa3146-app-a', 'records'), where: [], limit: 5 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: appRef('mission', 'monitor_sessions'), where: [], limit: 5 }, 'refuse:scope_denied'),
          ],
          checks: [
            { kind: 'textExcludes', on: 1, tokens: ['mission-monitor', 'feature_mission_monitor_sessions'], name: 's1Leak' },
            { kind: 'textExcludes', on: 2, tokens: ['mission-monitor', 'feature_mission_monitor_sessions'], name: 's2Leak' },
            { kind: 'textExcludes', on: 3, tokens: ['mission-monitor', 'feature_mission_monitor_sessions'], name: 's3Leak' },
            {
              kind: 'sameExcept',
              a: 1,
              b: 2,
              strip: ['qa3146-app-a', 'qa3146-app-b', 'records'],
              name: 'notOracular',
            },
          ],
        },
      ],
      consent: null,
    };
  }

  if (id === 'qa3146-app-b') {
    const records = appRef('qa3146-app-b', 'records');
    return {
      probes: [
        {
          id: 'F-7.11',
          steps: [
            pstep('application_data_write', { ref: records, key: ['r1'], set: { value: 'b-original' } }),
            pstep('application_data_read', { ref: records, where: [], limit: 10 }),
          ],
          checks: [{ kind: 'containsRow', on: 2, path: 'rows', field: 'value', value: 'b-original', name: 'ownRecords' }],
        },
        {
          id: 'F-7.13',
          steps: [pstep('application_data_read', { ref: records, where: [], limit: 10 })],
          checks: [{ kind: 'containsRow', on: 1, path: 'rows', field: 'value', value: 'b-original', name: 'unchanged' }],
        },
      ],
      consent: null,
      /* A landed write from A must be OBSERVED, not masked: this watch re-reads the
         row and announces the transition. Re-opening B re-seeds r1, so the live watch
         -- not a later load -- is the leg that survives A's attempt. */
      watch: {
        id: 'F-7.13',
        action: 'application_data_read',
        args: { ref: records, where: [], limit: 10 },
        path: 'rows',
        field: 'value',
        value: 'b-original',
        intervalMs: 2000,
      },
    };
  }

  if (id === 'mission') {
    return {
      probes: [
        {
          id: 'F-7.11',
          steps: [
            pstep('application_data_read', { ref: appRef('mission', 'monitor_sessions'), where: [], limit: 10 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: appRef('mission', 'monitor_secrets'), where: [], limit: 10 }, 'refuse:scope_denied'),
          ],
          checks: [{ kind: 'pathEq', on: 1, path: 'appId', eq: 'mission', name: 'appId' }],
          facts: [{ name: 'appId', on: 1, path: 'appId' }],
        },
      ],
      consent: null,
    };
  }

  if (id === 'orbit') {
    return {
      probes: [
        {
          id: 'F-7.12',
          steps: [
            pstep('application_data_write', { ref: { applicationId: 'orbit', table: 'orbit_own' }, key: ['o1'], set: { body: 'orbit-own-value' } }),
            pstep('application_data_read', { ref: appRef('orbit', 'lab_notes'), where: [], limit: 10 }, 'refuse:scope_denied'),
            pstep('application_data_read', { ref: appRef('orbit', 'orbit_own'), where: [], limit: 10 }),
          ],
          checks: [{ kind: 'containsRow', on: 3, path: 'rows', field: 'body', value: 'orbit-own-value', name: 'orbitOwn' }],
        },
      ],
      consent: null,
    };
  }

  if (id === 'orbit-lab') {
    return {
      probes: [
        {
          id: 'F-7.12',
          steps: [pstep('application_data_read', { ref: appRef('orbit-lab', 'notes'), where: [], limit: 10 }, 'refuse:scope_denied')],
        },
      ],
      consent: null,
    };
  }

  if (id === 'qa3146-consent-a') {
    return {
      probes: [
        {
          id: 'F-7.17',
          steps: [
            pstep('db_query_execute', CONSENT_QUERY, 'any'),
            pstep('pg_database_reset', {}, 'refuse:consent_required'),
          ],
          checks: [
            { kind: 'pathEq', on: 2, path: 'capability', eq: 'high-risk.database-reset', name: 'resetCapability' },
            {
              kind: 'textExcludes',
              on: 1,
              tokens: ['qa3146-no-such-connection'],
              onlyCodes: ['consent_required'],
              name: 'consentBeforeHandler',
            },
            {
              kind: 'pathEq',
              on: 1,
              path: 'capability',
              eq: 'high-risk.database-query',
              onlyCodes: ['consent_required'],
              name: 'queryCapability',
            },
          ],
          facts: [
            { name: 'queryCapability', on: 1, path: 'capability' },
            { name: 'resetCapability', on: 2, path: 'capability' },
          ],
        },
      ],
      consent: {
        queryAction: 'db_query_execute',
        queryArgs: CONSENT_QUERY,
        transitionIds: ['F-7.18', 'F-7.27'],
        resetId: 'F-7.20',
        intervalMs: 2000,
      },
    };
  }

  if (id === 'qa3146-consent-b') {
    return {
      probes: [
        {
          id: 'F-7.19',
          steps: [pstep('db_query_execute', CONSENT_QUERY, 'refuse:consent_required')],
          checks: [{ kind: 'pathEq', on: 1, path: 'appId', eq: 'qa3146-consent-b', name: 'derivedAppId' }],
          facts: [{ name: 'appId', on: 1, path: 'appId' }],
        },
      ],
      consent: null,
    };
  }

  if (id === 'qa3146-no-capabilities') {
    return {
      probes: [
        {
          id: 'F-7.26',
          steps: [
            pstep(
              'application_data_read',
              { ref: appRef('qa3146-no-capabilities', 'notes'), where: [], limit: 5 },
              'refuse:action_not_declared'
            ),
            pstep('application_data_declare', { declarations: [] }, 'refuse:action_not_declared'),
            pstep('pg_database_reset', {}, 'refuse:action_not_declared'),
          ],
        },
      ],
      consent: null,
    };
  }

  if (id === 'qa3146-mirror-control') {
    /* KNOWINGLY FALSE expectation -- see the fixture's `asserts`. A working mirror
       prints FAIL here; that line is the control itself. */
    return {
      probes: [
        {
          id: 'MIRROR-CONTROL',
          steps: [
            pstep(
              'application_data_read',
              { ref: appRef('qa3146-mirror-control', 'control_probe'), where: [], limit: 5 },
              'refuse:action_not_declared'
            ),
          ],
        },
      ],
      consent: null,
    };
  }

  return { probes: [], consent: null };
}

function buildProbePlan(fixture) {
  const plan = probePlanFor(fixture);
  const probes = plan.probes || [];
  /* Every assertion id this DOCUMENT can emit -- the load-time probes plus the ids the
     consent/data watchers publish later. The header advertises the full set so a reader
     knows which lines to look for, and which are missing. */
  const advertised = probes.map((probe) => probe.id);
  if (plan.consent) {
    for (const id of plan.consent.transitionIds || []) advertised.push(id);
    if (plan.consent.resetId) advertised.push(plan.consent.resetId);
  }
  if (plan.watch && plan.watch.id) advertised.push(plan.watch.id);
  const unique = [];
  for (const id of advertised) {
    if (!unique.includes(id)) unique.push(id);
  }
  return {
    fixtureId: fixture.id,
    appId: fixture.id,
    version: fixture.version,
    capabilitiesText: capabilityIdsOf(fixture.capabilities).join('+') || '(none)',
    tablesText: tableNamesOf(fixture.capabilities).join(',') || '(none)',
    probeIds: unique,
    probeCount: probes.length,
    probes: probes,
    consent: plan.consent || null,
    watch: plan.watch || null,
  };
}

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
    /* One VISIBLE line per assertion. The word PASS / FAIL is in the text, so the
       status is never carried by colour alone; FAIL is additionally bold. */
    p[data-assertion] { font-family: ui-monospace, Consolas, monospace; font-size: 13px;
                        line-height: 1.55; margin: 0 0 4px; white-space: pre-wrap;
                        overflow-wrap: anywhere; }
    p[data-assertion][data-status="FAIL"] { font-weight: 700; }
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
 * The one child module TEMPLATE. Every openable fixture ships this module with
 * its OWN probe plan substituted for __PLAN_JSON__, so each document drives
 * exactly the assertions its package exists to prove. The capability behaviour
 * under test lives in the HOST; the fixture supplies the self-driving probes and
 * the rendered-text mirror a host-side read scores.
 * ========================================================================== */

const CAPABILITY_PROBE_MODULE = `// Generated by .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs
// (Spec #3146). Plain ESM: the host bootstrap imports this file and calls the
// exported mount(ctx).
//
// SELF-DRIVING (Spec #3146 round 2, the #3147 precedent). The installed window is
// deliberately unreachable by EVERY tauri_webview_* tool -- execute_js, dom_snapshot,
// find_element, screenshot and console all return "Request timeout after 2000ms"
// against an installed-* windowId, because the bridge's result channel is ACL-denied
// inside the child. So this fixture does NOT wait to be driven: on mount it runs its
// own probe plan and mirrors EVERY outcome as VISIBLE TEXT. The tester reads that text
// with a capability-independent instrument: a native accessibility (UIA) read of the
// installed window's own a11y tree, corroborated by a native window capture. No
// execute_js call is part of this contract.
//
// The fixture NEVER bundles a Tauri API. It calls exactly one thing --
// window.__FREDO_INSTALLED__.invoke(action, args), the host-authored child
// client -- and writes every outcome (the resolved value, or the refusal object
// verbatim) to the rendered record.
//
// If the shim is absent the fixture records the refusal code "no-invoke-shim",
// which is exactly what the PRE-CHANGE tree produces: that is the redden
// control for every [NEW] row bound to this fixture.
//
// RENDERED MIRROR (what a host-side read asserts):
//   [data-qa3146-header]      ONE deterministic line, identical on every run:
//                             QA3146-FIXTURE app=<id> version=<v> capabilities=<set> tables=<csv> probes=<ids>
//   [data-qa3146-document]    ONE per-document line:
//                             QA3146-DOCUMENT app= version= ready=true mount=<id> loaded=<iso> origin=<origin>
//   [data-qa3146-theme]       the LIVE theme readout (re-published every second):
//                             QA3146-THEME theme.body-bg=.. theme.card-bg=.. theme.text-primary=..
//                             theme.accent-primary=.. colorScheme=<light|dark> mount=<id>
//   [data-qa3146-assertions]  one <p data-assertion="<id>" data-status="PASS|FAIL"> per probe:
//                             "PASS <id> codes=<c1>,<c2> ..."  |  "FAIL <id> codes=... <reason>"
//   [data-qa3146-consent]     the live consent state line (consent fixtures only)
//   [data-refusal-code]       the LAST refusal code, as text
//   [data-refusal-json]       the LAST refusal, verbatim JSON text
//   [data-call-log]           every call in drive order, JSON
//   [data-qa3146-summary]     QA3146-SUMMARY calls=<n> rejected=<n> probes=<n> done=<state>
//
// The NEGATIVE CONTROL package (qa3146-mirror-control) carries a probe whose
// expectation is knowingly false, so a working mirror MUST print a FAIL line. That is
// how a reader tells "every probe said PASS" from "the mirror never ran".

var PLAN = __PLAN_JSON__;

function makeEl(doc, tag, attrs, text) {
  var node = doc.createElement(tag);
  if (attrs) {
    for (var name in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) node.setAttribute(name, attrs[name]);
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function safeString(value) {
  try {
    var text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text;
  } catch (e) {
    return String(value);
  }
}

function lower(text) {
  return String(text).toLowerCase();
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.message === "string") return value.message;
    return safeString(value);
  }
  return String(value);
}

function codeOf(value) {
  if (value && typeof value === "object" && typeof value.code === "string") return value.code;
  if (typeof value === "string") {
    /* A raw-handle rejection is a free-text authority message. Keep a short token for
       the positional codes= clause; the verbatim text stays in the call record, which
       the text checks and the reader both use. */
    if (value.length <= 32 && value.indexOf(" ") === -1 && value.indexOf(",") === -1) return value;
    return "refused";
  }
  return "";
}

function isIndex(key) {
  if (key.length === 0) return false;
  for (var i = 0; i < key.length; i++) {
    var c = key.charAt(i);
    if (c < "0" || c > "9") return false;
  }
  return true;
}

function readPath(subject, dotted) {
  if (!dotted) return subject;
  var parts = String(dotted).split(".");
  var cursor = subject;
  for (var i = 0; i < parts.length; i++) {
    if (cursor === null || cursor === undefined) return undefined;
    var key = parts[i];
    if (Array.isArray(cursor) && isIndex(key)) cursor = cursor[Number(key)];
    else if (typeof cursor === "object") cursor = cursor[key];
    else return undefined;
  }
  return cursor;
}

function renderValue(value) {
  if (value === undefined) return "<missing>";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeString(value);
}

function containsToken(text, tokens) {
  var haystack = lower(text);
  for (var i = 0; i < tokens.length; i++) {
    if (haystack.indexOf(lower(tokens[i])) !== -1) return "contains the token " + tokens[i];
  }
  return "";
}

function stripTokens(text, tokens) {
  var out = String(text);
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    var at = lower(out).indexOf(lower(token));
    while (at !== -1) {
      out = out.slice(0, at) + out.slice(at + token.length);
      at = lower(out).indexOf(lower(token));
    }
  }
  var parts = out.split(" ");
  var kept = [];
  for (var p = 0; p < parts.length; p++) {
    if (parts[p] !== "") kept.push(parts[p]);
  }
  return kept.join(" ");
}

function mountPanel(root, doc) {
  var existing = root.querySelector("[data-qa3146-panel]");
  if (existing) return existing;
  var panel = makeEl(doc, "section", { "data-qa3146-panel": "" });
  panel.appendChild(makeEl(doc, "h1", null, "Spec #3146 capability probe (self-driving)"));
  panel.appendChild(
    makeEl(
      doc,
      "p",
      null,
      "Every probe below runs on document load and publishes its outcome as VISIBLE TEXT. " +
        "Read the PASS / FAIL lines with a native accessibility (UIA) read of this window or a " +
        "native window capture: the tauri_webview_* tools cannot reach an installed-* window."
    )
  );
  panel.appendChild(makeEl(doc, "pre", { "data-qa3146-header": "" }));
  panel.appendChild(makeEl(doc, "pre", { "data-qa3146-document": "" }));
  panel.appendChild(makeEl(doc, "pre", { "data-qa3146-theme": "" }));
  panel.appendChild(makeEl(doc, "div", { "data-qa3146-assertions": "" }));
  panel.appendChild(makeEl(doc, "pre", { "data-qa3146-consent": "" }));
  panel.appendChild(makeEl(doc, "p", null, "last refusal code:"));
  panel.appendChild(makeEl(doc, "pre", { "data-refusal-code": "" }));
  panel.appendChild(makeEl(doc, "p", null, "last refusal (verbatim):"));
  panel.appendChild(makeEl(doc, "pre", { "data-refusal-json": "" }));
  panel.appendChild(makeEl(doc, "p", null, "call record (JSON, drive order):"));
  panel.appendChild(makeEl(doc, "pre", { "data-call-log": "" }));
  panel.appendChild(makeEl(doc, "pre", { "data-qa3146-summary": "" }));
  root.appendChild(panel);
  return panel;
}

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError("capability-probe: ctx.root is missing from InstalledAppContext");
  }
  root.setAttribute("data-fixture", PLAN.fixtureId);

  var doc = root.ownerDocument || document;
  var panel = mountPanel(root, doc);

  var headerEl = panel.querySelector("[data-qa3146-header]");
  var documentEl = panel.querySelector("[data-qa3146-document]");
  var themeEl = panel.querySelector("[data-qa3146-theme]");
  var assertionsEl = panel.querySelector("[data-qa3146-assertions]");
  var consentEl = panel.querySelector("[data-qa3146-consent]");
  var logEl = panel.querySelector("[data-call-log]");
  var summaryEl = panel.querySelector("[data-qa3146-summary]");
  var codeEl = panel.querySelector("[data-refusal-code]");
  var refusalEl = panel.querySelector("[data-refusal-json]");

  var records = [];
  var halted = false;

  function randomToken() {
    var text = "";
    var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 12; i++) {
      text = text + alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
  }

  var loadedAt = new Date().toISOString();
  var mountId = String(new Date().getTime()) + "-" + randomToken();
  var childKey = "qa3146-child-" + randomToken();

  /* ---- the header (deterministic) and the per-document line (runtime) ---- */
  headerEl.textContent =
    "QA3146-FIXTURE app=" + PLAN.appId +
    " version=" + PLAN.version +
    " capabilities=" + PLAN.capabilitiesText +
    " tables=" + PLAN.tablesText +
    " probes=" + PLAN.probeIds.join(",");

  var origin = "unreadable";
  try {
    origin = String(window.location.origin);
  } catch (error) {
    origin = "unreadable";
  }

  documentEl.textContent =
    "QA3146-DOCUMENT app=" + String(ctx.appId) +
    " version=" + String(ctx.version) +
    " ready=true mount=" + mountId +
    " loaded=" + loadedAt +
    " origin=" + origin;

  root.setAttribute("data-mounted-at", loadedAt);
  root.setAttribute("data-mount-id", mountId);
  root.setAttribute("data-qa3146-ready", "true");

  if (!PLAN.consent) consentEl.textContent = "QA3146-CONSENT app=" + PLAN.appId + " state=none";

  /* The host writes the theme tokens as CSS custom properties on documentElement, so
     this document can read them back and PUBLISH them. Re-published every second so a
     live theme push (F-1.8) is observable without a reload -- together with the mount
     id, which is the reload discriminator. */
  var THEME_TOKENS = ["--body-bg", "--card-bg", "--text-primary", "--accent-primary", "--accent-secondary"];
  var THEME_NAMES = ["body-bg", "card-bg", "text-primary", "accent-primary", "accent-secondary"];

  function publishTheme() {
    var computed = null;
    try {
      computed = window.getComputedStyle(document.documentElement);
    } catch (error) {
      computed = null;
    }
    var parts = [];
    for (var i = 0; i < THEME_TOKENS.length; i++) {
      var value = "unreadable";
      if (computed && typeof computed.getPropertyValue === "function") {
        value = String(computed.getPropertyValue(THEME_TOKENS[i])).replace(/^\\s+|\\s+$/g, "");
      }
      parts.push("theme." + THEME_NAMES[i] + "=" + (value === "" ? "<empty>" : value));
    }
    var scheme = "unknown";
    try {
      if (ctx.theme && ctx.theme.colorScheme) scheme = String(ctx.theme.colorScheme);
    } catch (error) {
      scheme = "unknown";
    }
    themeEl.textContent = "QA3146-THEME " + parts.join(" ") + " colorScheme=" + scheme + " mount=" + mountId;
  }

  /* ---- the mirror writers ---- */
  function publishAssertion(id, ok, detail) {
    var text = (ok ? "PASS " : "FAIL ") + id + (detail ? " " + detail : "");
    var line = makeEl(doc, "p", { "data-assertion": id, "data-status": ok ? "PASS" : "FAIL" }, text);
    assertionsEl.appendChild(line);
    return text;
  }

  function publishLog() {
    logEl.textContent = JSON.stringify(records, null, 2);
    var rejected = 0;
    for (var i = 0; i < records.length; i++) {
      if (!records[i].ok) rejected = rejected + 1;
    }
    summaryEl.textContent =
      "QA3146-SUMMARY calls=" + records.length +
      " rejected=" + rejected +
      " probes=" + PLAN.probeCount +
      " done=" + (halted ? "halted" : "running");
  }

  function showRefusal(refusal) {
    var code = codeOf(refusal);
    /* The refusal must be DISPLAYABLE: both the code and the whole object are
       rendered as text -- never colour-only, never swallowed. */
    codeEl.textContent = code || "(no code on the caught value)";
    codeEl.setAttribute("data-refusal-code", code || "none");
    refusalEl.textContent = safeString(refusal);
  }

  function identityAssertion() {
    if (String(ctx.appId) !== PLAN.appId) {
      publishAssertion("HDR", false, "app-id-mismatch expected=" + PLAN.appId + " actual=" + String(ctx.appId));
    } else if (String(ctx.version) !== PLAN.version) {
      publishAssertion("HDR", false, "version-mismatch expected=" + PLAN.version + " actual=" + String(ctx.version));
    } else {
      publishAssertion("HDR", true, "app=" + PLAN.appId + " version=" + PLAN.version);
    }
  }

  /* A reload inside one window reuses sessionStorage, so a stale stored mount id
     proves the document was reloaded instead of re-opened. Close + re-open destroys
     the browsing context, so it is allowed (a fresh document). */
  function reloadAssertion() {
    try {
      var key = "qa3146-mount-" + PLAN.fixtureId;
      var previous = window.sessionStorage.getItem(key);
      window.sessionStorage.setItem(key, mountId);
      if (previous && previous !== mountId) {
        publishAssertion("RELOAD", false, "document-reloaded previous=" + previous + " current=" + mountId);
      }
    } catch (error) {
      publishAssertion("RELOAD", false, "storage-unavailable: the reload control cannot run");
    }
  }

  /* ---- the ONE call route (never a raw command, except the ACL probe) ---- */
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

  /* The RAW handle, deliberately. One probe (F-7.10, the ACL row) must call
     registered commands DIRECTLY to prove the ACL is the second lock; a probe that
     only ever uses the shim cannot see it. */
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

  function substitute(value) {
    if (typeof value === "string") return value === "$CHILD_KEY" ? childKey : value;
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(substitute(value[i]));
      return list;
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = substitute(value[key]);
      }
      return out;
    }
    return value;
  }

  function settle(spec, raw) {
    var args = substitute(spec.args);
    var resolver = raw ? invokeRaw : invoke;
    return resolver(spec.action, args).then(
      function (value) {
        records.push({ action: spec.action, raw: Boolean(raw), ok: true, value: value });
        return { ok: true, value: value, refusal: null, action: spec.action };
      },
      function (refusal) {
        records.push({ action: spec.action, raw: Boolean(raw), ok: false, refusal: refusal });
        showRefusal(refusal);
        return { ok: false, value: null, refusal: refusal, action: spec.action };
      }
    );
  }

  /* ---- assertion evaluation ---- */
  function subjectOf(outcome) {
    if (!outcome) return undefined;
    return outcome.ok ? outcome.value : outcome.refusal;
  }

  function codesClause(outcomes) {
    var parts = [];
    for (var i = 0; i < outcomes.length; i++) {
      var outcome = outcomes[i];
      if (!outcome) {
        parts.push("aborted");
        continue;
      }
      parts.push(outcome.ok ? "ok" : codeOf(outcome.refusal) || "refused");
    }
    return "codes=" + parts.join(",");
  }

  function expectationFailure(expect, outcome) {
    if (!expect || expect === "any") return "";
    if (expect === "ok") {
      return outcome.ok ? "" : "expected to resolve, refused with " + (codeOf(outcome.refusal) || "no code");
    }
    if (expect === "refuse") return outcome.ok ? "expected a refusal, resolved" : "";
    if (expect.indexOf("refuse:") === 0) {
      var wanted = expect.slice(7);
      if (outcome.ok) return "expected refusal " + wanted + ", resolved";
      var code = codeOf(outcome.refusal);
      if (code !== wanted) return "expected refusal " + wanted + ", got " + (code || "no code");
      return "";
    }
    return "";
  }

  function onlyCodesAllow(check, target) {
    if (!check.onlyCodes || check.onlyCodes.length === 0) return true;
    var code = target && !target.ok ? codeOf(target.refusal) : "ok";
    for (var i = 0; i < check.onlyCodes.length; i++) {
      if (check.onlyCodes[i] === code) return true;
    }
    return false;
  }

  function checkFailure(check, outcomes) {
    var target = outcomes[check.on - 1];
    if (!onlyCodesAllow(check, target)) return "";
    var subject = subjectOf(target);

    if (check.kind === "pathEq") {
      var actual = readPath(subject, check.path);
      if (String(renderValue(actual)) !== String(check.eq)) {
        return (check.name || check.path) + " expected " + String(check.eq) + " got " + renderValue(actual);
      }
      return "";
    }
    if (check.kind === "present") {
      var value = readPath(subject, check.path);
      var absent = value === undefined || value === null || String(value) === "";
      return absent ? (check.name || check.path) + " is absent" : "";
    }
    if (check.kind === "containsRow") {
      var rows = readPath(subject, check.path || "rows");
      if (!Array.isArray(rows)) return (check.name || "rows") + " is not an array";
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (row && typeof row === "object" && String(renderValue(readPath(row, check.field))) === String(check.value)) {
          return "";
        }
      }
      return (check.name || "rows") + " has no row with " + check.field + "=" + String(check.value);
    }
    if (check.kind === "textExcludes") {
      var hit = containsToken(textOf(subject), check.tokens);
      return hit ? (check.name || "text") + " " + hit : "";
    }
    if (check.kind === "textIncludesAny") {
      var text = lower(textOf(subject));
      for (var t = 0; t < check.tokens.length; t++) {
        if (text.indexOf(lower(check.tokens[t])) !== -1) return "";
      }
      return (check.name || "text") + " names none of " + check.tokens.join(",");
    }
    if (check.kind === "notCode") {
      if (!target || target.ok) return "";
      var got = codeOf(target.refusal);
      for (var n = 0; n < check.codes.length; n++) {
        if (got === check.codes[n]) return (check.name || "code") + " must not be " + got;
      }
      return "";
    }
    if (check.kind === "sameExcept") {
      var first = textOf(subjectOf(outcomes[check.a - 1]));
      var second = textOf(subjectOf(outcomes[check.b - 1]));
      return stripTokens(first, check.strip) === stripTokens(second, check.strip)
        ? ""
        : (check.name || "details") + " differ";
    }
    return "unknown check kind " + check.kind;
  }

  function publishProbeLine(ids, ok, detail) {
    for (var i = 0; i < ids.length; i++) publishAssertion(ids[i], ok, detail);
  }

  function runProbe(probe) {
    var outcomes = [];
    var chain = Promise.resolve();
    for (var i = 0; i < probe.steps.length; i++) {
      (function (stepSpec) {
        chain = chain.then(function () {
          if (halted) return null;
          return settle(stepSpec.call, Boolean(stepSpec.call.raw)).then(function (outcome) {
            outcomes.push(outcome);
            publishLog();
            return outcome;
          });
        });
      })(probe.steps[i]);
    }
    var ids = probe.ids || [probe.id];
    return chain.then(function () {
      if (halted) return "";
      var clauses = codesClause(outcomes);
      for (var s = 0; s < probe.steps.length; s++) {
        if (!outcomes[s]) {
          publishProbeLine(ids, false, clauses + " aborted before step " + (s + 1));
          return "";
        }
        var failure = expectationFailure(probe.steps[s].expect, outcomes[s]);
        if (failure) {
          publishProbeLine(ids, false, clauses + " step " + (s + 1) + " " + failure);
          return "";
        }
      }
      var checks = probe.checks || [];
      for (var c = 0; c < checks.length; c++) {
        var failed = checkFailure(checks[c], outcomes);
        if (failed) {
          publishProbeLine(ids, false, clauses + " " + failed);
          return "";
        }
      }
      var facts = [clauses];
      var factSpecs = probe.facts || [];
      for (var f = 0; f < factSpecs.length; f++) {
        var fact = factSpecs[f];
        facts.push(fact.name + "=" + renderValue(readPath(subjectOf(outcomes[fact.on - 1]), fact.path)));
      }
      var extras = probe.extraFacts || [];
      for (var e = 0; e < extras.length; e++) {
        var extra = extras[e];
        facts.push(extra.name + "=" + (extra.value === "$CHILD_KEY" ? childKey : String(extra.value)));
      }
      var detail = facts.join(" ");
      publishProbeLine(ids, true, detail);
      return detail;
    });
  }

  function runAllProbes() {
    var chain = Promise.resolve();
    for (var i = 0; i < PLAN.probes.length; i++) {
      (function (probe) {
        chain = chain.then(function () {
          return runProbe(probe);
        });
      })(PLAN.probes[i]);
    }
    return chain.then(
      function () {
        publishLog();
        summaryEl.textContent =
          "QA3146-SUMMARY calls=" + records.length +
          " probes=" + PLAN.probeCount +
          " done=" + (halted ? "halted" : "true");
      },
      function (error) {
        publishAssertion("RUNNER", false, "the probe runner threw: " + textOf(error));
      }
    );
  }

  /* ---- the consent watcher (consent fixtures only) -------------------------
     The grant/revoke controls live in the HOST settings pane, so this document
     cannot press them. It polls the consent-gated call instead and publishes each
     STATE TRANSITION as a line, with the mount id: a decision that follows the
     host without a reload is exactly what F-7.18 / F-7.27 assert. */
  function startConsentWatch() {
    var spec = PLAN.consent;
    if (!spec) return;
    var state = "";
    var busy = false;
    var resetProbed = false;

    function publishConsent(next, extra) {
      consentEl.textContent =
        "QA3146-CONSENT app=" + PLAN.appId + " mount=" + mountId + " state=" + next + " " + extra;
    }

    function queryOnce() {
      return invoke(spec.queryAction, substitute(spec.queryArgs)).then(
        function (value) {
          return { ok: true, code: "", refusal: null, value: value };
        },
        function (refusal) {
          return { ok: false, code: codeOf(refusal), refusal: refusal, value: null };
        }
      );
    }

    function probeResetOnce() {
      if (resetProbed) return Promise.resolve();
      resetProbed = true;
      return settle({ action: "pg_database_reset", args: {} }, false).then(function (outcome) {
        publishLog();
        var clauses = codesClause([outcome]);
        if (outcome.ok) {
          halted = true;
          publishAssertion(spec.resetId, false, clauses + " FATAL: pg_database_reset was ALLOWED past the consent gate");
          return;
        }
        var code = codeOf(outcome.refusal);
        var capability = renderValue(readPath(outcome.refusal, "capability"));
        if (code !== "consent_required" || capability !== "high-risk.database-reset") {
          publishAssertion(
            spec.resetId,
            false,
            clauses + " capability=" + capability + " expected consent_required on high-risk.database-reset"
          );
          return;
        }
        publishAssertion(spec.resetId, true, clauses + " capability=" + capability + " queryGrant=held");
      });
    }

    function tick() {
      if (halted || busy) return;
      busy = true;
      queryOnce().then(
        function (outcome) {
          var next = outcome.ok || outcome.code !== "consent_required" ? "granted" : "consent";
          var extra = "query=" + (outcome.ok ? "resolved" : outcome.code || "unknown");
          if (!outcome.ok) {
            var capability = readPath(outcome.refusal, "capability");
            if (capability) extra = extra + " capability=" + renderValue(capability);
          }
          publishConsent(next, extra);
          if (state === "") {
            state = next;
            /* A document that loads with the grant ALREADY held (the post-restart
               case, F-7.22) sees no transition -- so the once-only reset probe must
               fire on the first observation too, not only on consent-to-granted. */
            if (next === "granted") return probeResetOnce();
            return null;
          }
          if (next === state) return null;
          var fromTo = state + "-to-" + next;
          state = next;
          var ids = spec.transitionIds || [];
          for (var i = 0; i < ids.length; i++) {
            publishAssertion(ids[i], true, "transition " + fromTo + " " + extra + " mount=" + mountId + " reload=no");
          }
          if (next === "granted") return probeResetOnce();
          return null;
        },
        function (error) {
          publishAssertion(spec.resetId, false, "the consent watcher threw: " + textOf(error));
        }
      ).then(function () {
        busy = false;
      });
    }

    tick();
    window.setInterval(tick, spec.intervalMs || 2000);
  }

  /* ---- the data watch (a dropped write must be OBSERVED, never masked) -----
     Re-reading a row in a still-open document is the only way to see another
     application's write land without an inject path. One line per observed STATE
     CHANGE, so a stable row stays quiet (a PASS at the first observation states
     the baseline it is guarding). */
  function startDataWatch() {
    var spec = PLAN.watch;
    if (!spec) return;
    var last = "";

    function observe(rows) {
      if (!Array.isArray(rows)) return "not-an-array";
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row && typeof row === "object" && String(renderValue(readPath(row, spec.field))) === String(spec.value)) {
          return "expected";
        }
      }
      for (var j = 0; j < rows.length; j++) {
        var other = rows[j];
        if (other && typeof other === "object") {
          return "changed:" + renderValue(readPath(other, spec.field));
        }
      }
      return "missing";
    }

    function tick() {
      if (halted) return;
      invoke(spec.action, substitute(spec.args)).then(
        function (value) {
          var state = observe(readPath(value, spec.path || "rows"));
          if (state === last) return;
          last = state;
          if (state === "expected") {
            publishAssertion(spec.id, true, "watch value=" + String(spec.value) + " rows-observed");
          } else {
            publishAssertion(spec.id, false, "watch state=" + state + " expected value=" + String(spec.value));
          }
        },
        function (refusal) {
          publishAssertion(spec.id, false, "watch read refused with " + (codeOf(refusal) || "no code"));
        }
      );
    }

    tick();
    window.setInterval(tick, spec.intervalMs || 2000);
  }

  /* The programmable surface is kept for a future HOST-SIDE inject path (a
     Toolsmith item); no row in this suite depends on it. */
  window.__QA3146 = {
    results: function () {
      return records;
    },
    probes: function () {
      return PLAN.probeIds;
    }
  };

  /* mount() returns synchronously: the probe plan runs on a floating continuation so
     a slow step can never be mistaken for a mount-timeout (R-4.2's signal stays clean). */
  identityAssertion();
  reloadAssertion();
  publishLog();
  publishTheme();
  window.setInterval(publishTheme, 1000);
  runAllProbes().then(function () {
    startConsentWatch();
    startDataWatch();
  });
}
`;

/**
 * The shipped `main.js` for one fixture: the shared self-driving module with THAT
 * fixture's probe plan embedded as data. The plan is a pure function of the catalog,
 * so two runs emit byte-identical modules (no clock, no randomness at build time).
 */
function capabilityProbeModule(fixture) {
  const planJson = JSON.stringify(buildProbePlan(fixture), null, 2);
  return CAPABILITY_PROBE_MODULE.replace('__PLAN_JSON__', () => planJson);
}

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
  } else if (fixture.openable) {
    const moduleText = moduleBytes.toString('utf8');
    if (!/export function mount\s*\(/.test(moduleText)) {
      problems.push('main.js does not export the mount function the host calls');
    }
    /* --- the rendered mirror is the TEST TRANSPORT: assert it is really there --- */
    if (!moduleText.includes('data-qa3146-header')) {
      problems.push('main.js does not render the deterministic header block [data-qa3146-header]');
    }
    if (!moduleText.includes('data-qa3146-document')) {
      problems.push('main.js does not render the per-document line [data-qa3146-document]');
    }
    if (!moduleText.includes('data-qa3146-theme')) {
      problems.push('main.js does not render the live theme line [data-qa3146-theme]');
    }
    if (!moduleText.includes('data-assertion')) {
      problems.push('main.js does not render per-assertion lines [data-assertion]');
    }
    if (!moduleText.includes('"QA3146-FIXTURE app="') || !moduleText.includes('" capabilities="')) {
      problems.push('the header line does not carry app/version/capabilities in the fixed grammar');
    }
    if (moduleText.includes('__PLAN_JSON__')) {
      problems.push('the probe plan placeholder was never substituted');
    }
    const plan = buildProbePlan(fixture);
    if (plan.probes.length === 0) {
      problems.push('fixture has no probe plan: nothing would ever be rendered');
    }
    if (plan.probeCount !== plan.probes.length) {
      problems.push('probeCount and probes disagree');
    }
    for (const probe of plan.probes) {
      if (!plan.probeIds.includes(probe.id)) {
        problems.push('probe ' + probe.id + ' is not advertised in the header probe list');
      }
      if (!moduleText.includes('"' + probe.id + '"')) {
        problems.push('probe ' + probe.id + ' is not embedded in main.js');
      }
      if (!Array.isArray(probe.steps) || probe.steps.length === 0) {
        problems.push('probe ' + probe.id + ' has no steps');
      }
      for (const stepSpec of probe.steps || []) {
        if (!stepSpec.call || typeof stepSpec.call.action !== 'string') {
          problems.push('probe ' + probe.id + ' has a step with no action');
        }
      }
    }
    /* A probe that cannot fail is not a proof: every non-control probe must carry at
       least one expectation or check beyond "any". */
    if (!fixture.mustPrintFail) {
      for (const probe of plan.probes) {
        const hasExpectation = probe.steps.some((s) => s.expect && s.expect !== 'any');
        const hasChecks = Array.isArray(probe.checks) && probe.checks.length > 0;
        if (!hasExpectation && !hasChecks) {
          problems.push('probe ' + probe.id + ' asserts nothing (no expectation, no check)');
        }
      }
    }
    /* --- the NEGATIVE CONTROL must be a control: knowingly false, and reachable --- */
    if (fixture.mustPrintFail) {
      if (!moduleText.includes('MIRROR-CONTROL')) {
        problems.push('the mirror control lost its MIRROR-CONTROL probe');
      }
      const controlProbe = plan.probes[0];
      const firstStep = controlProbe && controlProbe.steps ? controlProbe.steps[0] : null;
      if (!firstStep || String(firstStep.expect).indexOf('refuse:') !== 0) {
        problems.push('the mirror control\'s probe must EXPECT a refusal (a knowingly false expectation)');
      }
      if (!firstStep || String(firstStep.call.action).indexOf('application_data_read') !== 0) {
        problems.push('the mirror control must drive a read of its own declared table');
      }
    }
  }

  return problems;
}

function packageEntries(fixture) {
  return [
    { name: 'fredo-app.json', data: Buffer.from(JSON.stringify(manifestFor(fixture), null, 2) + '\n', 'utf8') },
    { name: 'index.html', data: Buffer.from(documentHtml(fixture.displayName, fixture.id), 'utf8') },
    { name: 'main.js', data: Buffer.from(capabilityProbeModule(fixture), 'utf8') },
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
capabilities round-trip, mount export, the EXACT capability defect for a refusal
fixture, and -- for a self-driving fixture -- that every probe id it promises is
embedded in main.js and that the rendered mirror hooks exist). Exit code is
non-zero if any self-check fails.

Every openable package is SELF-DRIVING: on mount it runs its own probe plan and
mirrors every outcome as visible text, so the tester reads it with a native
accessibility (UIA) read / native window capture instead of tauri_webview_* (which
cannot reach an installed-* window). qa3146-mirror-control is the NEGATIVE CONTROL:
it must print a FAIL line, which is how a reader knows the mirror really ran.

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
      selfDriving: Boolean(item.fixture.openable),
      mustPrintFail: Boolean(item.fixture.mustPrintFail),
      probeIds: buildProbePlan(item.fixture).probeIds,
      declares: item.fixture.declares,
      capabilities: item.fixture.capabilities,
      expectedInstallRefusal: item.fixture.expectedInstallRefusal || null,
      entries: item.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
      asserts: item.fixture.asserts,
      dom: item.fixture.dom,
    })),
    mirror: {
      why:
        'Every installed-* window is unreachable by tauri_webview_execute_js / dom_snapshot / ' +
        'find_element / screenshot / console ("Request timeout after 2000ms", #3147). So each ' +
        'openable package drives itself on mount and renders its results as text.',
      readWith:
        'A native accessibility (UIA) text read of the installed-<id> window, corroborated by a ' +
        'native window capture. Never a tauri_webview_* call.',
      header: '[data-qa3146-header] one deterministic line: app= version= capabilities= tables= probes=',
      document: '[data-qa3146-document] one per-document line: app= version= ready= mount= loaded= origin=',
      theme:
        '[data-qa3146-theme] the live theme readout, re-published every second: ' +
        'QA3146-THEME theme.body-bg= theme.card-bg= theme.text-primary= theme.accent-primary= colorScheme= mount=',
      assertions:
        '[data-qa3146-assertions] one <p data-assertion="<id>" data-status="PASS|FAIL"> per probe: ' +
        '"PASS <id> codes=<c1>,<c2> ..." or "FAIL <id> codes=... <reason>"',
      consent: '[data-qa3146-consent] the live consent state line (consent fixtures only)',
      record: '[data-refusal-code] / [data-refusal-json] / [data-call-log] / [data-qa3146-summary]',
      negativeControl: 'qa3146-mirror-control MUST print a FAIL line; a missing line means the mirror never ran',
    },
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
    pad('id', 24) + pad('zip', 32) + pad('bytes', 8) + pad('openable', 10) + pad('lines', 8) + pad('refusal', 24) + 'sha256',
    pad('--', 24) + pad('---', 32) + pad('-----', 8) + pad('--------', 10) + pad('-----', 8) + pad('-------', 24) + '------',
  ];
  for (const item of built) {
    const refusal = item.fixture.expectedInstallRefusal
      ? item.fixture.expectedInstallRefusal.code
      : '-';
    const probeCount = item.fixture.openable ? buildProbePlan(item.fixture).probeIds.length : 0;
    lines.push(
      pad(item.fixture.id, 24) +
        pad(item.fileName, 32) +
        pad(item.bytes, 8) +
        pad(item.fixture.openable ? 'yes' : 'no', 10) +
        pad(probeCount, 8) +
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
  lines.push(
    'negative control: ' +
      built
        .filter((item) => item.fixture.mustPrintFail)
        .map((item) => item.fixture.id + ' -> MUST print a FAIL line')
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
      ' archives re-parsed, CRC-verified, manifest + capabilities round-tripped, every expected ' +
      'install refusal asserted at its exact field path, and every self-driving fixture carrying ' +
      'its probe plan + rendered mirror hooks (the mirror-control probe is knowingly false on purpose).'
  );
  console.log('DETERMINISM: run again and compare the sha256 column (must be identical).');
}

main();
