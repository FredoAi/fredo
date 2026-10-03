/**
 * Spec #2946 ST-3 — theme/token + a11y source audit for the new files.
 *
 * Binding hygiene (plan token checklist / #2770): semantic tokens and the shared
 * `tint()` helper only — ZERO hex/rgba/hsl literals, ZERO `var(--x)NN`
 * alpha-append. And the a11y invariant: `aria-live` exists ONLY on the single
 * shared announcer, never on the visual keycaps.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Strip block + line comments so doc prose (issue refs like `#2946`) cannot
 *  mask or satisfy a colour / a11y literal scan. Mirrors the repo pattern. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

const KEYCAP = 'src/shared/components/hotkeys/Keycap.tsx';
const DESCRIBE = 'src/shared/hotkeys/describe.ts';
const ANNOUNCER = 'src/shared/hotkeys/announcer.tsx';
// Spec #2959 ST-3 — the persistent key bar + its pure geometry + the shared
// dock-derived inset all obey the SAME token/var hygiene and single-live-region
// discipline as the shipped surfaces.
const KEYBOARD_BAR = 'src/shared/hotkeys/KeyboardBar.tsx';
const KEYBOARD_BAR_GEOMETRY = 'src/shared/hotkeys/keyboardBarGeometry.ts';
const BOTTOM_STACK = 'src/shared/hotkeys/bottomStack.ts';
// Spec #2960 ST-5 — the S3 cluster + its three integrated surfaces obey the SAME
// token/var hygiene and single-live-region discipline as the shipped surfaces.
const HOTKEYS_CLUSTER = 'src/shared/hotkeys/HotkeysCluster.tsx';
const INPUT_REGIME_INDICATOR = 'src/shared/hotkeys/InputRegimeIndicator.tsx';
const KEYS_DISCOVERY = 'src/shared/hotkeys/KeysDiscovery.tsx';
const KEYBOARD_INTRO = 'src/shared/hotkeys/KeyboardIntro.tsx';
const FILES = [
  KEYCAP,
  DESCRIBE,
  ANNOUNCER,
  KEYBOARD_BAR,
  KEYBOARD_BAR_GEOMETRY,
  BOTTOM_STACK,
  HOTKEYS_CLUSTER,
  INPUT_REGIME_INDICATOR,
  KEYS_DISCOVERY,
  KEYBOARD_INTRO,
];

describe('ST-3 source audit — token hygiene', () => {
  it('scans the real new files (guards against an empty glob passing vacuously)', () => {
    for (const file of FILES) {
      expect(readSource(file).length, `${file} must exist and be non-empty`).toBeGreaterThan(0);
    }
  });

  it('contains no hex / rgb() / hsl() colour literal in code (comments stripped)', () => {
    for (const file of FILES) {
      const code = readSource(file);

      const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(hex, `${file}: hex colour literal(s) ${JSON.stringify(hex)}`).toEqual([]);

      const functional = [...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
      expect(
        functional,
        `${file}: functional colour literal(s) ${JSON.stringify(functional)}`,
      ).toEqual([]);
    }
  });

  it('contains no var(--x)NN alpha-append (#2770 trap) in code', () => {
    for (const file of FILES) {
      const appends = [...readSource(file).matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0]);
      expect(appends, `${file}: var() alpha-append ${JSON.stringify(appends)}`).toEqual([]);
    }
  });

  it('Keycap uses the shared tint() helper and semantic tokens (positive control)', () => {
    const code = readSource(KEYCAP);
    expect(code).toContain('tint(');
    expect(code).toContain('bg="bg.subtle"');
    expect(code).toContain('color="fg.default"');
    expect(code).toContain('borderColor="border.subtle"');
    expect(code).toContain('fontFamily="mono"');
    expect(code).toContain('borderRadius="sm"');
  });
});

describe('ST-3 source audit — one live region only', () => {
  it('Keycap declares no aria-live / role="status"', () => {
    const code = readSource(KEYCAP);
    expect(code).not.toContain('aria-live');
    expect(code).not.toContain('role="status"');
    // Visual keycaps stay out of the accessibility tree — the announcer speaks.
    expect(code).toContain('aria-hidden="true"');
  });

  it('only the announcer file declares aria-live', () => {
    const withLive = FILES.filter((file) => readSource(file).includes('aria-live'));
    expect(withLive).toEqual([ANNOUNCER]);
  });

  it('the announcer carries the fixed help accessible name', () => {
    const source = readFileSync(resolve(process.cwd(), ANNOUNCER), 'utf8');
    expect(source).toContain("'Hotkey sequence help'");
  });
});
