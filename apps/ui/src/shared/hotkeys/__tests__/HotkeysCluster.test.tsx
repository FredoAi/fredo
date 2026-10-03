/**
 * Spec #2960 ST-5 — the ONE shared top-left cluster for the S3 surfaces.
 *
 * Pins the integration contract: a single `position: fixed` top-left container
 * (`left: 12px`, derived `top`, `z-index: REGIME_SIGNAL_Z_INDEX`) laying out the
 * regime chip, the discovery control, and the first-run card as an in-flow
 * vertical flex column (so they stack, never overlap); the container is
 * click-through and each interactive surface re-enables pointer events; and the
 * cluster adds NO live region of its own (the shared announcer stays the only
 * one).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { resetContextRegistryForTests } from '@/shared/hotkeys/contexts';
import { resetHotkeyContextForTests } from '@/shared/hotkeys/contextStack';
import {
  installHotkeyEngine,
  registerDefaultFredoActions,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import { resetKeyboardModeForTests } from '@/shared/hotkeys/keyboardMode';
import { resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import {
  TOP_STACK_ANCHOR_X_PX,
  TOP_STACK_CLEARANCE_GAP_PX,
  TOP_STACK_MIN_PX,
} from '@/shared/hotkeys/topStack';
import { REGIME_SIGNAL_Z_INDEX } from '@/shared/hotkeys/InputRegimeIndicator';
import { INPUT_REGIME_TESTID } from '@/shared/hotkeys/InputRegimeIndicator';
import { KEYS_DISCOVERY_TESTID } from '@/shared/hotkeys/KeysDiscovery';
import { KEYBOARD_INTRO_TESTID } from '@/shared/hotkeys/KeyboardIntro';
import { HOTKEYS_CLUSTER_GAP_PX, HOTKEYS_CLUSTER_TESTID, HotkeysCluster } from '../HotkeysCluster';

/** Flush the settled intro read promise + the resulting React commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function cluster(): HTMLElement {
  return screen.getByTestId(HOTKEYS_CLUSTER_TESTID);
}

function mountHeader(bottom: number): void {
  const header = document.createElement('header');
  header.className = 'fredo-window__header';
  header.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom,
      left: 0,
      right: 1280,
      width: 1280,
      height: bottom,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(header);
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  registerDefaultFredoActions();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── Binding constants ────────────────────────────────────────────────────────

describe('HotkeysCluster — binding constants', () => {
  it('declares the exact cluster testid, gap, and stacking', () => {
    expect(HOTKEYS_CLUSTER_TESTID).toBe('hotkeys-cluster');
    expect(HOTKEYS_CLUSTER_GAP_PX).toBe(8);
    expect(REGIME_SIGNAL_Z_INDEX).toBe(1310);
  });
});

// ── ONE fixed top-left container (G-253/G-267) ───────────────────────────────

describe('HotkeysCluster — ONE fixed top-left container', () => {
  it('is a single fixed flex column at the derived base inset', async () => {
    renderWithChakra(<HotkeysCluster reducedMotion />);
    await settle();

    const root = cluster();
    expect(document.querySelectorAll(`[data-testid="${HOTKEYS_CLUSTER_TESTID}"]`)).toHaveLength(1);
    expect(root.style.position).toBe('fixed');
    expect(root.style.left).toBe(`${TOP_STACK_ANCHOR_X_PX}px`);
    expect(root.style.top).toBe(`${TOP_STACK_MIN_PX}px`);
    expect(root.style.zIndex).toBe(String(REGIME_SIGNAL_Z_INDEX));
    expect(root.style.display).toBe('flex');
    expect(root.style.flexDirection).toBe('column');
    expect(root.style.gap).toBe(`${HOTKEYS_CLUSTER_GAP_PX}px`);
    // Click-through: it must never swallow app clicks, not even in the gaps.
    expect(root.style.pointerEvents).toBe('none');
  });

  it('derives its top from the ACTUAL rendered header bottom (never a nominal sum)', async () => {
    mountHeader(48);
    renderWithChakra(<HotkeysCluster reducedMotion />);
    await settle();

    expect(cluster().style.top).toBe('48px');
  });
});

// ── Collision-aware displacement (Spec #2960 round 2, F-65) ──────────────────

describe('HotkeysCluster — collision-aware displacement (F-65)', () => {
  const CLUSTER_WIDTH_PX = 83;
  const CLUSTER_HEIGHT_PX = 75;

  function rect(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      x: left,
      y: top,
      top,
      left,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Stub the cluster's measured box + the focused field's resting rect. */
  function stubRects(fieldRect: DOMRect): void {
    const clusterRect = rect(
      TOP_STACK_ANCHOR_X_PX,
      TOP_STACK_MIN_PX,
      TOP_STACK_ANCHOR_X_PX + CLUSTER_WIDTH_PX,
      TOP_STACK_MIN_PX + CLUSTER_HEIGHT_PX,
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this instanceof HTMLElement && this.dataset.testid === HOTKEYS_CLUSTER_TESTID) {
        return clusterRect;
      }
      if (this instanceof HTMLElement && this.dataset.testid === 'focused-field') {
        return fieldRect;
      }
      return rect(0, 0, 0, 0);
    });
  }

  async function focusField(): Promise<HTMLElement> {
    const field = document.createElement('input');
    field.setAttribute('data-testid', 'focused-field');
    document.body.appendChild(field);
    await act(async () => {
      field.focus();
    });
    await settle();
    return field;
  }

  it('displaces BELOW the focused Mission Monitor field, keeping left/z/gap', async () => {
    const uninstall = installHotkeyEngine();
    try {
      // The real live F-65 rect: input[placeholder="Filter sessions..."].
      stubRects(rect(24, 79, 202, 102));
      renderWithChakra(<HotkeysCluster reducedMotion />);
      await settle();

      await focusField();

      const root = cluster();
      // 102 (field.bottom) + 8 (clearance gap) = 110 — clear of the field.
      expect(root.style.top).toBe(`${102 + TOP_STACK_CLEARANCE_GAP_PX}px`);
      expect(root.style.top).toBe('110px');
      // Unchanged invariants.
      expect(root.style.left).toBe(`${TOP_STACK_ANCHOR_X_PX}px`);
      expect(root.style.zIndex).toBe(String(REGIME_SIGNAL_Z_INDEX));
      expect(root.style.gap).toBe(`${HOTKEYS_CLUSTER_GAP_PX}px`);
      expect(root.style.pointerEvents).toBe('none');

      // The three surfaces stay in-flow inside the ONE cluster.
      for (const el of [
        screen.getByTestId(INPUT_REGIME_TESTID),
        screen.getByTestId(KEYS_DISCOVERY_TESTID),
        screen.getByTestId(KEYBOARD_INTRO_TESTID),
      ]) {
        expect(root.contains(el)).toBe(true);
      }
    } finally {
      uninstall();
    }
  });

  it('stays at the derived rest for a launcher-shaped field at the viewport bottom', async () => {
    const uninstall = installHotkeyEngine();
    try {
      // The launcher field sits at the viewport bottom, outside the top-left lane.
      stubRects(rect(360, 412, 920, 460));
      renderWithChakra(<HotkeysCluster reducedMotion />);
      await settle();

      await focusField();

      expect(cluster().style.top).toBe(`${TOP_STACK_MIN_PX}px`);
    } finally {
      uninstall();
    }
  });
});

// ── The three surfaces are in-flow (ST-5 adjudication) ───────────────────────

describe('HotkeysCluster — three surfaces in-flow', () => {
  it('renders the chip, the discovery control, and the intro card as in-flow children', async () => {
    renderWithChakra(<HotkeysCluster reducedMotion />);
    await settle();

    const root = cluster();
    const chip = screen.getByTestId(INPUT_REGIME_TESTID);
    const discovery = screen.getByTestId(KEYS_DISCOVERY_TESTID);
    const intro = screen.getByTestId(KEYBOARD_INTRO_TESTID);

    // All three are inside the ONE cluster.
    for (const el of [chip, discovery, intro]) {
      expect(root.contains(el)).toBe(true);
    }

    // None self-positions any more — the cluster owns placement.
    expect(chip.style.position).not.toBe('fixed');
    expect(discovery.parentElement!.style.position).not.toBe('fixed');
    expect(intro.style.position).not.toBe('fixed');

    // The chip stays click-through; the interactive surfaces re-enable pointer
    // events so the click-through cluster does not disable them.
    expect(chip.style.pointerEvents).toBe('none');
    expect(discovery.parentElement!.style.pointerEvents).toBe('auto');
    expect(intro.style.pointerEvents).toBe('auto');
  });
});

// ── Exactly one live region (no second announcer) ────────────────────────────

describe('HotkeysCluster — no live region of its own', () => {
  it('adds no [aria-live] / role="status" region', async () => {
    renderWithChakra(<HotkeysCluster reducedMotion />);
    await settle();

    const root = cluster();
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(root.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});
