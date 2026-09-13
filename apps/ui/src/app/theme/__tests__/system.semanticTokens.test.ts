/**
 * #2865 ST-3a — semantic-token bridge repair guard (R-3.2 / F-14).
 *
 * `system.ts` maps the shared `bg.*`/`fg.*`/`border.*` semantic tokens onto the
 * Fredo theme CSS vars. Chakra's `defaultConfig` ALSO defines those namespaces
 * (nested), and the nested definitions win the `colors.<path>` resolution — so a
 * flat dotted key (`'fg.muted'`) emits an unreachable escaped-dot custom property
 * and the stock Chakra value (`#52525b`) survives. These assertions pin the fix:
 * the namespaces are declared nested, so they emit DASH custom properties
 * (`--chakra-colors-fg-muted`) aliasing the Fredo vars with no stock fallback and
 * no empty token.
 */
import { describe, it, expect } from 'vitest';
import { system } from '../system';

/** The resolved base-layer token CSS, keyed by emitted custom-property name. */
const baseTokenVars = (): Record<string, string> => {
  const tokenCss = system.getTokenCss() as Record<string, unknown>;
  const layer = tokenCss['@layer tokens'] as
    | Record<string, Record<string, string>>
    | Array<Record<string, Record<string, string>>>;
  const layerEntry = Array.isArray(layer) ? layer[0] : layer;
  return layerEntry['&:where(html, .chakra-theme)'];
};

/** emitted custom property → the Fredo var it MUST alias. */
const FREDO_TOKEN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--chakra-colors-bg-canvas', 'var(--body-bg)'],
  ['--chakra-colors-bg-surface', 'var(--card-bg)'],
  ['--chakra-colors-bg-subtle', 'var(--header-bg)'],
  ['--chakra-colors-bg-muted', 'var(--card-hover-bg)'],
  ['--chakra-colors-bg-hover', 'var(--hover-bg)'],
  ['--chakra-colors-fg-default', 'var(--text-primary)'],
  ['--chakra-colors-fg-muted', 'var(--text-secondary)'],
  ['--chakra-colors-fg-subtle', 'var(--text-subtle)'],
  ['--chakra-colors-fg-on-accent', 'var(--accent-contrast)'],
  ['--chakra-colors-border-default', 'var(--border-color)'],
  ['--chakra-colors-border-subtle', 'var(--border-color)'],
];

describe('#2865 ST-3a semantic-token bridge', () => {
  it('registers bg/fg/border as NESTED semantic tokens (not flat dotted keys)', () => {
    const fg = system.query.semanticTokens.search('colors', 'fg');
    expect(fg).toContain('fg.default');
    expect(fg).toContain('fg.muted');
    expect(fg).toContain('fg.subtle');
    expect(fg).toContain('fg.onAccent');

    const bg = system.query.semanticTokens.search('colors', 'bg');
    expect(bg).toContain('bg.canvas');
    expect(bg).toContain('bg.surface');
    expect(bg).toContain('bg.subtle');
    expect(bg).toContain('bg.muted');
    expect(bg).toContain('bg.hover');

    const border = system.query.semanticTokens.search('colors', 'border');
    expect(border).toContain('border.default');
    expect(border).toContain('border.subtle');
  });

  it('emits dash custom properties aliasing the Fredo vars (F-14 acceptance)', () => {
    const base = baseTokenVars();
    for (const [name, expected] of FREDO_TOKEN_ALIASES) {
      expect(base[name], name).toBe(expected);
    }
  });

  it('never resolves to a stock Chakra value and never emits an empty token', () => {
    const base = baseTokenVars();
    // Stock Chakra gray.600 / gray.400 — the pre-fix failure surface.
    expect(base['--chakra-colors-fg-muted']).not.toBe('#52525b');
    expect(base['--chakra-colors-fg-subtle']).not.toBe('#a1a1aa');
    for (const [name] of FREDO_TOKEN_ALIASES) {
      expect(base[name], name).toBeTruthy();
      expect(String(base[name]).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the live-accent colorPalette + non-overlapping namespaces unchanged', () => {
    const base = baseTokenVars();
    // Regression invariant: `colorPalette="accent"` still resolves to the vars.
    expect(system.token('colors.accent.solid')).toBeDefined();
    expect(base['--chakra-colors-accent\\.solid']).toBe('var(--accent-primary)');
    expect(base['--chakra-colors-accent\\.contrast']).toBe('var(--accent-contrast)');
    // Non-overlapping namespaces keep their escaped-dot emission.
    expect(base['--chakra-colors-overlay\\.scrim']).toBe('var(--overlay-bg)');
    expect(base['--chakra-colors-status\\.success']).toBe('var(--status-success)');
  });
});
