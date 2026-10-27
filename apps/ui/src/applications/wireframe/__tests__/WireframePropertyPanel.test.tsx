/**
 * Wireframe property panel — contextual variants, immediate dispatch, numeric
 * alternatives, radius slider↔enum parity, hidden/locked selection behaviour
 * (Spec #3070, ST-4, R-3.1…R-3.6 / R-4.6).
 *
 * Arc/Zag machines deliver their state-change callbacks in a microtask, so every
 * machine-driven interaction is awaited inside `act` before the store is read.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframePropertyPanel } from '../components/WireframePropertyPanel';
import {
  createDefaultElement,
  type WireframeElement,
  type WireframeElementType,
} from '../model/elements';
import {
  dispatch,
  getSnapshot,
  resetWireframeStoreForTests,
  select,
  selectMany,
} from '../store/wireframeDocumentStore';

let counter = 0;

function addElement(type: WireframeElementType): WireframeElement {
  counter += 1;
  const snapshot = getSnapshot();
  const element = createDefaultElement(type, {
    page: snapshot.document.page,
    elements: snapshot.document.elements,
    id: `panel-element-${counter}`,
  });
  act(() => {
    dispatch('element.add', { element });
  });
  return element;
}

function elementFromStore(id: string): WireframeElement {
  const found = getSnapshot().document.elements.find((element) => element.id === id);
  if (!found) throw new Error(`element ${id} missing`);
  return found;
}

function renderPanel() {
  return renderWithChakra(<WireframePropertyPanel />);
}

/** Let Arc/Zag deliver its microtask state callback and React re-render. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function segmentInput(testId: string): HTMLInputElement {
  const item = screen.getByTestId(testId);
  const input =
    item.tagName === 'INPUT'
      ? (item as HTMLInputElement)
      : (item.querySelector('input') as HTMLInputElement | null);
  if (!input) throw new Error(`segment ${testId} has no radio input`);
  return input;
}

/** Activate a segment through its hidden radio's native click. */
async function clickSegment(testId: string): Promise<void> {
  const input = segmentInput(testId);
  await act(async () => {
    input.click();
    await Promise.resolve();
  });
}

function segmentChecked(testId: string): boolean {
  return segmentInput(testId).checked;
}

/** Click one of our own token-styled buttons (swatch, align toggle). */
async function clickControl(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
    await Promise.resolve();
  });
}

/** Toggle a Chakra switch through its hidden checkbox's native click. */
async function toggleSwitch(testId: string): Promise<void> {
  const input = within(screen.getByTestId(testId)).getByRole('checkbox') as HTMLInputElement;
  await act(async () => {
    input.click();
    await Promise.resolve();
  });
}

/**
 * Slider thumbs are `visibility:hidden` until the machine measures a thumb size
 * (jsdom never does), so Testing Library's accessible-role query skips them.
 * Query the DOM role directly — the control, its key handling and its
 * aria-value* attributes are all real. Keyboard steps only run in the machine's
 * focus state, so focus the thumb first (the real interaction is Tab + arrows).
 */
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

function numberInput(testId: string): HTMLInputElement {
  const root = screen.getByTestId(`${testId}-number`);
  const input = root.querySelector('input');
  if (!input) throw new Error(`number input ${testId} missing`);
  return input as HTMLInputElement;
}

beforeEach(() => {
  counter = 0;
  resetWireframeStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe('selection header and panel variants', () => {
  it('shows the page variant with the derived header and page controls', () => {
    renderPanel();

    expect(screen.getByTestId('wireframe-property-panel')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Page');
    expect(screen.getByTestId('wireframe-panel-caption')).toHaveTextContent(
      'No selection — editing page settings',
    );
    expect(screen.getByTestId('wireframe-page-controls')).toBeInTheDocument();
    expect(screen.queryByTestId('wireframe-element-width')).toBeNull();
    expect(segmentChecked('wireframe-page-preset-desktop')).toBe(true);
  });

  it('shows only text fields for a text element and swaps the header to Heading', async () => {
    const element = addElement('text');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Text');
    expect(screen.queryByTestId('wireframe-panel-caption')).toBeNull();
    expect(screen.getByTestId('wireframe-text-content')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-text-style-body')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-text-size-m')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-align-left')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('wireframe-appearance-primary')).toBeNull();
    expect(screen.queryByTestId('wireframe-fill-swatches')).toBeNull();
    expect(screen.getByTestId('wireframe-element-width')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-element-height')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-visible-switch')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-lock-switch')).toBeInTheDocument();

    expect(elementFromStore(element.id)).toMatchObject({ textStyle: 'body' });
    await clickSegment('wireframe-text-style-heading');
    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Heading');
  });

  it('shows label + appearance for a button and nothing text-specific', () => {
    addElement('button');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Button');
    expect(screen.getByTestId('wireframe-button-label')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-appearance-primary')).toBeInTheDocument();
    expect(screen.queryByTestId('wireframe-text-content')).toBeNull();
    expect(screen.queryByTestId('wireframe-fill-swatches')).toBeNull();
  });

  it('shows the placeholder field for an input element', () => {
    addElement('input');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Input');
    expect(screen.getByTestId('wireframe-input-placeholder')).toBeInTheDocument();
  });

  it('shows the preset row for a section and names the variant in the header', () => {
    addElement('section');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Header');
    expect(screen.getByTestId('wireframe-section-preset-navbar')).toBeInTheDocument();
    expect(screen.queryByTestId('wireframe-text-content')).toBeNull();
  });

  it('shows kind, fill, border and radius for a shape', () => {
    addElement('shape');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Rectangle');
    expect(screen.getByTestId('wireframe-shape-kind-ellipse')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-fill-swatches')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-fill-accent')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-border-thick')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-corner-radius')).toBeInTheDocument();
    expect(slider('Corner radius')).toBeInTheDocument();
  });

  it('hides the corner radius control for non-rectangle shapes', async () => {
    addElement('shape');
    renderPanel();

    await clickSegment('wireframe-shape-kind-ellipse');
    expect(screen.queryByTestId('wireframe-corner-radius')).toBeNull();
    expect(screen.queryByTestId('wireframe-radius-none')).toBeNull();
    expect(
      document.querySelector('[role="slider"][aria-label="Corner radius"]'),
    ).toBeNull();
  });

  it('shows the curated icon picker for an icon element', () => {
    addElement('icon');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Icon');
    expect(screen.getByTestId('wireframe-icon-picker')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-icon-star')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('wireframe-icon-user')).toBeInTheDocument();
  });

  it('shows only the common block for an image element', () => {
    addElement('image');
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Image');
    expect(screen.queryByTestId('wireframe-text-content')).toBeNull();
    expect(screen.queryByTestId('wireframe-appearance-primary')).toBeNull();
    expect(screen.queryByTestId('wireframe-fill-swatches')).toBeNull();
    expect(screen.getByTestId('wireframe-element-width')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-visible-switch')).toBeInTheDocument();
  });
});

describe('every control dispatches immediately', () => {
  it('writes text content, style, size and alignment on the same interaction', async () => {
    const element = addElement('text');
    renderPanel();

    fireEvent.change(screen.getByTestId('wireframe-text-content'), {
      target: { value: 'Hero headline' },
    });
    expect(elementFromStore(element.id)).toMatchObject({ text: 'Hero headline' });

    await clickSegment('wireframe-text-style-heading');
    expect(elementFromStore(element.id)).toMatchObject({ textStyle: 'heading' });

    await clickSegment('wireframe-text-size-xl');
    expect(elementFromStore(element.id)).toMatchObject({ size: 'xl' });

    await clickControl('wireframe-align-right');
    expect(elementFromStore(element.id)).toMatchObject({ align: 'right' });
    expect(screen.getByTestId('wireframe-align-right')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('wireframe-align-left')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('writes button label + appearance', async () => {
    const element = addElement('button');
    renderPanel();

    fireEvent.change(screen.getByTestId('wireframe-button-label'), {
      target: { value: 'Continue' },
    });
    expect(elementFromStore(element.id)).toMatchObject({ label: 'Continue' });

    await clickSegment('wireframe-appearance-ghost');
    expect(elementFromStore(element.id)).toMatchObject({ appearance: 'ghost' });
  });

  it('writes the input placeholder and card label', () => {
    const inputElement = addElement('input');
    renderPanel();
    fireEvent.change(screen.getByTestId('wireframe-input-placeholder'), {
      target: { value: 'Email address' },
    });
    expect(elementFromStore(inputElement.id)).toMatchObject({ placeholder: 'Email address' });

    cleanup();
    resetWireframeStoreForTests();
    const cardElement = addElement('card');
    renderPanel();
    fireEvent.change(screen.getByTestId('wireframe-card-label'), {
      target: { value: 'Reports' },
    });
    expect(elementFromStore(cardElement.id)).toMatchObject({ label: 'Reports' });
  });

  it('writes the section preset', async () => {
    const element = addElement('section');
    renderPanel();

    await clickSegment('wireframe-section-preset-footer');
    expect(elementFromStore(element.id)).toMatchObject({ preset: 'footer' });
    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Footer');
  });

  it('writes shape kind, fill, border and radius chips', async () => {
    const element = addElement('shape');
    renderPanel();

    await clickControl('wireframe-fill-accent');
    expect(elementFromStore(element.id)).toMatchObject({ fill: 'accent' });
    expect(screen.getByTestId('wireframe-fill-accent')).toHaveAttribute('aria-pressed', 'true');

    await clickSegment('wireframe-border-thick');
    expect(elementFromStore(element.id)).toMatchObject({ border: 'thick' });

    // Radius applies to rect only — set it before switching the kind.
    await clickSegment('wireframe-radius-l');
    expect(elementFromStore(element.id)).toMatchObject({ radius: 'l' });

    await clickSegment('wireframe-shape-kind-triangle');
    expect(elementFromStore(element.id)).toMatchObject({ shape: 'triangle' });
  });

  it('writes the selected icon', async () => {
    const element = addElement('icon');
    renderPanel();

    await clickControl('wireframe-icon-chart');
    expect(elementFromStore(element.id)).toMatchObject({ iconId: 'chart' });
    expect(screen.getByTestId('wireframe-icon-chart')).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes width and height from the sliders', async () => {
    const element = addElement('card');
    renderPanel();

    const before = elementFromStore(element.id);
    await pressSliderKey('Width slider', 'ArrowRight');
    expect(elementFromStore(element.id)).toMatchObject({ width: before.width + 1 });

    await pressSliderKey('Height slider', 'ArrowRight');
    expect(elementFromStore(element.id)).toMatchObject({ height: before.height + 1 });
  });

  it('writes width from the NumberInput stepper (immediate, no submit)', async () => {
    const user = userEvent.setup();
    const element = addElement('card');
    renderPanel();

    const before = elementFromStore(element.id);
    const root = screen.getByTestId('wireframe-element-width-number');
    await user.click(within(root).getByRole('button', { name: /increment/i }));

    expect(elementFromStore(element.id)).toMatchObject({ width: before.width + 1 });
  });

  it('writes the typed width on Enter through the number field', async () => {
    const user = userEvent.setup();
    const element = addElement('card');
    renderPanel();

    const field = numberInput('wireframe-element-width');
    await user.clear(field);
    await user.type(field, '200');
    await user.keyboard('{Enter}');

    expect(elementFromStore(element.id)).toMatchObject({ width: 200 });
  });

  it('toggles visibility without clearing the selection', async () => {
    const element = addElement('text');
    renderPanel();

    await toggleSwitch('wireframe-visible-switch');

    expect(elementFromStore(element.id)).toMatchObject({ visible: false });
    expect(getSnapshot().selectedId).toBe(element.id);
    expect(screen.getByTestId('wireframe-tag-hidden')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-text-content')).toBeInTheDocument();

    await toggleSwitch('wireframe-visible-switch');
    expect(elementFromStore(element.id)).toMatchObject({ visible: true });
    expect(screen.queryByTestId('wireframe-tag-hidden')).toBeNull();
  });

  it('locks but keeps property edits available (only drag/resize are blocked)', async () => {
    const element = addElement('text');
    renderPanel();

    await toggleSwitch('wireframe-lock-switch');

    expect(elementFromStore(element.id)).toMatchObject({ locked: true });
    expect(screen.getByTestId('wireframe-tag-locked')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-lock-caption')).toHaveTextContent(
      'Locked — drag and resize are disabled',
    );

    // Property edits stay live while locked (R-2.5 names drag/handle gestures only).
    await clickControl('wireframe-align-center');
    expect(elementFromStore(element.id)).toMatchObject({ align: 'center' });
  });
});

describe('multi-selection and group headers (Spec #3071, ST-6 — UI/UX 2.2)', () => {
  it('shows the multi-selection header and no field sections for 2+ ungrouped elements', () => {
    const first = addElement('text');
    const second = addElement('button');
    act(() => {
      selectMany([first.id, second.id]);
    });
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('2 elements selected');
    expect(screen.getByTestId('wireframe-panel-caption')).toHaveTextContent(
      'Arrange, align or group them from the toolbar',
    );
    expect(screen.queryByTestId('wireframe-tag-group')).toBeNull();
    expect(screen.queryByTestId('wireframe-page-controls')).toBeNull();
    expect(screen.queryByTestId('wireframe-element-width')).toBeNull();
    expect(screen.queryByTestId('wireframe-text-content')).toBeNull();
    expect(screen.queryByTestId('wireframe-button-label')).toBeNull();
  });

  it('shows the Group header + tag and no field sections while the selection is a group', () => {
    const first = addElement('text');
    const second = addElement('button');
    act(() => {
      dispatch('group.create', { ids: [first.id, second.id] });
    });
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Group');
    expect(screen.getByTestId('wireframe-tag-group')).toHaveTextContent('Group · 2');
    expect(screen.getByTestId('wireframe-panel-caption')).toHaveTextContent(
      'Drag or resize to move every unlocked member',
    );
    expect(screen.queryByTestId('wireframe-tag-locked')).toBeNull();
    expect(screen.queryByTestId('wireframe-page-controls')).toBeNull();
    expect(screen.queryByTestId('wireframe-element-width')).toBeNull();
    expect(screen.queryByTestId('wireframe-text-content')).toBeNull();
  });

  it('adds the locked tag and locked caption while the group is locked', () => {
    const first = addElement('text');
    const second = addElement('button');
    act(() => {
      dispatch('group.create', { ids: [first.id, second.id] });
    });
    const groupId = getSnapshot().document.groups[0].id;
    act(() => {
      dispatch('group.toggleLock', { groupIds: [groupId] });
    });
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Group');
    expect(screen.getByTestId('wireframe-tag-group')).toHaveTextContent('Group · 2');
    expect(screen.getByTestId('wireframe-tag-locked')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-panel-caption')).toHaveTextContent(
      'Group locked — drag and resize are disabled',
    );
    expect(screen.queryByTestId('wireframe-element-width')).toBeNull();
  });

  it('keeps the single-element header for one selected member of a group', () => {
    const first = addElement('text');
    const second = addElement('button');
    act(() => {
      dispatch('group.create', { ids: [first.id, second.id] });
    });
    act(() => {
      select(second.id);
    });
    renderPanel();

    expect(screen.getByTestId('wireframe-panel-title')).toHaveTextContent('Button');
    expect(screen.queryByTestId('wireframe-tag-group')).toBeNull();
    expect(screen.queryByTestId('wireframe-panel-caption')).toBeNull();
    expect(screen.getByTestId('wireframe-element-width')).toBeInTheDocument();
  });
});

describe('corner radius: chips and the 4-stop slider write the same enum', () => {
  it('slider stops map 0..3 onto none|s|m|l', async () => {
    const element = addElement('shape');
    renderPanel();

    expect(elementFromStore(element.id)).toMatchObject({ radius: 'm' });
    const radiusSlider = slider('Corner radius');
    expect(radiusSlider).toHaveAttribute('aria-valuemin', '0');
    expect(radiusSlider).toHaveAttribute('aria-valuemax', '3');
    expect(radiusSlider).toHaveAttribute('aria-valuenow', '2');

    await pressSliderKey('Corner radius', 'ArrowLeft');
    expect(elementFromStore(element.id)).toMatchObject({ radius: 's' });

    await pressSliderKey('Corner radius', 'Home');
    expect(elementFromStore(element.id)).toMatchObject({ radius: 'none' });

    await pressSliderKey('Corner radius', 'End');
    expect(elementFromStore(element.id)).toMatchObject({ radius: 'l' });

    // Chips write the SAME enum (no numeric px radius anywhere).
    await clickSegment('wireframe-radius-s');
    expect(elementFromStore(element.id)).toMatchObject({ radius: 's' });
    expect(segmentChecked('wireframe-radius-s')).toBe(true);
  });
});

describe('every numeric property has a non-numeric alternative (R-3.6)', () => {
  it('element width/height and the page dimensions all expose a slider', () => {
    addElement('shape');
    renderPanel();

    expect(slider('Width slider')).toBeInTheDocument();
    expect(slider('Height slider')).toBeInTheDocument();
    expect(slider('Corner radius')).toBeInTheDocument();

    // Steppers are real buttons (one decrement + one increment per numeric field).
    for (const testId of [
      'wireframe-element-width-number',
      'wireframe-element-height-number',
    ]) {
      const root = screen.getByTestId(testId);
      expect(within(root).getAllByRole('button')).toHaveLength(2);
    }

    cleanup();
    resetWireframeStoreForTests();
    renderPanel();
    expect(slider('Page width slider')).toBeInTheDocument();
    expect(slider('Page height slider')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('wireframe-page-width-number')).getAllByRole('button'),
    ).toHaveLength(2);
    expect(
      within(screen.getByTestId('wireframe-page-height-number')).getAllByRole('button'),
    ).toHaveLength(2);
  });
});
