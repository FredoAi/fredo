/**
 * #2868 ST-3 — Settings app chrome theming regression (migrated from #2864 ST-5,
 * REQ-9 / REQ-10).
 *
 * The audited surface must stay 100% token-driven: every rendered color derives
 * from the theming feature (semantic token, CSS var, or the shared `tint()`
 * helper) — never a hex/rgba/hsl literal, and never an invalid `var(--x)NN`
 * alpha-append (dropped by the browser at computed-value time, #2770 round 5).
 *
 * This is the durable enforcement behind AC-2's "0 literals": a drive-by literal
 * now fails the suite instead of surviving to a manual grep.
 *
 * MIGRATION (#2868 ST-2 retired the modal): the audit moves from the retired
 * home/components modal to the Settings app shell (`SettingsFeature` +
 * `SettingsSurface`). The retired modal's `<Dialog.*>` chrome (backdrop
 * `var(--overlay-bg)`, elevation `var(--shadow-dialog)`) no longer exists; the
 * live window-frame chrome it carried instead (sidebar `var(--header-bg)`,
 * `var(--border-color)` dividers, `var(--card-bg)` footer) is asserted in its
 * place. Every still-applicable token assertion is preserved verbatim — the
 * guard is relocated and refreshed, never weakened.
 *
 * Exemptions (matching QA Q-3): comment issue refs (`#<issue-number>`, e.g.
 * `#2864`) are stripped before scanning, and the allowed CSS keywords
 * `transparent` / `inherit` / `currentColor` / `none` are not color literals.
 * `theme.ts` token VALUE data is data, not a component, so it is out of scope.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The exact files the #2864 audit covers (paths relative to `apps/ui`). */
const AUDITED_FILES = [
  'src/features/settings-app/components/SettingsSurface.tsx',
  'src/features/settings-app/SettingsFeature.tsx',
  'src/shared/components/companion/CompanionSettingsPanel.tsx',
  'src/shared/components/companion/CompanionSetupWizard.tsx',
  'src/shared/components/companion/SetupStepCard.tsx',
  'src/shared/components/companion/ModelFilesStepCard.tsx',
  'src/shared/components/companion/ServerLaunchStepCard.tsx',
] as const;

/**
 * vitest runs with cwd = apps/ui (the package root), so sources resolve from
 * `process.cwd()` — the established convention for source-level guards here
 * (`import.meta.url` is not a file scheme under this workspace setup).
 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * Strip block + line comments so spec issue references (`#2864`, `#2855`, …)
 * and doc prose never false-positive the color scan. This is the sanctioned
 * pattern used by the SubagentNode theming guard.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

interface ColorPattern {
  kind: string;
  re: RegExp;
}

/** The color-literal shapes QA Q-3 greps for. */
function colorPatterns(): ColorPattern[] {
  return [
    { kind: 'hex', re: /#[0-9a-fA-F]{3,8}\b/g },
    { kind: 'rgb', re: /\brgba?\(/g },
    { kind: 'hsl', re: /\bhsla?\(/g },
    { kind: 'var-alpha-append', re: /var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/g },
  ];
}

/** Return human-readable offenders; empty array = literal-free. */
function findColorLiterals(source: string): string[] {
  const stripped = stripComments(source);
  const offenders: string[] = [];
  for (const { kind, re } of colorPatterns()) {
    const matches = stripped.match(re);
    if (matches && matches.length > 0) offenders.push(`${kind}: ${matches.join(', ')}`);
  }
  return offenders;
}

describe('#2864 ST-5 literal guard — the guard itself', () => {
  it('flags every color-literal shape (hex, rgb/rgba, hsl/hsla, var() alpha-append)', () => {
    const offenders = findColorLiterals(
      "const a = '#ff0000'; const b = 'rgba(0, 0, 0, 0.6)'; const c = 'hsl(1, 2, 3)'; const d = 'var(--accent-primary)28';",
    ).join(' | ');
    expect(offenders).toContain('hex');
    expect(offenders).toContain('ff0000');
    expect(offenders).toContain('rgb');
    expect(offenders).toContain('hsl');
    expect(offenders).toContain('var-alpha-append');
  });

  it('ignores comment issue refs and the allowed CSS keywords', () => {
    const clean = [
      '// #2864 ST-5 — the fix references issue #2855.',
      '/** Block comment: (#2856) / #2857 are issue refs. */',
      "{/* JSX comment: Spec #2848 */}",
      "const a = 'transparent';",
      "const b = 'inherit';",
      "const c = 'currentColor';",
      "const d = 'none';",
    ].join('\n');
    expect(findColorLiterals(clean)).toEqual([]);
  });
});

describe('#2864 ST-5 literal guard — audited component files', () => {
  it.each(AUDITED_FILES)('%s has zero color literals', (relativePath) => {
    const offenders = findColorLiterals(readSource(relativePath));
    expect(offenders, `${relativePath} color literals`).toEqual([]);
  });
});

describe('#2868 ST-3 — SettingsSurface chrome consumes registered tokens (migrated)', () => {
  const source = readSource('src/features/settings-app/components/SettingsSurface.tsx');

  it('routes every chrome value through its theme token', () => {
    // Scrollbar thumb + hover (T3/T4).
    expect(source).toContain('var(--scrollbar-thumb)');
    expect(source).toContain('var(--scrollbar-thumb-hover)');
    // Active-nav fill + indicator (T6, live accent).
    expect(source).toContain("tint('var(--accent-primary)', 12)");
    expect(source).toContain('var(--accent-strong)');
    // Nav hover + focus (T1).
    expect(source).toContain('var(--hover-bg)');
    // Live window-frame chrome: sidebar header surface, content/sidebar
    // dividers, and the save footer surface. Replaces the retired dialog's
    // `var(--overlay-bg)` backdrop + `var(--shadow-dialog)` elevation.
    expect(source).toContain('var(--header-bg)');
    expect(source).toContain('var(--border-color)');
    expect(source).toContain('var(--card-bg)');
    // Nav text states.
    expect(source).toContain('var(--text-primary)');
    expect(source).toContain('var(--text-secondary)');
    // Save button foreground (T5).
    expect(source).toContain('var(--accent-contrast)');
  });

  it('no longer carries the removed hardcoded chrome values', () => {
    const stripped = stripComments(source);
    // The classic-purple active-nav fill + white-alpha hover/scrollbar.
    expect(stripped).not.toMatch(/147,\s*51,\s*234/);
    expect(stripped).not.toMatch(/255,\s*255,\s*255/);
    // The backdrop + shadow rgba literals.
    expect(stripped).not.toMatch(/0,\s*0,\s*0/);
  });
});
