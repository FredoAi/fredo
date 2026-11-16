/**
 * Spec #3122 (P8), ST-5 — the committed absence guard (AC1 / AC2 / AC6 / AC8 / AC10;
 * EARS R-1.1, R-2.1, R-6.1, R-8.3, R-10.1).
 *
 * Scans the REAL tree through `readFileSync` (Vitest cwd is `apps/ui`; the repo root is
 * `resolve(process.cwd(), '../..')`) for:
 *   1. the Names Block §6 PURGE TOKENS (the retired hotkey runtime + the application
 *      command-surface opt-in). Comments and the TEXT of string literals are stripped
 *      first, so a prose/comment mention or a constructed test token cannot trip the ban,
 *      while template `${…}` interpolations are still scanned as CODE (G-419).
 *   2. the RETIRED APPLICATION references (AC10): the module/class tokens, the
 *      `applications/<retired-id>` paths and the QUOTED id literals. This pass is RAW —
 *      a reference in a comment or a string still counts (the AC is a literal zero).
 *
 * Scan scope (D-12): `apps/ui/src`, `apps/tauri/src`, `apps/opencode-plugin/src`,
 * `.opencode/tests/**`, `docs/**`. `apps/tools-mcp_DEPRECATED/**` is deliberately OUT of
 * scope — it is an already-deprecated backend for the retired browser extension whose
 * `optimizely` / `infrastructure-diagram` / `azdo-workitems` services are third-party
 * integrations, not the retired Fredo desktop applications.
 *
 * Self-reference allowlist (binding): this guard's own source and the five navigation
 * evidence docs, which necessarily quote the purge-token inventory so a tester can run it.
 * Every other path is literal-zero.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(process.cwd(), '../..');

/** D-12 scan scope. `apps/tools-mcp_DEPRECATED` is intentionally absent. */
const SCAN_ROOTS = [
  'apps/ui/src',
  'apps/tauri/src',
  'apps/opencode-plugin/src',
  '.opencode/tests',
  'docs',
] as const;

/** Text extensions worth scanning (binary artifacts never appear under these roots). */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.rs',
  '.toml',
  '.yml',
  '.yaml',
  '.txt',
]);

/** Directories that are build output / dependencies, never hand-written source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'coverage', 'gen']);

/** The exact binding self-reference allowlist. Paths are repo-root POSIX. */
const ALLOWLIST = new Set<string>([
  'apps/ui/src/shared/navigation/__tests__/legacyAbsence.test.ts',
  '.opencode/tests/navigation/smoke.md',
  '.opencode/tests/navigation/functional.md',
  '.opencode/tests/navigation/regression.md',
  '.opencode/tests/navigation/exploratory.md',
  '.opencode/tests/navigation/coverage-map.md',
]);

/**
 * Names Block §6 purge tokens. The bare `commandSurface` token is deliberately NOT here
 * (D-1): the Rust transport names are retained, so only the TS opt-in spellings are banned.
 * `g+` is a sequence token stored in strings (stripped by the G-419 rule); it is covered by
 * the durable-suite scrub and the QA R-1 grep, not by a code-token ban here.
 */
const PURGE_TOKENS = [
  'shared/hotkeys',
  'HotkeysProvider',
  'HotkeyAnnouncer',
  'HotkeyBar',
  'hotkeyBarModel',
  'hotkeyElements',
  'hotkeyGrammar',
  'commandSurfaceStore',
  'commandSurfaceFixture',
  'ApplicationCommandSurface',
  'FredoApplicationClass.commandSurface',
  'data-hotkey',
  'data-fredo-hotkey',
  'data-fredo-pending-sequence',
  'WIREFRAME_ACTIONS.hotkey',
] as const;

/** AC10 module/class tokens (raw scan — a comment/string reference is still a reference). */
const RETIRED_APP_TOKENS = [
  'ArchitectureDiagram',
  'DiagramFeature',
  'MyWorkItemsFeature',
  'CreateWorkItemFeature',
  'MyWorkItemsContainer',
  'OptimizelyFeature',
  'DocsViewerFeature',
  'GithubViewerFeature',
  'BrowserPreviewFeature',
  'ModelStorageFeature',
] as const;

/** `applications/<retired-id>` — the deleted registration modules. */
const RETIRED_APP_PATH =
  /applications\/(?:diagram|my-workitems|optimizely|docs-viewer|github-viewer|browser-preview|model-storage)(?:[/'"]|$)/;

/** A QUOTED retired app id (never a bare prose word like "diagram"). */
const RETIRED_APP_ID =
  /['"](?:diagram|my-workitems|create-workitem|optimizely|docs-viewer|github-viewer|browser-preview|model-storage)['"]/;

interface ScannedFile {
  /** Repo-root POSIX path. */
  readonly path: string;
  readonly source: string;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function walk(rootAbs: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return out; // an absent optional root (e.g. a package not checked out) is not a failure
  }
  for (const entry of entries) {
    const abs = join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(abs));
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    out.push(abs);
  }
  return out;
}

function scannedFiles(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(resolve(REPO_ROOT, root))) {
      const relativePath = toPosix(relative(REPO_ROOT, abs));
      if (ALLOWLIST.has(relativePath)) continue;
      files.push({ path: relativePath, source: readFileSync(abs, 'utf8') });
    }
  }
  return files;
}

/**
 * Remove comments and the TEXT of string literals, while keeping template `${…}`
 * interpolations as CODE (G-419). Escaped quotes/slashes are handled so a URL or an
 * escaped regex cannot be mistaken for a comment.
 */
function stripCode(source: string): string {
  let out = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');

  // Template literal: drop the literal text but keep every `${…}` expression.
  out = out.replace(/`(?:\\[\s\S]|[^`\\])*`/g, (match) => {
    const expressions: string[] = [];
    for (const expression of match.matchAll(/\$\{([\s\S]*?)\}/g)) {
      expressions.push(expression[1]);
    }
    return `\`${expressions.join(' ')}\``;
  });

  out = out.replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''");
  out = out.replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
  return out;
}

/** Only TypeScript/JavaScript carry JS string+comment syntax; everything else is raw. */
function codeText(file: ScannedFile): string {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)
    ? stripCode(file.source)
    : file.source;
}

const FILES = scannedFiles();

function purgeHits(): string[] {
  const hits: string[] = [];
  for (const file of FILES) {
    const text = codeText(file);
    for (const token of PURGE_TOKENS) {
      if (text.includes(token)) hits.push(`${file.path}: ${token}`);
    }
  }
  return hits;
}

function retiredAppHits(): string[] {
  const hits: string[] = [];
  for (const file of FILES) {
    for (const token of RETIRED_APP_TOKENS) {
      if (file.source.includes(token)) hits.push(`${file.path}: ${token}`);
    }
    if (RETIRED_APP_PATH.test(file.source)) hits.push(`${file.path}: applications/<retired-id>`);
    if (RETIRED_APP_ID.test(file.source)) hits.push(`${file.path}: quoted <retired-id>`);
  }
  return hits;
}

/**
 * AC6 / R-6.1 — the ADR-7 P8 exit predicate is a RAW `ADP-` grep over `apps/ui/src`
 * (the AC's own grep does not strip comments). It is therefore a THIRD pass and must
 * NOT use `stripCode`: the surviving occurrence was exactly a doc-comment mention, which
 * comment-stripping would hide. Scope is deliberately `apps/ui/src` ONLY — the ADR
 * deletion ledger (`docs/NAVIGATION_ENGINE.md` §12, `docs/adr/0007*`) legitimately lists
 * the adapter ids, and `docs/**` is not part of this predicate.
 *
 * The guard's own source necessarily contains the token literal; the `ALLOWLIST` above
 * self-excludes exactly this file (and the five navigation evidence docs of the other
 * passes), so the scan below never hides a product source.
 */
const ADP_SCAN_ROOT = 'apps/ui/src';

function adpHits(files: readonly ScannedFile[] = FILES): string[] {
  return files
    .filter((file) => file.path.startsWith(`${ADP_SCAN_ROOT}/`))
    .filter((file) => file.source.includes('ADP-'))
    .map((file) => file.path);
}

describe('legacyAbsence — the tree is non-vacuous', () => {
  it('scans the D-12 roots and thousands of real source files', () => {
    expect(FILES.length).toBeGreaterThan(500);
    for (const required of [
      'apps/ui/src/main.tsx',
      'apps/tauri/src/main.tsx',
      '.opencode/tests/terminal/functional.md',
      'docs/ARCHITECTURE.md',
    ]) {
      expect(FILES.some((file) => file.path === required), required).toBe(true);
    }
    // The allowlist excludes the evidence docs from the scan, never the whole root.
    expect(FILES.some((file) => file.path === '.opencode/tests/navigation/functional.md')).toBe(
      false,
    );
    // The allowlist never hides a scanned root.
    expect(FILES.some((file) => file.path === 'apps/ui/src/shared/navigation/keys.ts')).toBe(true);
  });
});

describe('legacyAbsence — no Names Block §6 purge token outside the allowlist (R-1 / R-2 / R-6)', () => {
  it('finds zero purge-token references', () => {
    expect(purgeHits()).toEqual([]);
  });

  it('stripCode keeps code (attributes/template expressions) and drops string/comment text', () => {
    // A JSX attribute is CODE — the token survives string stripping.
    expect(stripCode('<button data-hotkey="a" />')).toContain('data-hotkey');
    // The TEXT of a string literal is stripped (a constructed test token is not a hit).
    expect(stripCode("const legacy = 'data-hotkey';")).not.toContain('data-hotkey');
    // A template `${…}` expression is scanned as CODE.
    expect(stripCode('const name = `${HotkeysProvider}`;')).toContain('HotkeysProvider');
    // Comments are stripped.
    expect(stripCode('// data-hotkey\nconst x = 1;')).not.toContain('data-hotkey');
  });
});

describe('legacyAbsence — no retired application reference survives (AC10 / R-10.1)', () => {
  it('finds zero retired module/class tokens, paths or quoted ids', () => {
    expect(retiredAppHits()).toEqual([]);
  });

  it('detects the retired shapes in seeded synthetic source (non-vacuity)', () => {
    expect(RETIRED_APP_PATH.test("import '@/applications/browser-preview';")).toBe(true);
    expect(RETIRED_APP_ID.test("const id = 'optimizely';")).toBe(true);
    expect(RETIRED_APP_ID.test('a sequence diagram is not an app')).toBe(false);
  });
});

describe('legacyAbsence — no ADP- adapter id in apps/ui/src (AC6 / R-6.1, raw scan)', () => {
  it('finds zero raw ADP- references in apps/ui/src', () => {
    expect(adpHits()).toEqual([]);
  });

  it('scans RAW source (not stripCode), is scoped to apps/ui/src, and self-allowlists only this guard', () => {
    expect(ADP_SCAN_ROOT).toBe('apps/ui/src');

    // The guard's own token literal is the ONE self-allowlisted path in this scope.
    expect(
      ALLOWLIST.has('apps/ui/src/shared/navigation/__tests__/legacyAbsence.test.ts'),
    ).toBe(true);

    // Non-vacuity: the scan really walks the product source tree.
    const uiFiles = FILES.filter((file) => file.path.startsWith('apps/ui/src/'));
    expect(uiFiles.length).toBeGreaterThan(400);

    // Why this pass must be RAW: the surviving occurrence was a COMMENT, which stripCode hides.
    expect(stripCode('// ADP-15\nconst x = 1;').includes('ADP-')).toBe(false);
    expect('// ADP-15'.includes('ADP-')).toBe(true);

    // Negative control: a seeded hit in apps/ui/src is found.
    expect(
      adpHits([{ path: 'apps/ui/src/shared/navigation/synthetic.ts', source: '// ADP-15' }]),
    ).toEqual(['apps/ui/src/shared/navigation/synthetic.ts']);

    // The docs ADR ledger is out of the AC predicate and must not be scanned by this pass.
    expect(
      adpHits([{ path: 'docs/NAVIGATION_ENGINE.md', source: '| ADP-15 | **DELETED** |' }]),
    ).toEqual([]);
  });
});
