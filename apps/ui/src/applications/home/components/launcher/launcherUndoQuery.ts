/**
 * Spec #3120 (P6), ST-5 — the undo-by-description matcher (AC6.1–AC6.4, Q-1).
 *
 * One pure phrase table maps the launcher's typed text to `journal.undo` args. The four
 * outcomes are deliberately distinct:
 *
 *   - `undo`          — a rule matched; dispatch `journal.undo` with the args;
 *   - `no-match`      — NOT undo-shaped: an ordinary query, routed to the companion;
 *   - `no-match-undo` — undo-shaped but no rule (e.g. `undo the red one`): the ONLY path
 *                       that renders `UNDO_NO_MATCH_COPY` (Q-1 — this is what makes AC6.4
 *                       literally true);
 *   - `ambiguous`     — `undo that` / `undo it` (whose change?) or a count outside 1..100.
 *
 * Binding rules (case-insensitive, whole-phrase), in precedence order:
 *   1. companion + last           → `{ actor:'companion', count:'1' }`
 *   2. companion + N              → `{ actor:'companion', count:'N' }`
 *   3. last / bare undo           → `{ count:'1' }`
 *   4. `undo that` / `undo it`    → `ambiguous('actor')`
 *   5. undo-shaped, no rule       → `no-match-undo`
 *   6. anything else              → `no-match`
 *
 * Normalisation: trim, lower-case, collapse internal whitespace, strip trailing
 * punctuation, and treat a leading `revert` as `undo` (the manifest alias). Numbers may be
 * digits or English number words (`one`…`twenty`, `hundred`).
 *
 * PURE: no clock, no DOM, no state, no I/O.
 */

import type { Actor } from '../../../../shared/navigation';

/** The args a matched phrase feeds to `journal.undo` (binding shape — §3.5). */
export interface UndoQueryArgs {
  readonly actor?: Actor;
  readonly count?: string; // '1'..'100'
}

/** The four-way phrase verdict (binding shape — §3.5). */
export type UndoPhraseMatch =
  | { readonly kind: 'undo'; readonly args: UndoQueryArgs }
  | { readonly kind: 'no-match' }
  | { readonly kind: 'no-match-undo' }
  | { readonly kind: 'ambiguous'; readonly reason: 'actor' | 'count' };

/** AC6.4 — the undo-shaped miss's copy (rendered by the S6 clarify line). */
export const UNDO_NO_MATCH_COPY = "I couldn't tell which change to undo. Nothing changed.";
/** The actor ambiguity copy. */
export const UNDO_AMBIGUOUS_COPY =
  "Tell me whose change to undo — yours or the companion's. Nothing changed.";

/** The smallest/largest count `journal.undo` accepts (`normalizeQuery` clamps 1..100). */
const MIN_COUNT = 1;
const MAX_COUNT = 100;

/** English number words the matcher accepts (`count` words vs digits). */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** The change/action noun the rules accept. */
const NOUN = '(?:change|changes|action|actions)';
const NUM = '(?<n>\\d+|[a-z]+)';

/** Parse a digit or English number word; `null` when the token names no number. */
function parseCountToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

/** Normalise a phrase for whole-phrase matching. */
function normalize(text: string): string {
  let value = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  value = value.replace(/[\s.!?,;:]+$/g, '');
  value = value.replace(/\s+/g, ' ');
  value = value.replace(/^revert\b/, 'undo');
  return value;
}

/** True when the phrase starts with an undo verb or names one as a word. */
function isUndoShaped(value: string): boolean {
  return /^(?:undo|revert)(?:\s|$)/.test(value) || /(?:^|\s)(?:undo|revert)(?:\s|$)/.test(value);
}

/** Build the matched verdict from a parsed count, classifying an out-of-range count. */
function withCount(actor: Actor | undefined, token: string): UndoPhraseMatch {
  const parsed = parseCountToken(token);
  if (parsed === null) return { kind: 'no-match-undo' };
  if (parsed < MIN_COUNT || parsed > MAX_COUNT) return { kind: 'ambiguous', reason: 'count' };
  return actor === undefined
    ? { kind: 'undo', args: { count: String(parsed) } }
    : { kind: 'undo', args: { actor, count: String(parsed) } };
}

/** The binding phrase table. */
const RULES: readonly {
  readonly pattern: RegExp;
  readonly resolve: (match: RegExpMatchArray) => UndoPhraseMatch;
}[] = [
  // 2. companion + N (checked before the singular companion rules).
  {
    pattern: new RegExp(`^undo (?:the )?last ${NUM} companion ${NOUN}$`),
    resolve: (match) => withCount('companion', match.groups?.n ?? ''),
  },
  {
    pattern: new RegExp(`^undo (?:the )?companion'?s last ${NUM} ${NOUN}$`),
    resolve: (match) => withCount('companion', match.groups?.n ?? ''),
  },
  {
    pattern: new RegExp(`^undo (?:the )?last ${NUM} ${NOUN} (?:by|from) (?:the )?companion$`),
    resolve: (match) => withCount('companion', match.groups?.n ?? ''),
  },
  // 1. companion + last → single newest companion change.
  {
    pattern: /^undo (?:the )?companion'?s last (?:change|action)$/,
    resolve: () => ({ kind: 'undo', args: { actor: 'companion', count: '1' } }),
  },
  {
    pattern: /^undo (?:the )?last companion (?:change|action)$/,
    resolve: () => ({ kind: 'undo', args: { actor: 'companion', count: '1' } }),
  },
  {
    pattern: /^undo (?:the )?last (?:change|action) (?:by|from) (?:the )?companion$/,
    resolve: () => ({ kind: 'undo', args: { actor: 'companion', count: '1' } }),
  },
  {
    pattern: /^undo what (?:the )?companion did last$/,
    resolve: () => ({ kind: 'undo', args: { actor: 'companion', count: '1' } }),
  },
  // 3. bare / last undo → the newest change overall.
  {
    pattern: /^undo$/,
    resolve: () => ({ kind: 'undo', args: { count: '1' } }),
  },
  {
    pattern: /^undo (?:the )?last$/,
    resolve: () => ({ kind: 'undo', args: { count: '1' } }),
  },
  {
    pattern: /^undo (?:the )?last (?:change|action|one)$/,
    resolve: () => ({ kind: 'undo', args: { count: '1' } }),
  },
  {
    pattern: /^undo (?:the )?(?:newest|most recent) (?:change|action)$/,
    resolve: () => ({ kind: 'undo', args: { count: '1' } }),
  },
  // A counted phrase with no actor is actor-ambiguous (whose changes?).
  {
    pattern: new RegExp(`^undo (?:the )?last ${NUM} ${NOUN}$`),
    resolve: (match) => {
      const parsed = parseCountToken(match.groups?.n ?? '');
      if (parsed === null) return { kind: 'no-match-undo' };
      if (parsed < MIN_COUNT || parsed > MAX_COUNT) return { kind: 'ambiguous', reason: 'count' };
      return { kind: 'ambiguous', reason: 'actor' };
    },
  },
  // 4. `undo that` / `undo it` — whose change?
  {
    pattern: /^undo (?:that|it|this)$/,
    resolve: () => ({ kind: 'ambiguous', reason: 'actor' }),
  },
];

/**
 * Match a launcher query as an undo phrase.
 *
 * @param text the bar's raw text (typed or dictated)
 */
export function matchUndoPhrase(text: string): UndoPhraseMatch {
  const value = normalize(text);
  if (value === '') return { kind: 'no-match' };

  for (const rule of RULES) {
    const match = value.match(rule.pattern);
    if (match !== null) return rule.resolve(match);
  }

  // 5. Undo-shaped with no rule → the ONE path that renders `UNDO_NO_MATCH_COPY`.
  if (isUndoShaped(value)) return { kind: 'no-match-undo' };
  // 6. An ordinary query (never captured by the undo matcher).
  return { kind: 'no-match' };
}
