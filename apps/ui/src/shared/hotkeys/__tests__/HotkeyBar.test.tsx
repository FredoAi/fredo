/**
 * Spec #3009 CU-1 (ST-2) — the always-on bottom hotkey bar (plan UI/UX section /
 * QA rows F-96/F-97/F-98/F-106/F-107). Pins the exact testids + stacking, the
 * null-at-zero reach-back, document-ordered rows, the disabled pair, the pending
 * chip, the ONE-ellipsizing-child / exempt-children rule (G-274), the a11y
 * invariants (named region, no focusables, no live region), and token hygiene.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { buildHotkeyBarModel } from '../hotkeyBarModel';
import { parseDataHotkey } from '../hotkeyGrammar';
import { resetHotkeyElementDiscoveryForTests } from '../hotkeyElements';
import type { HotkeyElementEntry } from '../hotkeyElements';
import type { FocusSnapshot } from '../engine';
import type { FocusContext } from '../types';
import {
  HOTKEY_BAR_ARIA_LABEL,
  HOTKEY_BAR_BOTTOM_INSET_PX,
  HOTKEY_BAR_FADE_MS,
  HOTKEY_BAR_HEIGHT_PX,
  HOTKEY_BAR_LIST_TESTID,
  HOTKEY_BAR_PENDING_LABEL,
  HOTKEY_BAR_PENDING_TESTID,
  HOTKEY_BAR_ROW_GAP,
  HOTKEY_BAR_ROW_MAX_WIDTH_PX,
  HOTKEY_BAR_ROW_TESTID,
  HOTKEY_BAR_TESTID,
  HOTKEY_BAR_TITLE_MIN_WIDTH_PX,
  HOTKEY_BAR_Z_INDEX,
  HOTKEY_DUPLICATE_ERROR_TESTID,
  HotkeyBar,
} from '../HotkeyBar';
import { BODY_HOTKEYS_DISABLED_ATTR } from '../hotkeyElements';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function entry(key: string, title: string, id = 'fixture'): HotkeyElementEntry {
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  return {
    element: document.createElement('button'),
    actionId: `fredo.element.${key}#${id}`,
    grammar,
    title,
    source: 'element',
  };
}

function focus(context: FocusContext, textEntry = false): FocusSnapshot {
  return { context, nativeConsumes: false, textEntry };
}

function modelFor(
  entries: readonly HotkeyElementEntry[],
  pending: string | null = null,
  focusSnapshot: FocusSnapshot = focus('default'),
) {
  return buildHotkeyBarModel({ entries, pending, focus: focusSnapshot });
}

function root(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_BAR_TESTID}"]`);
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${HOTKEY_BAR_ROW_TESTID}"]`));
}

function duplicateBanner(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_DUPLICATE_ERROR_TESTID}"]`);
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetHotkeyElementDiscoveryForTests();
});

afterEach(() => {
  cleanup();
  resetHotkeyElementDiscoveryForTests();
  document.body.innerHTML = '';
});

// ── Binding constants ────────────────────────────────────────────────────────

describe('HotkeyBar — binding constants', () => {
  it('declares the exact contract testids, stacking and design constants', () => {
    expect(HOTKEY_BAR_Z_INDEX).toBe(1250);
    expect(HOTKEY_BAR_HEIGHT_PX).toBe(34);
    expect(HOTKEY_BAR_BOTTOM_INSET_PX).toBe(0);
    expect(HOTKEY_BAR_ROW_GAP).toBe(2);
    expect(HOTKEY_BAR_ROW_MAX_WIDTH_PX).toBe(240);
    expect(HOTKEY_BAR_TITLE_MIN_WIDTH_PX).toBe(48);
    expect(HOTKEY_BAR_FADE_MS).toBe(150);
    expect(HOTKEY_BAR_TESTID).toBe('hotkeys-keybar');
    expect(HOTKEY_BAR_LIST_TESTID).toBe('hotkeys-keybar-list');
    expect(HOTKEY_BAR_ROW_TESTID).toBe('hotkeys-keybar-row');
    expect(HOTKEY_BAR_PENDING_TESTID).toBe('hotkeys-keybar-pending');
    expect(HOTKEY_BAR_ARIA_LABEL).toBe('Available hotkeys');
    expect(HOTKEY_DUPLICATE_ERROR_TESTID).toBe('hotkeys-duplicate-error');
  });
});

// ── Null-at-zero reach-back ──────────────────────────────────────────────────

describe('HotkeyBar — zero-state reach-back (R-2.2 / G-265)', () => {
  it('renders null and no body hook when the model is empty', () => {
    const { container } = renderWithChakra(<HotkeyBar model={modelFor([])} reducedMotion />);
    expect(root(container)).toBeNull();
    expect(rows(container)).toHaveLength(0);
    expect(document.body.hasAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe(false);
  });
});

// ── Duplicate-key DEV error surface (ST-2R / R-3.4) ──────────────────────────

describe('HotkeyBar — DEV duplicate-key error surface (R-3.4)', () => {
  it('renders the DEV banner when two entries declare the same key', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={modelFor([entry('s', 'First', 'dup-a'), entry('s', 'Second', 'dup-b')])}
        reducedMotion
      />,
    );
    expect(duplicateBanner(container)).not.toBeNull();
  });

  it('renders no banner for a single entry', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('s', 'Only')])} reducedMotion />,
    );
    expect(duplicateBanner(container)).toBeNull();
  });

  it('renders no banner for disjoint keys', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('s', 'Find'), entry('d', 'Diagram')])} reducedMotion />,
    );
    expect(duplicateBanner(container)).toBeNull();
  });

  it('unmounts the banner when the duplicate is removed (recovery, no cached flag)', () => {
    const { container, rerender } = renderWithChakra(
      <HotkeyBar
        model={modelFor([entry('s', 'First', 'dup-a'), entry('s', 'Second', 'dup-b')])}
        reducedMotion
      />,
    );
    expect(duplicateBanner(container)).not.toBeNull();

    rerender(<HotkeyBar model={modelFor([entry('s', 'First', 'dup-a')])} reducedMotion />);
    expect(duplicateBanner(container)).toBeNull();
  });

  it('keeps the banner a non-live, non-focusable sibling of the bar', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={modelFor([entry('s', 'First', 'dup-a'), entry('s', 'Second', 'dup-b')])}
        reducedMotion
      />,
    );
    const banner = duplicateBanner(container);
    expect(banner).not.toBeNull();
    expect(banner).not.toHaveAttribute('aria-live');
    expect(banner?.getAttribute('role')).not.toBe('status');
    expect(banner?.getAttribute('role')).not.toBe('alert');
    expect(banner?.querySelectorAll('button, [tabindex], [href]')).toHaveLength(0);
    // Sibling of the bar container, not a descendant (the bar cannot clip it).
    expect(banner?.closest(`[data-testid="${HOTKEY_BAR_TESTID}"]`)).toBeNull();
    // The banner adds no live region (the announcer stays the sole channel).
    expect(container.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
  });
});

// ── Visible render ───────────────────────────────────────────────────────────

describe('HotkeyBar — always-on render (R-2.1/R-2.5/R-2.6)', () => {
  it('renders a named, non-focusable region with document-ordered rows', () => {
    const { container } = renderWithChakra(
      <HotkeyBar
        model={modelFor([entry('s', 'Find session'), entry('n', 'Next'), entry('a+b', 'Two step')])}
        reducedMotion
        platform="win32"
      />,
    );

    const bar = root(container);
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute('role', 'region');
    expect(bar).toHaveAttribute('aria-label', 'Available hotkeys');
    expect(bar?.style.position).toBe('fixed');
    expect(bar?.style.bottom).toBe('0px');
    expect(bar?.style.pointerEvents).toBe('none');
    expect(bar).not.toHaveAttribute('aria-hidden');

    const list = container.querySelector(`[data-testid="${HOTKEY_BAR_LIST_TESTID}"]`);
    expect(list).toHaveAttribute('role', 'list');

    // Rows are element-only and in the listing's document order.
    expect(rows(container).map((row) => row.getAttribute('data-hotkey-key'))).toEqual(['s', 'n', 'a']);
    // Storage unit (first step) vs display unit (full serialized sequence).
    expect(rows(container)[2].getAttribute('data-hotkey-action')).toBe('fredo.element.a+b#fixture');
    expect(rows(container)[2]).toHaveAttribute('data-hotkey-availability', 'available');
    expect(rows(container)[2]).toHaveAttribute('aria-label', 'A then B: Two step');

    // No focusable descendant, no live region (the announcer stays the one channel).
    expect(bar?.querySelectorAll('button, [tabindex], [href]')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
  });
});

// ── Disabled state ───────────────────────────────────────────────────────────

describe('HotkeyBar — disabled state (R-2.3/R-2.4)', () => {
  it('marks every row disabled + the body hook while typing', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('a', 'Alpha')], null, focus('text-entry', true))} reducedMotion />,
    );

    const first = rows(container)[0];
    expect(first).toHaveAttribute('data-hotkey-availability', 'disabled');
    expect(first.querySelector('svg')).not.toBeNull();
    expect(document.body.getAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe('true');
  });

  it('clears the body hook on unmount', () => {
    const { unmount } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('a', 'Alpha')], null, focus('terminal'))} reducedMotion />,
    );
    expect(document.body.getAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe('true');
    unmount();
    expect(document.body.hasAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe(false);
  });
});

// ── Pending prefix ───────────────────────────────────────────────────────────

describe('HotkeyBar — pending prefix (R-3.2)', () => {
  it('shows the pending chip outside the scroll region when a prefix is set', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('a+b', 'Two step')], 'a')} reducedMotion />,
    );
    const pending = container.querySelector(`[data-testid="${HOTKEY_BAR_PENDING_TESTID}"]`);
    expect(pending).not.toBeNull();
    expect(pending).toHaveTextContent(HOTKEY_BAR_PENDING_LABEL);
    // Pinned outside the scroll region → a sibling, not a descendant of the list.
    expect(pending?.closest(`[data-testid="${HOTKEY_BAR_LIST_TESTID}"]`)).toBeNull();
  });

  it('renders no pending chip when the prefix is null', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('a', 'Alpha')], null)} reducedMotion />,
    );
    expect(container.querySelector(`[data-testid="${HOTKEY_BAR_PENDING_TESTID}"]`)).toBeNull();
  });
});

// ── Width clamp (G-274) ──────────────────────────────────────────────────────

describe('HotkeyBar — ONE ellipsizing child + exempt children (G-274)', () => {
  it('floors + ellipsizes only the title; the keycap group and marker never shrink', () => {
    const { container } = renderWithChakra(
      <HotkeyBar model={modelFor([entry('a', 'A long action title')], null, focus('terminal'))} reducedMotion />,
    );

    const row = rows(container)[0];
    const title = row.querySelector('p');
    expect(title).not.toBeNull();
    expect(getComputedStyle(title as HTMLElement).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(title as HTMLElement).overflow).toBe('hidden');
    expect(getComputedStyle(title as HTMLElement).minWidth).toBe(`${HOTKEY_BAR_TITLE_MIN_WIDTH_PX}px`);

    // The keycap group is wrapped in an aria-hidden, non-shrinking box.
    const group = row.querySelector('[data-testid="hotkeys-keycap-group"]');
    expect(group).not.toBeNull();
    const groupWrapper = group?.parentElement;
    expect(groupWrapper).toHaveAttribute('aria-hidden', 'true');
    expect(getComputedStyle(groupWrapper as HTMLElement).flexShrink).toBe('0');

    // The disabled marker is decorative and non-shrinking.
    const marker = row.querySelector('svg');
    expect(marker).not.toBeNull();
    expect(marker).toHaveAttribute('aria-hidden', 'true');
  });
});

// ── Token hygiene (source audit) ─────────────────────────────────────────────

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const NEW_FILES = [
  'src/shared/hotkeys/hotkeyGrammar.ts',
  'src/shared/hotkeys/hotkeyElements.ts',
  'src/shared/hotkeys/hotkeyBarModel.ts',
  'src/shared/hotkeys/HotkeyBar.tsx',
];

describe('HotkeyBar — token hygiene', () => {
  it('introduces no hex / rgb() / hsl() colour literal', () => {
    for (const file of NEW_FILES) {
      const code = stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'));
      const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
      expect(hex, `${file}: ${JSON.stringify(hex)}`).toEqual([]);
      const functional = [...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((match) => match[0]);
      expect(functional, `${file}: ${JSON.stringify(functional)}`).toEqual([]);
    }
  });

  it('never alpha-appends onto a var() (AGENTS.md #2770)', () => {
    for (const file of NEW_FILES) {
      const code = stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'));
      const appends = [...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((match) => match[0]);
      expect(appends, `${file}: ${JSON.stringify(appends)}`).toEqual([]);
    }
  });
});
