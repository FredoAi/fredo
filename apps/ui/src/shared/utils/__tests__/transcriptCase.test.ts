/**
 * transcriptCase — Spec #2888 ST-1 unit pins.
 *
 * The projection is a deterministic string function, so every REQ-1..REQ-5 claim
 * is pinnable here: the sentence-case opening, the closed product-name
 * confusable table (one pin per entry), the closed capital-preservation
 * vocabulary, the content-integrity invariant (the non-alphabetic sequence is
 * identical), and idempotence.
 *
 * Pins mirror the QA Plan's injected corpus (F-83..F-88) so the bar-level rows
 * and the unit oracle assert the SAME strings.
 */

import { describe, it, expect } from 'vitest';

import {
  FREDO_CONFUSABLES,
  PRESERVED_TOKENS,
  PRODUCT_NAME,
  normalizeTranscriptSegment,
} from '../transcriptCase';

/** The projection with `atUtteranceStart = true` (the first segment of a turn). */
const open = (raw: string) => normalizeTranscriptSegment(raw, true);
/** The projection with `atUtteranceStart = false` (a continuation segment). */
const cont = (raw: string) => normalizeTranscriptSegment(raw, false);

/** Every ASCII letter stripped — the sequence the transform may never touch. */
const nonAlphabetic = (value: string) => value.replace(/[A-Za-z]/g, '');

describe('transcriptCase — the declared vocabularies', () => {
  it('names the canonical product token', () => {
    expect(PRODUCT_NAME).toBe('Fredo');
  });

  it('declares UPPERCASE engine spellings and canonical-capital tokens', () => {
    expect(FREDO_CONFUSABLES.length).toBeGreaterThan(0);
    for (const spelling of FREDO_CONFUSABLES) {
      expect(spelling, spelling).toBe(spelling.toUpperCase());
    }
    expect(PRESERVED_TOKENS).toContain('Fredo');
    expect(PRESERVED_TOKENS).toContain('API');
    expect(PRESERVED_TOKENS).toContain('SQL');
    // The curation rule: never a common English word (would rewrite real text).
    for (const word of ['IT', 'IS', 'AM', 'PM', 'SO', 'IN', 'ON', 'DO']) {
      expect(PRESERVED_TOKENS, word).not.toContain(word);
    }
  });
});

describe('transcriptCase — REQ-3: empty and whitespace-only input is untouched', () => {
  it('returns an empty string for an empty string (both start flags)', () => {
    expect(open('')).toBe('');
    expect(cont('')).toBe('');
  });

  it('returns whitespace-only input byte-for-byte', () => {
    expect(open('   ')).toBe('   ');
    expect(open('\n\t')).toBe('\n\t');
    expect(cont(' \u00a0 ')).toBe(' \u00a0 ');
  });
});

describe('transcriptCase — REQ-1: sentence case (the opening capitalised once)', () => {
  it('lowercases every word but the first alphabetic character', () => {
    expect(open('HELLO WORLD')).toBe('Hello world');
    expect(open('DEPLOY THE BUILD TONIGHT')).toBe('Deploy the build tonight');
    expect(open('TONIGHT')).toBe('Tonight');
  });

  it('keeps a continuation segment lowercase-initial (no manufactured mid-sentence capital)', () => {
    expect(cont('HELLO WORLD')).toBe('hello world');
    expect(cont('WORLD')).toBe('world');
    // …while the SAME bytes opening a turn DO capitalise.
    expect(open('WORLD')).toBe('World');
  });

  it('capitalises the first alphabetic character after leading punctuation/digits', () => {
    expect(open('"HELLO"')).toBe('"Hello"');
    expect(open('2 BUILD')).toBe('2 Build');
    expect(cont('2 BUILD')).toBe('2 build');
  });

  it('is already-sentence-cased text idempotent (a re-read cumulative partial)', () => {
    expect(open('Deploy the build tonight')).toBe('Deploy the build tonight');
  });
});

describe('transcriptCase — REQ-4: the product name (closed confusable table)', () => {
  it('canonicalizes FREDO everywhere it occurs', () => {
    expect(open('SEND AN EMAIL TO FREDO')).toBe('Send an email to Fredo');
    expect(open('FREDO FREDO')).toBe('Fredo Fredo');
    expect(open('ASK FREDO TO OPEN THE LOGS')).toBe('Ask Fredo to open the logs');
    expect(open('TELL FREDO THAT FREDO SAID YES')).toBe('Tell Fredo that Fredo said yes');
    expect(open('FREDO FREDO ARE YOU THERE')).toBe('Fredo Fredo are you there');
  });

  it('renders the name alone as exactly `Fredo` — never `FREDO`, never `fredo`', () => {
    expect(open('FREDO')).toBe('Fredo');
    expect(cont('FREDO')).toBe('Fredo');
  });

  it('canonicalizes a confusable spelling embedded in a sentence', () => {
    expect(open('FRITO THE BUILD')).toBe('Fredo the build');
    expect(open('ASK FRITO TO OPEN THE LOGS')).toBe('Ask Fredo to open the logs');
  });

  it('keeps the apostrophe of a name-suffixed token', () => {
    expect(open("FREDO'S PLAN")).toBe("Fredo's plan");
  });

  // One pin per declared entry (the closed set is the whole REQ-4 mitigation).
  it.each([...FREDO_CONFUSABLES])(
    'canonicalizes the declared confusable spelling %s to the product name',
    (spelling) => {
      expect(open(spelling)).toBe('Fredo');
      expect(open(`ASK ${spelling} NOW`)).toBe('Ask Fredo now');
      expect(cont(`ASK ${spelling} NOW`)).toBe('ask Fredo now');
    },
  );
});

describe('transcriptCase — REQ-5: intentional capitals survive', () => {
  it('preserves the named acronyms while lowercasing the words around them', () => {
    expect(open('CALL THE API AND CHECK THE SQL')).toBe('Call the API and check the SQL');
    expect(open('EXPORT THE API SPEC AND RUN SQL')).toBe('Export the API spec and run SQL');
    expect(open('CALL THE API FREDO')).toBe('Call the API Fredo');
    expect(open('API RETURNS SQL')).toBe('API returns SQL');
  });

  it('preserves the first-person `I` and never flattening it to `i`', () => {
    expect(open('I TOLD FREDO')).toBe('I told Fredo');
  });

  it('does NOT preserve an ordinary all-caps word (only the declared vocabulary)', () => {
    // Mid-sentence and as a continuation — never flattened only when it opens a
    // turn, and then only by the sentence-case rule, not by preservation.
    expect(open('THE BUILD IS DONE')).toBe('The build is done');
    expect(cont('BUILD')).toBe('build');
  });

  it.each([...PRESERVED_TOKENS])('emits the declared token %s verbatim', (token) => {
    expect(cont(token)).toBe(token);
    expect(cont(token.toLowerCase())).toBe(token);
  });
});

describe('transcriptCase — REQ-3: content integrity (case is the only change)', () => {
  it("keeps a token's apostrophe and re-cases only its parts", () => {
    expect(open("DON'T STOP")).toBe("Don't stop");
    expect(open("I'M SERIOUS")).toBe("I'm serious");
    expect(open("THE API'S URL")).toBe("The API's URL");
  });

  it('leaves digits, punctuation, interior spacing and separators in place', () => {
    expect(open('VERSION 2 IS READY')).toBe('Version 2 is ready');
    expect(open('HELLO, WORLD')).toBe('Hello, world');
    expect(open('HELLO  WORLD')).toBe('Hello  world');
    expect(open('SNAKE_CASE_TOKEN')).toBe('Snake_case_token');
    expect(open('WELL-KNOWN')).toBe('Well-known');
  });

  it('passes every non-ASCII code unit through verbatim (the walk is [A-Za-z] only)', () => {
    // `\u00c9` (É) and `\u2014` (—) are not ASCII letters: the declared walk
    // copies them byte-for-byte and never case-folds them.
    expect(cont('CAF\u00c9')).toBe('caf\u00c9');
    expect(cont('HELLO \u2014 WORLD')).toBe('hello \u2014 world');
    expect(open("IT'S FINE \u2014 REALLY")).toBe("It's fine \u2014 really");
  });

  const INTEGRITY_CORPUS: readonly string[] = [
    '',
    'HELLO WORLD',
    'DEPLOY THE BUILD TONIGHT',
    'VERSION 2 IS READY',
    'HELLO, WORLD',
    "DON'T STOP",
    "I'M SERIOUS",
    'WELL-KNOWN',
    'SNAKE_CASE_TOKEN',
    'HELLO  WORLD',
    "THE API'S URL",
    'FREDO',
    'FREDO FREDO',
    'FRITO THE BUILD',
    'CAF\u00c9 TIME',
    'HELLO \u2014 WORLD',
    '   ',
  ];

  /**
   * The declared product-name mapping is the ONE permitted non-case change, so
   * the case-insensitive-equality property is pinned on inputs containing no
   * `FREDO_CONFUSABLES` member (the non-alphabetic property below covers the rest).
   */
  const CASE_ONLY_CORPUS: readonly string[] = [
    '',
    'HELLO WORLD',
    'DEPLOY THE BUILD TONIGHT',
    'VERSION 2 IS READY',
    'HELLO, WORLD',
    "DON'T STOP",
    "I'M SERIOUS",
    'WELL-KNOWN',
    'SNAKE_CASE_TOKEN',
    'HELLO  WORLD',
    "THE API'S URL",
    'CALL THE API AND CHECK THE SQL',
    'I TOLD SOMEONE',
    'CAF\u00c9 TIME',
    'HELLO \u2014 WORLD',
    '   ',
  ];

  it.each([...INTEGRITY_CORPUS])(
    'preserves the non-alphabetic sequence exactly (%s)',
    (raw) => {
      expect(nonAlphabetic(open(raw))).toBe(nonAlphabetic(raw));
      expect(nonAlphabetic(cont(raw))).toBe(nonAlphabetic(raw));
    },
  );

  it.each([...CASE_ONLY_CORPUS])(
    'changes case only — no byte differs case-insensitively (%s)',
    (raw) => {
      expect(open(raw).toLowerCase()).toBe(raw.toLowerCase());
      expect(cont(raw).toLowerCase()).toBe(raw.toLowerCase());
    },
  );
});

describe('transcriptCase — idempotence', () => {
  const CORPUS: readonly string[] = [
    '',
    'HELLO WORLD',
    'CALL THE API AND CHECK THE SQL',
    'CALL THE API FREDO',
    'FREDO FREDO',
    'FRITO THE BUILD',
    "DON'T STOP",
    "I'M SERIOUS",
    'VERSION 2 IS READY',
    'HELLO, WORLD',
    'SNAKE_CASE_TOKEN',
    "THE API'S URL",
    'HELLO  WORLD',
    '   ',
  ];

  it.each([...CORPUS])('normalize(normalize(x)) === normalize(x) [%s]', (raw) => {
    const once = open(raw);
    expect(open(once)).toBe(once);
    const onceCont = cont(raw);
    expect(cont(onceCont)).toBe(onceCont);
  });
});
