/**
 * transcriptCase — the ONE transcript projection (Spec #2888 ST-1).
 *
 * The shipped dictation path puts the raw engine hypothesis straight into the
 * bar (`Recognizer::result_text()` → `SttTranscriptEvent.text` → the
 * `stt:transcript` handler). The pinned sherpa-onnx streaming zipformer model is
 * an icefall/LibriSpeech BPE transducer whose vocabulary is **uppercase-only**,
 * so every dictated phrase arrives shouted and the product's own name arrives as
 * some other spelling (`FRITO`, `FREITO`, …).
 *
 * This module is the single, pure projection that turns that hypothesis into the
 * text a person would write: **sentence case**, the product name recognised, and
 * the product's declared intentional capitals preserved.
 *
 * Why the transform is INPUT-CASING-INDEPENDENT (the AC1 vs AC2 crux): the pinned
 * engine emits no case information at all — `API` and `api` are the same bytes —
 * so intent cannot be recovered by inspecting the input. The projection therefore
 * forces its own output casing and re-applies capitals from a closed,
 * product-owned vocabulary. Nothing is guessed: no shape heuristics, no phonetic
 * matching, no punctuation insertion, no spelling correction beyond the declared
 * product-name table.
 *
 * Contract (REQ-1..REQ-5):
 *   - REQ-1: the segment's first alphabetic character is uppercase and every
 *     other alphabetic character lowercase — except the tokens below.
 *   - REQ-3: every non-alphabetic character is preserved byte-for-byte and the
 *     token sequence of the engine hypothesis is preserved (nothing added,
 *     removed, reordered or summarised); case is the ONLY change, except for the
 *     single closed product-name mapping.
 *   - REQ-4: a token equal to a `FREDO_CONFUSABLES` member renders as
 *     `PRODUCT_NAME` (`Fredo`), alone, embedded, and for every occurrence.
 *   - REQ-5: a token equal to a `PRESERVED_TOKENS` member renders exactly as
 *     written there (its canonical capitals are never flattened).
 *
 * Pure by construction: no DOM, no Tauri/IPC, no clock, no state, no imports.
 */

/** The canonical product-name token (REQ-4). */
export const PRODUCT_NAME = 'Fredo';

/**
 * The CLOSED confusable set: the engine spellings this product canonicalizes to
 * `Fredo`. UPPERCASE literals — the pinned engine emits an uppercase-only
 * alphabet (icefall LibriSpeech BPE), so no other casing can arrive. Membership
 * is FIXED: never learned, never user-editable.
 */
export const FREDO_CONFUSABLES: readonly string[] = [
  'FREDO', 'FREDO', 'FREDA', 'FREDDA', 'FREDDO',
  'FREEDO', 'FREEDOE', 'FREETO', 'FREITO', 'FRIDO',
  'FRITO', 'FRITTO', 'FRETO', // 'FRITO' is the expected dominant confusion
];

/**
 * The CLOSED capital-preservation vocabulary (REQ-5): a transcript token equal
 * to one of these CASE-INSENSITIVELY is emitted EXACTLY as written here; every
 * other token is lowercased (except the utterance-opening character). Curation
 * rule: never add an entry that is also a common English word — that is why
 * IT / IS / AM / PM / SO / IN / ON / DO are absent. `Fredo` and `I` are members.
 */
export const PRESERVED_TOKENS: readonly string[] = [
  'Fredo', 'I',
  'API', 'SQL',
  'AI', 'ML', 'LLM', 'NLP', 'TTS', 'STT',
  'JSON', 'HTTP', 'HTTPS', 'URL', 'URI',
  'UI', 'UX', 'CLI', 'SDK', 'IDE', 'OS',
  'CPU', 'GPU', 'RAM', 'SSD', 'USB', 'SSH',
  'HTML', 'CSS', 'PDF', 'CSV', 'DNS', 'CI', 'CD',
];

/** `FREDO_CONFUSABLES` keyed by its uppercased form (exact membership). */
const FREDO_BY_UPPER = new Map<string, string>(
  FREDO_CONFUSABLES.map((spelling) => [spelling.toUpperCase(), PRODUCT_NAME]),
);

/** `PRESERVED_TOKENS` keyed by its uppercased form (exact membership). */
const PRESERVED_BY_UPPER = new Map<string, string>(
  PRESERVED_TOKENS.map((token) => [token.toUpperCase(), token]),
);

/** `[A-Za-z]` only — every other UTF-16 unit passes through verbatim. */
const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

/**
 * The ONE transcript projection.
 *
 * @param raw               the engine hypothesis (uppercase-only, cumulative per
 *                          ASR segment).
 * @param atUtteranceStart  `true` for the FIRST segment of a dictation session,
 *                          `false` for continuation segments — the utterance
 *                          opening is capitalised once; a mid-utterance endpoint
 *                          must not manufacture a new sentence.
 *
 * ALGORITHM (binding):
 *  1. Walk `raw`; copy every non-`[A-Za-z']` character verbatim (digits,
 *     punctuation, spaces and any non-ASCII pass through unchanged).
 *  2. A token is the maximal run of `[A-Za-z']`; a token is split on `'` into
 *     parts and re-joined with `'` so `DON'T`/`I'M`/`FREDO'S` keep their
 *     apostrophe.
 *  3. Render each part from its UPPERCASED form:
 *     a. member of `FREDO_CONFUSABLES` → `PRODUCT_NAME` (`Fredo`);
 *     b. member of `PRESERVED_TOKENS`  → that entry verbatim (canonical caps);
 *     c. otherwise → lowercase, and if this is the first alphabetic character of
 *        the segment and `atUtteranceStart` is true, uppercase that first
 *        character instead.
 *  4. Never insert, drop or reorder anything.
 */
export function normalizeTranscriptSegment(raw: string, atUtteranceStart: boolean): string {
  let out = '';
  // Has the segment's FIRST alphabetic character already been emitted? Only the
  // branch-(c) rendering consults it (branches a/b already carry intentional caps).
  let openingEmitted = false;

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (!isAsciiLetter(ch) && ch !== "'") {
      // Step 1 — verbatim pass-through (never re-cased, never dropped).
      out += ch;
      i += 1;
      continue;
    }

    // Step 2 — the maximal `[A-Za-z']` run, then its apostrophe-separated parts.
    let end = i;
    while (end < raw.length && (isAsciiLetter(raw[end]) || raw[end] === "'")) end += 1;
    const parts = raw.slice(i, end).split("'");

    for (let p = 0; p < parts.length; p += 1) {
      if (p > 0) out += "'"; // the apostrophe is preserved verbatim
      const part = parts[p];
      if (part === '') continue; // a standalone/duplicated apostrophe
      const upper = part.toUpperCase();

      // Step 3a — the closed product-name confusable table (spelling, REQ-4).
      const canonicalName = FREDO_BY_UPPER.get(upper);
      if (canonicalName !== undefined) {
        out += canonicalName;
        openingEmitted = true;
        continue;
      }

      // Step 3b — the closed capital-preservation vocabulary (REQ-5).
      const preserved = PRESERVED_BY_UPPER.get(upper);
      if (preserved !== undefined) {
        out += preserved;
        openingEmitted = true;
        continue;
      }

      // Step 3c — lowercase, with the utterance opening capitalised once.
      let rendered = part.toLowerCase();
      if (atUtteranceStart && !openingEmitted) {
        rendered = rendered.charAt(0).toUpperCase() + rendered.slice(1);
      }
      openingEmitted = true;
      out += rendered;
    }

    i = end;
  }

  return out;
}
