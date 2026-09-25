/**
 * Spec #2946 ST-6 — source-level token hygiene for the new Hotkeys surface
 * files (plan token checklist / #2770): semantic tokens + CSS vars + the shared
 * `tint()` helper only — ZERO hex/rgb/hsl literals and ZERO `var(--x)NN`
 * alpha-append.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

const FILES = [
  'src/features/settings-app/components/HotkeysSettings.tsx',
  'src/features/settings-app/components/SettingsSurface.tsx',
  'src/shared/hotkeys/vimPreset.ts',
] as const;

describe('ST-6 source audit — token hygiene', () => {
  it('scans real, non-empty files', () => {
    for (const file of FILES) {
      expect(readSource(file).length, `${file} must exist`).toBeGreaterThan(0);
    }
  });

  it('contains no hex / rgb() / hsl() colour literal in code', () => {
    for (const file of FILES) {
      const code = readSource(file);
      const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(hex, `${file}: hex ${JSON.stringify(hex)}`).toEqual([]);
      const functional = [...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
      expect(functional, `${file}: functional colour ${JSON.stringify(functional)}`).toEqual([]);
    }
  });

  it('contains no var(--x)NN alpha-append', () => {
    for (const file of FILES) {
      const appends = [...readSource(file).matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0]);
      expect(appends, `${file}: var() alpha-append ${JSON.stringify(appends)}`).toEqual([]);
    }
  });
});
