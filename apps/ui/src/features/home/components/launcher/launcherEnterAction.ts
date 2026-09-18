/**
 * Spec #2882 ST-1 — THE ONE pure Enter decision for the launcher command bar.
 *
 * Why this module exists (R-6.3): the hint chip asked for by the spec must
 * "always state the action Enter will take", and the previous code implemented
 * the same exact-full-name rule TWICE, independently — the hint memo
 * (`LauncherShell.tsx:430`) and `commitBarQuery` (`:564-565`). Two copies can
 * drift; one exported decision function cannot. Both the hint and the Enter
 * handler MUST consume the helpers below, never re-derive them.
 *
 * What lives here:
 *   - `appNameMatches` / `findTopRankedMatch` — the whole-query matcher
 *     (R-5.1/R-5.3/R-5.4, PO clarification #1). It is deliberately stronger
 *     than the grid's substring filter: a query matches an app name only when
 *     it is (a) a whole-query prefix of the name, or (b) a whole word — or a
 *     contiguous run of whole words — occurring inside the name. Fragments
 *     (`Missing all the time` contains `Miss`) and aliases (`MM`) match
 *     nothing. Internal whitespace is `trim()`ed only, never collapsed, so the
 *     matcher and the existing substring filter agree.
 *   - `resolveEnterAction` — the binding precedence table (live capture → empty
 *     → dictated → typed match → send → none).
 *   - `enterHintLabel` — the single-source-of-truth copy derivation so the
 *     chip can never promise a different action than Enter performs.
 *
 * ST-5-fix addendum (QA-10 CLOSED): the LIVE launcher-origin capture is modelled
 * here ADDITIVELY, via the optional `captureLive` input, so the chip and Enter
 * keep deriving from ONE rule: while a capture is live Enter acts as NOTHING and
 * the chip reads `release Space to finish`. The wiring feeds the SAME
 * `captureLive` primitive into this module on both the hint path and the handler
 * path (R-6.3) — there is no second copy table anywhere.
 *
 * Pure by construction: no React, no DOM, no Tauri, no timers, no state — so
 * every rule is unit-pinned without a rendering harness.
 */
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

/** Where the bar's content came from. `'dictated'` survives user edits
 *  (PO clarification #2); only text typed from scratch is `'typed'`. */
export type EnterTextOrigin = 'typed' | 'dictated';

/**
 * The resolved Enter verdict.
 *
 * NOTE (declared deviation from the plan's literal union): the plan's binding
 * hint derivation distinguishes `↵ send transcript to Fredo` (dictated content)
 * from `↵ send to Fredo` (typed content), but its literal `{ kind: 'send' }`
 * variant carries no provenance and its `enterHintLabel` opts are
 * `{ busy, queryEmpty }` — so the two labels would be indistinguishable. The
 * `send` variant therefore carries `textOrigin`, which makes provenance
 * structural (the hint can never disagree with the handler) and preserves
 * `enterHintLabel`'s declared signature exactly. Recorded in the ST-1 report.
 */
export type LauncherEnterAction =
  | { kind: 'launch'; feature: FredoFeatureClass }
  | { kind: 'send'; textOrigin: EnterTextOrigin }
  | {
      kind: 'none';
      /**
       * `listening` (ST-5-fix, QA-10) — a launcher-origin capture is live: Enter
       * can neither finalize a held capture nor act on the bar's content. It is
       * the ONE no-op row whose instruction (`release Space to finish`) must
       * survive an EMPTY bar, which is the normal live-capture state.
       */
      reason: 'empty' | 'busy' | 'no-match-no-companion' | 'listening';
    };

/** The exact chip copy (UI/UX-owned wording, binding derivation). */
export const ENTER_HINT_COPY = {
  send: '↵ send to Fredo',
  sendTranscript: '↵ send transcript to Fredo',
  noMatch: 'no match',
  busy: 'Fredo is replying…',
  /** UI/UX §3 row 2 / §1 S3 — the live launcher-origin capture's only exit. */
  releaseToFinish: 'release Space to finish',
} as const;

/** `\b`-equivalent word character — the name is already lower-cased. */
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[a-z0-9_]/.test(ch);

/**
 * True when `needle` occurs in `haystack` delimited by word boundaries on both
 * sides — i.e. a whole word or a contiguous run of whole words. Manual boundary
 * checks (not a RegExp) so no query text is ever interpreted as a pattern.
 */
function isWholeWordRun(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? undefined : haystack[idx - 1];
    const after =
      idx + needle.length >= haystack.length ? undefined : haystack[idx + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
}

/**
 * R-5.1/R-5.4 — the whole-query matcher. Case-insensitive; the query is
 * `trim()`ed only (internal whitespace is preserved so this predicate and the
 * grid's `includes` filter agree). An empty/whitespace-only query matches
 * nothing.
 *
 *   `set`                 → `Settings`        (prefix)
 *   `Miss` / `miss`       → `Mission Monitor` (prefix)
 *   `monitor`             → `Mission Monitor` (whole word inside the name)
 *   `Mission Mon`         → `Mission Monitor` (longer prefix)
 *   `Missing all the time`→ no match          (neither prefix nor whole-word run)
 *   `MM`                  → no match          (no aliases/abbreviations)
 *   `ission`              → no match          (a partial word is a fragment)
 */
export function appNameMatches(query: string, name: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  const n = name.toLowerCase();
  return n.startsWith(q) || isWholeWordRun(n, q);
}

/**
 * R-5.3 / PO clarification #1 — the top-ranked match is the FIRST matching
 * entry of the array it is given, i.e. the earliest rule-matching entry of the
 * results list the grid renders (order is never re-sorted here).
 */
export function findTopRankedMatch(
  query: string,
  entries: readonly FredoFeatureClass[],
): FredoFeatureClass | null {
  for (const entry of entries) {
    if (appNameMatches(query, entry.name)) return entry;
  }
  return null;
}

export interface ResolveEnterActionInput {
  query: string;
  entries: readonly FredoFeatureClass[];
  textOrigin: EnterTextOrigin;
  companionActive: boolean;
  /**
   * ST-5-fix (QA-10) — a launcher-origin capture is live (`voice.listening &&
   * origin === 'launcher'`). OPTIONAL and additive: omitting it preserves the
   * pre-ST-5-fix verdict for every input, so the existing pins still hold.
   */
  captureLive?: boolean;
}

/**
 * The binding precedence (R-5/R-6, clarifications #1/#2, QA-10; #2892 ST-5):
 *
 *   0. `captureLive`                     → `{ none, 'listening' }` (a live
 *                                          capture outranks EVERY content rule:
 *                                          Enter can never finalize it, launch a
 *                                          partially transcribed live text, or
 *                                          dispatch a partial)
 *   1. empty query                       → `{ none, 'empty' }`
 *   2. `textOrigin === 'dictated'`       → `send` when `companionActive`, else
 *                                          `none` (a dictated transcript NEVER
 *                                          launches — clarification #2 / R-4.3)
 *   3. typed + app match                 → `launch`, INDEPENDENT of the companion
 *                                          (AC5 "present, away, off, or replying")
 *   4. typed, no match, `companionActive`→ `send`  (#2892 ST-5: a send is gated
 *                                          ONLY by `companionActive` — never by a
 *                                          reply in flight; an accepted send is
 *                                          queued by the entity)
 *   5. otherwise                         → `none`
 *
 * #2892 ST-5 REMOVED the `companionBusy` input: the old busy-gate rows (dictated
 * no-op, typed non-match no-op) are retired. Replying is no longer a bar-level
 * send gate — the entity owns accept/queue/interrupt, so Enter keeps its promise.
 * The `busy` OVER `listening` precedence (UI/UX §3 row 1 → row 2) survives at the
 * hint layer only (`enterHintLabel`), where both are no-ops but the copy differs.
 * The `'busy'` reason variant is retained for totality/back-compat; this resolver
 * no longer emits it.
 */
export function resolveEnterAction(input: ResolveEnterActionInput): LauncherEnterAction {
  // 0. ST-5-fix (QA-10) — a LIVE launcher-origin capture is a hard no-op, in every
  //    query state: Enter must never launch partially transcribed live text or
  //    dispatch it as a partial (the bar's content is provisional until release).
  if (input.captureLive) return { kind: 'none', reason: 'listening' };

  const q = input.query.trim();
  if (q === '') return { kind: 'none', reason: 'empty' };

  if (input.textOrigin === 'dictated') {
    if (input.companionActive) {
      return { kind: 'send', textOrigin: 'dictated' };
    }
    return { kind: 'none', reason: 'no-match-no-companion' };
  }

  const match = findTopRankedMatch(q, input.entries);
  if (match) return { kind: 'launch', feature: match };

  if (input.companionActive) {
    return { kind: 'send', textOrigin: 'typed' };
  }
  return { kind: 'none', reason: 'no-match-no-companion' };
}

/**
 * R-6.3/R-4.5 — the chip copy, derived from the SAME verdict the handler acts
 * on. `launch` wins over `busy` deliberately: a typed app match launches even
 * while Fredo is replying, so the chip must say so (a `Fredo is replying…` chip
 * there would be exactly the lie this spec removes).
 *
 *   live capture        → `release Space to finish` (busy outranks it)
 *   launch              → `↵ open <name>`
 *   send (dictated)     → `↵ send transcript to Fredo`
 *   send (typed)        → `↵ send to Fredo`
 *   none (busy)         → `Fredo is replying…`
 *   none (no companion) → `no match`
 *   empty query         → `undefined` (no chip)
 */
export function enterHintLabel(
  action: LauncherEnterAction,
  opts: { busy: boolean; queryEmpty: boolean },
): string | undefined {
  // UI/UX §3 rows 1–2 (QA-10, ST-5-fix) — the live launcher-origin capture is the
  // ONE no-op row whose instruction must survive an EMPTY bar: a hold starts on an
  // empty bar, so deferring to the empty-query rule below would hide the single
  // instruction telling the user how to finish the capture. `busy` (row 1) outranks
  // it and reads as replying.
  if (action.kind === 'none' && action.reason === 'listening') {
    return opts.busy ? ENTER_HINT_COPY.busy : ENTER_HINT_COPY.releaseToFinish;
  }

  if (opts.queryEmpty) return undefined;

  if (action.kind === 'launch') return `↵ open ${action.feature.name}`;
  if (action.kind === 'send') {
    return action.textOrigin === 'dictated' ? ENTER_HINT_COPY.sendTranscript : ENTER_HINT_COPY.send;
  }

  if (action.reason === 'empty') return undefined;
  // #2892 ST-5 — `opts.busy` is consulted ONLY in the live-capture branch above
  // (the one place a reply can outrank a no-op's instruction). It NEVER gates a
  // send, so a typed non-match during a reply still reads `↵ send to Fredo`.
  // The `'busy'` reason stays total for a caller that reports it directly.
  if (action.reason === 'busy') return ENTER_HINT_COPY.busy;
  return ENTER_HINT_COPY.noMatch;
}
