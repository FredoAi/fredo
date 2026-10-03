/**
 * Spec #2960 ST-3 — the always-present zero-knowledge discovery control + its
 * NON-MODAL key panel (EARS R-4.1, R-4.2, R-4.3).
 *
 * Pins: the exact binding constants; the always-present real `<button>` with the
 * visible `Keys` label and its `aria-expanded`/`aria-controls`; the panel's
 * non-modal semantics (no `role="dialog"`/`aria-modal`/focus trap, no second live
 * region, no `document` keydown listener); the current-context listing from
 * `resolveActiveBindings()` with context-scoped rows first; the pinned
 * `KEYBOARD_MODE_CHORD` row (outside the scroll region) invoking the shipped
 * `toggleKeyboardMode()`; the defined empty state; the three close paths; the
 * G-273/G-274 clamp + single ellipsis target + exempt children; the resting-box
 * ZERO-overlap with the focused field at every supported width; and token
 * hygiene.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { REFERENCE_DESCEND_ACTION_ID } from '@/shared/hotkeys/defaults';
import { registerDefaultFredoActions, resetHotkeyEngineForTests } from '@/shared/hotkeys/engine';
import { resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import { resetHotkeyContextForTests } from '@/shared/hotkeys/contextStack';
import {
  isKeyboardModeOn,
  resetKeyboardModeForTests,
} from '@/shared/hotkeys/keyboardMode';
import { measureTopOffsetPx, TOP_STACK_ANCHOR_X_PX } from '@/shared/hotkeys/topStack';
import {
  KEYS_DISCOVERY_CHORD_COPY,
  KEYS_DISCOVERY_CHORD_TESTID,
  KEYS_DISCOVERY_CLOSE_TESTID,
  KEYS_DISCOVERY_CONTROL_LABEL,
  KEYS_DISCOVERY_EMPTY_COPY,
  KEYS_DISCOVERY_EMPTY_TESTID,
  KEYS_DISCOVERY_LIST_MAX_HEIGHT,
  KEYS_DISCOVERY_LIST_TESTID,
  KEYS_DISCOVERY_PANEL_TESTID,
  KEYS_DISCOVERY_PANEL_WIDTH,
  KEYS_DISCOVERY_ROW_TESTID,
  KEYS_DISCOVERY_TESTID,
  KEYS_DISCOVERY_Z_INDEX,
  KeysDiscovery,
} from '../KeysDiscovery';

const SRC = 'src/shared/hotkeys/KeysDiscovery.tsx';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function renderDiscovery() {
  return renderWithChakra(<KeysDiscovery platform="win32" />);
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId(KEYS_DISCOVERY_TESTID));
}

function rowActions(): string[] {
  return screen
    .getAllByTestId(KEYS_DISCOVERY_ROW_TESTID)
    .map((row) => row.getAttribute('data-hotkey-action') ?? '');
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
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
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── Binding constants (verbatim) ─────────────────────────────────────────────

describe('KeysDiscovery — binding constants', () => {
  it('declares the exact contract testids + copy', () => {
    expect(KEYS_DISCOVERY_TESTID).toBe('hotkeys-keys-discovery');
    expect(KEYS_DISCOVERY_PANEL_TESTID).toBe('hotkeys-keys-discovery-panel');
    expect(KEYS_DISCOVERY_LIST_TESTID).toBe('hotkeys-keys-discovery-list');
    expect(KEYS_DISCOVERY_ROW_TESTID).toBe('hotkeys-keys-discovery-row');
    expect(KEYS_DISCOVERY_CHORD_TESTID).toBe('hotkeys-keys-discovery-mode-chord');
    expect(KEYS_DISCOVERY_EMPTY_TESTID).toBe('hotkeys-keys-discovery-empty');
    expect(KEYS_DISCOVERY_CLOSE_TESTID).toBe('hotkeys-keys-discovery-close');
    expect(KEYS_DISCOVERY_CONTROL_LABEL).toBe('Keys');
    expect(KEYS_DISCOVERY_EMPTY_COPY).toBe('No keys in this context');
    expect(KEYS_DISCOVERY_CHORD_COPY).toBe('turn on keyboard mode');
    expect(KEYS_DISCOVERY_PANEL_WIDTH).toBe('min(360px, 92vw)');
    expect(KEYS_DISCOVERY_Z_INDEX).toBe(1310);
  });
});

// ── Always-present control (R-4.1) ───────────────────────────────────────────

describe('KeysDiscovery — always-present control', () => {
  it('renders a real, visible <button> with the Keys label and a keyboard icon', () => {
    renderDiscovery();

    const control = screen.getByTestId(KEYS_DISCOVERY_TESTID);
    expect(control.tagName).toBe('BUTTON');
    expect(control).toHaveTextContent('Keys');
    expect(control.querySelector('svg')).not.toBeNull();
    expect(control).toBeVisible();
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(control).toHaveAttribute('aria-controls', KEYS_DISCOVERY_PANEL_TESTID);
    expect(screen.queryByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeNull();
  });

  it('rests in the fixed top-left cluster layer (never reflowed by app content)', () => {
    renderDiscovery();
    const root = screen.getByTestId(KEYS_DISCOVERY_TESTID).parentElement as HTMLElement;
    expect(root.style.position).toBe('fixed');
    expect(root.style.left).toBe(`${TOP_STACK_ANCHOR_X_PX}px`);
    expect(root.style.top).toBe(`${measureTopOffsetPx()}px`);
    expect(root.style.zIndex).toBe(String(KEYS_DISCOVERY_Z_INDEX));
  });

  it('opens the panel on activation and tracks aria-expanded', () => {
    renderDiscovery();
    const control = screen.getByTestId(KEYS_DISCOVERY_TESTID);

    fireEvent.click(control);

    expect(control).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID);
    expect(panel).toHaveAttribute('id', KEYS_DISCOVERY_PANEL_TESTID);
  });
});

// ── Non-modal semantics (R-4.3) ──────────────────────────────────────────────

describe('KeysDiscovery — non-modal panel', () => {
  it('is not a dialog, declares no aria-modal, and adds no live region', () => {
    renderDiscovery();
    openPanel();

    const panel = screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID);
    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(panel.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(panel.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('adds NO document keydown listener and no dialog markup (source audit)', () => {
    const code = stripComments(readFileSync(resolve(process.cwd(), SRC), 'utf8'));
    expect(code).not.toMatch(/document\.addEventListener\(\s*['"]keydown/);
    expect(code).not.toContain('role="dialog"');
    expect(code).not.toContain('aria-modal');
  });
});

// ── Listing (R-4.2) ──────────────────────────────────────────────────────────

describe('KeysDiscovery — current-context listing', () => {
  it('lists the active context bindings with shared Keycaps, context-scoped first', () => {
    renderDiscovery();
    openPanel();

    const rows = screen.getAllByTestId(KEYS_DISCOVERY_ROW_TESTID);
    expect(rows.length).toBeGreaterThan(0);

    // The shipped descent action (opensContextId = a non-ROOT context) is
    // context-scoped and must sort FIRST; an always-on ROOT binding follows.
    const actions = rowActions();
    expect(actions[0]).toBe(REFERENCE_DESCEND_ACTION_ID);
    expect(actions.indexOf(REFERENCE_DESCEND_ACTION_ID)).toBeLessThan(
      actions.indexOf('fredo.launcher.toggle'),
    );

    // Every row carries a shared Keycap and a tier tag.
    const first = rows[0];
    expect(within(first).getAllByTestId('hotkeys-keycap').length).toBeGreaterThan(0);
    expect(within(first).getByText('Global')).toBeInTheDocument();
    expect(first).toHaveAttribute('data-hotkey-tier', 'fredo');
  });
});

// ── Pinned mode-chord row (R-4.2) ────────────────────────────────────────────

describe('KeysDiscovery — pinned keyboard-mode chord', () => {
  it('renders the chord + copy OUTSIDE the scroll region and toggles the shipped mode', () => {
    renderDiscovery();
    openPanel();

    const chord = screen.getByTestId(KEYS_DISCOVERY_CHORD_TESTID);
    expect(chord).toHaveTextContent(KEYS_DISCOVERY_CHORD_COPY);
    const caps = within(chord).getAllByTestId('hotkeys-keycap');
    expect(caps[0]).toHaveAttribute('data-chord-token', 'ctrl+shift+f8');

    // Pinned OUTSIDE the scrolling key list.
    const list = screen.getByTestId(KEYS_DISCOVERY_LIST_TESTID);
    expect(list.contains(chord)).toBe(false);

    // The key list scrolls with a bounded height.
    expect(list.style.overflowY).toBe('auto');
    expect(list.style.maxHeight).toBe(KEYS_DISCOVERY_LIST_MAX_HEIGHT);

    expect(isKeyboardModeOn()).toBe(false);
    fireEvent.click(chord);
    expect(isKeyboardModeOn()).toBe(true);
  });
});

// ── Empty context (R-4.2) ────────────────────────────────────────────────────

describe('KeysDiscovery — empty context', () => {
  it('renders the defined empty copy, never a blank panel', () => {
    resetRegistryForTests();
    renderDiscovery();
    openPanel();

    expect(screen.queryAllByTestId(KEYS_DISCOVERY_ROW_TESTID)).toHaveLength(0);
    expect(screen.getByTestId(KEYS_DISCOVERY_EMPTY_TESTID)).toHaveTextContent(
      'No keys in this context',
    );
    // The panel and the pinned mode chord still render.
    expect(screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(KEYS_DISCOVERY_CHORD_TESTID)).toBeInTheDocument();
  });
});

// ── Close paths (R-4.3) ──────────────────────────────────────────────────────

describe('KeysDiscovery — close paths', () => {
  it('the close button closes and returns focus to the control', () => {
    renderDiscovery();
    openPanel();

    fireEvent.click(screen.getByTestId(KEYS_DISCOVERY_CLOSE_TESTID));

    expect(screen.queryByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeNull();
    expect(screen.getByTestId(KEYS_DISCOVERY_TESTID)).toHaveFocus();
  });

  it('Escape on the panel root closes and returns focus to the control', () => {
    renderDiscovery();
    openPanel();

    fireEvent.keyDown(screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID), { key: 'Escape' });

    expect(screen.queryByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeNull();
    expect(screen.getByTestId(KEYS_DISCOVERY_TESTID)).toHaveFocus();
  });

  it('an outside pointer press closes; an inside press does not', () => {
    renderDiscovery();
    openPanel();
    const panel = screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID);

    fireEvent.pointerDown(panel);
    expect(screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId(KEYS_DISCOVERY_PANEL_TESTID)).toBeNull();
  });
});

// ── G-273/G-274 render contract ──────────────────────────────────────────────

describe('KeysDiscovery — clamp + single ellipsis target + exempt children', () => {
  it('is the ONE clamp and makes the action TITLE the ONE ellipsis/shrink target', () => {
    renderDiscovery();
    openPanel();

    const panel = screen.getByTestId(KEYS_DISCOVERY_PANEL_TESTID);
    expect(panel.style.width).toBe('min(360px, 92vw)');

    const row = screen.getAllByTestId(KEYS_DISCOVERY_ROW_TESTID)[0];
    const title = row.querySelector<HTMLElement>('[data-keys-discovery-title]');
    expect(title).not.toBeNull();
    expect(title!.style.textOverflow).toBe('ellipsis');
    expect(title!.style.overflow).toBe('hidden');
    expect(title!.style.whiteSpace).toBe('nowrap');
    expect(parseFloat(title!.style.minWidth)).toBe(0);
  });

  it('exempts the Keycap group, tier tag, pinned chord Keycap, and close button', () => {
    renderDiscovery();
    openPanel();

    const row = screen.getAllByTestId(KEYS_DISCOVERY_ROW_TESTID)[0];
    const keycaps = row.querySelector<HTMLElement>('[data-keys-discovery-keycaps]');
    const tier = row.querySelector<HTMLElement>('[data-keys-discovery-tier]');
    const chordCap = screen
      .getByTestId(KEYS_DISCOVERY_CHORD_TESTID)
      .querySelector<HTMLElement>('[data-keys-discovery-chord-keycap]');
    const close = screen.getByTestId(KEYS_DISCOVERY_CLOSE_TESTID);

    for (const [name, el] of [
      ['keycaps', keycaps],
      ['tier', tier],
      ['chord keycap', chordCap],
      ['close', close],
    ] as const) {
      expect(el, `${name} must render`).not.toBeNull();
      expect(el!.style.flexShrink, `${name} flexShrink`).toBe('0');
      expect(el!.style.whiteSpace, `${name} whiteSpace`).toBe('nowrap');
    }
  });
});

// ── Resting box never overlaps the focused field (F-65, G-273) ───────────────

describe('KeysDiscovery — resting box clear of the focused field', () => {
  const SUPPORTED_WIDTHS = [320, 768, 1280, 1920];
  const CONTROL_WIDTH_PX = 96;
  const CONTROL_HEIGHT_PX = 32;
  const FIELD_TOP_PX = 120;
  const FIELD_HEIGHT_PX = 40;

  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function intersects(a: DOMRect, b: DOMRect): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  it('has ZERO overlap with a focused field at every supported width', () => {
    renderDiscovery();
    const control = screen.getByTestId(KEYS_DISCOVERY_TESTID);

    const field = document.createElement('input');
    field.setAttribute('data-testid', 'focused-field');
    document.body.appendChild(field);

    const root = control.parentElement as HTMLElement;
    const restingLeft = parseFloat(root.style.left);
    const restingTop = parseFloat(root.style.top);

    let fieldRect = rect(0, FIELD_TOP_PX, 0, FIELD_HEIGHT_PX);
    // jsdom has no layout engine: the pin stubs the measured rects, deriving the
    // control's resting corner from the component's OWN declared anchor. The live
    // F-65 row performs the real measurement.
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        if (this instanceof HTMLElement && this.dataset.testid === KEYS_DISCOVERY_TESTID) {
          return rect(restingLeft, restingTop, CONTROL_WIDTH_PX, CONTROL_HEIGHT_PX);
        }
        if (this instanceof HTMLElement && this.dataset.testid === 'focused-field') {
          return fieldRect;
        }
        return rect(0, 0, 0, 0);
      });

    for (const width of SUPPORTED_WIDTHS) {
      const fieldWidth = Math.min(480, width - 32);
      fieldRect = rect((width - fieldWidth) / 2, FIELD_TOP_PX, fieldWidth, FIELD_HEIGHT_PX);
      expect(
        intersects(control.getBoundingClientRect(), field.getBoundingClientRect()),
        `width ${width}`,
      ).toBe(false);
    }

    rectSpy.mockRestore();
  });
});

// ── Token hygiene ────────────────────────────────────────────────────────────

describe('KeysDiscovery — token hygiene', () => {
  it('has no hex / rgb() / hsl() literal and no var() alpha-append', () => {
    const code = stripComments(readFileSync(resolve(process.cwd(), SRC), 'utf8'));
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
  });

  it('uses the shared tint() helper + semantic tokens', () => {
    const code = stripComments(readFileSync(resolve(process.cwd(), SRC), 'utf8'));
    expect(code).toContain('tint(');
    expect(code).toContain('bg="bg.surface"');
    expect(code).toContain('borderColor="border.default"');
    expect(code).toContain('color="fg.default"');
  });
});
