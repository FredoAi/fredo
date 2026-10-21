/**
 * Wireframe page controls — three presets + derived `Custom` caption, editable
 * dimensions and the declared 64..4096 clamp (Spec #3070, ST-4, R-3.5 / R-4.6).
 *
 * Arc/Zag machines deliver their state-change callbacks in a microtask, so every
 * machine-driven interaction is awaited inside `act` before the store is read.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframePropertyPanel } from '../components/WireframePropertyPanel';
import { getSnapshot, resetWireframeStoreForTests } from '../store/wireframeDocumentStore';

function page() {
  return getSnapshot().document.page;
}

function numberInput(testId: string): HTMLInputElement {
  const root = screen.getByTestId(`${testId}-number`);
  const input = root.querySelector('input');
  if (!input) throw new Error(`number input ${testId} missing`);
  return input as HTMLInputElement;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function presetInput(preset: 'desktop' | 'tablet' | 'phone'): HTMLInputElement {
  const input = screen.getByTestId(`wireframe-page-preset-${preset}-input`);
  return input as unknown as HTMLInputElement;
}

function presetChecked(preset: 'desktop' | 'tablet' | 'phone'): boolean {
  return presetInput(preset).checked;
}

async function clickPreset(preset: 'desktop' | 'tablet' | 'phone'): Promise<void> {
  const input = presetInput(preset);
  await act(async () => {
    input.click();
    await Promise.resolve();
  });
}

/** Slider thumbs stay `visibility:hidden` under jsdom (no measured size). */
function slider(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[role="slider"][aria-label="${name}"]`,
  );
  if (!element) throw new Error(`slider ${name} missing`);
  return element;
}

async function pressSliderKey(name: string, key: string): Promise<void> {
  const thumb = slider(name);
  thumb.focus();
  await settle();
  await act(async () => {
    fireEvent.keyDown(thumb, { key });
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe('page controls (nothing selected)', () => {
  it('renders three selectable presets, the dims and the clipping caption', () => {
    renderWithChakra(<WireframePropertyPanel />);

    expect(screen.getByTestId('wireframe-page-controls')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-page-preset-desktop')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-page-preset-tablet')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-page-preset-phone')).toBeInTheDocument();
    expect(screen.queryByTestId('wireframe-page-preset-custom')).toBeNull();
    expect(screen.queryByTestId('wireframe-page-size-custom')).toBeNull();

    expect(presetChecked('desktop')).toBe(true);
    expect(presetChecked('tablet')).toBe(false);
    expect(presetChecked('phone')).toBe(false);

    expect(numberInput('wireframe-page-width').value).toBe('1280');
    expect(numberInput('wireframe-page-height').value).toBe('800');
    expect(screen.getByTestId('wireframe-page-clip-caption')).toHaveTextContent(
      'Content outside the page is hidden and not exported.',
    );
  });

  it('a preset writes its exact dimensions and becomes the selection', async () => {
    renderWithChakra(<WireframePropertyPanel />);

    await clickPreset('tablet');
    expect(page()).toEqual({ preset: 'tablet', width: 768, height: 1024 });
    expect(presetChecked('tablet')).toBe(true);
    expect(presetChecked('desktop')).toBe(false);
    // The editable fields re-sync through the NumberInput machine.
    await waitFor(() => {
      expect(numberInput('wireframe-page-width').value).toBe('768');
      expect(numberInput('wireframe-page-height').value).toBe('1024');
    });

    await clickPreset('phone');
    expect(page()).toEqual({ preset: 'phone', width: 390, height: 844 });
    expect(presetChecked('phone')).toBe(true);
  });

  it('editing a dimension yields Custom (none selected) with the derived caption', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframePropertyPanel />);

    const width = numberInput('wireframe-page-width');
    await user.clear(width);
    await user.type(width, '640');
    await user.keyboard('{Enter}');

    expect(page()).toEqual({ preset: 'custom', width: 640, height: 800 });

    const height = numberInput('wireframe-page-height');
    await user.clear(height);
    await user.type(height, '480');
    await user.keyboard('{Enter}');

    expect(page()).toEqual({ preset: 'custom', width: 640, height: 480 });

    expect(presetChecked('desktop')).toBe(false);
    expect(presetChecked('tablet')).toBe(false);
    expect(presetChecked('phone')).toBe(false);
    expect(screen.getByTestId('wireframe-page-size-custom')).toHaveTextContent('Custom');
  });

  it('clamps typed dimensions to the declared 64..4096 range', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframePropertyPanel />);

    const width = numberInput('wireframe-page-width');
    await user.clear(width);
    await user.type(width, '10');
    await user.keyboard('{Enter}');
    expect(page().width).toBe(64);

    const height = numberInput('wireframe-page-height');
    await user.clear(height);
    await user.type(height, '99999');
    await user.keyboard('{Enter}');
    expect(page().height).toBe(4096);
    expect(page()).toMatchObject({ preset: 'custom' });
  });

  it('the page sliders expose the full clamp without typing', async () => {
    renderWithChakra(<WireframePropertyPanel />);

    await pressSliderKey('Page width slider', 'Home');
    expect(page().width).toBe(64);

    await pressSliderKey('Page width slider', 'End');
    expect(page().width).toBe(4096);

    await pressSliderKey('Page height slider', 'Home');
    expect(page().height).toBe(64);
  });

  it('selecting a preset after Custom restores the preset selection', async () => {
    const user = userEvent.setup();
    renderWithChakra(<WireframePropertyPanel />);

    await clickPreset('tablet');
    const width = numberInput('wireframe-page-width');
    await user.clear(width);
    await user.type(width, '700');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('wireframe-page-size-custom')).toBeInTheDocument();

    await clickPreset('desktop');
    expect(page()).toEqual({ preset: 'desktop', width: 1280, height: 800 });
    expect(screen.queryByTestId('wireframe-page-size-custom')).toBeNull();
    expect(presetChecked('desktop')).toBe(true);
  });
});
