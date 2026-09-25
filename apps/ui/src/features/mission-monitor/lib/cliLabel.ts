/**
 * Mission Monitor — CLI label resolution (Spec #2945 ST-3).
 *
 * The single closed mapping from a canonical row `provider` token to the
 * display identity rendered on the session-list row and the selected session's
 * header. The token is produced by the ONE shared extraction rule
 * (`rtdb/attrs.rs` `resolve_provider_token`, Spec #2932) and copied verbatim
 * into the `sessionRollup` `provider` fact — this module performs NO extraction
 * of its own (NFR-6 / REQ-10). It is a pure projection of an already-resolved
 * field.
 *
 * Canonical tokens (Architect/UI-UX contract):
 *   open_code    → OpenCode
 *   copilot_cli  → GitHub Copilot
 *   claude_code  → Claude Code
 *   internal     → Internal
 *
 * ANY other value — `unknown`, the `null`/absent case, an empty/whitespace
 * string, or an unrecognized token — resolves to the explicit `Unknown CLI`
 * fallback. An absent/unrecognized value is NEVER mapped to OpenCode (REQ-3).
 */

/** Visible fallback label for an absent/unrecognized provider (QA-4). */
export const CLI_UNKNOWN_LABEL = 'Unknown CLI';

/** Resolved display identity for a canonical `provider` token. */
export interface CliLabelParts {
  /** Visible display label, uppercased by the consumer's CSS. */
  displayLabel: string;
  /**
   * Human-readable name. Used as the accessible/tooltip name: consumers render
   * `CLI: ${longName}` for a known provider; the fallback value is already the
   * complete accessible name (`CLI unknown`).
   */
  longName: string;
  /** Leading identity glyph (a second, non-colour identity channel). */
  glyph: string;
  /** True for the explicit fallback (absent/`unknown`/unrecognized). */
  isUnknown: boolean;
}

/**
 * The closed mapping. `Object.freeze` guards against accidental mutation from a
 * consumer; an unrecognized key is looked up with `hasOwnProperty` below so no
 * prototype property (e.g. `'constructor'`) can ever resolve to a known CLI.
 */
const CLI_MAP: Readonly<Record<string, Omit<CliLabelParts, 'isUnknown'>>> = Object.freeze({
  open_code: { displayLabel: 'OpenCode', longName: 'OpenCode', glyph: '◈' },
  copilot_cli: { displayLabel: 'GitHub Copilot', longName: 'GitHub Copilot', glyph: '◆' },
  claude_code: { displayLabel: 'Claude Code', longName: 'Claude Code', glyph: '◇' },
  internal: { displayLabel: 'Internal', longName: 'Internal', glyph: '▫' },
});

/**
 * Resolve a canonical `provider` token to its display identity.
 *
 * @param provider the canonical token read from the declared `sessions` rollup
 *   row — `string | null | undefined` (ST-2 surfaces `null` for an absent
 *   column value).
 */
export function resolveCliLabel(provider: string | null | undefined): CliLabelParts {
  const key = typeof provider === 'string' ? provider.trim() : '';
  const known =
    key.length > 0 && Object.prototype.hasOwnProperty.call(CLI_MAP, key) ? CLI_MAP[key] : undefined;
  if (known) return { ...known, isUnknown: false };
  return {
    displayLabel: CLI_UNKNOWN_LABEL,
    // The complete accessible name for the fallback (`CLI unknown`, QA-4) —
    // deliberately not `CLI: Unknown CLI`.
    longName: 'CLI unknown',
    glyph: '?',
    isUnknown: true,
  };
}
