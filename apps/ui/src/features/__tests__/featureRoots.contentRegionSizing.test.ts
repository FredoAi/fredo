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
 * This pin scans those three components and asserts (1) no viewport unit
 * survives in the file and (2) the root declarations now express content-region
 * sizing. It is deliberately a source scan (the same idiom as the repo's other
 * source pins) rather than a render — the defect is a static sizing declaration
 * and the three components carry heavy runtime dependencies.
 *
 * `100vh` elsewhere is NOT asserted away: `Home.tsx:190` (the app shell root)
 * and the `AppDock` rail/pill calcs are legitimately viewport-relative shell
 * chrome, not feature-window content roots.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'src/features';

/** Strip block + line comments so prose/issue refs are exempt from the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function source(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

const DEV_MODE = `${BASE}/dev-mode/components/DevMode.tsx`;
const DIAGRAM = `${BASE}/diagram/components/ArchitectureDiagram.tsx`;
const TERMINAL_SESSION_VIEW = `${BASE}/terminal/components/TerminalSessionView.tsx`;

describe('#2924 ST-4 — feature roots size to the content region, not the viewport', () => {
  it.each([DEV_MODE, DIAGRAM, TERMINAL_SESSION_VIEW])(
    '%s contains no viewport unit (100vh / 100vw)',
    (path) => {
      const code = source(path);
      expect(code).not.toMatch(/100vh/);
      expect(code).not.toMatch(/100vw/);
    },
  );

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

  it('terminal status root is content-region sized', () => {
    const code = source(TERMINAL_SESSION_VIEW);
    expect(code).toContain('<Flex direction="column" h="100%"');
  });
});
