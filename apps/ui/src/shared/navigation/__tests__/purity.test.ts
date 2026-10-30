/**
 * Spec #3117 (P3) — ST-5 source-purity scan (AC1 / REQ-01.1–01.4, REQ-01.7, REQ-04.1).
 *
 * This is a STANDING proof: it re-checks the module's purity on every `test:run` instead of
 * once by a reader. It reads the ELEVEN real module sources from disk with
 * `readFileSync(resolve(process.cwd(), 'src/shared/navigation/<file>'))` (vitest's cwd is
 * `apps/ui`; `import.meta.url` is NOT a file scheme there), strips comments and — for the
 * token scans — string/template literals, and asserts the boundaries.
 *
 * Why strip string literals: the domain id `'wireframe.document.new'` legitimately contains
 * the token `document.`. A substring match on the raw source would force evasion-shaped
 * code (the module currently composes that id from fragments); stripping literals makes the
 * scan assert "no DOM-global MEMBER ACCESS", which is the real constraint.
 *
 * Every scan test asserts how many files it actually checked, so a renamed path fails loudly
 * instead of silently scanning nothing (the non-vacuity guard mirrors `themeHygiene.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** REQ-01.1 — the eleven module files, exactly. */
const MODULE_FILES = [
  'types.ts',
  'registry.ts',
  'resolver.ts',
  'keyResolver.ts',
  'dispatch.ts',
  'journal.ts',
  'context.ts',
  'discover.ts',
  'manifest.ts',
  'validation.ts',
  'index.ts',
] as const;

const MODULE_DIR = 'src/shared/navigation';
const TESTS_DIR = 'src/shared/navigation/__tests__';

/** REQ-01.2 — import specifiers that would break the module's purity boundary. */
const FORBIDDEN_SPECIFIERS = [
  'react',
  'react-dom',
  '@tauri-apps',
  'node:',
  '@/',
  '../',
  'applications/',
] as const;

/** REQ-01.3 — clock, global, timer, storage and network reads. */
const FORBIDDEN_TOKENS = [
  'Date.now(',
  'new Date(',
  'performance.now(',
  'setTimeout(',
  'setInterval(',
  'localStorage',
  'fetch(',
  'document.',
  'window.',
  'globalThis.',
] as const;

function readModule(file: string): string {
  return readFileSync(resolve(process.cwd(), `${MODULE_DIR}/${file}`), 'utf8');
}

/**
 * Strip block comments, line comments and (optionally) string / template literals.
 *
 * A single pass so a `//` inside a string or a quote inside a comment cannot desync the
 * scanner. Template literals are stripped whole, including their `${…}` interpolations.
 */
function sanitize(source: string, stripStrings: boolean): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      let literal = '';
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          literal += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        literal += current;
        index += 1;
      }
      out += stripStrings ? ' ' : `${quote}${literal}${quote}`;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Comments removed, strings kept (import specifiers live inside quotes). */
function codeWithStrings(file: string): string {
  return sanitize(readModule(file), false);
}

/** Comments AND string/template literals removed (token scans). */
function codeWithoutLiterals(file: string): string {
  return sanitize(readModule(file), true);
}

function importSpecifiers(code: string): string[] {
  return [
    ...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);
}

describe('navigation module purity (REQ-01.1–01.7)', () => {
  it('declares exactly eleven modules and a __tests__ directory', () => {
    // Non-vacuity guard (first assertion): the scan must READ eleven real, non-empty files.
    expect(MODULE_FILES).toHaveLength(11);
    expect(existsSync(resolve(process.cwd(), TESTS_DIR))).toBe(true);

    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const raw = readModule(file);
      expect(raw.trim().length, `${file} must exist and be non-empty`).toBeGreaterThan(0);
      scannedModules += 1;
    }

    // The assertion count: 11 modules read and checked, so a renamed path cannot pass.
    expect(scannedModules).toBe(11);
    expect(scannedModules).toBe(MODULE_FILES.length);
  });

  it('imports only sibling ./ modules', () => {
    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const code = codeWithStrings(file);
      const specifiers = importSpecifiers(code);

      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./'),
          `${file}: non-sibling import "${specifier}"`,
        ).toBe(true);
        for (const forbidden of FORBIDDEN_SPECIFIERS) {
          expect(
            specifier.includes(forbidden),
            `${file}: forbidden import token "${forbidden}" in "${specifier}"`,
          ).toBe(false);
        }
      }

      // Belt and braces: no non-relative static or dynamic import survives the scan at all.
      expect(code, `${file}: non-relative \`from\``).not.toMatch(/\bfrom\s+['"](?!\.\/)/);
      expect(code, `${file}: non-relative dynamic import`).not.toMatch(
        /\bimport\s*\(\s*['"](?!\.\/)/,
      );
      expect(code, `${file}: CommonJS require`).not.toMatch(/\brequire\s*\(/);

      scannedModules += 1;
    }
    expect(scannedModules).toBe(11);
  });

  it('reads no clock, global, timer, I/O or network', () => {
    // String and template literals are stripped BEFORE this check: `'wireframe.document.new'`
    // contains the token `document.` and must not force evasion-shaped code in the source.
    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const code = codeWithoutLiterals(file);
      expect(code.trim().length, `${file}: code must survive stripping`).toBeGreaterThan(0);

      for (const token of FORBIDDEN_TOKENS) {
        expect(code.includes(token), `${file}: forbidden token "${token}"`).toBe(false);
      }

      // No DOM-global member access of any kind.
      expect(code, `${file}: DOM-global member access`).not.toMatch(
        /\b(?:document|window|globalThis)\s*\./,
      );

      scannedModules += 1;
    }
    expect(scannedModules).toBe(11);
  });

  it('declares no any in module sources', () => {
    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const code = codeWithoutLiterals(file);
      expect(code, `${file}: ": any"`).not.toMatch(/:\s*any\b/);
      expect(code, `${file}: "<any>"`).not.toMatch(/<any>/);
      expect(code, `${file}: "as any"`).not.toMatch(/\bas\s+any\b/);
      expect(code, `${file}: "any[]"`).not.toMatch(/\bany\[\]/);
      scannedModules += 1;
    }
    expect(scannedModules).toBe(11);
  });

  it('holds no module-level mutable state', () => {
    // What is checkable in source: no top-level `let`/`var`, no module-scope mutable
    // collection (`new Map`/`new Set`/`new WeakMap`/`new WeakSet`) and no bare
    // module-scope assignment. Indented declarations live in function bodies and are fine.
    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const code = codeWithoutLiterals(file);
      const lines = code.split(/\r?\n/);

      for (const line of lines) {
        expect(
          /^(?:export\s+)?(?:let|var)\s/.test(line),
          `${file}: module-level mutable binding "${line.trim()}"`,
        ).toBe(false);
        expect(
          /^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(/.test(
            line,
          ),
          `${file}: module-scope mutable collection "${line.trim()}"`,
        ).toBe(false);
        expect(
          /^[\w$]+\s*=[^=]/.test(line),
          `${file}: module-scope assignment "${line.trim()}"`,
        ).toBe(false);
      }

      scannedModules += 1;
    }
    expect(scannedModules).toBe(11);
  });

  it('run is referenced only by dispatch.ts', () => {
    // REQ-04.1 — every channel reaches a verb through `dispatch`; no other module may
    // INVOKE `run`. We match call positions (`verb.run(` / a bare `run(`), never the
    // `run:` field declaration in `types.ts` or a descriptor's type annotation.
    let scannedModules = 0;
    for (const file of MODULE_FILES) {
      const code = codeWithoutLiterals(file);
      if (file === 'dispatch.ts') {
        // Positive control: the funnel DOES call the verb.
        expect(code).toMatch(/\bverb\.run\s*\(/);
        continue;
      }
      expect(code, `${file}: invokes run`).not.toMatch(/\brun\s*\(/);
      scannedModules += 1;
    }
    expect(scannedModules).toBe(10);
  });
});
