/**
 * Spec #3009 CU-1 (ST-1) — the `data-hotkey` grammar (plan API Contracts block).
 *
 * The ONE parser for the declarative `data-hotkey` attribute. The grammar is
 * deliberately tiny: ONE or TWO lowercase steps from `[a-z0-9]`, joined by `+`
 * (`'a'` | `'a+b'`). Uppercase, modifiers, punctuation, an empty value and three
 * or more steps are all rejected.
 *
 * PURE by design: no DOM / React / store imports. This is the shared contract
 * ST-2 (`hotkeyBarModel`), ST-3 (the engine seam) and ST-5 (feature migration)
 * adopt — it is produced FIRST so every consumer can depend on it (G-255).
 *
 * Serialization: `serialized` is the SPACE-joined canonical form the shipped
 * `keys.ts` uses for its multi-stroke bindings (`'a'` | `'a b'`), so the shared
 * `Keycap` / `displaySequence` renderers work unchanged. `key` is the FIRST step
 * — the storage / first-step unit the bar row and the duplicate detector key off
 * (G-187).
 */

/**
 * The `data-hotkey` grammar: one lowercase `a`–`z` / `0`–`9` step, optionally a
 * second step joined by `'+'`. Lowercase only — `A`, `a+B`, `a++b`, `!`, `a+b+c`
 * and `''` are all rejected.
 */
export const DATA_HOTKEY_PATTERN = /^[a-z0-9](?:\+[a-z0-9])?$/;

/** The parsed projection of one `data-hotkey` attribute value. */
export interface HotkeyGrammar {
  /** The lowercase chord steps: `['a']` | `['a', 'b']`. */
  readonly steps: readonly string[];
  /** The space-joined canonical serialized form: `'a'` | `'a b'`. */
  readonly serialized: string;
  /** The FIRST step — the bar / duplicate key. */
  readonly key: string;
  /** `true` when the value declares a two-step sequence. */
  readonly sequential: boolean;
}

/**
 * Parse a raw `data-hotkey` attribute value. TOTAL and PURE: never throws; a
 * `null`, non-string, or grammar-miss value yields `null` (the caller excludes
 * the element and surfaces a dev diagnostic — R-1.3).
 */
export function parseDataHotkey(raw: string | null): HotkeyGrammar | null {
  if (typeof raw !== 'string') return null;
  if (!DATA_HOTKEY_PATTERN.test(raw)) return null;
  const steps = raw.split('+');
  return Object.freeze({
    steps: Object.freeze(steps),
    serialized: steps.join(' '),
    key: steps[0],
    sequential: steps.length === 2,
  });
}
