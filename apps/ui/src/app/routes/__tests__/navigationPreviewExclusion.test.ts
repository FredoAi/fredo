/**
 * Spec #3118 (P4), ST-6 — the DEV prototype's production-exclusion proof (AC8 / R-8.2,
 * QA Q8-02).
 *
 * Two independent legs:
 *
 *  1. **Source gate** (always runnable): the lazy import sits inside an
 *     `if (import.meta.env.DEV)` block, the preview is reached only through a dynamic
 *     `import(`, no other product source references `NavigationPreview`, `src/index.ts`
 *     exports nothing from `app/dev/`, and `'navigation-preview'` appears only in the
 *     Router's DEV branch.
 *  2. **Built-bundle receipt**: a real `pnpm --filter @fredo/ui build` must have emitted
 *     `apps/ui/dist/assets`, and every emitted file must contain ZERO occurrences of the
 *     five dev-route-only markers (`NavigationPreview`, `navigationDemoSurface`,
 *     `demo.canvas`, `demo.arrange`, `navigation-preview`). This is a plain file read over
 *     the named artifact — it works whether or not the claim holds (G-408), never "the app
 *     doesn't show it".
 *
 * The artifact leg deliberately FAILS when `dist` is absent: the receipt is the bundle, so a
 * run without a build is not evidence (run the build first).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateSurface, type ContextSnapshot } from '@/shared/navigation';
import { navPrefixMessage } from '@/shared/navigation/ui/announce';
import { createNavigationHost } from '@/shared/navigation/ui/host';
import {
  DEMO_PLACES,
  NAVIGATION_DEMO_SURFACE,
  createNavigationDemoController,
} from '../../dev/navigationDemoSurface';
import routerSource from '../Router.tsx?raw';

const UI_ROOT = process.cwd(); // vitest runs with cwd = apps/ui
const SRC_ROOT = resolve(UI_ROOT, 'src');
const INDEX_SOURCE = resolve(SRC_ROOT, 'index.ts');
const ROUTER_SOURCE = resolve(SRC_ROOT, 'app/routes/Router.tsx');
const DEV_DIR = resolve(SRC_ROOT, 'app/dev');

/** The five dev-route-only markers (Architect C2/C13 == QA Q8-02's set). */
const DEV_MARKERS = [
  'NavigationPreview',
  'navigationDemoSurface',
  'demo.canvas',
  'demo.arrange',
  'navigation-preview',
] as const;

/** Recursive file list (files only). */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** True when `path` lives inside a `__tests__` directory (test sources are not product code). */
function isTestPath(path: string): boolean {
  return path.split(sep).includes('__tests__');
}

/** True when `path` is under `app/dev/`. */
function isDevPath(path: string): boolean {
  const normalised = path.split(sep).join('/');
  return normalised.includes('/app/dev/');
}

/** Total (non-overlapping) occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Strip comments so prose cannot satisfy or defeat a source scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every PRODUCT source file under `src/` (tests and the dev prototype excluded). */
function productSources(): string[] {
  return walkFiles(SRC_ROOT).filter(
    (file) =>
      (file.endsWith('.ts') || file.endsWith('.tsx')) &&
      !isTestPath(file) &&
      !isDevPath(file),
  );
}

/* ───────────────────────────── 1. source gate ───────────────────────────── */

describe('DEV prototype — source gate (Q8-02 / R-8.2)', () => {
  const code = stripComments(routerSource);

  it('creates the lazy preview ONCE inside an `import.meta.env.DEV` block', () => {
    const devBlock = code.match(
      /if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*\{([\s\S]*?)\n\s*\}/,
    );
    expect(devBlock).not.toBeNull();
    const block = devBlock?.[1] ?? '';

    // The ONLY assignment of the lazy component is inside the compile-time-false block.
    expect(block).toContain('React.lazy(');
    expect(block).toContain("import('../dev/NavigationPreview')");
  });

  it('guards the render branch with `import.meta.env.DEV` as well', () => {
    expect(code).toMatch(/if\s*\(\s*import\.meta\.env\.DEV\s*&&/);
    expect((code.match(/import\.meta\.env\.DEV/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('reaches the preview only through a dynamic `import(` — never a static import', () => {
    expect(code).toContain("import('../dev/NavigationPreview')");
    expect(code).not.toMatch(/from\s+['"][^'"]*dev\/NavigationPreview['"]/);
  });

  it('has no other product source referencing the preview (non-vacuity: many sources scanned)', () => {
    const sources = productSources();
    expect(sources.length).toBeGreaterThan(100);

    for (const file of sources) {
      if (file === ROUTER_SOURCE) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, `${file} must not reference the dev preview`).not.toContain(
        'NavigationPreview',
      );
    }
  });

  it('exports nothing from `app/dev/` through the root barrel', () => {
    const indexSource = readFileSync(INDEX_SOURCE, 'utf8');
    expect(indexSource).not.toContain('app/dev');
    expect(indexSource).not.toContain('NavigationPreview');
  });

  it('keeps the `navigation-preview` literal inside the Router DEV branch only', () => {
    const sources = productSources();
    // Comments are not emitted code: the bound names block documents that the literals are
    // deliberately absent, so scan the stripped source (the bundle receipt below is the
    // authoritative artifact proof).
    const offenders = sources.filter(
      (file) =>
        file !== ROUTER_SOURCE &&
        stripComments(readFileSync(file, 'utf8')).includes('navigation-preview'),
    );
    expect(offenders).toEqual([]);

    // The Router itself owns the literal (the branch the test above proves is DEV-gated).
    expect(code).toContain("'navigation-preview'");
  });

  it('declares the dev prototype directory outside every application tree', () => {
    expect(DEV_DIR.split(sep).join('/')).toContain('/app/dev');
    expect(DEV_DIR.split(sep).join('/')).not.toContain('/applications/');
  });
});

/* ───────────────────────────── 2. demo declaration ───────────────────────────── */

describe('DEV prototype declaration (Q8-01 static legs / R-8.1)', () => {
  it('is a valid surface declaring exactly the Canvas tree (Canvas + six children)', () => {
    const validation = validateSurface(NAVIGATION_DEMO_SURFACE);
    expect(validation.diagnostics).toEqual([]);
    expect(validation.valid).toBe(true);

    expect(NAVIGATION_DEMO_SURFACE.tree.root).toBe(DEMO_PLACES.canvas);
    expect(NAVIGATION_DEMO_SURFACE.tree.places.map((place) => place.label)).toEqual([
      'Canvas',
      'Create',
      'Edit',
      'Arrange',
      'Style',
      'View',
      'File',
    ]);
  });

  it('declares a transient Create, sticky children, nine Arrange verbs and the direct aliases', () => {
    const byId = new Map(
      NAVIGATION_DEMO_SURFACE.tree.places.map((place) => [place.id, place]),
    );
    expect(byId.get(DEMO_PLACES.create)?.transient).toBe(true);
    for (const place of ['edit', 'arrange', 'style', 'view', 'file'] as const) {
      expect(byId.get(DEMO_PLACES[place])?.sticky).toBe(true);
    }

    const arrange = byId.get(DEMO_PLACES.arrange);
    expect(arrange).toBeDefined();
    expect(Object.keys(arrange?.keys ?? {})).toHaveLength(9);

    expect(NAVIGATION_DEMO_SURFACE.tree.directAliases).toEqual({
      r: 'place.rect',
      e: 'place.ellipse',
      u: 'journal.undo',
      y: 'journal.redo',
    });
  });

  it('exposes a controller whose host records ONE companion-attributed entry', async () => {
    const controller = createNavigationDemoController();
    expect(controller.surface).toBe(NAVIGATION_DEMO_SURFACE);
    expect(controller.confirm({} as never)).toBe(true);

    const context = (): ContextSnapshot => controller.getContext();
    const host = createNavigationHost({
      surface: NAVIGATION_DEMO_SURFACE,
      getContext: context,
      applyPatch: (patch) => controller.applyPatch(patch),
      confirm: () => true,
    });

    await host.runVerb('place.rect', 'agent');
    const entries = host.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe('companion');
    expect(entries[0]?.label).toBe('Rectangle');
  });

  it('declares the two-stroke Canvas prefix (w n → View, w p → Style) and no bare w', () => {
    const canvas = NAVIGATION_DEMO_SURFACE.tree.places.find(
      (place) => place.id === DEMO_PLACES.canvas,
    );
    expect(canvas).toBeDefined();

    // The prefix continuations are real verb bindings on the root place (Q4-07).
    expect(canvas?.keys['w n']).toEqual({ kind: 'verb', verbId: DEMO_PLACES.view });
    expect(canvas?.keys['w p']).toEqual({ kind: 'verb', verbId: DEMO_PLACES.style });

    // V-11 satisfiability: Canvas declares no bare `w`, so the prefix shadows no single stroke.
    expect(canvas?.keys.w).toBeUndefined();
  });

  it('arms the live prefix from the real declaration and enters View on the second stroke', async () => {
    const controller = createNavigationDemoController();
    const host = createNavigationHost({
      surface: NAVIGATION_DEMO_SURFACE,
      getContext: () => controller.getContext(),
      applyPatch: (patch) => controller.applyPatch(patch),
      confirm: () => true,
    });

    // Arm `w` at Canvas: the host announces the composer output for its continuations.
    await host.handleStroke('w', 1000);
    expect(host.getSnapshot().pending?.sequence).toBe('w');
    expect(host.getSnapshot().announcement).toBe(navPrefixMessage('w', ['View', 'Style']));
    expect(host.getSnapshot().announcement).toBe('w… View, Style');

    // The continuation resolves to demo.view and clears the prefix.
    await host.handleStroke('n', 1001);
    const snapshot = host.getSnapshot();
    expect(snapshot.pending).toBeNull();
    expect(snapshot.context.placePath).toEqual([DEMO_PLACES.canvas, DEMO_PLACES.view]);
  });
});

/* ───────────────────────────── 3. built bundle ───────────────────────────── */

describe('DEV prototype — production bundle markers (Q8-02 receipt)', () => {
  it('emits apps/ui/dist/assets with zero dev-route markers in every file', () => {
    const assetsDir = resolve(UI_ROOT, 'dist/assets');

    // The receipt IS the built artifact: a run without a build is not evidence.
    if (!existsSync(assetsDir)) {
      throw new Error(
        'apps/ui/dist/assets is missing — run `pnpm --filter @fredo/ui build` before this test',
      );
    }

    const files = walkFiles(assetsDir);
    expect(files.length).toBeGreaterThan(0);

    let scannedBytes = 0;
    const perMarker = new Map<string, number>();
    for (const marker of DEV_MARKERS) perMarker.set(marker, 0);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      scannedBytes += content.length;
      for (const marker of DEV_MARKERS) {
        perMarker.set(marker, (perMarker.get(marker) ?? 0) + countOccurrences(content, marker));
      }
    }

    // Non-vacuity: we really scanned the emitted app bundle.
    expect(scannedBytes).toBeGreaterThan(1000);

    for (const marker of DEV_MARKERS) {
      expect(perMarker.get(marker), `marker "${marker}" must not appear in dist/assets`).toBe(0);
    }
  });
});
