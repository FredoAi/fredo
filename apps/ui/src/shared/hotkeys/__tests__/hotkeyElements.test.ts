/**
 * Spec #3009 CU-1 (ST-1) — the `data-hotkey` element registry (plan API Contracts
 * / QA rows F-96/F-100/F-101). Pins document-order listing, the invalid-attribute
 * exclusion + diagnostic (R-1.3), duplicate detection + the DEV throw (R-3.4),
 * revision monotonicity (AGENTS.md #523), the body hooks, the coalesced observer
 * flush, and the activation fallback (A4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDataHotkey } from '../hotkeyGrammar';
import {
  BODY_HOTKEY_COUNT_ATTR,
  BODY_HOTKEY_DUPLICATE_ATTR,
  BODY_HOTKEYS_DISABLED_ATTR,
  DuplicateHotkeyError,
  activateHotkeyElement,
  detectDuplicateHotkeys,
  flushElementHotkeys,
  getElementHotkeyRevision,
  installHotkeyElementDiscovery,
  listElementHotkeys,
  resetHotkeyElementDiscoveryForTests,
  setElementHotkeysDisabled,
  subscribeElementHotkeys,
  type HotkeyElementEntry,
} from '../hotkeyElements';

// ── Helpers ──────────────────────────────────────────────────────────────────

function appendHotkey(
  tag: string,
  key: string,
  options?: { readonly label?: string; readonly text?: string },
): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute('data-hotkey', key);
  if (options?.label !== undefined) element.setAttribute('data-hotkey-label', options.label);
  if (options?.text !== undefined) element.textContent = options.text;
  document.body.appendChild(element);
  return element;
}

function makeEntry(element: HTMLElement, key: string, title = key.toUpperCase()): HotkeyElementEntry {
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  return {
    element,
    actionId: `fredo.element.${key}#fixture`,
    grammar,
    title,
    source: 'element',
  };
}

/** Let the MutationObserver batch + the coalesced microtask flush both run. */
async function settleMutations(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetHotkeyElementDiscoveryForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetHotkeyElementDiscoveryForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ── Listing + validity + order ───────────────────────────────────────────────

describe('listElementHotkeys — grammar-valid, document-ordered', () => {
  it('lists only valid elements in document order and publishes the count hook', () => {
    const first = appendHotkey('button', 'a', { text: 'Alpha' });
    const second = appendHotkey('button', 'b', { text: 'Beta' });
    const invalidUpper = appendHotkey('button', 'A');
    const invalidPunct = appendHotkey('button', '!');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    flushElementHotkeys();

    const entries = listElementHotkeys();
    expect(entries.map((entry) => entry.grammar.key)).toEqual(['a', 'b']);
    expect(entries.map((entry) => entry.element)).toEqual([first, second]);
    expect(entries.some((entry) => entry.element === invalidUpper)).toBe(false);
    expect(entries.some((entry) => entry.element === invalidPunct)).toBe(false);
    expect(document.body.getAttribute(BODY_HOTKEY_COUNT_ATTR)).toBe('2');
    // R-1.3 — a dev diagnostic is surfaced for the grammar miss.
    expect(error).toHaveBeenCalled();
  });

  it('orders entries by document position (compareDocumentPosition)', () => {
    const first = appendHotkey('button', 'a');
    const third = appendHotkey('button', 'c');
    const second = document.createElement('button');
    second.setAttribute('data-hotkey', 'b');
    document.body.insertBefore(second, third);

    flushElementHotkeys();

    expect(listElementHotkeys().map((entry) => entry.element)).toEqual([first, second, third]);
  });

  it('resolves the title as label > accessible name > uppercased key', () => {
    const labelled = appendHotkey('button', 'a', { label: 'Label wins', text: 'Text loses' });
    labelled.setAttribute('aria-label', 'Aria loses');
    const aria = appendHotkey('button', 'b');
    aria.setAttribute('aria-label', 'Aria wins');
    const text = appendHotkey('button', 'c', { text: 'Text name' });
    const bare = appendHotkey('button', 'd');

    flushElementHotkeys();

    const titles = new Map(listElementHotkeys().map((entry) => [entry.grammar.key, entry.title]));
    expect(titles.get('a')).toBe('Label wins');
    expect(titles.get('b')).toBe('Aria wins');
    expect(titles.get('c')).toBe('Text name');
    expect(titles.get('d')).toBe('D');
  });
});

// ── Revision + subscription ──────────────────────────────────────────────────

describe('getElementHotkeyRevision — advances only on a real diff', () => {
  it('is stable across no-op flushes and monotonic on real changes', () => {
    const element = appendHotkey('button', 'a');
    flushElementHotkeys();
    const base = getElementHotkeyRevision();
    expect(base).toBeGreaterThan(0);

    flushElementHotkeys();
    expect(getElementHotkeyRevision()).toBe(base);

    element.setAttribute('data-hotkey-label', 'Renamed');
    flushElementHotkeys();
    expect(getElementHotkeyRevision()).toBe(base + 1);

    element.remove();
    flushElementHotkeys();
    expect(getElementHotkeyRevision()).toBe(base + 2);
    expect(listElementHotkeys()).toHaveLength(0);
  });

  it('notifies subscribers only on a real change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeElementHotkeys(listener);
    appendHotkey('button', 'a');

    flushElementHotkeys();
    expect(listener).toHaveBeenCalledTimes(1);

    flushElementHotkeys();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

// ── Observer (coalesced, idempotent) ─────────────────────────────────────────

describe('installHotkeyElementDiscovery — one coalesced observer', () => {
  it('is idempotent and coalesces a mutation batch into ONE flush', async () => {
    installHotkeyElementDiscovery();
    installHotkeyElementDiscovery();
    const base = getElementHotkeyRevision();

    appendHotkey('button', 'a');
    appendHotkey('button', 'b');
    await settleMutations();

    expect(getElementHotkeyRevision()).toBe(base + 1);
    expect(listElementHotkeys().map((entry) => entry.grammar.key)).toEqual(['a', 'b']);
  });
});

// ── Duplicate detection ──────────────────────────────────────────────────────

describe('detectDuplicateHotkeys', () => {
  it('reports the shared key (pure — no throw)', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    const duplicate = detectDuplicateHotkeys([
      makeEntry(first, 'a', 'One'),
      makeEntry(second, 'a', 'Two'),
    ]);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.key).toBe('a');
    expect(duplicate.entries).toHaveLength(2);

    const distinct = detectDuplicateHotkeys([makeEntry(first, 'a'), makeEntry(second, 'b')]);
    expect(distinct.duplicate).toBe(false);
    expect(distinct.key).toBeNull();
    expect(distinct.entries).toHaveLength(0);
  });

  it('defaults to the current listing when called with no argument', () => {
    document.body.appendChild(document.createElement('button')).setAttribute('data-hotkey', 'a');
    flushElementHotkeys();
    expect(detectDuplicateHotkeys().duplicate).toBe(false);
  });
});

describe('duplicate enforcement on flush', () => {
  it('sets the body hook + console.error and throws in DEV', () => {
    appendHotkey('button', 'a');
    appendHotkey('button', 'a');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    if (import.meta.env.DEV) {
      expect(() => flushElementHotkeys()).toThrow(DuplicateHotkeyError);
    } else {
      expect(() => flushElementHotkeys()).not.toThrow();
    }

    expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');
    expect(error).toHaveBeenCalled();
  });

  it('clears the hook once the duplicate is removed', () => {
    appendHotkey('button', 'a');
    const second = appendHotkey('button', 'a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      flushElementHotkeys();
    } catch {
      // The DEV throw is expected; the hook is published first.
    }
    expect(document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe('true');

    second.remove();
    flushElementHotkeys();
    expect(document.body.hasAttribute(BODY_HOTKEY_DUPLICATE_ATTR)).toBe(false);
  });
});

// ── Activation (A4) ──────────────────────────────────────────────────────────

describe('activateHotkeyElement — click → focus → CustomEvent', () => {
  it('clicks a clickable element', () => {
    const button = document.createElement('button');
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    activateHotkeyElement(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('clicks a role=button element', () => {
    const roleButton = document.createElement('div');
    roleButton.setAttribute('role', 'button');
    const onClick = vi.fn();
    roleButton.addEventListener('click', onClick);
    activateHotkeyElement(roleButton);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('focuses a focusable element', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    activateHotkeyElement(input);
    expect(document.activeElement).toBe(input);
  });

  it('dispatches a bubbling hotkey-activate CustomEvent as the fallback', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const onBubbled = vi.fn();
    document.body.addEventListener('hotkey-activate', onBubbled);
    activateHotkeyElement(element);
    expect(onBubbled).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('hotkey-activate', onBubbled);
  });
});

// ── Body hooks ───────────────────────────────────────────────────────────────

describe('setElementHotkeysDisabled', () => {
  it('sets and clears the disabled body hook', () => {
    setElementHotkeysDisabled(true);
    expect(document.body.getAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe('true');
    setElementHotkeysDisabled(false);
    expect(document.body.hasAttribute(BODY_HOTKEYS_DISABLED_ATTR)).toBe(false);
  });
});
