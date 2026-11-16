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
 * #2942 ST-5/ST-6 — the 44 px horizontal rail is DELIBERATELY SUPERSEDED by the
 * compact vertical `TerminalSidebar`; the root assertion stays direction-agnostic
 * (`row` again, but that is UI/UX-owned) and the scan now also pins that the
 * retired rail hooks cannot silently return.
 *
 * `100vh` elsewhere is NOT asserted away: `Home.tsx:190` (the app shell root)
 * and the `AppDock` rail/pill calcs are legitimately viewport-relative shell
 * chrome, not feature-window content roots.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'src/applications';

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
const TERMINAL_COMPONENTS = `${BASE}/terminal/components`;
const TERMINAL_WINDOW = `${TERMINAL_COMPONENTS}/TerminalWindow.tsx`;
/**
 * Spec #3121 ST-1 — the terminal is the ONE structural wrapper of the fleet: its column root
 * (the `h="100%"` definite-height root) lives in the navigation provider, and the shipped
 * row became that column's `flex="1"` child.
 */
const TERMINAL_NAV_PROVIDER = `${TERMINAL_COMPONENTS}/TerminalNavigationProvider.tsx`;
const TERMINAL_SIDEBAR = `${TERMINAL_COMPONENTS}/TerminalSidebar.tsx`;
const TERMINAL_SESSION_VIEW = `${TERMINAL_COMPONENTS}/TerminalSessionView.tsx`;
/** The superseded #2940 horizontal rail module — must not return (#2942). */
const TERMINAL_SESSION_BAR = `${TERMINAL_COMPONENTS}/SessionBar.tsx`;

/** The served host document, read from the `apps/ui` vitest CWD (G-061-safe). */
const HOST_DOCUMENT = '../tauri/index.html';

describe('#2924 ST-4 — feature roots size to the content region, not the viewport', () => {
  it.each([DEV_MODE])('%s contains no viewport unit (100vh / 100vw)', (path) => {
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
    // Spec #2942 ST-5: the NEW vertical sidebar is the navigation surface and
    // must be inside the viewport-unit scan.
    expect(files).toContain(TERMINAL_SIDEBAR);

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

  it('terminal window root is content-region sized (direction-agnostic)', () => {
    // Spec #3121 ST-1 — the root MOVED, the invariant did not. The terminal's column root
    // (the definite-height `h="100%"` Flex that fills its content region) now lives in the
    // navigation provider, which also owns the ONE key adapter and the footer; the shipped
    // row became that column's `flex="1"` child (it MUST NOT keep `h="100%"`, or it would
    // overflow the column past the footer). Re-pointed exactly as #2934 ST-3 re-pointed this
    // pin when the root moved out of `TerminalSessionView.tsx`.
    expect(source(TERMINAL_NAV_PROVIDER)).toMatch(/<Flex\b[^>]*\bh="100%"/);
    expect(source(TERMINAL_WINDOW)).toMatch(/<Flex\b[^>]*\bflex="1"/);
  });

  it('pins the #2942 sidebar as the terminal navigation surface (the #2940 rail cannot return)', () => {
    // The window composes the NEW vertical sidebar, and the sidebar module is
    // the one carrying the `terminal-session-sidebar` root hook.
    expect(source(TERMINAL_WINDOW)).toContain('TerminalSidebar');
    expect(source(TERMINAL_SIDEBAR)).toContain('terminal-session-sidebar');

    const files = collectTsx(TERMINAL_COMPONENTS);
    // The superseded 44 px rail module is deleted…
    expect(files).not.toContain(TERMINAL_SESSION_BAR);
    // …and no PRODUCTION terminal component restores the superseded hooks (the
    // window test legitimately asserts their ABSENCE, so tests are excluded).
    const production = files.filter((file) => !file.includes('/__tests__/'));
    for (const file of production) {
      const code = source(file);
      expect(code, `${file} must not restore the superseded rail`).not.toContain(
        'terminal-session-bar',
      );
      expect(code, `${file} must not restore the superseded History popover`).not.toContain(
        'terminal-previous-toggle',
      );
    }
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
