import { describe, it, expect } from 'vitest';

import { classifyFocusContext, isInteractiveElement, isTextControl } from '../focusContext';

function element(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function terminalWithInput(): HTMLElement {
  const root = element('div', { 'data-fredo-terminal-root': 'true' });
  const input = element('input');
  root.appendChild(input);
  return input;
}

function modalWithInput(): HTMLElement {
  const dialog = element('div', { role: 'dialog', 'aria-modal': 'true' });
  const input = element('input');
  dialog.appendChild(input);
  return input;
}

describe('isTextControl', () => {
  it('is true for native editing controls', () => {
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
  it('is true for buttons, links and role/tabindex controls', () => {
    expect(isInteractiveElement(element('button'))).toBe(true);
    expect(isInteractiveElement(element('a', { href: '#' }))).toBe(true);
    expect(isInteractiveElement(element('div', { role: 'button' }))).toBe(true);
    expect(isInteractiveElement(element('div', { tabindex: '0' }))).toBe(true);
  });

  it('is false for a plain div, an anchor without href and null', () => {
    expect(isInteractiveElement(element('div'))).toBe(false);
    expect(isInteractiveElement(element('a'))).toBe(false);
    expect(isInteractiveElement(null)).toBe(false);
  });
});

describe('classifyFocusContext', () => {
  it('classifies native editing controls and contenteditable as text-entry', () => {
    expect(classifyFocusContext(element('input'))).toBe('text-entry');
    expect(classifyFocusContext(element('textarea'))).toBe('text-entry');
    expect(classifyFocusContext(element('select'))).toBe('text-entry');
    expect(classifyFocusContext(element('div', { contenteditable: 'true' }))).toBe('text-entry');
    expect(classifyFocusContext(element('div', { role: 'textbox' }))).toBe('text-entry');
  });

  it('classifies terminal focus before text-entry (hidden terminal textarea)', () => {
    expect(classifyFocusContext(terminalWithInput())).toBe('terminal');
  });

  it('classifies a focus inside an open modal dialog as modal', () => {
    expect(classifyFocusContext(modalWithInput())).toBe('modal');
  });

  it('honours the global open-modal flag', () => {
    expect(classifyFocusContext(element('div'), { modalOpen: true })).toBe('modal');
  });

  it('classifies interactive controls', () => {
    expect(classifyFocusContext(element('button'))).toBe('interactive');
    expect(classifyFocusContext(element('div', { role: 'tab' }))).toBe('interactive');
  });

  it('falls back to default for a plain element and null', () => {
    expect(classifyFocusContext(element('div'))).toBe('default');
    expect(classifyFocusContext(null)).toBe('default');
  });

  it('lets terminal win over a global open-modal flag', () => {
    expect(classifyFocusContext(terminalWithInput(), { modalOpen: true })).toBe('terminal');
  });
});
