/**
 * Chord-suppression pin (Spec #3151 ST-1) — AC2's three suppression cases made
 * expressible by `shared/window-system/chordSuppression.ts`.
 *
 * Pins the BINDING precedence `terminal > modal > text-entry > none` (the
 * classifier the retired engine owned, relocated here with the same order and
 * the same reason: a terminal's hidden helper textarea must not classify as
 * text-entry and mask the terminal context), each predicate, and the
 * document-reading `isChordSuppressed()` — including that it adds NO listener.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  TERMINAL_ROOT_SELECTOR,
  classifyChordSuppression,
  isChordSuppressed,
  isInteractiveElement,
  isTextControl,
} from '../chordSuppression';

function element(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/** An input nested inside a terminal root. */
function terminalWithInput(): HTMLElement {
  const root = element('div', { 'data-fredo-terminal-root': 'true' });
  const input = element('input');
  root.appendChild(input);
  document.body.appendChild(root);
  return input;
}

/** An input nested inside an open aria-modal dialog. */
function modalWithInput(): HTMLElement {
  const dialog = element('div', { role: 'dialog', 'aria-modal': 'true' });
  const input = element('input');
  dialog.appendChild(input);
  document.body.appendChild(dialog);
  return input;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TERMINAL_ROOT_SELECTOR', () => {
  it('is the exact terminal root attribute selector', () => {
    expect(TERMINAL_ROOT_SELECTOR).toBe('[data-fredo-terminal-root="true"]');
  });
});

describe('isTextControl', () => {
  it('is true for the native editing controls', () => {
    expect(isTextControl(element('input'))).toBe(true);
    expect(isTextControl(element('textarea'))).toBe(true);
    expect(isTextControl(element('select'))).toBe(true);
  });

  it('is true for contenteditable and role=textbox', () => {
    expect(isTextControl(element('div', { contenteditable: 'true' }))).toBe(true);
    expect(isTextControl(element('div', { role: 'textbox' }))).toBe(true);
  });

  it('is false for a button, a plain element and null', () => {
    expect(isTextControl(element('button'))).toBe(false);
    expect(isTextControl(element('div'))).toBe(false);
    expect(isTextControl(null)).toBe(false);
  });
});

describe('isInteractiveElement', () => {
  it('is true for buttons, href links and role/tabindex controls', () => {
    expect(isInteractiveElement(element('button'))).toBe(true);
    expect(isInteractiveElement(element('a', { href: '#' }))).toBe(true);
    expect(isInteractiveElement(element('div', { role: 'button' }))).toBe(true);
    expect(isInteractiveElement(element('div', { tabindex: '0' }))).toBe(true);
  });

  it('is false for a plain div, a href-less anchor and null', () => {
    expect(isInteractiveElement(element('div'))).toBe(false);
    expect(isInteractiveElement(element('a'))).toBe(false);
    expect(isInteractiveElement(null)).toBe(false);
  });
});

describe('classifyChordSuppression — precedence terminal > modal > text-entry > none', () => {
  it('classifies nothing focused as none', () => {
    expect(classifyChordSuppression(null)).toBe('none');
    expect(classifyChordSuppression(element('div'))).toBe('none');
  });

  it('classifies a text control as text-entry', () => {
    expect(classifyChordSuppression(element('input'))).toBe('text-entry');
    expect(classifyChordSuppression(element('textarea'))).toBe('text-entry');
    expect(classifyChordSuppression(element('div', { contenteditable: 'true' }))).toBe(
      'text-entry',
    );
    expect(classifyChordSuppression(element('div', { role: 'textbox' }))).toBe('text-entry');
  });

  it('classifies a focus inside an open aria-modal dialog as modal', () => {
    expect(classifyChordSuppression(modalWithInput())).toBe('modal');
  });

  it('honours the global modalOpen fact', () => {
    expect(classifyChordSuppression(element('div'), { modalOpen: true })).toBe('modal');
    expect(classifyChordSuppression(element('div'), { modalOpen: false })).toBe('none');
  });

  it('classifies terminal focus BEFORE text-entry (the hidden terminal textarea)', () => {
    expect(classifyChordSuppression(terminalWithInput())).toBe('terminal');
  });

  it('lets terminal win over a global modalOpen flag', () => {
    expect(classifyChordSuppression(terminalWithInput(), { modalOpen: true })).toBe('terminal');
  });

  it('lets modal win over a text control inside the modal', () => {
    // The precedence leg: a text control inside an aria-modal dialog is `modal`, not
    // `text-entry` (the dialog owns the keystroke).
    const input = modalWithInput();
    expect(classifyChordSuppression(input)).toBe('modal');
  });

  it('leaves a button unsuppressed (an interactive control does not suppress a chord)', () => {
    expect(classifyChordSuppression(element('button'))).toBe('none');
  });
});

describe('isChordSuppressed — the document-reading predicate', () => {
  it('is false with a plain focused element', () => {
    const div = element('div');
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    expect(isChordSuppressed()).toBe(false);
  });

  it('is true while a text control has focus (AC2 case 1)', () => {
    const input = element('input');
    document.body.appendChild(input);
    input.focus();
    expect(isChordSuppressed()).toBe(true);
  });

  it('is true while a terminal session has focus (AC2 case 2)', () => {
    const input = terminalWithInput();
    input.focus();
    expect(isChordSuppressed()).toBe(true);
  });

  it('is true under an open modal dialog (AC2 case 3)', () => {
    const dialog = element('div', { role: 'dialog', 'aria-modal': 'true' });
    const button = element('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    expect(isChordSuppressed()).toBe(true);
  });

  it('installs no document listener (the installer owns that, not this module)', () => {
    const before = document.onkeydown;
    const addSpy: string[] = [];
    const originalAdd = document.addEventListener.bind(document);
    // Record any keydown registration for the duration of one call.
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      addSpy.push(type);
      return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    try {
      isChordSuppressed();
    } finally {
      document.addEventListener = originalAdd;
    }
    expect(addSpy).not.toContain('keydown');
    expect(document.onkeydown).toBe(before);
  });
});
