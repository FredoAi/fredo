/**
 * Spec #2946 ST-3 — theme/token + a11y source audit for the new files.
 *
 * Binding hygiene (plan token checklist / #2770): semantic tokens and the shared
 * `tint()` helper only — ZERO hex/rgba/hsl literals, ZERO `var(--x)NN`
 * alpha-append. And the a11y invariant: `aria-live` exists ONLY on the single
 * shared announcer, never on the visual keycaps.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
// Spec #3009 — the new element-model + always-on bar files obey the SAME
// token/var hygiene and single-live-region discipline as the shipped surfaces.
const HOTKEY_BAR = 'src/shared/hotkeys/HotkeyBar.tsx';
const HOTKEY_BAR_MODEL = 'src/shared/hotkeys/hotkeyBarModel.ts';
const HOTKEY_ELEMENTS = 'src/shared/hotkeys/hotkeyElements.ts';
const HOTKEY_GRAMMAR = 'src/shared/hotkeys/hotkeyGrammar.ts';
const HOTKEYS_PROVIDER = 'src/shared/hotkeys/HotkeysProvider.tsx';
const ENGINE = 'src/shared/hotkeys/engine.ts';
const REGISTRY = 'src/shared/hotkeys/registry.ts';
const FILES = [
  KEYCAP,
  DESCRIBE,
  ANNOUNCER,
  HOTKEY_BAR,
  HOTKEY_BAR_MODEL,
  HOTKEY_ELEMENTS,
  HOTKEY_GRAMMAR,
  HOTKEYS_PROVIDER,
  ENGINE,
  REGISTRY,
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

// ── ST-6 (#3009) — ONE dispatch listener / ONE action table ──────────────────

const HOTKEYS_DIR = 'src/shared/hotkeys';

/** Every top-level source file in `shared/hotkeys/`, deterministically ordered. */
function listHotkeySources(): string[] {
  return readdirSync(resolve(process.cwd(), HOTKEYS_DIR))
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .sort();
}

describe('ST-6 source audit — exactly ONE dispatch listener', () => {
  it('the only document keydown listeners are the engine dispatch + the traversal Tab boundary', () => {
    const listeners = listHotkeySources()
      .map((name) => ({
        name,
        count: [
          ...stripComments(
            readFileSync(resolve(process.cwd(), HOTKEYS_DIR, name), 'utf8'),
          ).matchAll(/document\.addEventListener\(\s*['"]keydown['"]/g),
        ].length,
      }))
      .filter((entry) => entry.count > 0);

    // Exactly TWO `document` keydown listeners exist: the ONE engine dispatch
    // listener (engine.ts) and the ONLY other, non-dispatch listener — the Tab
    // window-boundary handler in traversal.ts (documented). No module adds a
    // third, parallel listener.
    expect(listeners).toEqual([
      { name: 'engine.ts', count: 1 },
      { name: 'traversal.ts', count: 1 },
    ]);
  });

  it('no module exports a second dispatch entry or a second action table', () => {
    for (const name of listHotkeySources()) {
      const code = stripComments(readFileSync(resolve(process.cwd(), HOTKEYS_DIR, name), 'utf8'));
      expect(code, `${name} must not export a second dispatch entry`).not.toMatch(
        /export\s+(?:async\s+)?(?:function|const)\s+dispatch\b/,
      );
    }
    // The registry is the single action table: exactly one run entry point.
    const registry = stripComments(
      readFileSync(resolve(process.cwd(), HOTKEYS_DIR, 'registry.ts'), 'utf8'),
    );
    expect([...registry.matchAll(/export\s+function\s+runHotkeyAction\b/g)]).toHaveLength(1);
  });
});
