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
 *   - `resolveEnterAction` — the binding precedence table (empty → dictated →
 *     typed match → send → none).
 *   - `enterHintLabel` — the single-source-of-truth copy derivation so the
 *     chip can never promise a different action than Enter performs.
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
  | { kind: 'none'; reason: 'empty' | 'busy' | 'no-match-no-companion' };

/** The exact chip copy (UI/UX-owned wording, binding derivation). */
export const ENTER_HINT_COPY = {
  send: '↵ send to Fredo',
  sendTranscript: '↵ send transcript to Fredo',
  noMatch: 'no match',
  busy: 'Fredo is replying…',
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
  companionBusy: boolean;
}

/**
 * The binding precedence (R-5/R-6, clarifications #1/#2):
 *
 *   1. empty query                       → `{ none, 'empty' }`
 *   2. `textOrigin === 'dictated'`       → `send` when active && !busy, else `none`
 *                                          (a dictated transcript NEVER launches —
 *                                          clarification #2 / R-4.3)
 *   3. typed + app match                 → `launch`, INDEPENDENT of companion + busy
 *                                          (AC5 "present, away, off, or replying")
 *   4. typed, no match, active && !busy  → `send`
 *   5. otherwise                         → `none`
 */
export function resolveEnterAction(input: ResolveEnterActionInput): LauncherEnterAction {
  const q = input.query.trim();
  if (q === '') return { kind: 'none', reason: 'empty' };

  if (input.textOrigin === 'dictated') {
    if (input.companionActive && !input.companionBusy) {
      return { kind: 'send', textOrigin: 'dictated' };
    }
    return { kind: 'none', reason: input.companionBusy ? 'busy' : 'no-match-no-companion' };
  }

  const match = findTopRankedMatch(q, input.entries);
  if (match) return { kind: 'launch', feature: match };

  if (input.companionActive && !input.companionBusy) {
    return { kind: 'send', textOrigin: 'typed' };
  }
  return { kind: 'none', reason: input.companionBusy ? 'busy' : 'no-match-no-companion' };
}

/**
 * R-6.3/R-4.5 — the chip copy, derived from the SAME verdict the handler acts
 * on. `launch` wins over `busy` deliberately: a typed app match launches even
 * while Fredo is replying, so the chip must say so (a `Fredo is replying…` chip
 * there would be exactly the lie this spec removes).
 *
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
  if (opts.queryEmpty) return undefined;

  if (action.kind === 'launch') return `↵ open ${action.feature.name}`;
  if (action.kind === 'send') {
    return action.textOrigin === 'dictated' ? ENTER_HINT_COPY.sendTranscript : ENTER_HINT_COPY.send;
  }

  if (action.reason === 'empty') return undefined;
  if (opts.busy || action.reason === 'busy') return ENTER_HINT_COPY.busy;
  return ENTER_HINT_COPY.noMatch;
}
