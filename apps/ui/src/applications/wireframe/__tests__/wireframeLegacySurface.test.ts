/**
 * Wireframe legacy-surface removal scan (Spec #3119, ST-7 — R-7/AC7, R-6a/AC6, NFR).
 *
 * Every scan reads the REAL tree (`import.meta.glob` raw sources) and the REAL built
 * bundle (`apps/ui/dist/assets`), never a fixture. Comments are stripped before every
 * token check; identifier checks additionally strip the literal TEXT of strings and
 * template literals while keeping `${…}` interpolation expressions as CODE (G-419).
 * Attribute scans keep the legacy JSX attribute name — it is code, not a literal — while
 * the value text is stripped. The token is CONSTRUCTED so this suite is not itself a scan hit.
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';
import { wireframeFeature } from '../WireframeFeature';

/* ───────────────────────────── the real tree ───────────────────────────── */

const RAW_MODULES = import.meta.glob('/src/applications/wireframe/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const NON_SOURCE = /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

/** Constructed so this suite is not itself a legacy-attribute scan hit. */
const LEGACY_KEY_ATTR = ['data', 'hotkey'].join('-');
/** Constructed so this suite is not itself a purge-token hit. */
const LEGACY_SURFACE_PROP = ['command', 'Surface'].join('');

/** The Wireframe SOURCE tree (tests, mocks and `.d.ts` dropped). */
const SOURCE_TARGETS: Array<{ path: string; source: string }> = Object.entries(RAW_MODULES)
  .filter(([path]) => !NON_SOURCE.test(path) && !path.endsWith('.d.ts'))
  .map(([path, source]) => ({ path, source }));

/** Every Wireframe file, including tests (for the "no import of a removed module" leg). */
const ALL_TARGETS: Array<{ path: string; source: string }> = Object.entries(RAW_MODULES).map(
  ([path, source]) => ({ path, source }),
);

/* ───────────────────────────── stripping (G-419) ───────────────────────────── */

/** Remove block + line comments; string literals stay intact. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Remove comments AND the literal text of `'…'` / `"…"` / template literals, keeping
 * `${ … }` interpolation expressions as CODE (G-419). Nested strings/templates/comments
 * inside an interpolation are handled recursively through the same context stack.
 */
function stripLiteralText(source: string): string {
  type Context = { kind: 'code'; braceDepth: number } | { kind: 'template' };
  const stack: Context[] = [{ kind: 'code', braceDepth: 0 }];
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    const ctx = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (ctx.kind === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        i += 1;
        out.push('`');
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'code', braceDepth: 0 });
        i += 2;
        out.push('${');
        continue;
      }
      i += 1; // drop the template's literal text
      continue;
    }

    // code context
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out.push('""');
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      out.push('`');
      continue;
    }
    if (ctx.braceDepth === 0 && ch === '}' && stack.length > 1) {
      stack.pop();
      i += 1;
      out.push('}');
      continue;
    }
    if (ch === '{') ctx.braceDepth += 1;
    else if (ch === '}') ctx.braceDepth = Math.max(0, ctx.braceDepth - 1);
    out.push(ch);
    i += 1;
  }

  return out.join('');
}

/* ───────────────────────────── store-mutator scan ───────────────────────────── */

/** Store mutation entry points a UI handler must never call directly. */
const BANNED_STORE_MUTATORS = new Set([
  'dispatch',
  'applyDocumentPatch',
  'undo',
  'redo',
  'resetForNewDocument',
  'loadDocument',
  'addWireframeElement',
  'updateElement',
]);

/**
 * The ONE legitimate `applyDocumentPatch` importer: the navigation provider wires it
 * into the host as its `applyPatch` seam. No other component may import any mutator.
 */
const HOST_SEAM =
  '/src/applications/wireframe/components/WireframeNavigationProvider.tsx';

const COMPONENT_TARGETS = SOURCE_TARGETS.filter((target) =>
  target.path.includes('/components/'),
);

/** The named imports a file takes from any `wireframeDocumentStore` module path. */
function storeImports(source: string): {
  readonly names: string[];
  readonly namespaceAliases: string[];
} {
  const code = stripComments(source);
  const names: string[] = [];
  const namespaceAliases: string[] = [];
  const importRe = /import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;

  for (const match of code.matchAll(importRe)) {
    const clause = match[1];
    const modulePath = match[3];
    if (!modulePath.endsWith('wireframeDocumentStore')) continue;

    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace !== null) namespaceAliases.push(namespace[1]);

    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced === null) continue;
    for (const part of braced[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name !== '' && name !== 'type') names.push(name);
    }
  }

  return { names, namespaceAliases };
}

/* ───────────────────────────── timer scan ───────────────────────────── */

/**
 * Timer-loop violations in one source file. A `requestAnimationFrame` LOOP must re-arm,
 * so a file with ≥2 rAF calls, or a rAF inside an explicit `for`/`while` body, is a
 * loop; a single one-shot focus schedule is not. `setInterval`/`setTimeout` are always
 * violations in the Wireframe tree (the engine's 250 ms prefix clear is a `nowMs`
 * comparison, not a timer).
 */
function timerViolations(source: string): string[] {
  const code = stripLiteralText(source);
  const violations: string[] = [];

  if (/\bsetInterval\s*\(/.test(code)) violations.push('setInterval');
  if (/\bsetTimeout\s*\(/.test(code)) violations.push('setTimeout');

  const rafCalls = (code.match(/\brequestAnimationFrame\s*\(/g) ?? []).length;
  if (rafCalls >= 2) violations.push(`requestAnimationFrame x${rafCalls} (re-arm loop)`);
  if (rafCalls > 0 && /\b(?:for|while)\s*\([\s\S]{0,240}?requestAnimationFrame\s*\(/.test(code)) {
    violations.push('requestAnimationFrame inside a for/while loop');
  }

  return violations;
}

/* ───────────────────────────── the build bundle ───────────────────────────── */

const DIST_ASSETS = resolve(process.cwd(), 'dist/assets');
const BUNDLE_EXTENSIONS = /\.(?:js|css|html|map)$/;

function bundleFiles(): Array<{ name: string; text: string }> {
  expect(
    existsSync(DIST_ASSETS),
    'apps/ui/dist/assets is missing — run `pnpm --filter @fredo/ui build` before this suite',
  ).toBe(true);
  return readdirSync(DIST_ASSETS)
    .filter((name) => BUNDLE_EXTENSIONS.test(name))
    .map((name) => ({ name, text: readFileSync(join(DIST_ASSETS, name), 'utf8') }));
}

/** The three removed module spellings that must not reach the production bundle. */
const REMOVED_BUNDLE_TOKENS = [
  'wireframeCommandSurface',
  'WireframeHotkeyCarrier',
  'wireframe-hotkey-carrier',
] as const;

/* ───────────────────────────── the suite ───────────────────────────── */

describe('legacy Wireframe surface removal (R-7 / AC7)', () => {
  it('the legacy command surface and hotkey carrier are deleted', () => {
    const paths = Object.keys(RAW_MODULES);
    expect(paths.some((path) => path.endsWith('/wireframeCommandSurface.ts'))).toBe(false);
    expect(paths.some((path) => path.endsWith('/WireframeHotkeyCarrier.tsx'))).toBe(false);

    // Non-vacuity: the glob DOES enumerate the surviving modules.
    expect(paths.some((path) => path.endsWith('/wireframeSurface.ts'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/components/WireframeEditor.tsx'))).toBe(true);

    // No file in the Wireframe tree imports either removed module.
    const importers = ALL_TARGETS.flatMap(({ path, source }) => {
      const code = stripComments(source);
      return /from\s+['"][^'"]*(?:wireframeCommandSurface|WireframeHotkeyCarrier)[^'"]*['"]/.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(importers).toEqual([]);

    // `WireframeFeature` no longer declares the retired command surface.
    expect(
      (wireframeFeature as unknown as Record<string, unknown>)[LEGACY_SURFACE_PROP],
    ).toBeUndefined();
    const featureSource = RAW_MODULES['/src/applications/wireframe/WireframeFeature.tsx'] ?? '';
    expect(stripLiteralText(featureSource)).not.toMatch(
      new RegExp(`\\b${LEGACY_SURFACE_PROP}\\b`),
    );
  });

  it('no wireframe action declares a hotkey', () => {
    for (const action of WIREFRAME_ACTIONS) {
      expect(
        Object.prototype.hasOwnProperty.call(action, 'hotkey'),
        `action ${action.id} still declares a hotkey`,
      ).toBe(false);
    }

    const actionsSource =
      RAW_MODULES['/src/applications/wireframe/actions/wireframeActions.ts'] ?? '';
    // Identifier-level scan: comments AND string text stripped (G-419).
    expect(stripLiteralText(actionsSource)).not.toMatch(/\bhotkey\b/);
  });

  it('no wireframe source binds a g prefixed sequence', () => {
    // The binding LITERAL is the observable, so strings are kept here (comments stripped)
    // while imports/identifiers are not what this leg inspects.
    const violations = SOURCE_TARGETS.flatMap(({ path, source }) => {
      const hits = [...stripComments(source).matchAll(/(['"`])g\+[a-z0-9]/g)].map(
        (match) => match[0],
      );
      return hits.length > 0 ? [`${path}: ${hits.join(', ')}`] : [];
    });
    expect(violations).toEqual([]);

    // Non-vacuity: a reintroduced carrier binding WOULD be caught.
    expect(/(['"`])g\+[a-z0-9]/.test(`<span ${LEGACY_KEY_ATTR}="g+g" />`)).toBe(true);
  });

  it('no wireframe component carries a legacy key attribute', () => {
    const legacyAttrPattern = new RegExp(`\\b${LEGACY_KEY_ATTR}\\b`);
    const violations = SOURCE_TARGETS.flatMap(({ path, source }) =>
      legacyAttrPattern.test(stripLiteralText(source)) ? [path] : [],
    );
    expect(violations).toEqual([]);

    // Non-vacuity: the attribute NAME survives string stripping, so the scan is real.
    expect(legacyAttrPattern.test(stripLiteralText(`<button ${LEGACY_KEY_ATTR}="a" />`))).toBe(
      true,
    );
  });

  it('no ui handler mutates the store outside dispatch', () => {
    expect(COMPONENT_TARGETS.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const applyPatchImporters: string[] = [];

    for (const { path, source } of COMPONENT_TARGETS) {
      const { names, namespaceAliases } = storeImports(source);
      for (const name of names) {
        if (!BANNED_STORE_MUTATORS.has(name)) continue;
        if (name === 'applyDocumentPatch') applyPatchImporters.push(path);
        // The navigation provider is the host's ONE applyPatch seam; it may import ONLY
        // that mutator (never a second write path).
        if (path === HOST_SEAM && name === 'applyDocumentPatch') continue;
        violations.push(`${path} imports ${name}`);
      }

      // A namespace import must not reach a mutator through `<ns>.<name>`.
      if (namespaceAliases.length > 0) {
        const code = stripLiteralText(source);
        for (const alias of namespaceAliases) {
          for (const mutator of BANNED_STORE_MUTATORS) {
            if (new RegExp(`\\b${alias}\\s*\\.\\s*${mutator}\\b`).test(code)) {
              violations.push(`${path} calls ${alias}.${mutator}`);
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);

    // There is exactly ONE `applyDocumentPatch` importer — the provider seam — and no
    // component imports any other banned mutator.
    expect(applyPatchImporters).toEqual([HOST_SEAM]);

    // Read-only accessors stay allowed: the shell imports getSnapshot + subscribe.
    const editor = COMPONENT_TARGETS.find((target) => target.path.endsWith('/WireframeEditor.tsx'));
    expect(editor).toBeDefined();
    const editorImports = storeImports(editor!.source).names;
    expect(editorImports).toContain('getSnapshot');
    expect(editorImports).toContain('subscribe');
    expect(editorImports.some((name) => BANNED_STORE_MUTATORS.has(name))).toBe(false);

    // Negative self-test: a direct `dispatch` import IS flagged by the same parser.
    expect(storeImports(`import { dispatch } from '../store/wireframeDocumentStore';`).names).toContain(
      'dispatch',
    );
  });

  it('no new polling or timer loop exists', () => {
    const violations = SOURCE_TARGETS.flatMap(({ path, source }) =>
      timerViolations(source).map((kind) => `${path}: ${kind}`),
    );
    expect(violations).toEqual([]);

    // Non-vacuity: a reintroduced timer loop WOULD be caught.
    expect(timerViolations('setInterval(() => tick(), 16);')).toContain('setInterval');
    expect(timerViolations('setTimeout(run, 250);')).toContain('setTimeout');
    expect(
      timerViolations('const loop = () => { requestAnimationFrame(loop); }; requestAnimationFrame(loop);'),
    ).toContain('requestAnimationFrame x2 (re-arm loop)');
    // A single one-shot focus schedule is NOT a loop (the shipped New-document dialog).
    expect(timerViolations('requestAnimationFrame(() => cancelRef.current?.focus());')).toEqual([]);
  });

  it('the built bundle names no removed module', () => {
    const files = bundleFiles();
    expect(files.length).toBeGreaterThan(0);

    // Non-vacuity: the scan reads the REAL bundle (a shipped testid is present).
    expect(files.some((file) => file.text.includes('navigation-rail'))).toBe(true);

    for (const token of REMOVED_BUNDLE_TOKENS) {
      const hits = files.filter((file) => file.text.includes(token)).map((file) => file.name);
      expect(hits, `removed module "${token}" leaked into ${hits.join(', ')}`).toEqual([]);
    }
  });
});
