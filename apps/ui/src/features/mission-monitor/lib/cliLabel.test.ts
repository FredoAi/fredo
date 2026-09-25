/**
 * Mapping pins for the Mission Monitor CLI label resolver (Spec #2945 ST-4).
 *
 * The resolver is the SINGLE closed mapping from a canonical `provider` token
 * to its display identity. These pins lock:
 *   - every recognized token → its exact visible label / accessible name / glyph;
 *   - `unknown`, `null`, `undefined`, empty/whitespace, and ANY unrecognized
 *     string → the explicit `Unknown CLI` fallback (never OpenCode — REQ-3).
 *
 * Pure unit test — no DOM. The component-level attribute rendering lives with
 * the component tests.
 */
import { describe, it, expect } from 'vitest';
import { CLI_UNKNOWN_LABEL, resolveCliLabel } from './cliLabel';

describe('resolveCliLabel (Spec #2945 ST-3/ST-4)', () => {
  it('maps every canonical token to its exact display identity', () => {
    expect(resolveCliLabel('open_code')).toEqual({
      displayLabel: 'OpenCode',
      longName: 'OpenCode',
      glyph: '◈',
      isUnknown: false,
    });
    expect(resolveCliLabel('copilot_cli')).toEqual({
      displayLabel: 'GitHub Copilot',
      longName: 'GitHub Copilot',
      glyph: '◆',
      isUnknown: false,
    });
    expect(resolveCliLabel('claude_code')).toEqual({
      displayLabel: 'Claude Code',
      longName: 'Claude Code',
      glyph: '◇',
      isUnknown: false,
    });
    expect(resolveCliLabel('internal')).toEqual({
      displayLabel: 'Internal',
      longName: 'Internal',
      glyph: '▫',
      isUnknown: false,
    });
  });

  it('pins the explicit fallback for unknown/null/undefined/empty', () => {
    for (const value of ['unknown', null, undefined, '', '   '] as const) {
      const parts = resolveCliLabel(value);
      expect(parts.displayLabel).toBe(CLI_UNKNOWN_LABEL);
      expect(parts.displayLabel).toBe('Unknown CLI');
      expect(parts.longName).toBe('CLI unknown');
      expect(parts.glyph).toBe('?');
      expect(parts.isUnknown).toBe(true);
    }
  });

  it('maps any unrecognized string to the fallback and NEVER to OpenCode', () => {
    const unrecognized = [
      'OPEN_CODE', // exact-token mapping is case-sensitive
      'open-code',
      'openai', // a model/provider id must never read as a CLI identity
      'anthropic',
      'gpt-4o',
      'constructor', // prototype keys must not resolve
      '__proto__',
      'toString',
    ];
    for (const value of unrecognized) {
      const parts = resolveCliLabel(value);
      expect(parts.isUnknown).toBe(true);
      expect(parts.displayLabel).toBe('Unknown CLI');
      expect(parts.displayLabel).not.toBe('OpenCode');
    }
  });

  it('trims surrounding whitespace before matching a canonical token', () => {
    expect(resolveCliLabel('  open_code  ').displayLabel).toBe('OpenCode');
    expect(resolveCliLabel('\tcopilot_cli\n').displayLabel).toBe('GitHub Copilot');
  });

  it('never maps an absent/unrecognized value to OpenCode', () => {
    for (const value of [null, undefined, '', 'unknown', 'mystery_cli']) {
      expect(resolveCliLabel(value).displayLabel).not.toBe('OpenCode');
      expect(resolveCliLabel(value).isUnknown).toBe(true);
    }
  });
});
