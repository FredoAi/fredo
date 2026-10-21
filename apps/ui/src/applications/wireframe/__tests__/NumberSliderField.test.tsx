/**
 * Numeric stepper commit (Spec #3070, round 3, ST-4b / E-15).
 *
 * Zag's NumberInput steps on POINTERDOWN and only commits on blur/Enter. The
 * field's stepper handler therefore has to persist the value the machine has
 * already stepped to — read from the ref written in `onValueChange`, never from
 * the `draft` state captured by the render that produced the handler.
 *
 * The pin reproduces the failure window precisely: it captures the control's
 * click handler BEFORE the press (the render the user's click would run in the
 * live defect), performs the real pointer press so the machine steps, and then
 * invokes that pre-step handler. `commit(draft)` commits the old value; the
 * ref-based handler commits the stepped one.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChakraProvider, createSystem, defaultBaseConfig } from '@chakra-ui/react';

import { NumberSliderField } from '../components/fields/NumberSliderField';
import { createNewWireframeDocument } from '../model/document';
import { createDefaultElement } from '../model/elements';
import {
  dispatch,
  getSnapshot,
  loadDocument,
  resetWireframeStoreForTests,
  undo,
} from '../store/wireframeDocumentStore';

beforeAll(() => {
  // jsdom 24 ships no `PointerEvent`; without one the pointer sequence degrades
  // to plain events and Zag's `button === 0` guard refuses the press.
  if (typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    (window as unknown as { PointerEvent?: unknown }).PointerEvent = window.MouseEvent;
  }
});

const testSystem = createSystem({
  ...defaultBaseConfig,
  disableLayers: true,
  preflight: false,
  globalCss: {},
});

function renderField(value: number, step?: number): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(
    <ChakraProvider value={testSystem}>
      <NumberSliderField
        label="Width"
        value={value}
        min={0}
        max={4000}
        step={step}
        testId="wireframe-width"
        onChange={onChange}
      />
    </ChakraProvider>,
  );
  return onChange;
}

function trigger(kind: 'increment' | 'decrement'): HTMLElement {
  const byPart = document.querySelector<HTMLElement>(`[data-part="${kind}-trigger"]`);
  if (byPart) return byPart;
  const namePattern =
    kind === 'increment' ? /increase|increment|up/i : /decrease|decrement|down/i;
  return screen.getByRole('button', { name: namePattern });
}

function spinbutton(): HTMLElement {
  return screen.getByRole('spinbutton');
}

/** The click handler the CURRENT (pre-step) render installed on the control. */
function capturedClickHandler(button: HTMLElement): () => void {
  const control = button.closest('[data-part="control"]');
  if (!control) throw new Error('number-input control missing');
  const propsKey = Object.keys(control).find((key) => key.indexOf('__reactProps') === 0);
  const props = propsKey
    ? (control as unknown as Record<string, { onClick?: () => void }>)[propsKey]
    : null;
  if (!props || typeof props.onClick !== 'function') {
    throw new Error('control click handler missing');
  }
  return props.onClick;
}

/** Press the trigger for real (Zag steps on pointerdown) without clicking it. */
async function pressTrigger(button: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.pointer({ keys: '[MouseLeft>]', target: button });
}

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
});

describe('NumberSliderField stepper', () => {
  it('commits the incremented value', async () => {
    const onChange = renderField(100);
    const button = trigger('increment');
    const staleClick = capturedClickHandler(button);

    await pressTrigger(button);
    // The machine holds the stepped value; the click handler below is still the
    // one the pre-step render produced — the live E-15 window.
    expect(spinbutton()).toHaveAttribute('aria-valuenow', '101');

    staleClick();

    expect(onChange).toHaveBeenCalledWith(101);
  });

  it('commits the decremented value', async () => {
    const onChange = renderField(100);
    const button = trigger('decrement');
    const staleClick = capturedClickHandler(button);

    await pressTrigger(button);
    expect(spinbutton()).toHaveAttribute('aria-valuenow', '99');

    staleClick();

    expect(onChange).toHaveBeenCalledWith(99);
  });

  it('commits the value stepped by a non-unit step', async () => {
    const onChange = renderField(100, 5);
    const button = trigger('increment');
    const staleClick = capturedClickHandler(button);

    await pressTrigger(button);
    expect(spinbutton()).toHaveAttribute('aria-valuenow', '105');

    staleClick();

    expect(onChange).toHaveBeenCalledWith(105);
  });
});

describe('stepper history granularity (E-15)', () => {
  /**
   * Store-bound consumer: the field commits into the REAL document store, so the
   * pin sees the history, not just the callback value. A realistic click
   * (pointerdown -> pointerup -> click) steps and commits; the number field the
   * click focused is then blurred, which makes Zag re-commit the value the store
   * already holds. The store's value-equal no-op must keep that re-commit out of
   * the undo history.
   */
  function renderStoreBoundField(): { startWidth: number; commits: number[] } {
    resetWireframeStoreForTests();
    const base = createNewWireframeDocument('desktop');
    const element = createDefaultElement('card', {
      page: base.page,
      elements: [],
      id: 'el-card',
    });
    loadDocument({ ...base, elements: [element] }, 'C:/tmp/doc.wireframe.json');

    const commits: number[] = [];
    render(
      <ChakraProvider value={testSystem}>
        <NumberSliderField
          label="Width"
          value={element.width}
          min={64}
          max={4096}
          testId="wireframe-width"
          onChange={(next) => {
            commits.push(next);
            dispatch('element.update', { id: element.id, patch: { width: next } });
          }}
        />
      </ChakraProvider>,
    );
    return { startWidth: element.width, commits };
  }

  function documentWidth(): number {
    return getSnapshot().document.elements[0].width;
  }

  it('one stepper click + its blur re-commit costs exactly one undo entry', async () => {
    const { startWidth, commits } = renderStoreBoundField();
    const button = trigger('increment');
    const user = userEvent.setup();

    // pointerdown (Zag steps) -> pointerup -> click (commit of the stepped value).
    await user.pointer({ keys: '[MouseLeft]', target: button });
    // The click focused the number input; leaving it is Zag's blur commit. (jsdom's
    // pointer press does not land the focus itself, so the focus/blur pair is driven
    // explicitly — the same machine path the live interaction takes. Zag defers the
    // commit for a frame, so the blur is awaited.)
    act(() => {
      spinbutton().focus();
    });
    await act(async () => {
      spinbutton().blur();
      await new Promise((resolve) => setTimeout(resolve, 32));
    });

    // The defect window is real: the SAME value is committed twice — once by the
    // click and once by the blur's onValueCommit.
    expect(commits).toEqual([startWidth + 1, startWidth + 1]);
    expect(documentWidth()).toBe(startWidth + 1);

    // Exactly ONE history entry: a single undo returns the pre-click value.
    expect(getSnapshot().canUndo).toBe(true);
    act(() => undo());
    expect(documentWidth()).toBe(startWidth);
    expect(getSnapshot().canUndo).toBe(false);
  });
});
