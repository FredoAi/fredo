/**
 * Continuous token-first chrome audit — Spec #2949 ST-8 (R11 / AC5).
 *
 * R11 is a CONTINUOUS-STATE requirement: pane + divider chrome must re-tint
 * live under a theme/accent change. That holds only if every colour is a theme
 * CSS var, a Chakra semantic token, or a `tint()` color-mix — with NO hardcoded
 * hex/rgba, NO `var(--x)NN` alpha-append (the #2770 trap), and NO new theming
 * token. `WindowFrame.test.tsx` REQ-9 scans the whole `window-system` directory;
 * this is the focused ST-8 pin that names the pane/divider chrome specifically,
 * so a regression that copies a literal into these two files fails here first.
 *
 * ST-3/ST-5 already routed every pane/divider colour through tokens/vars/`tint()`
 * — ST-8 is a verification + pin (no new token, no new code path).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Strip block + line comments so doc prose cannot mask a colour literal. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const DIR = resolve(process.cwd(), 'src/shared/window-system');

function readSource(file: string): { raw: string; code: string; rel: string } {
  const raw = readFileSync(resolve(DIR, file), 'utf8');
  return { raw, code: stripComments(raw), rel: file };
}

const PANE = readSource('WorkspacePane.tsx');
const DIVIDER = readSource('PaneDivider.tsx');

describe('pane + divider chrome — token-first audit (R11)', () => {
  it('audits the real files (guards against an empty read passing vacuously)', () => {
    expect(PANE.code).toContain('workspace-pane-');
    expect(DIVIDER.code).toContain('pane-divider-');
  });

  it('contains no hex / rgb() / hsl() colour literal in code', () => {
    for (const { code, rel } of [PANE, DIVIDER]) {
      const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(hex, `${rel}: hex colour literal(s) ${JSON.stringify(hex)}`).toEqual([]);

      const functional = [...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
      expect(
        functional,
        `${rel}: functional colour literal(s) ${JSON.stringify(functional)}`,
      ).toEqual([]);
    }
  });

  it('contains no var(--x)NN alpha-append (#2770 trap)', () => {
    for (const { code, rel } of [PANE, DIVIDER]) {
      const appends = [...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0]);
      expect(appends, `${rel}: var() alpha-append ${JSON.stringify(appends)}`).toEqual([]);
    }
  });

  it('routes every tint through the shared color-mix helper', () => {
    for (const { code, rel } of [PANE, DIVIDER]) {
      expect(code, `${rel} must use tint()`).toContain('tint(');
      expect(code, `${rel} must import the shared tint helper`).toContain("from '../utils/colorTint'");
    }
    // The accent chrome is tinted from the LIVE accent var, not a literal.
    expect(PANE.code).toContain("tint('var(--accent-primary)'");
    expect(DIVIDER.code).toContain("tint('var(--accent-primary)'");
  });

  it('declares the pane/divider chrome from theme tokens / CSS vars', () => {
    const surface = `${PANE.code}\n${DIVIDER.code}`;
    for (const token of [
      'bg.surface',
      'accent.default',
      'border.default',
      'var(--border-color)',
      'var(--header-bg)',
      'var(--card-hover-bg)',
    ]) {
      expect(surface, `token ${token} must drive the pane/divider chrome`).toContain(token);
    }
  });

  it('never suppresses the focus ring (no outline: none on pane/divider)', () => {
    for (const { code, rel } of [PANE, DIVIDER]) {
      expect(code).not.toMatch(/outline\s*[:=]\s*['"]none['"]/);
    }
    // The global :focus-visible guarantee is honoured by the divider's own ring.
    expect(DIVIDER.code).toContain('var(--accent-primary)');
    expect(DIVIDER.code).toContain('_focusVisible');
  });
});
