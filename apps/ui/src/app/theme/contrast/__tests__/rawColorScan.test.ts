/**
 * Spec #3033 ST-4 — focused unit checks for the raw-colour scanner + allowlist.
 * Pure (no browser, no fs): all inputs are controlled fixtures.
 */

import { describe, expect, it } from 'vitest';
import { defaultScanTargets, normalizeRawLiteral, scanRawColors } from '../rawColorScan';
import { RAW_COLOR_ALLOWLIST } from '../rawColorAllowlist';

const ALLOWLISTED_TERMINAL_FILE =
  'apps/ui/src/applications/terminal/components/SessionTerminal.tsx';
const ALLOWLISTED_CANVAS_FILE =
  'apps/ui/src/applications/dev-mode/components/SpatiotemporalManifold.tsx';

describe('normalizeRawLiteral', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizeRawLiteral('  RGBA(255,  255, 255, 0.25)  ')).toBe(
      'rgba(255, 255, 255, 0.25)',
    );
    expect(normalizeRawLiteral('#3B82F6')).toBe('#3b82f6');
  });
});

describe('scanRawColors — detection', () => {
  it('reports an injected hardcoded colour in a non-allowlisted application path', () => {
    const violations = scanRawColors([
      { path: 'src/applications/__injected__/Bad.tsx', source: 'const c = "#ff0000";' },
    ]);
    expect(violations).toEqual([
      { file: 'src/applications/__injected__/Bad.tsx', literal: '#ff0000', kind: 'hex' },
    ]);
  });

  it('captures the full balanced call for functional colours (kind function)', () => {
    const violations = scanRawColors([
      { path: 'src/applications/X.tsx', source: 'bg="rgba(10, 15, 25, 0.7)"' },
    ]);
    expect(violations).toEqual([
      { file: 'src/applications/X.tsx', literal: 'rgba(10, 15, 25, 0.7)', kind: 'function' },
    ]);
  });

  it('reports var() alpha-append (kind var-alpha-append), one digit per the pattern', () => {
    const violations = scanRawColors([
      { path: 'src/applications/X.tsx', source: 'background="var(--accent-primary)22"' },
    ]);
    expect(violations).toEqual([
      {
        file: 'src/applications/X.tsx',
        literal: 'var(--accent-primary)2',
        kind: 'var-alpha-append',
      },
    ]);
  });

  it('strips block and trailing line comments before scanning', () => {
    const violations = scanRawColors([
      {
        path: 'src/applications/X.tsx',
        source: "const c = '#ff0000'; // issue #00ff00\n/* Spec #0000ff */\n",
      },
    ]);
    expect(violations.map((v) => v.literal)).toEqual(['#ff0000']);
  });
});

describe('scanRawColors — literal-pinned allowlist (anti-widening)', () => {
  it('allows an allowlisted file + one of its enumerated literals', () => {
    const violations = scanRawColors([
      { path: ALLOWLISTED_TERMINAL_FILE, source: "const c = '#f44747';" },
    ]);
    expect(violations).toEqual([]);
  });

  it('reports a NEW literal added to an allowlisted file', () => {
    const violations = scanRawColors([
      { path: ALLOWLISTED_TERMINAL_FILE, source: "const c = '#123456';" },
    ]);
    expect(violations).toEqual([
      { file: ALLOWLISTED_TERMINAL_FILE, literal: '#123456', kind: 'hex' },
    ]);
  });

  it('reports a DOM-chrome colour added beside an allowlisted canvas palette', () => {
    const violations = scanRawColors([
      { path: ALLOWLISTED_CANVAS_FILE, source: 'color="rgba(255,255,255,0.25)"' },
    ]);
    expect(violations).toEqual([
      { file: ALLOWLISTED_CANVAS_FILE, literal: 'rgba(255,255,255,0.25)', kind: 'function' },
    ]);
  });
});

describe('defaultScanTargets', () => {
  const targets = defaultScanTargets();

  it('covers system.ts and feature components under applications/', () => {
    const paths = targets.map((t) => t.path);
    expect(paths).toContain('apps/ui/src/app/theme/system.ts');
    expect(paths.some((p) => p.includes('dev-mode/components/DevMode.tsx'))).toBe(true);
    expect(paths.every((p) => p.startsWith('apps/ui/src/'))).toBe(true);
    expect(targets.length).toBeGreaterThan(50);
  });

  it('excludes test/spec/declaration files and carries sources', () => {
    expect(targets.every((t) => !/(?:__tests__|__mocks__)/.test(t.path))).toBe(true);
    expect(targets.every((t) => !/\.(?:test|spec)\.tsx?$/.test(t.path))).toBe(true);
    expect(targets.every((t) => t.source.length > 0)).toBe(true);
  });
});

describe('RAW_COLOR_ALLOWLIST schema', () => {
  it('is literal-pinned with reviewed, non-empty literals and a since reference', () => {
    expect(RAW_COLOR_ALLOWLIST.length).toBeGreaterThan(0);
    const kinds = new Set(['terminal-ansi', 'canvas-3d', 'node-identity', 'test-fixture']);
    for (const entry of RAW_COLOR_ALLOWLIST) {
      expect(kinds.has(entry.kind)).toBe(true);
      expect(entry.literals.length).toBeGreaterThan(0);
      expect(entry.file.endsWith('/DevMode.tsx')).toBe(false);
      expect(/^\s*$/.test(entry.since)).toBe(false);
      for (const literal of entry.literals) {
        expect(literal).toBe(normalizeRawLiteral(literal));
      }
    }
  });
});
