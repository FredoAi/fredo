/**
 * WindowFrame frame-contract tests — Spec #2924 ST-5 (REQ-1, REQ-4, REQ-5,
 * REQ-6, REQ-7, REQ-9).
 *
 * The durable `.opencode/tests/window-manager/**` suite is pipeline-written, so
 * this file is the frame's IN-REPO home for the #2924 kernel contract:
 *
 *  1. A born full-bleed window renders the `100%/100%` surface rect with
 *     `borderRadius: 0` and `boxShadow: none` (REQ-1) — and the surface keeps
 *     `role="group"` + `aria-label={title}` (REQ-5).
 *  2. The content region applies ZERO content padding (the blanket `p="4"` is
 *     gone) and the frame's content box is flush (REQ-6) — asserted at the
 *     declared/computed level because **jsdom has no layout engine** (every
 *     `getBoundingClientRect()` is `0×0`, so a rect-equality pin would be
 *     vacuous; the live tester owns the measured rects).
 *  3. Zero resize grips while maximized; the full 8-grip set when floating; zero
 *     while minimized (REQ-7).
 *  4. A restored float is the container-derived CENTERED float
 *     (`min(DEFAULT, container − 2×GESTURE_INSET)` floored at MIN, no cascade),
 *     and float→max→restore returns the PRE-MAXIMIZE float (saved geometry),
 *     never a re-derived/recentered rect (REQ-8).
 *  5. A source scan proves the window-system surface is token-native: no hex,
 *     no `rgb()/rgba()/hsl()/hsla()`, no `var(--x)NN` alpha-append (REQ-9).
 *
 * No timers/fake timers are used: the saved-geometry leg is proven by mutating
 * the measured workspace while maximized (a re-derivation would land on the new
 * center) instead of driving a rAF-coalesced drag gesture — deterministic under
 * any suite order (G-222).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Box } from '@chakra-ui/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { useSyncExternalStore } from 'react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowFrame } from '../WindowFrame';
import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
  subscribeWindows,
} from '../windowStore';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  GESTURE_INSET,
  MIN_HEIGHT,
  MIN_WIDTH,
  resolveFloatGeometry,
} from '../windowGeometry';
import type { OpenWindowParams } from '../windowTypes';

const WINDOW_ID = 'mission-monitor';
const TITLE = 'Mission Monitor';

/**
 * The measured workspace (the `WindowManager` container) — mutable so a test can
 * resize it between a maximize and a restore. jsdom has no layout, so the
 * harness container's `getBoundingClientRect` is stubbed at the PROTOTYPE level
 * (scoped to the `data-testid="workspace"` node) in `beforeEach` — this is
 * installed before any render, so the frame's mount layout effect can measure it.
 */
let workspaceSize = { width: 0, height: 0 };

/** A DOMRect-shaped stub (only width/height are read by the frame). */
function rectOf(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Renders one store-backed frame inside a measurable workspace container. */
function FrameHarness({ id }: { id: string }) {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const win = windows.find((w) => w.id === id);
  return (
    <div data-testid="workspace">{win ? <WindowFrame window={win} /> : null}</div>
  );
}

/** Open a window through the real store; `isMaximized` omitted ⇒ full-bleed default. */
function openEntry(overrides: Partial<OpenWindowParams> = {}): void {
  openWindow({
    id: WINDOW_ID,
    title: TITLE,
    icon: <span data-testid="feature-icon" />,
    component: <div data-testid="feature-content">feature body</div>,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    ...overrides,
  });
}

function renderFrame(): HTMLElement {
  const { container } = renderWithChakra(<FrameHarness id={WINDOW_ID} />);
  return container;
}

function getSurface(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.fredo-window__surface');
  if (!el) throw new Error('window surface did not render');
  return el;
}

/** The content region is the frame's second child (header is first; grips follow). */
function getContentRegion(surface: HTMLElement): HTMLElement {
  const el = surface.children[1];
  if (!(el instanceof HTMLElement)) throw new Error('content region did not render');
  return el;
}

function getGrips(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('[class*="fredo-window__grip--"]'));
}

/**
 * jsdom has no layout engine: an unset inset computes to `''` and an explicit
 * zero to `'0px'`. Both mean "no inset"; anything else is a real inset.
 */
function expectZeroInset(value: string, label: string): void {
  expect(['', '0px'], `${label} must be zero/unset (got "${value}")`).toContain(value);
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  workspaceSize = { width: 0, height: 0 };
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'workspace') {
        return rectOf(workspaceSize.width, workspaceSize.height);
      }
      return rectOf(0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  cleanup();
  resetWindowStoreForTests();
});

// ── REQ-1 / REQ-5 — born full-bleed surface + preserved role/aria ─────────────

describe('WindowFrame — born full-bleed surface (REQ-1, REQ-5)', () => {
  it('renders the 100%/100% rect, borderRadius 0 and boxShadow none for a default-open window', () => {
    openEntry(); // isMaximized omitted ⇒ REQ-2 full-bleed default
    const surface = getSurface(renderFrame());

    // Declared geometry (the frame's source of truth in jsdom).
    expect(surface.style.top).toBe('0px');
    expect(surface.style.left).toBe('0px');
    expect(surface.style.width).toBe('100%');
    expect(surface.style.height).toBe('100%');

    // Computed surface recovers the full-bleed chrome.
    const cs = getComputedStyle(surface);
    expect(cs.top).toBe('0px');
    expect(cs.left).toBe('0px');
    expect(cs.width).toBe('100%');
    expect(cs.height).toBe('100%');
    expect(cs.borderRadius).toBe('0px');
    expect(cs.boxShadow).toBe('none');
  });

  it('keeps the frame non-modal: role="group" named by the title', () => {
    openEntry({ title: 'Sessions' });
    const surface = getSurface(renderFrame());

    expect(surface.getAttribute('role')).toBe('group');
    expect(surface.getAttribute('aria-label')).toBe('Sessions');
  });

  it('renders zero resize grips while maximized (only header + content)', () => {
    openEntry();
    const surface = getSurface(renderFrame());

    expect(getGrips(surface)).toHaveLength(0);
    expect(surface.children).toHaveLength(2);
  });
});

// ── REQ-6 — flush content region ──────────────────────────────────────────────

describe('WindowFrame — flush content region (REQ-6)', () => {
  it('applies ZERO content padding and no margin, so the feature root is flush', () => {
    openEntry();
    const surface = getSurface(renderFrame());
    const content = getContentRegion(surface);

    expect(content).toBeInstanceOf(HTMLElement);
    expect(content).not.toBe(surface);
    expect(content).toContainElement(screen.getByTestId('feature-content'));

    const cs = getComputedStyle(content);
    expectZeroInset(cs.paddingTop, 'content paddingTop');
    expectZeroInset(cs.paddingRight, 'content paddingRight');
    expectZeroInset(cs.paddingBottom, 'content paddingBottom');
    expectZeroInset(cs.paddingLeft, 'content paddingLeft');
    expectZeroInset(cs.marginTop, 'content marginTop');
    expectZeroInset(cs.marginRight, 'content marginRight');
    expectZeroInset(cs.marginBottom, 'content marginBottom');
    expectZeroInset(cs.marginLeft, 'content marginLeft');

    // The surface itself contributes no inset either — with both at zero the
    // content box spans the surface's inner edges (flush left/right/bottom).
    const surfaceCs = getComputedStyle(surface);
    expectZeroInset(surfaceCs.paddingLeft, 'surface paddingLeft');
    expectZeroInset(surfaceCs.paddingRight, 'surface paddingRight');
    expectZeroInset(surfaceCs.paddingBottom, 'surface paddingBottom');
  });

  it('preserves the content region contract: fills + scrolls, min-height 0, tabIndex -1', () => {
    openEntry();
    const surface = getSurface(renderFrame());
    const content = getContentRegion(surface);
    const cs = getComputedStyle(content);

    // `flex: 1` + `min-height: 0` + `overflow: auto` — unchanged by the flush
    // change. (jsdom does not expand the `overflow` shorthand into `overflowY`,
    // so read the shorthand; likewise `min-height: 0` stays unitless.)
    expect(cs.flexGrow).toBe('1');
    expect(['0', '0px']).toContain(cs.minHeight);
    expect(cs.overflow).toBe('auto');
    expect(content.tabIndex).toBe(-1);
  });

  it('oracle: jsdom cascades a raw declared padding — the zero-inset pins are not vacuous', () => {
    renderWithChakra(
      <>
        <Box data-testid="padded-raw" padding="16px" />
        <Box data-testid="padded-token" p="4" />
      </>,
    );

    // The cascade is live in this test system: a declared inset DOES surface.
    expect(getComputedStyle(screen.getByTestId('padded-raw')).paddingTop).toBe('16px');

    // But the isolated Chakra test system has no spacing token scale, so the
    // token form `p="4"` emits no rule at all. That is exactly why the SOURCE
    // guard below (not the computed padding) is the binding pin for a re-added
    // blanket `p="4"`.
    expect(getComputedStyle(screen.getByTestId('padded-token')).paddingTop).toBe('');
  });

  it('ships no padding prop on the frame at all (source guard, comments stripped)', () => {
    const frameSource = stripComments(
      readFileSync(resolve(process.cwd(), 'src/shared/window-system/WindowFrame.tsx'), 'utf8'),
    );
    // The removed blanket `p="4"` and any other padding prop must not return.
    expect(frameSource).not.toContain('p="4"');
    expect(frameSource).not.toMatch(/\bpadding\b/);
    // The content region's marker prop must survive alongside the flush change.
    expect(frameSource).toContain('tabIndex={-1}');
  });
});

// ── REQ-7 — grips per state ───────────────────────────────────────────────────

describe('WindowFrame — resize grips (REQ-7)', () => {
  it('renders the full 8-grip set, with every direction, when floating', () => {
    openEntry({ isMaximized: false });
    const surface = getSurface(renderFrame());

    const grips = getGrips(surface);
    expect(grips).toHaveLength(8);
    expect(surface.children).toHaveLength(10); // header + content + 8 grips

    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const dir of dirs) {
      expect(
        surface.querySelector(`.fredo-window__grip--${dir}`),
        `grip ${dir} must be hit-testable while floating`,
      ).not.toBeNull();
    }
  });

  it('renders zero grips while minimized (the dock is the restore affordance)', () => {
    openEntry({ isMaximized: false });
    const container = renderFrame();
    const surface = getSurface(container);
    expect(getGrips(surface)).toHaveLength(8);

    fireEvent.click(screen.getByRole('button', { name: `Minimize ${TITLE}` }));

    const hidden = getSurface(container);
    expect(getComputedStyle(hidden).display).toBe('none');
    expect(getGrips(hidden)).toHaveLength(0);
  });
});

// ── REQ-8 — centered float + saved-geometry restore ───────────────────────────

describe('WindowFrame — geometry resolution + restore (REQ-8)', () => {
  it('declares the container-derived CENTERED float for a floating window (no cascade)', () => {
    workspaceSize = { width: 1000, height: 800 };
    const workspace = { width: 1000, height: 800 };
    openEntry({ isMaximized: false });
    const surface = getSurface(renderFrame());

    const expected = resolveFloatGeometry(workspace);
    // Spell out the contract rather than trusting the helper blindly:
    // min(DEFAULT, container − 2×GESTURE_INSET) floored at MIN, then centered.
    expect(expected.width).toBe(DEFAULT_WIDTH);
    expect(expected.height).toBe(DEFAULT_HEIGHT);
    expect(expected.x).toBe((workspace.width - DEFAULT_WIDTH) / 2);
    expect(expected.y).toBe((workspace.height - DEFAULT_HEIGHT) / 2);

    expect(surface.style.left).toBe(`${expected.x}px`);
    expect(surface.style.top).toBe(`${expected.y}px`);
    expect(surface.style.width).toBe(`${expected.width}px`);
    expect(surface.style.height).toBe(`${expected.height}px`);

    // Cascade fingerprint (48 + idx·16) must never appear.
    expect(surface.style.left).not.toBe('48px');
    expect(surface.style.top).not.toBe('48px');
    expect(surface.style.left).not.toBe('64px');
    expect(surface.style.top).not.toBe('64px');

    // Floating chrome: rounded + the 8 grips.
    expect(getComputedStyle(surface).borderRadius).toBe('8px');
    expect(getGrips(surface)).toHaveLength(8);
  });

  it('shrinks to the workspace with a GESTURE_INSET margin, floored at MIN', () => {
    workspaceSize = { width: 500, height: 400 };
    const workspace = { width: 500, height: 400 };
    openEntry({ isMaximized: false });
    const surface = getSurface(renderFrame());

    // 500 − 2×24 = 452 (< DEFAULT 480, > MIN 320); 400 − 48 = 352 → DEFAULT 320.
    const expected = resolveFloatGeometry(workspace);
    expect(expected.width).toBe(500 - GESTURE_INSET * 2);
    expect(expected.height).toBe(DEFAULT_HEIGHT);
    expect(expected.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(expected.height).toBeGreaterThanOrEqual(MIN_HEIGHT);

    expect(surface.style.width).toBe(`${expected.width}px`);
    expect(surface.style.height).toBe(`${expected.height}px`);
    expect(surface.style.left).toBe(`${expected.x}px`);
    expect(surface.style.top).toBe(`${expected.y}px`);
  });

  it('restores a born-full-bleed window to the CENTERED container float (never 0,0)', () => {
    workspaceSize = { width: 1000, height: 800 };
    const workspace = { width: 1000, height: 800 };
    openEntry(); // never floated — no saved geometry
    const container = renderFrame();

    expect(getSurface(container).style.width).toBe('100%');

    fireEvent.click(screen.getByRole('button', { name: `Restore ${TITLE}` }));

    const surface = getSurface(container);
    const expected = resolveFloatGeometry(workspace);
    expect(surface.style.left).toBe(`${expected.x}px`);
    expect(surface.style.top).toBe(`${expected.y}px`);
    expect(surface.style.width).toBe(`${expected.width}px`);
    expect(surface.style.height).toBe(`${expected.height}px`);
    // Never the unmeasured DEFAULT seed at 0,0.
    expect(surface.style.left).not.toBe('0px');
    expect(surface.style.top).not.toBe('0px');
    expect(getComputedStyle(surface).borderRadius).toBe('8px');
    expect(getGrips(surface)).toHaveLength(8);
  });

  it('float → maximize → restore returns the PRE-MAXIMIZE float (saved geometry), not a re-derived one', () => {
    workspaceSize = { width: 1000, height: 800 };
    openEntry({ isMaximized: false });
    const container = renderFrame();

    const preMaximize = resolveFloatGeometry({ width: 1000, height: 800 });
    expect(getSurface(container).style.left).toBe(`${preMaximize.x}px`);

    fireEvent.click(screen.getByRole('button', { name: `Maximize ${TITLE}` }));
    const maximized = getSurface(container);
    expect(maximized.style.width).toBe('100%');
    expect(maximized.style.left).toBe('0px');
    expect(getGrips(maximized)).toHaveLength(0);

    // The workspace changes size WHILE maximized. A restore that recomputed the
    // centered float from the current workspace would land on the new center;
    // the saved pre-maximize float is the contract (REQ-8).
    workspaceSize = { width: 2000, height: 1200 };
    const rederived = resolveFloatGeometry({ width: 2000, height: 1200 });
    expect(rederived.x).toBe((2000 - DEFAULT_WIDTH) / 2); // 760 — really differs
    expect(rederived.x).not.toBe(preMaximize.x);

    fireEvent.click(screen.getByRole('button', { name: `Restore ${TITLE}` }));

    const restored = getSurface(container);
    expect(restored.style.left).toBe(`${preMaximize.x}px`);
    expect(restored.style.top).toBe(`${preMaximize.y}px`);
    expect(restored.style.width).toBe(`${preMaximize.width}px`);
    expect(restored.style.height).toBe(`${preMaximize.height}px`);
    expect(restored.style.left).not.toBe(`${rederived.x}px`);
  });
});

// ── REQ-9 — token-native source scan ──────────────────────────────────────────

/** Strip block + line comments so doc prose (issue refs like `#2807`) cannot mask
 *  or satisfy a colour literal scan. Mirrors the established repo pattern. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every product source file under the window-system surface (tests excluded). */
function listWindowSystemSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...listWindowSystemSources(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('window-system surface — token-native colour audit (REQ-9)', () => {
  const dir = resolve(process.cwd(), 'src/shared/window-system');
  const files = listWindowSystemSources(dir);

  it('scans the real surface (guards against an empty glob passing vacuously)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    const names = files.map((f) => f.replace(/\\/g, '/'));
    for (const required of ['WindowFrame.tsx', 'WindowChrome.tsx', 'chrome.css']) {
      expect(names.some((n) => n.endsWith(required)), `${required} must be scanned`).toBe(true);
    }
  });

  it('contains no hex / rgb() / hsl() colour literal in code (comments stripped)', () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rel = file.slice(dir.length + 1).replace(/\\/g, '/');

      const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(hex, `${rel}: hex colour literal(s) ${JSON.stringify(hex)}`).toEqual([]);

      const functional = [...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
      expect(
        functional,
        `${rel}: functional colour literal(s) ${JSON.stringify(functional)}`,
      ).toEqual([]);
    }
  });

  it('contains no var(--x)NN alpha-append (#2770 trap) in code', () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rel = file.slice(dir.length + 1).replace(/\\/g, '/');
      const appends = [...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0]);
      expect(appends, `${rel}: var() alpha-append ${JSON.stringify(appends)}`).toEqual([]);
    }
  });

  it('uses the shared tint() helper for the frame/chrome hovers (positive control)', () => {
    const allCode = files.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n');
    expect(allCode).toContain('tint(');
  });
});
