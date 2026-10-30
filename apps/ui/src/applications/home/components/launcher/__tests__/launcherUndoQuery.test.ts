/**
 * Spec #3120 (P6), ST-5 — the undo-by-description phrase table (QA F-144 / R-6.1).
 *
 * The binding table from the plan §3.5:
 *   companion + last → `{actor:'companion',count:'1'}`; companion + N → `{actor:'companion',count:'N'}`;
 *   bare/last → `{count:'1'}`; `undo that` / `undo it` → `ambiguous('actor')`;
 *   an undo-SHAPED miss → `no-match-undo`; anything else → `no-match`.
 *
 * The `no-match` vs `no-match-undo` distinction is load-bearing: only the latter routes to
 * `UNDO_NO_MATCH_COPY` (AC6.4), so it is pinned with a non-vacuity assertion.
 */

import { describe, expect, it } from 'vitest';

import {
  UNDO_AMBIGUOUS_COPY,
  UNDO_NO_MATCH_COPY,
  matchUndoPhrase,
} from '@/applications/home/components/launcher/launcherUndoQuery';

describe('matchUndoPhrase — the binding phrase table', () => {
  it('companion + last → the newest companion change', () => {
    expect(matchUndoPhrase("undo the companion's last change")).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '1' },
    });
    expect(matchUndoPhrase('undo the last companion change')).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '1' },
    });
    expect(matchUndoPhrase('undo the last change from the companion')).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '1' },
    });
  });

  it('companion + N → a block of N companion changes (digit or number word)', () => {
    expect(matchUndoPhrase('undo the last 3 companion changes')).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '3' },
    });
    expect(matchUndoPhrase('undo the last three companion changes')).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '3' },
    });
    expect(matchUndoPhrase("undo the companion's last 3 changes")).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '3' },
    });
  });

  it('bare / last undo → the newest change overall (no actor)', () => {
    expect(matchUndoPhrase('undo')).toEqual({ kind: 'undo', args: { count: '1' } });
    expect(matchUndoPhrase('undo the last change')).toEqual({
      kind: 'undo',
      args: { count: '1' },
    });
    expect(matchUndoPhrase('undo last')).toEqual({ kind: 'undo', args: { count: '1' } });
  });

  it('`undo that` / `undo it` → ambiguous (whose change?)', () => {
    expect(matchUndoPhrase('undo that')).toEqual({ kind: 'ambiguous', reason: 'actor' });
    expect(matchUndoPhrase('undo it')).toEqual({ kind: 'ambiguous', reason: 'actor' });
  });

  it('an undo-shaped phrase with no rule → no-match-undo (the UNDO_NO_MATCH_COPY path)', () => {
    expect(matchUndoPhrase('undo the red one')).toEqual({ kind: 'no-match-undo' });
    expect(matchUndoPhrase('undo the thing I just made')).toEqual({ kind: 'no-match-undo' });
  });

  it('an ordinary query → no-match (never captured by the matcher)', () => {
    expect(matchUndoPhrase('make it nicer')).toEqual({ kind: 'no-match' });
    expect(matchUndoPhrase('open settings')).toEqual({ kind: 'no-match' });
    expect(matchUndoPhrase('')).toEqual({ kind: 'no-match' });
  });

  it('keeps no-match and no-match-undo distinct (Q-1 non-vacuity)', () => {
    expect(matchUndoPhrase('make it nicer').kind).toBe('no-match');
    expect(matchUndoPhrase('undo the red one').kind).toBe('no-match-undo');
    expect(matchUndoPhrase('make it nicer').kind).not.toBe(matchUndoPhrase('undo the red one').kind);
  });
});

describe('matchUndoPhrase — normalisation and bounds', () => {
  it('is case-insensitive and tolerant of punctuation / extra whitespace', () => {
    const expected = { kind: 'undo', args: { actor: 'companion', count: '1' } };
    expect(matchUndoPhrase("UNDO THE COMPANION'S LAST CHANGE")).toEqual(expected);
    expect(matchUndoPhrase("  undo   the companion's   last change?!  ")).toEqual(expected);
    expect(matchUndoPhrase("Undo the companion's last change.")).toEqual(expected);
    expect(matchUndoPhrase('undo the last 3 companion changes!')).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '3' },
    });
  });

  it('treats `revert` as the manifest undo alias', () => {
    expect(matchUndoPhrase("revert the companion's last change")).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '1' },
    });
  });

  it('a count outside 1..100 is ambiguous (count), never a dispatch', () => {
    expect(matchUndoPhrase('undo the last 200 changes')).toEqual({
      kind: 'ambiguous',
      reason: 'count',
    });
    expect(matchUndoPhrase('undo the last 0 changes')).toEqual({
      kind: 'ambiguous',
      reason: 'count',
    });
    expect(matchUndoPhrase('undo the last 200 companion changes')).toEqual({
      kind: 'ambiguous',
      reason: 'count',
    });
  });

  it('a counted phrase with no actor is ambiguous (actor)', () => {
    expect(matchUndoPhrase('undo the last 3 changes')).toEqual({
      kind: 'ambiguous',
      reason: 'actor',
    });
  });
});

describe('undo copy — the two ship-verbatim strings', () => {
  it('exposes the binding copy exactly', () => {
    expect(UNDO_NO_MATCH_COPY).toBe("I couldn't tell which change to undo. Nothing changed.");
    expect(UNDO_AMBIGUOUS_COPY).toBe(
      "Tell me whose change to undo — yours or the companion's. Nothing changed.",
    );
  });
});
