/**
 * Zoned pane + overlay chrome — token-first audit — Spec #2980 ST-4 (R-5.2 NFR).
 *
 * The zone redesign is token-first: every colour in the zoned pane and the
 * overlay must be a Chakra semantic token, a theme CSS var, or a `tint()`
 * color-mix — with NO hardcoded hex/rgba, NO `var(--x)NN` alpha-append (the
 * #2770 trap), and no new theming token. This is the focused ST-4 pin that names
 * the two ST-4 paints specifically, so a regression that copies a literal into
 * either file fails here first.
 *
 * (The retired `PaneDivider.tsx` is not audited — ST-6 deletes it.)
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
const OVERLAY = readSource('ZoneOverlay.tsx');

describe('zoned pane + overlay chrome — token-first audit (R-5.2)', () => {
  it('audits the real files (guards against an empty read passing vacuously)', () => {
    expect(PANE.code).toContain('workspace-pane-');
    expect(OVERLAY.code).toContain('zone-overlay');
  });

  it('contains no hex / rgb() / hsl() colour literal in code', () => {
    for (const { code, rel } of [PANE, OVERLAY]) {
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
    for (const { code, rel } of [PANE, OVERLAY]) {
      const appends = [...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0]);
      expect(appends, `${rel}: var() alpha-append ${JSON.stringify(appends)}`).toEqual([]);
    }
  });

  it('routes every tint through the shared color-mix helper', () => {
    for (const { code, rel } of [PANE, OVERLAY]) {
      expect(code, `${rel} must use tint()`).toContain('tint(');
      expect(code, `${rel} must import the shared tint helper`).toContain(
        "from '../utils/colorTint'",
      );
      // The accent chrome is tinted from the LIVE accent var, not a literal.
      expect(code).toContain("tint('var(--accent-primary)'");
    }
  });

  it('declares the chrome from theme tokens / CSS vars', () => {
    const surface = `${PANE.code}\n${OVERLAY.code}`;
    for (const token of [
      'bg.surface',
      'accent.default',
      'border.default',
      'var(--border-color)',
      'var(--header-bg)',
      'var(--card-hover-bg)',
    ]) {
      expect(surface, `token ${token} must drive the zoned chrome`).toContain(token);
    }
  });

  it('never suppresses the focus ring (no outline: none)', () => {
    for (const { code, rel } of [PANE, OVERLAY]) {
      expect(code, `${rel} must not suppress the focus ring`).not.toMatch(
        /outline\s*[:=]\s*['"]none['"]/,
      );
    }
  });
});
