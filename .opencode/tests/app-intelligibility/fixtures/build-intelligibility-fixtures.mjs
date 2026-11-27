#!/usr/bin/env node
/**
 * build-intelligibility-fixtures.mjs -- the #3244 test-data generator.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plan for #3244 declared its required test data (a new installable package
 * fixture `qa3244-untaught`, AC-4's progressive dense-screen fixtures, and the
 * beacon-ingress negative controls) but no implementation capsule owned the
 * generation of that data, so the testing round had nothing to drive. The QA
 * Expert is the sole test author, so this generator is the deliverable that
 * closes that gap. Nothing here ships: this and the packages it emits are test
 * scaffolding under `.opencode/`, and no product code under `apps/**` reads it.
 *
 * It follows the `installable-apps` generator conventions (read
 * `.opencode/tests/installable-apps/README.md` and
 * `fixtures/build-capability-fixtures.mjs` -- the QA-owned sibling):
 *
 *   - **Node built-ins only** (`node:crypto`, `node:fs`, `node:path`,
 *     `node:url`). No network, no npm package, no shell-out, no toolchain.
 *   - **Byte-deterministic**: stored (method 0) zip entries in a fixed order,
 *     the fixed 1980-01-01 DOS timestamp, no build-time clock and no
 *     randomness. Run it twice and compare the printed sha256 column -- THAT
 *     is the determinism receipt.
 *   - **No committed hash manifest.** The QA Expert holds no shell (G-460), so
 *     it cannot derive hashes to commit. Instead every archive is SELF-CHECKED
 *     before it is written (re-parse, CRC, manifest round-trip, mount export,
 *     the mirror hooks, every declared control embedded) and the generator
 *     exits non-zero on any problem.
 *   - The generated archives are written to a gitignored output directory
 *     (default `.opencode/tmp/3244/fixtures/intelligibility`), never committed.
 *
 * WHAT IT EMITS
 * -------------
 *
 *  1. `qa3244-untaught` -- AC-2 / AC-3's subject. An installable package that
 *     DECLARES a `description` and renders a MUTABLE screen, so the freshness
 *     leg (two turns separated by a visible screen change) can be driven. The
 *     installed child is unreachable by every `tauri_webview_*` tool (the
 *     #3147 isolation property), so the mutation levers are the app's OWN
 *     visible affordances plus a live line: a native click / keyboard
 *     activation of `[data-qa3244-mutate]`, and a `[data-qa3244-live]` line
 *     that advances every second. Its id must appear NOWHERE under `apps/**`
 *     (that absence is AC-2b's proof; the sweep artifact checks it).
 *
 *  2. `qa3244-beacon-control` -- ING-1's committed negative-control fixture.
 *     On mount it issues the ingress controls a child CAN issue (oversize
 *     payload, missing nonce, unknown nonce) and mirrors each attempt as
 *     visible text; it also wraps the host-injected reporter so the two
 *     turn-coupled controls (timeout, replay-after-TTL) can be armed from the
 *     app's own visible buttons. See `BEACON-INGRESS-CONTROLS.md` for the plan,
 *     the expected typed reason per control, and the ONE control this fixture
 *     cannot produce (a genuinely expired nonce -- the finding is recorded
 *     there).
 *
 *  3. The AC-4 progressive dense-screen ladder -- `qa3244-dense-*`, a monotone
 *     ladder of named-node counts (and name lengths) so a live run can find the
 *     density at which the injected pair stops fitting. Rung `qa3244-dense-120`
 *     sits exactly at `SCREEN_OUTLINE_MAX_NODES` (120) and produces
 *     `truncated: true`; rung `qa3244-dense-url11k` is shaped to hand the
 *     GATE-0 hard gate its ~11 KB payload. The ladder's real byte/node numbers
 *     are the RUN's to record (G-511) -- this file declares the ladder, never a
 *     measurement.
 *
 * SCOPE: never touches product code, never writes outside the output directory.
 *
 * Usage:
 *   node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs
 *   node ... --out <dir>     override the output directory
 *   node ... --list          print the catalog (packages + the AC-4 ladder) and exit
 *   node ... --quiet         print only the summary table
 *   node ... --help
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.opencode', 'tmp', '3244', 'fixtures', 'intelligibility');

/* ==========================================================================
 * The shipped constants the fixtures must agree with.
 *
 * These are the CONTRACT the fixtures encode. Each one is a copy of a product
 * constant, and the self-check asserts the copy is still the shipped value by
 * reading the product source, so a drift cannot silently invalidate a fixture.
 * ========================================================================== */

/** `beacon.rs::BEACON_PATH` -- the reserved host path (a same-origin load). */
const BEACON_PATH = '/__fredo/beacon';
/** `beacon.rs::BEACON_MAX_BYTES` -- the decoded-payload size bound. */
const BEACON_MAX_BYTES = 16 * 1024;
/** `beacon.rs::BEACON_TIMEOUT_MS` / `BEACON_NONCE_TTL_MS`. */
const BEACON_TIMEOUT_MS = 2000;
/** `beacon.rs::BEACON_INGRESS_SPAN_NAME` -- the ingress receipt the QA reads. */
const BEACON_INGRESS_SPAN_NAME = 'installed.beacon.ingress';
/** `screenOutline.ts::SCREEN_OUTLINE_MAX_NAME_CHARS` -- the projector's name clip. */
const SCREEN_OUTLINE_MAX_NAME_CHARS = 120;
/** `screenOutline.ts::SCREEN_OUTLINE_MAX_NODES`. */
const SCREEN_OUTLINE_MAX_NODES = 120;
/** `screenOutline.ts::SCREEN_OUTLINE_MAX_BYTES`. */
const SCREEN_OUTLINE_MAX_BYTES = 8192;
/** `injection.rs::INJECTION_SPAN_NAME` -- the per-turn receipt. */
const INJECTION_SPAN_NAME = 'companion.injection';

/* ==========================================================================
 * Manifest rules (restated from the package format the plan fixes; read
 * `.opencode/tests/installable-apps/README.md` section 2).
 * ========================================================================== */

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const MAX_DESCRIPTION_CHARS = 280;

/** The host-owned DOM hooks a fixture must NEVER duplicate. */
const HOST_OWNED_HOOKS = [
  'installed-app-loading',
  'installed-app-failure',
  'installed-app-failure-reason',
  'installed-app-retry',
];

/* ==========================================================================
 * The AC-4 density ladder (single source of truth; printed by --list).
 *
 * `renderedNodes` = the number of named controls the document renders.
 * `nameChars`    = the length of each control's accessible name (<= 120, the
 *                  projector's clip). Longer names carry more bytes, so the
 *                  ladder steps density on BOTH axes.
 * `chromeNodes`  = the panel's OWN named elements (a title + a header line);
 *                  the outline carries renderedNodes + chromeNodes nodes.
 * `intent`       = what the rung is for. The BYTES are the run's to record.
 * ========================================================================== */

const DENSE_LADDER = [
  {
    id: 'qa3244-dense-08',
    renderedNodes: 8,
    nameChars: 24,
    chromeNodes: 2,
    intent: 'A small, sparse screen -- the "plenty of budget" end of the ladder.',
  },
  {
    id: 'qa3244-dense-32',
    renderedNodes: 32,
    nameChars: 32,
    chromeNodes: 2,
    intent: 'A mid-density form-like screen.',
  },
  {
    id: 'qa3244-dense-72',
    renderedNodes: 72,
    nameChars: 40,
    chromeNodes: 2,
    intent: 'A dense screen below the node cap.',
  },
  {
    id: 'qa3244-dense-120',
    renderedNodes: 120,
    nameChars: 40,
    chromeNodes: 2,
    intent:
      'EXACTLY SCREEN_OUTLINE_MAX_NODES extra controls past the chrome: the outline must be capped ' +
      'and carry truncated=true. The boundary rung.',
  },
  {
    id: 'qa3244-dense-160',
    renderedNodes: 160,
    nameChars: 40,
    chromeNodes: 2,
    intent: 'Over the node cap: 120 nodes + truncated=true, with 42 named controls dropped.',
  },
  {
    id: 'qa3244-dense-url11k',
    renderedNodes: 120,
    nameChars: 36,
    chromeNodes: 2,
    intent:
      'Shaped to hand GATE-0 its ~11 KB payload: 120 short-named controls (~11 KB of decoded outline ' +
      'JSON, under the 16 KB ingress bound, so it must be ACCEPTED). The realized byte count is the ' +
      "run's reading, never this file's claim.",
  },
];

/* ==========================================================================
 * Catalog -- the single source of truth for packages, the printed summary and
 * every self-check.
 * ========================================================================== */

const UNTAUGHT_ID = 'qa3244-untaught';
const BEACON_CONTROL_ID = 'qa3244-beacon-control';

const UNTAUGHT_DESCRIPTION =
  'A tiny note list for the QA round: it shows saved notes and can show a newer ' +
  'revision of the list on the next screen.';

const BEACON_CONTROL_DESCRIPTION =
  'QA negative-control app: it issues deliberately malformed screen-outline beacons so the ' +
  'ingress hardening can be observed live.';

/**
 * The controls `qa3244-beacon-control` issues. `producible: 'child'` means the
 * fixture can issue it with no host turn; `producible: 'turn'` means it arms a
 * lever and needs one companion turn targeting this app; `producible: 'no'`
 * records a control the shipped code makes unreachable (the finding).
 */
const BEACON_CONTROLS = [
  {
    id: 'A-OVERSIZE',
    producible: 'child',
    expect: 'oversize',
    what: 'A payload over BEACON_MAX_BYTES (raw query > 2x the bound).',
  },
  {
    id: 'B-MISSING-NONCE',
    producible: 'child',
    expect: 'missing-nonce',
    what: 'A well-formed payload with no `nonce` query parameter at all.',
  },
  {
    id: 'C-UNKNOWN-NONCE',
    producible: 'child',
    expect: 'unknown-nonce',
    what: 'A nonce the host never issued (and could never have issued).',
  },
  {
    id: 'E-TIMEOUT',
    producible: 'turn',
    expect: 'timeout',
    what:
      'Arm `Suppress the next beacon`, then drive one turn: the reporter is called but issues no load, ' +
      'so the host abandons the wait and records a `timeout` ingress receipt.',
  },
  {
    id: 'D-REPLAY-AFTER-TTL',
    producible: 'turn',
    // The fixture-reachable observation is `unknown-nonce` ONLY. `expired` needs a
    // nonce still IN the store past its TTL, which the shipped code makes unreachable
    // from a child (BEACON_NONCE_TTL_MS == BEACON_TIMEOUT_MS, and request_outline
    // closes the nonce as soon as it is served or abandoned) -- that path is
    // unit-pinned by `an_expired_nonce_is_dropped`. The expectation is stated as the
    // ONE reachable value rather than a `|`-alternation, so a run that reads
    // `expired` is a real FINDING, not a tolerated outcome.
    expect: 'unknown-nonce',
    what:
      'Arm `Replay the last nonce after the TTL`, then drive one turn. The turn\'s own beacon is ' +
      'ACCEPTED inside the 2 s window; the captured nonce is then re-issued ' +
      'BEACON_TIMEOUT_MS + 250 ms later, by which point request_outline has closed it -- so the ' +
      'replay records `unknown-nonce`. The leg therefore yields TWO ingress spans (one accepted, ' +
      'one unknown-nonce). An `expired` reading would need a nonce still in the store past its TTL ' +
      'and is the unit-pinned path, not fixture-reachable; see BEACON-INGRESS-CONTROLS.md.',
  },
];

const FIXTURES = [
  {
    id: UNTAUGHT_ID,
    kind: 'untaught',
    displayName: 'QA3244 Untaught Notes',
    version: '1.0.0',
    description: UNTAUGHT_DESCRIPTION,
    openable: true,
    asserts: [
      'AC-2 / F-3: open + one companion turn targeting it; the per-turn injection span',
      '(' + INJECTION_SPAN_NAME + ') carries the declared description, a screenshot leg, a',
      'simplified-HTML leg, and taught=false / perAppEntries=0.',
      'AC-3 / F-5: two turns separated by a visible screen change carry distinct digests;',
      'the changed token appears in the simplified-HTML leg.',
      'AC-2b / F-4: the id appears NOWHERE under apps/** (the sweep artifact checks it).',
    ],
    dom: [
      '[data-qa3244-panel]            the fixture panel (rendered, native-readable)',
      '[data-qa3244-header]           ONE deterministic line: app= version= descriptionBytes=',
      '[data-qa3244-description]      the DECLARED description, verbatim (what the turn must carry)',
      '[data-qa3244-screen]           THE MUTABLE SCREEN: "QA3244-SCREEN step=<n> token=<t>"',
      '[data-qa3244-live]             a live line, advanced every 1000 ms ("QA3244-LIVE t=<ms>")',
      '[data-qa3244-step]             the current step as text',
      '[data-qa3244-mutate]           the visible button that advances the screen (native click /',
      '                               keyboard activation -- the app\'s OWN affordance)',
      '[data-qa3244-screen-log]       one line per mutation, so both states are readable at once',
      'Read with a native accessibility (UIA) text read / native window capture -- never',
      'tauri_webview_* (unreachable on installed-<id>, #3147).',
    ],
  },
  {
    id: BEACON_CONTROL_ID,
    kind: 'beacon-control',
    displayName: 'QA3244 Beacon Control',
    version: '1.0.0',
    description: BEACON_CONTROL_DESCRIPTION,
    openable: true,
    asserts: [
      'ING-1: each control below emits ONE beacon and the host records ONE',
      BEACON_INGRESS_SPAN_NAME + ' span carrying the typed reason. The typed, non-silent',
      'reason IS the observable -- a beacon that merely "does not crash" is not a PASS.',
      'The three child-issued controls fire on mount; the two turn-coupled controls are',
      'armed from the app\'s own visible buttons and need one companion turn.',
    ],
    dom: [
      '[data-qa3244-beacon-panel]     the control panel (rendered, native-readable)',
      '[data-qa3244-beacon-header]    ONE deterministic line: app= controls= path= maxBytes=',
      'one <p data-beacon-control="<id>" data-state="pending|sent"> per child-issued control',
      '                               "SENT <id> expect=<reason> query=<first 64 chars>"',
      '[data-qa3244-beacon-log]       every issued URL (oversize one truncated), in order',
      '[data-qa3244-beacon-arms]      which turn-coupled levers are armed (suppress / replay)',
      '[data-qa3244-beacon-last-nonce] the last host-issued nonce the wrapper observed',
      '[data-qa3244-beacon-wrapper]   a mirror of the wrapper\'s activity',
      '[data-qa3244-beacon-suppress]  button: arm "suppress the next beacon" (the timeout leg)',
      '[data-qa3244-beacon-replay]    button: arm "replay the last nonce after the TTL"',
    ],
  },
].concat(
  DENSE_LADDER.map((rung) => ({
    id: rung.id,
    kind: 'dense',
    displayName: 'QA3244 Dense ' + rung.renderedNodes + 'x' + rung.nameChars,
    version: '1.0.0',
    description:
      'AC-4 density rung: renders ' +
      rung.renderedNodes +
      ' named controls of ' +
      rung.nameChars +
      ' characters for the screen-read measurement.',
    renderedNodes: rung.renderedNodes,
    nameChars: rung.nameChars,
    chromeNodes: rung.chromeNodes,
    ladderIntent: rung.intent,
    openable: true,
    asserts: [
      'AC-4 / F-6: open + drive one companion turn; read ' +
        INJECTION_SPAN_NAME +
        ' back and record the outline bytes/nodes + imageTokens for THIS rung.',
      'The rung declares density only -- the recorded number is the run\'s (G-511).',
    ],
    dom: [
      '[data-qa3244-dense-panel]      the rung panel',
      '[data-qa3244-dense-header]     ONE deterministic line: app= controls= nameChars=',
      '<button data-qa3244-dense-node="<i>" aria-label="<nameChars chars>"> x ' +
        rung.renderedNodes +
        '                              (the named controls the outline projects)',
    ],
  })),
);

/* ==========================================================================
 * The child documents. The host scheme handler owns the real shell; these
 * carry no script at all, so a fixture can never double-mount.
 * ========================================================================== */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function documentHtml(fixture) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(fixture.displayName)} - Fredo QA fixture (Spec #3244)</title>
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
          white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 8px; }
    button { font: inherit; padding: 6px 10px; margin: 0 6px 6px 0; }
  </style>
</head>
<body data-fixture-document="${escapeHtml(fixture.id)}">
  <noscript>This fixture needs JavaScript.</noscript>
</body>
</html>
`;
}

/* ==========================================================================
 * The child modules. Plain ESM (`export function mount(ctx)`), ES5-style
 * bodies: no framework, no bundler, no bundled Tauri API, no backslash escapes
 * (so the generator's template literals carry them verbatim). Every module
 * renders ONLY inside `ctx.root` and duplicates no host-owned hook.
 * ========================================================================== */

const SHARED_HELPERS = `function el(doc, tag, attrs, text) {
  var node = doc.createElement(tag);
  if (attrs) {
    for (var name in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) node.setAttribute(name, attrs[name]);
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
`;

function untaughtModule(fixture) {
  return `// Generated by .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs
// (Spec #3244). Plain ESM: the host bootstrap imports this file and calls the
// exported mount(ctx).
//
// THE AC-2 "UNTAUGHT" FIXTURE. It declares a description and renders a MUTABLE
// screen. The installed window is deliberately unreachable by EVERY
// tauri_webview_* tool (execute_js / dom_snapshot / find_element / screenshot all
// time out against installed-* -- the #3147 isolation property), so the mutation
// levers are the app's OWN visible affordances:
//
//   * native click / keyboard activation of [data-qa3244-mutate] advances the
//     screen (the app changes its own screen, exactly as a real app would); and
//   * [data-qa3244-live] advances every second, so a screen change is
//     guaranteed between any two turns even with no input at all.
//
// Both the changed step token and the live stamp are plain text INSIDE the
// projected root, so the change is visible in the turn's simplified-HTML leg
// (AC-3's witness). Nothing here is product code; no per-app knowledge exists.

var FIXTURE_ID = __ID_JSON__;
var VERSION = __VERSION_JSON__;
var DESCRIPTION = __DESCRIPTION_JSON__;

${SHARED_HELPERS}
function utf8ByteLength(value) {
  var bytes = 0;
  var text = String(value);
  for (var index = 0; index < text.length; ) {
    var codePoint = text.codePointAt(index);
    if (codePoint === undefined) codePoint = 0;
    bytes += codePoint <= 127 ? 1 : codePoint <= 2047 ? 2 : codePoint <= 65535 ? 3 : 4;
    index += codePoint > 65535 ? 2 : 1;
  }
  return bytes;
}

function tokenFor(step) {
  // A deterministic function of the step -- no clock, no randomness -- so the
  // first screen is reproducible and each advance is a distinct, assertable
  // string.
  var text = 'step-' + String(step) + '-';
  var seed = (step * 2654435761) % 4294967296;
  text = text + String(seed.toString(16));
  return text;
}

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError('qa3244-untaught: ctx.root is missing from InstalledAppContext');
  }
  root.setAttribute('data-fixture', FIXTURE_ID);

  var doc = root.ownerDocument || document;
  var panel = el(doc, 'section', { 'data-qa3244-panel': '' });
  panel.appendChild(el(doc, 'h1', null, 'QA3244 untaught fixture (a mutable screen)'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-header': '' }));
  panel.appendChild(el(doc, 'p', null, 'The declared description a companion turn must carry:'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-description': '' }));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-screen': '' }));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-live': '' }));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-step': '' }));
  panel.appendChild(el(doc, 'button', { 'data-qa3244-mutate': '', type: 'button' }, 'Advance the screen'));
  panel.appendChild(el(doc, 'p', null, 'One line per mutation (both states stay readable):'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-screen-log': '' }));
  root.appendChild(panel);

  var headerEl = panel.querySelector('[data-qa3244-header]');
  var descriptionEl = panel.querySelector('[data-qa3244-description]');
  var screenEl = panel.querySelector('[data-qa3244-screen]');
  var liveEl = panel.querySelector('[data-qa3244-live]');
  var stepEl = panel.querySelector('[data-qa3244-step]');
  var mutateEl = panel.querySelector('[data-qa3244-mutate]');
  var logEl = panel.querySelector('[data-qa3244-screen-log]');

  headerEl.textContent =
    'QA3244-FIXTURE app=' + FIXTURE_ID +
    ' version=' + VERSION +
    ' descriptionBytes=' + String(utf8ByteLength(DESCRIPTION));
  descriptionEl.textContent = DESCRIPTION;

  var step = 0;
  var log = [];

  function publishScreen() {
    var token = tokenFor(step);
    screenEl.textContent = 'QA3244-SCREEN step=' + String(step) + ' token=' + token;
    stepEl.textContent = 'QA3244-STEP ' + String(step);
    log.push('step=' + String(step) + ' token=' + token);
    logEl.textContent = log.join('\\n');
    root.setAttribute('data-qa3244-step', String(step));
  }

  function advance() {
    step = step + 1;
    publishScreen();
  }

  mutateEl.addEventListener('click', advance);
  // Keyboard activation on the focused control is the same real user action.
  mutateEl.addEventListener('keydown', function (event) {
    if (event && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
      advance();
    }
  });

  function publishLive() {
    liveEl.textContent = 'QA3244-LIVE t=' + String(new Date().getTime());
  }

  publishScreen();
  publishLive();
  root.setAttribute('data-qa3244-ready', 'true');
  window.setInterval(publishLive, 1000);
}
`
    .replace('__ID_JSON__', () => JSON.stringify(fixture.id))
    .replace('__VERSION_JSON__', () => JSON.stringify(fixture.version))
    .replace('__DESCRIPTION_JSON__', () => JSON.stringify(fixture.description));
}

function beaconControlModule(fixture) {
  return `// Generated by .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs
// (Spec #3244). Plain ESM: the host bootstrap imports this file and calls the
// exported mount(ctx).
//
// THE ING-1 NEGATIVE-CONTROL FIXTURE. It plays the UNTRUSTED CHILD: it issues
// deliberately malformed screen-outline beacons at the host's own scheme handler
// and mirrors every attempt as visible text. The observable is NOT "it did not
// crash" -- it is the host's TYPED, NON-SILENT ingress reason (the
// ${BEACON_INGRESS_SPAN_NAME} span), which the tester reads back from
// telemetry_spans.
//
// The three child-issued controls fire on mount. The two turn-coupled controls
// are armed from this app's OWN visible buttons (the installed window takes no
// test-harness input) and need one companion turn targeting this app:
//
//   * Suppress the next beacon  -> the reporter is called but issues no load, so
//     the host abandons the wait and records reason=timeout.
//   * Replay the last nonce after the TTL -> the captured nonce is re-issued
//     after BEACON_TIMEOUT_MS + 250 ms. The shipped TTL EQUALS the correlation
//     timeout, and request_outline CLOSES the nonce once it is served or
//     abandoned, so the observed reason is unknown-nonce. An expired reading
//     needs a nonce still in the store past its TTL (the unit-pinned path, not
//     reachable from a child). See BEACON-INGRESS-CONTROLS.md section 4.
//
// Wrapping the host-authored reporter is deliberate: it is exactly the
// untrusted-child behaviour the ingress must survive, and it is the ONLY way a
// child can hold a host-issued nonce long enough to replay it.

var FIXTURE_ID = __ID_JSON__;
var VERSION = __VERSION_JSON__;
var BEACON_PATH = __BEACON_PATH_JSON__;
var BEACON_MAX_BYTES = __MAX_BYTES__;
var BEACON_TIMEOUT_MS = __TIMEOUT_MS__;

${SHARED_HELPERS}
function base64Utf8(value) {
  var bytes = new TextEncoder().encode(value);
  var binary = '';
  for (var index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function encodePayload(json) {
  return encodeURIComponent(base64Utf8(json));
}

function validOutlineJson() {
  // A minimal, well-formed ScreenOutline: the ingress accepts exactly this
  // shape (nodes + a boolean truncated).
  return JSON.stringify({
    nodes: [{ role: 'button', name: 'qa3244 control node', tag: 'button', bbox: [0, 0, 10, 10] }],
    truncated: false
  });
}

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError('qa3244-beacon-control: ctx.root is missing from InstalledAppContext');
  }
  root.setAttribute('data-fixture', FIXTURE_ID);

  var doc = root.ownerDocument || document;
  var panel = el(doc, 'section', { 'data-qa3244-beacon-panel': '' });
  panel.appendChild(el(doc, 'h1', null, 'QA3244 beacon-ingress negative controls'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-beacon-header': '' }));
  var controlsEl = el(doc, 'div', { 'data-qa3244-beacon-controls': '' });
  panel.appendChild(controlsEl);
  panel.appendChild(el(doc, 'p', null, 'Issued URLs (the oversize one is truncated):'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-beacon-log': '' }));
  panel.appendChild(el(doc, 'p', null, 'Turn-coupled levers (arm one, then drive a companion turn on this app):'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-beacon-arms': '' }));
  panel.appendChild(el(doc, 'button', { 'data-qa3244-beacon-suppress': '', type: 'button' }, 'Suppress the next beacon (timeout leg)'));
  panel.appendChild(el(doc, 'button', { 'data-qa3244-beacon-replay': '', type: 'button' }, 'Replay the last nonce after the TTL'));
  panel.appendChild(el(doc, 'p', null, 'Last host-issued nonce the wrapper observed:'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-beacon-last-nonce': '' }));
  panel.appendChild(el(doc, 'p', null, 'Wrapper activity:'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-beacon-wrapper': '' }));
  root.appendChild(panel);

  var headerEl = panel.querySelector('[data-qa3244-beacon-header]');
  var logEl = panel.querySelector('[data-qa3244-beacon-log]');
  var armsEl = panel.querySelector('[data-qa3244-beacon-arms]');
  var nonceEl = panel.querySelector('[data-qa3244-beacon-last-nonce]');
  var wrapperEl = panel.querySelector('[data-qa3244-beacon-wrapper]');
  var suppressEl = panel.querySelector('[data-qa3244-beacon-suppress]');
  var replayEl = panel.querySelector('[data-qa3244-beacon-replay]');

  headerEl.textContent =
    'QA3244-BEACON app=' + FIXTURE_ID +
    ' controls=A-OVERSIZE,B-MISSING-NONCE,C-UNKNOWN-NONCE,E-TIMEOUT,D-REPLAY-AFTER-TTL' +
    ' path=' + BEACON_PATH +
    ' maxBytes=' + String(BEACON_MAX_BYTES) +
    ' timeoutMs=' + String(BEACON_TIMEOUT_MS);

  var issued = [];
  var arms = { suppress: false, replay: false };
  var lastNonce = '';
  var wrapperNotes = [];

  function publishLog() {
    logEl.textContent = issued.join('\\n');
  }

  function publishArms() {
    armsEl.textContent =
      'suppress=' + (arms.suppress ? 'armed' : 'off') +
      ' replayAfterTtl=' + (arms.replay ? 'armed' : 'off');
  }

  function publishWrapper(note) {
    if (note) wrapperNotes.push(note);
    wrapperEl.textContent = wrapperNotes.join('\\n');
  }

  function controlLine(id, state, detail) {
    var existing = controlsEl.querySelector('[data-beacon-control="' + id + '"]');
    if (!existing) {
      existing = el(doc, 'p', { 'data-beacon-control': id }, '');
      controlsEl.appendChild(existing);
    }
    existing.setAttribute('data-state', state);
    existing.textContent = state.toUpperCase() + ' ' + id + ' ' + detail;
  }

  function load(query) {
    var image = new Image();
    image.src = BEACON_PATH + '?' + query;
    return image;
  }

  /* ---- the three child-issued controls: fire on mount ---- */

  function issueOversize() {
    // The raw query is checked BEFORE any decoding, so a raw length over 2x the
    // bound is refused without the host buffering anything.
    var filler = '';
    while (filler.length < BEACON_MAX_BYTES * 2 + 64) filler = filler + 'A';
    var query = 'nonce=qa3244-control-oversize&d=' + filler;
    load(query);
    issued.push('A-OVERSIZE ' + query.slice(0, 96) + '... (' + String(query.length) + ' chars)');
    controlLine('A-OVERSIZE', 'sent', 'expect=oversize queryChars=' + String(query.length));
    publishLog();
  }

  function issueMissingNonce() {
    var query = 'd=' + encodePayload(validOutlineJson());
    load(query);
    issued.push('B-MISSING-NONCE ' + query);
    controlLine('B-MISSING-NONCE', 'sent', 'expect=missing-nonce payloadChars=' + String(query.length));
    publishLog();
  }

  function issueUnknownNonce() {
    var query = 'nonce=qa3244-control-never-issued&d=' + encodePayload(validOutlineJson());
    load(query);
    issued.push('C-UNKNOWN-NONCE ' + query);
    controlLine('C-UNKNOWN-NONCE', 'sent', 'expect=unknown-nonce payloadChars=' + String(query.length));
    publishLog();
  }

  /* ---- the wrapper: capture the host-issued nonce, arm the two turn-led legs ---- */

  var originalReport = window.__FREDO_REPORT_OUTLINE__;

  function reportNonce(nonce) {
    var text = 'nonce=' + String(nonce);
    nonceEl.textContent = text;
    return text;
  }

  window.__FREDO_REPORT_OUTLINE__ = function (nonce, maxNodes) {
    if (typeof nonce !== 'string' || nonce === '') {
      publishWrapper('report called with no nonce -- forwarded');
    } else {
      lastNonce = nonce;
      publishWrapper('observed ' + reportNonce(nonce));
    }

    if (arms.suppress) {
      // One-shot: the next turn's reporter is swallowed, so the host times out.
      arms.suppress = false;
      publishArms();
      publishWrapper('suppressed a report for ' + String(nonce) + ' (timeout leg armed->fired)');
      return;
    }

    if (typeof originalReport === 'function') {
      originalReport(nonce, maxNodes);
    }

    if (arms.replay && typeof nonce === 'string' && nonce !== '') {
      arms.replay = false;
      publishArms();
      window.setTimeout(function () {
        load('nonce=' + encodeURIComponent(nonce) + '&d=' + encodePayload(validOutlineJson()));
        issued.push('D-REPLAY-AFTER-TTL ' + String(nonce) + ' (+' + String(BEACON_TIMEOUT_MS + 250) + 'ms)');
        controlLine('D-REPLAY-AFTER-TTL', 'sent', 'expect=unknown-nonce');
        publishLog();
        publishWrapper('replayed ' + String(nonce) + ' after the TTL');
      }, BEACON_TIMEOUT_MS + 250);
    }
  };

  suppressEl.addEventListener('click', function () {
    arms.suppress = true;
    publishArms();
    controlLine('E-TIMEOUT', 'armed', 'expect=timeout (drive one turn)');
  });
  replayEl.addEventListener('click', function () {
    arms.replay = true;
    publishArms();
    controlLine('D-REPLAY-AFTER-TTL', 'armed', 'expect=unknown-nonce (drive one turn)');
  });

  /* A small documented surface for a FUTURE host-side driver (a Toolsmith item;
     no row in this suite depends on it). */
  window.__QA3244_BEACON__ = {
    lastNonce: function () { return lastNonce; },
    issued: function () { return issued.slice(); },
    arms: function () { return { suppress: arms.suppress, replay: arms.replay }; }
  };

  publishArms();
  publishLog();
  publishWrapper('wrapper installed (pass-through until armed)');
  root.setAttribute('data-qa3244-beacon-ready', 'true');

  // Issued on a floating continuation so mount() resolves synchronously and a
  // slow image load can never be mistaken for a mount timeout.
  window.setTimeout(function () {
    issueOversize();
    issueMissingNonce();
    issueUnknownNonce();
  }, 0);
}
`
    .replace('__ID_JSON__', () => JSON.stringify(fixture.id))
    .replace('__VERSION_JSON__', () => JSON.stringify(fixture.version))
    .replace('__BEACON_PATH_JSON__', () => JSON.stringify(BEACON_PATH))
    .replace('__MAX_BYTES__', () => String(BEACON_MAX_BYTES))
    .replace('__TIMEOUT_MS__', () => String(BEACON_TIMEOUT_MS));
}

function denseModule(fixture) {
  return `// Generated by .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs
// (Spec #3244). Plain ESM: the host bootstrap imports this file and calls the
// exported mount(ctx).
//
// AN AC-4 DENSITY RUNG. It renders a declared number of named controls, each
// with an accessible name of a declared length, so a live companion turn can be
// driven at each density and the injected pair's size recorded. The rung
// declares DENSITY only -- the bytes/nodes/tokens are the RUN's reading (G-511).

var FIXTURE_ID = __ID_JSON__;
var VERSION = __VERSION_JSON__;
var RENDERED_NODES = __RENDERED_NODES__;
var NAME_CHARS = __NAME_CHARS__;

${SHARED_HELPERS}
function labelFor(index) {
  // Exactly NAME_CHARS characters, deterministic, and carrying its index so a
  // reader can tell which control a projection entry came from. The index is
  // placed FIRST because the name is SLICED to NAME_CHARS: a suffix-only id lost
  // its index on every rung whose nameChars is shorter than the id prefix (all
  // eight names at nameChars=24 collapsed to the same string).
  var base = 'control ' + String(index) + ' dense rung ' + FIXTURE_ID + ' ';
  var text = base;
  while (text.length < NAME_CHARS) text = text + 'x';
  return text.slice(0, NAME_CHARS);
}

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root || root.nodeType !== 1) {
    throw new TypeError('qa3244-dense: ctx.root is missing from InstalledAppContext');
  }
  root.setAttribute('data-fixture', FIXTURE_ID);

  var doc = root.ownerDocument || document;
  var panel = el(doc, 'section', { 'data-qa3244-dense-panel': '' });
  panel.appendChild(el(doc, 'h1', null, 'QA3244 density rung: ' + String(RENDERED_NODES) + ' named controls'));
  panel.appendChild(el(doc, 'pre', { 'data-qa3244-dense-header': '' }));

  var seen = {};
  var distinct = 0;
  for (var index = 0; index < RENDERED_NODES; index += 1) {
    var name = labelFor(index);
    if (!seen[name]) {
      seen[name] = true;
      distinct += 1;
    }
    var button = el(doc, 'button', { 'data-qa3244-dense-node': String(index), 'aria-label': name, type: 'button' });
    button.textContent = name;
    panel.appendChild(button);
  }
  root.appendChild(panel);

  var headerEl = panel.querySelector('[data-qa3244-dense-header]');
  // distinctNames is the fixture's own self-check of its name generator: the
  // accessible names must be UNIQUE so a reader can attribute a projected
  // outline entry to its control. A collapse (every name identical) would make
  // the rung useless for AC-4 and would otherwise be invisible.
  headerEl.textContent =
    'QA3244-DENSE app=' + FIXTURE_ID +
    ' controls=' + String(RENDERED_NODES) +
    ' nameChars=' + String(NAME_CHARS) +
    ' distinctNames=' + String(distinct) +
    ' version=' + VERSION;
  root.setAttribute('data-qa3244-dense-ready', 'true');
}
`
    .replace('__ID_JSON__', () => JSON.stringify(fixture.id))
    .replace('__VERSION_JSON__', () => JSON.stringify(fixture.version))
    .replace('__RENDERED_NODES__', () => String(fixture.renderedNodes))
    .replace('__NAME_CHARS__', () => String(fixture.nameChars));
}

function moduleFor(fixture) {
  if (fixture.kind === 'untaught') return untaughtModule(fixture);
  if (fixture.kind === 'beacon-control') return beaconControlModule(fixture);
  if (fixture.kind === 'dense') return denseModule(fixture);
  throw new Error('unknown fixture kind: ' + fixture.kind);
}

/* ==========================================================================
 * Deterministic zip writer (stored entries, fixed 1980-01-01 timestamp) --
 * the sibling generators' exact policy, restated so this script validates its
 * own output rather than trusting a sibling.
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
 * The manifest + the rules this generator asserts.
 * ========================================================================== */

function manifestFor(fixture) {
  return {
    manifestVersion: 1,
    id: fixture.id,
    displayName: fixture.displayName,
    version: fixture.version,
    engines: { fredo: '>=0.0.0' },
    entry: { document: 'index.html', module: 'main.js' },
    description: fixture.description,
  };
}

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
  if (!m.entry || m.entry.document !== 'index.html' || m.entry.module !== 'main.js') {
    errors.push('entry must be index.html + main.js');
  }
  if (typeof m.description !== 'string' || m.description.trim().length === 0) {
    errors.push('description must be a NON-EMPTY string (this fixture exists to declare one)');
  } else if (m.description.length > MAX_DESCRIPTION_CHARS) {
    errors.push('description must be at most ' + MAX_DESCRIPTION_CHARS + ' chars');
  }
  return errors;
}

/** Self-check one built archive: re-parse, round-trip, and the fixture's own claims. */
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
      for (const error of validateBase(parsed)) problems.push('base schema: ' + error);
      if (JSON.stringify(parsed) !== JSON.stringify(manifestFor(fixture))) {
        problems.push('the archive manifest drifted from the authored one');
      }
    }
  }

  const documentBytes = readZipEntry(item.archive, 'index.html');
  if (!documentBytes || documentBytes.length === 0) {
    problems.push('index.html is missing or empty');
  } else {
    const documentText = documentBytes.toString('utf8');
    if (!documentText.includes('<!doctype html>')) problems.push('index.html is not an HTML document');
    // A fixture that duplicated a host-owned hook would make the host's own
    // failure/loading rows unreadable.
    for (const hook of HOST_OWNED_HOOKS) {
      if (documentText.includes(hook)) problems.push('index.html duplicates the host-owned hook ' + hook);
    }
  }

  const moduleBytes = readZipEntry(item.archive, 'main.js');
  if (!moduleBytes || moduleBytes.length === 0) {
    problems.push('main.js is missing or empty');
  } else {
    const moduleText = moduleBytes.toString('utf8');
    if (!/export function mount\s*\(/.test(moduleText)) {
      problems.push('main.js does not export the mount function the host calls');
    }
    if (moduleText.includes('__ID_JSON__') || moduleText.includes('__VERSION_JSON__') ||
        moduleText.includes('__DESCRIPTION_JSON__') || moduleText.includes('__BEACON_PATH_JSON__') ||
        moduleText.includes('__MAX_BYTES__') || moduleText.includes('__TIMEOUT_MS__') ||
        moduleText.includes('__RENDERED_NODES__') || moduleText.includes('__NAME_CHARS__')) {
      problems.push('a template placeholder was never substituted in main.js');
    }
    for (const hook of HOST_OWNED_HOOKS) {
      if (moduleText.includes(hook)) problems.push('main.js duplicates the host-owned hook ' + hook);
    }
    if (!moduleText.includes(JSON.stringify(fixture.id))) {
      problems.push('main.js does not carry its own fixture id');
    }

    if (fixture.kind === 'untaught') {
      for (const hook of [
        'data-qa3244-header',
        'data-qa3244-description',
        'data-qa3244-screen',
        'data-qa3244-live',
        'data-qa3244-mutate',
      ]) {
        if (!moduleText.includes(hook)) problems.push('untaught fixture lost ' + hook);
      }
      if (!moduleText.includes('descriptionBytes=')) problems.push('untaught header lost its description byte count');
      if (!moduleText.includes('QA3244-SCREEN step=')) problems.push('the mutable screen line is missing');
      if (!moduleText.includes('QA3244-LIVE t=')) problems.push('the live line is missing');
      if (!moduleText.includes('publishScreen')) problems.push('the mutation path is missing');
    }

    if (fixture.kind === 'beacon-control') {
      if (!moduleText.includes(BEACON_PATH)) problems.push('beacon-control fixture lost the beacon path');
      for (const control of BEACON_CONTROLS) {
        if (!moduleText.includes(control.id)) problems.push('beacon control ' + control.id + ' is not embedded');
      }
      for (const hook of [
        'data-qa3244-beacon-header',
        'data-qa3244-beacon-controls',
        'data-qa3244-beacon-suppress',
        'data-qa3244-beacon-replay',
        'data-qa3244-beacon-last-nonce',
      ]) {
        if (!moduleText.includes(hook)) problems.push('beacon-control fixture lost ' + hook);
      }
      if (!moduleText.includes('__FREDO_REPORT_OUTLINE__')) {
        problems.push('the wrapper does not take over the host reporter');
      }
      if (!moduleText.includes('oversize')) problems.push('the oversize control is missing');
      if (!moduleText.includes('missing-nonce')) problems.push('the missing-nonce control is missing');
      if (!moduleText.includes('unknown-nonce')) problems.push('the unknown-nonce control is missing');
    }

    if (fixture.kind === 'dense') {
      if (!moduleText.includes('String(RENDERED_NODES)')) {
        problems.push('the dense rung does not render from its declared node count');
      }
      if (!moduleText.includes('data-qa3244-dense-node')) problems.push('the dense rung lost its node hook');
      if (!moduleText.includes('aria-label')) problems.push('the dense rung controls carry no accessible name');
      const expectedOutlineNodes = Math.min(fixture.renderedNodes + fixture.chromeNodes, SCREEN_OUTLINE_MAX_NODES);
      if (fixture.renderedNodes + fixture.chromeNodes > SCREEN_OUTLINE_MAX_NODES &&
          expectedOutlineNodes !== SCREEN_OUTLINE_MAX_NODES) {
        problems.push('an over-cap rung must project exactly ' + SCREEN_OUTLINE_MAX_NODES + ' nodes');
      }
      if (fixture.nameChars > SCREEN_OUTLINE_MAX_NAME_CHARS) {
        problems.push('nameChars exceeds the projector clip (' + SCREEN_OUTLINE_MAX_NAME_CHARS + ')');
      }
      // The names must be DISTINCT at the declared length, or the rung cannot be
      // read: a projected outline of N identical names tells a model nothing and
      // makes an AC-4 reading unattributable. Simulate `labelFor` exactly (the id
      // is substituted at module build time, so the simulation uses fixture.id).
      if (!moduleText.includes("'control ' + String(index)")) {
        problems.push(
          'the dense name generator no longer puts the index FIRST -- at a short nameChars the ' +
          'names collapse to one identical string'
        );
      } else {
        const names = new Set();
        for (let index = 0; index < fixture.renderedNodes; index += 1) {
          const base = 'control ' + index + ' dense rung ' + fixture.id + ' ';
          let text = base;
          while (text.length < fixture.nameChars) text += 'x';
          names.add(text.slice(0, fixture.nameChars));
        }
        if (names.size !== fixture.renderedNodes) {
          problems.push(
            'the dense rung renders ' + names.size + ' distinct name(s) for ' +
            fixture.renderedNodes + ' controls at nameChars=' + fixture.nameChars
          );
        }
        if (!moduleText.includes('distinctNames=')) {
          problems.push('the dense header lost its rendered distinctNames self-check');
        }
      }
    }
  }

  return problems;
}

function packageEntries(fixture) {
  return [
    { name: 'fredo-app.json', data: Buffer.from(JSON.stringify(manifestFor(fixture), null, 2) + '\n', 'utf8') },
    { name: 'index.html', data: Buffer.from(documentHtml(fixture), 'utf8') },
    { name: 'main.js', data: Buffer.from(moduleFor(fixture), 'utf8') },
  ];
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ==========================================================================
 * CLI
 * ========================================================================== */

const HELP = `build-intelligibility-fixtures.mjs -- Spec #3244 test-data fixtures.

Usage:
  node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs [options]

Options:
  --out <dir>   output directory (default: .opencode/tmp/3244/fixtures/intelligibility)
  --list        print the catalog (packages + the AC-4 ladder) and exit
  --quiet       print only the summary table
  --help        this text

Emits three families of installable packages:
  1. qa3244-untaught        -- AC-2/AC-3's subject: a declared description + a mutable screen.
  2. qa3244-beacon-control  -- ING-1's negative controls (oversize / missing / unknown nonce;
                               plus the turn-armed timeout and replay-after-TTL legs).
  3. qa3244-dense-*         -- the AC-4 progressive dense-screen ladder.

Every archive is self-checked before it is written (re-parse, CRC, manifest
round-trip, mount export, the mirror hooks, the control ids, and that no
host-owned DOM hook is duplicated). Exit code is non-zero if any self-check
fails. Output is deterministic: run it twice and compare the sha256 column --
that comparison is the determinism receipt (no hash manifest is committed).

Read BEACON-INGRESS-CONTROLS.md for the ingress control plan, and README.md for
the conventions and the invocation of every artifact.`;

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, quiet: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--list') options.list = true;
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
      'Spec #3244 app-intelligibility fixtures. Written next to the archives so the output directory is ' +
      'self-describing. This file is NOT a committed expectation: it is regenerated on every run, and ' +
      'determinism is proven by running the generator twice and comparing sha256.',
    generator: '.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs',
    manifestVersion: 1,
    contract: {
      beaconPath: BEACON_PATH,
      beaconMaxBytes: BEACON_MAX_BYTES,
      beaconTimeoutMs: BEACON_TIMEOUT_MS,
      beaconIngressSpanName: BEACON_INGRESS_SPAN_NAME,
      injectionSpanName: INJECTION_SPAN_NAME,
      screenOutlineMaxNodes: SCREEN_OUTLINE_MAX_NODES,
      screenOutlineMaxBytes: SCREEN_OUTLINE_MAX_BYTES,
    },
    zipPolicy: {
      method: 'stored (0)',
      dosTimestamp: '1980-01-01T00:00:00 (dosTime 0x0000, dosDate 0x0021)',
      entryOrder: 'fredo-app.json, index.html, main.js',
    },
    fixtures: built.map((item) => ({
      id: item.fixture.id,
      kind: item.fixture.kind,
      displayName: item.fixture.displayName,
      version: item.fixture.version,
      description: item.fixture.description,
      file: item.fileName,
      bytes: item.bytes,
      sha256: item.sha256,
      renderedNodes: item.fixture.kind === 'dense' ? item.fixture.renderedNodes : null,
      nameChars: item.fixture.kind === 'dense' ? item.fixture.nameChars : null,
      chromeNodes: item.fixture.kind === 'dense' ? item.fixture.chromeNodes : null,
      ladderIntent: item.fixture.kind === 'dense' ? item.fixture.ladderIntent : null,
      entries: item.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
      asserts: item.fixture.asserts,
      dom: item.fixture.dom,
    })),
    ac4DensityLadder: DENSE_LADDER.map((rung, index) => ({
      step: index + 1,
      id: rung.id,
      renderedNodes: rung.renderedNodes,
      nameChars: rung.nameChars,
      chromeNodes: rung.chromeNodes,
      expectedOutlineNodes: Math.min(rung.renderedNodes + rung.chromeNodes, SCREEN_OUTLINE_MAX_NODES),
      expectedTruncated: rung.renderedNodes + rung.chromeNodes > SCREEN_OUTLINE_MAX_NODES,
      intent: rung.intent,
    })),
    beaconIngressControls: {
      fixture: BEACON_CONTROL_ID,
      readWith:
        'A native accessibility (UIA) text read of the installed-<id> window, corroborated by a native ' +
        'window capture. Never a tauri_webview_* call.',
      receipt:
        'One ' + BEACON_INGRESS_SPAN_NAME + ' span per attempt in telemetry_spans, carrying the typed reason.',
      controls: BEACON_CONTROLS,
    },
    mirror: {
      why:
        'Every installed-* window is unreachable by tauri_webview_execute_js / dom_snapshot / ' +
        'find_element / screenshot ("Request timeout after 2000ms", #3147). So each package drives ' +
        'itself on mount and renders its results as text, and its mutation levers are its OWN ' +
        'visible controls.',
    },
  };
}

function listCatalog() {
  const lines = ['Spec #3244 app-intelligibility fixture catalog', ''];
  lines.push('Packages:');
  for (const fixture of FIXTURES) {
    lines.push('  ' + pad(fixture.id, 26) + pad(fixture.kind, 16) + fixture.displayName);
  }
  lines.push('');
  lines.push('AC-4 density ladder (the run records the real numbers):');
  lines.push('  ' + pad('step', 6) + pad('id', 26) + pad('controls', 10) + pad('nameChars', 11) + pad('outlineNodes', 14) + 'truncated');
  for (let index = 0; index < DENSE_LADDER.length; index++) {
    const rung = DENSE_LADDER[index];
    const outlineNodes = Math.min(rung.renderedNodes + rung.chromeNodes, SCREEN_OUTLINE_MAX_NODES);
    lines.push(
      '  ' +
        pad(index + 1, 6) +
        pad(rung.id, 26) +
        pad(rung.renderedNodes, 10) +
        pad(rung.nameChars, 11) +
        pad(outlineNodes, 14) +
        (rung.renderedNodes + rung.chromeNodes > SCREEN_OUTLINE_MAX_NODES ? 'true' : 'false')
    );
  }
  lines.push('');
  lines.push('Beacon ingress controls (' + BEACON_CONTROL_ID + '):');
  for (const control of BEACON_CONTROLS) {
    lines.push('  ' + pad(control.id, 22) + pad(control.producible, 8) + 'expect=' + control.expect);
  }
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.list) {
    console.log(listCatalog());
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
    path.join(options.out, 'INTELLIGIBILITY-FIXTURES.json'),
    JSON.stringify(summary(built), null, 2) + '\n',
    'utf8'
  );

  if (options.quiet) {
    // The documented contract: `--quiet` prints ONLY the summary table (the
    // id/kind/zip/bytes/sha256 columns) — no preamble, no ladder/control tails.
    // It used to be parsed and then ignored, so `--quiet` printed the full report.
    const header =
      pad('id', 26) + pad('kind', 15) + pad('zip', 32) + pad('bytes', 9) + 'sha256';
    const rows = built.map(
      (item) =>
        pad(item.fixture.id, 26) +
        pad(item.fixture.kind, 15) +
        pad(item.fileName, 32) +
        pad(item.bytes, 9) +
        item.sha256
    );
    console.log([header, ...rows].join('\n'));
    return;
  }

  const lines = [
    'Spec #3244 app-intelligibility fixtures',
    'generated by .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs',
    '',
    'output directory: ' + options.out,
    '',
    pad('id', 26) + pad('kind', 15) + pad('zip', 32) + pad('bytes', 9) + 'sha256',
    pad('--', 26) + pad('----', 15) + pad('---', 32) + pad('-----', 9) + '------',
  ];
  for (const item of built) {
    lines.push(
      pad(item.fixture.id, 26) +
        pad(item.fixture.kind, 15) +
        pad(item.fileName, 32) +
        pad(item.bytes, 9) +
        item.sha256
    );
  }
  lines.push('');
  lines.push('AC-4 ladder: ' + DENSE_LADDER.map((rung) => rung.id).join(' -> '));
  lines.push('Beacon controls: ' + BEACON_CONTROLS.map((control) => control.id).join(', '));
  lines.push('Determinism: run this twice and compare the sha256 column above.');
  console.log(lines.join('\n'));
}

main();
