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
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChakraProvider, createSystem, defaultBaseConfig } from '@chakra-ui/react';

import { NumberSliderField } from '../components/fields/NumberSliderField';

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
