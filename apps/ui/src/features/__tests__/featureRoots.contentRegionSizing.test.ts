/**
 * #2924 ST-4 — per-feature interior-spacing regression pin.
 *
 * The window kernel (#2807) removed the frame's blanket `p="4"` content inset
 * (#2924 ST-2), so each feature now owns its own interior spacing. A feature
 * root that sizes itself to the VIEWPORT (`100vh`) while it actually lives
 * inside the 40px-header frame content region is taller than its container and
 * raises a scrollbar that the removed frame inset used to hide. ST-4 located
 * three such roots and sized them to the CONTENT REGION instead:
 *
 *   - `dev-mode` root           — `DevMode.tsx` (was `height="100vh"`)
 *   - `diagram` loading + error — `ArchitectureDiagram.tsx` (was `height="100vh"` ×2,
 *                                 filter-panel `maxHeight="calc(100vh - 150px)"`)
 *   - `terminal` status root    — `TerminalSessionView.tsx` (was `h="100vh"`)
 *
 * #2934 ST-3 moved the Terminal window root from `TerminalSessionView.tsx` to
 * `TerminalWindow.tsx` (a row layout: sidebar + pane). The content-region-sizing
 * invariant is unchanged and is now pinned on the new root, while the no-viewport
 * scan covers BOTH terminal files.
 *
 * #2940 ST-6 — reconciliation with the REAL invariant. The defect (#2940 AC1) was
 * NOT a `100vh` that survived; it was that the SERVED host document
 * (`apps/tauri/index.html`) never gave `#root` a definite height, so every
 * descendant `height: 100%` resolved to `auto` (CSS percentage-height rule) and
 * the terminal collapsed to its content. A pin that only scans feature sources can
 * never catch that class, so it now also reads the host document and requires the
 * `html, body { … height: 100% }` + `#root { height: 100% }` chain (the same chain
 * the standalone `apps/ui` entry gets from `apps/ui/src/style.css`).
 *
 * The root assertion is deliberately DIRECTION-AGNOSTIC: `direction` is a UI/UX
 * composition detail (ST-3 moves the root from `row` to `column`) while the
 * invariant is "the window root is a Flex that fills its definite-height content
 * region with `h=100%`". Pinning the exact direction made the pin fail on a
 * legitimate rework while still missing the actual defect.
 *
 * This pin is a source scan (the same idiom as the repo's other source pins)
 * rather than a render — the defect is a static sizing declaration and the
 * components carry heavy runtime dependencies.
 *
 * `100vh` elsewhere is NOT asserted away: `Home.tsx:190` (the app shell root)
 * and the `AppDock` rail/pill calcs are legitimately viewport-relative shell
 * chrome, not feature-window content roots.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'src/features';

/** Strip block + line comments so prose/issue refs are exempt from the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Strip HTML comments so prose/issue refs are exempt from the host-document scan. */
function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function source(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

/** Recursively collect every `.tsx` file under `dir` (repo-relative, `/`-joined). */
function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectTsx(relative));
    else if (entry.name.endsWith('.tsx')) out.push(relative);
  }
  return out;
}

const DEV_MODE = `${BASE}/dev-mode/components/DevMode.tsx`;
const DIAGRAM = `${BASE}/diagram/components/ArchitectureDiagram.tsx`;
const TERMINAL_COMPONENTS = `${BASE}/terminal/components`;
const TERMINAL_WINDOW = `${TERMINAL_COMPONENTS}/TerminalWindow.tsx`;
const TERMINAL_SESSION_VIEW = `${TERMINAL_COMPONENTS}/TerminalSessionView.tsx`;

/** The served host document, read from the `apps/ui` vitest CWD (G-061-safe). */
const HOST_DOCUMENT = '../tauri/index.html';

describe('#2924 ST-4 — feature roots size to the content region, not the viewport', () => {
  it.each([DEV_MODE, DIAGRAM])('%s contains no viewport unit (100vh / 100vw)', (path) => {
    const code = source(path);
    expect(code).not.toMatch(/100vh/);
    expect(code).not.toMatch(/100vw/);
  });

  it('EVERY terminal component source is free of viewport units (100vh / 100vw)', () => {
    const files = collectTsx(TERMINAL_COMPONENTS);
    // Guard against a path change silently emptying the scan.
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(TERMINAL_WINDOW);
    expect(files).toContain(TERMINAL_SESSION_VIEW);
    expect(files).toContain(`${TERMINAL_COMPONENTS}/TerminalPane.tsx`);

    for (const file of files) {
      const code = source(file);
      expect(code, `${file} must not size itself with a viewport unit`).not.toMatch(/100vh/);
      expect(code, `${file} must not size itself with a viewport unit`).not.toMatch(/100vw/);
    }
  });

  it('dev-mode root is content-region sized', () => {
    const code = source(DEV_MODE);
    expect(code).toContain('<Box width="100%" height="100%" display="flex" flexDirection="column"');
  });

  it('diagram loading/error roots and filter-panel max-height are content-region sized', () => {
    const code = source(DIAGRAM);
    // main canvas root + loading root + error root — all fill the content region
    expect(code.match(/height="100%"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(code).toContain('maxHeight="calc(100% - 90px)"');
  });

  it('terminal window root is content-region sized (direction-agnostic)', () => {
    const code = source(TERMINAL_WINDOW);
    // The invariant: a Flex window root that fills its definite-height content
    // region. `direction` / extra props are UI/UX-owned and are NOT pinned.
    expect(code).toMatch(/<Flex\b[^>]*\bh="100%"/);
  });

  it('served host document (apps/tauri/index.html) hands the content region a definite height', () => {
    const html = stripHtmlComments(
      readFileSync(resolve(process.cwd(), HOST_DOCUMENT), 'utf8'),
    );

    const htmlBodyRule = html.match(/html\s*,\s*body\s*\{([^}]*)\}/);
    expect(htmlBodyRule, 'index.html must declare an `html, body { … }` rule').not.toBeNull();
    const htmlBodyDecls = htmlBodyRule?.[1] ?? '';
    expect(htmlBodyDecls).toMatch(/\bheight\s*:\s*100%/);
    expect(htmlBodyDecls).toMatch(/\bmargin\s*:\s*0\b/);

    const rootRule = html.match(/#root\s*\{([^}]*)\}/);
    expect(rootRule, 'index.html must declare a `#root { … }` rule').not.toBeNull();
    expect(rootRule?.[1] ?? '').toMatch(/\bheight\s*:\s*100%/);
  });
});
