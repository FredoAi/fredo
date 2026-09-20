/**
 * #2871 ST-3r — reduced-motion cursor gate (REQ-16 / DR-7).
 *
 * STATIC / PRODUCT-UNIT PIN. The live reduced-motion leg is NOT drivable on this
 * host — `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is
 * `false` and the MCP driver cannot flip the media feature (G-148 / #2870 F-66;
 * #2850 F-19 / #2852 E-32 precedent). This test therefore pins the SOURCE
 * contract instead:
 *   1. `companion.css`'s `@media (prefers-reduced-motion: reduce)` block carries
 *      a `.fredo-cursor { animation: none !important; }` rule — the only author
 *      rule that can beat the cursor Box's inline `animation`.
 *   2. `SpeechBubble.tsx` attaches the `fredo-cursor` class to the streaming
 *      cursor Box, so the media rule actually targets it.
 *
 * It is NOT a live reduced-motion claim; the live `matchMedia` flip is a NAMED
 * BLOCKER recorded in the Tester's `## Tests Runs`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = 'src/shared/components/companion/companion.css';
const BUBBLE_PATH = 'src/shared/components/companion/SpeechBubble.tsx';

/** vitest runs with cwd = apps/ui (the package root) — same pattern as
 * `CompanionSettingsPanel.theming.test.tsx`. */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * Slice the body of the `@media (prefers-reduced-motion: reduce)` block. Inner
 * rule closings are indented (`  }`); the block's own closing brace sits at
 * column 0, so the first `\n}` after the opening brace is the block terminator.
 */
function reducedMotionBlock(css: string): string {
  const mediaStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(
    mediaStart,
    'companion.css must declare a @media (prefers-reduced-motion: reduce) block',
  ).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', mediaStart);
  const close = css.indexOf('\n}', open);
  expect(open).toBeGreaterThan(mediaStart);
  expect(close).toBeGreaterThan(open);
  return css.slice(open, close + 2);
}

describe('#2871 ST-3r — reduced-motion cursor (STATIC/PRODUCT-UNIT pin)', () => {
  it('gates the streaming cursor animation off INSIDE the reduced-motion block', () => {
    const block = reducedMotionBlock(readSource(CSS_PATH));

    // The rule must live in the block (the helper already bounds the slice).
    expect(block).toMatch(/\.fredo-cursor\s*\{/);
    // `animation: none !important` — `!important` is required to beat the inline
    // `animation` on the cursor Box (behavior change is otherwise a no-op).
    expect(block).toMatch(/\.fredo-cursor\s*\{[^}]*animation:\s*none\s*!important/);
  });

  it('attaches the fredo-cursor class to the SpeechBubble streaming cursor Box', () => {
    const bubble = readSource(BUBBLE_PATH);
    expect(bubble).toContain('className="fredo-cursor"');
  });
});
