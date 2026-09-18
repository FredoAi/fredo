/**
 * Spec #2893 ST-6 — pins the UI/UX AUTHORITATIVE reply copy char-for-char
 * (R-4.1/R-4.2/R-4.3; UI/UX §1). A paraphrase or a curly quote is a failure.
 */
import { describe, it, expect } from 'vitest';

import {
  appOpenAmbiguousReply,
  appOpenFailedReply,
  appOpenSuccessReply,
  appOpenUnknownReply,
  joinCandidateNames,
} from '../appOpenReply';

describe('appOpenReply — exact copy (UI/UX §1)', () => {
  it('success: `Opening <displayName>`', () => {
    expect(appOpenSuccessReply('Mission Monitor')).toBe('Opening Mission Monitor');
  });

  it('unknown: `I couldn\'t find "<spokenName>"` with plain ASCII quotes', () => {
    const reply = appOpenUnknownReply('Narnia');
    expect(reply).toBe('I couldn\'t find "Narnia"');
    expect(reply).toContain('"');
    expect(reply).not.toContain('\u201c');
    expect(reply).not.toContain('\u201d');
  });

  it('unknown: echoes the spoken name verbatim (case preserved)', () => {
    expect(appOpenUnknownReply('NotARealApp')).toBe('I couldn\'t find "NotARealApp"');
    expect(appOpenUnknownReply('notarealapp')).toBe('I couldn\'t find "notarealapp"');
  });

  it('ambiguous (2): `A or B`', () => {
    expect(appOpenAmbiguousReply('monitor', ['Mission Monitor', 'Monitor Two'])).toBe(
      'I found more than one app matching "monitor". Which one did you mean: Mission Monitor or Monitor Two?',
    );
  });

  it('failed: contains the display name and a next step', () => {
    expect(appOpenFailedReply('Mission Monitor')).toBe(
      'I couldn\'t open Mission Monitor. Try again from the launcher grid.',
    );
  });
});

describe('joinCandidateNames — UI/UX §1 join rule', () => {
  it('joins 1 / 2 / 3 candidates', () => {
    expect(joinCandidateNames(['A'])).toBe('A');
    expect(joinCandidateNames(['A', 'B'])).toBe('A or B');
    expect(joinCandidateNames(['A', 'B', 'C'])).toBe('A, B, or C');
  });

  it('joins >3 with only the first 3 plus `(and N more)`', () => {
    expect(joinCandidateNames(['A', 'B', 'C', 'D'])).toBe('A, B, or C (and 1 more)');
    expect(joinCandidateNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, or C (and 2 more)');
  });

  it('returns an empty string for no candidates (defensive)', () => {
    expect(joinCandidateNames([])).toBe('');
  });
});
