/**
 * Spec #2946 ST-3 — the single polite announcement channel (R-3.2).
 *
 * There is exactly ONE `aria-live` region for hotkey announcements. The visual
 * keycaps are `aria-hidden`; only this channel speaks. `announce` is imperative
 * so the engine / passthrough detection can emit without a hook.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { Keycap } from '@/shared/components/hotkeys/Keycap';
import {
  HOTKEY_ANNOUNCER_LABEL,
  HotkeyAnnouncer,
  announce,
  getAnnouncement,
  resetHotkeyAnnouncer,
  subscribeAnnouncer,
  useHotkeyAnnouncer,
} from '../announcer';

beforeEach(() => {
  resetHotkeyAnnouncer();
});

afterEach(() => {
  resetHotkeyAnnouncer();
  cleanup();
});

describe('HotkeyAnnouncer — the one live region', () => {
  it('is a polite status region with the fixed help accessible name', () => {
    const { getByTestId } = renderWithChakra(<HotkeyAnnouncer />);

    const region = getByTestId('hotkeys-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-label', HOTKEY_ANNOUNCER_LABEL);
    expect(region).toHaveTextContent('');
  });

  it('announce() drives the region imperatively', () => {
    const { getByTestId } = renderWithChakra(<HotkeyAnnouncer />);
    const region = getByTestId('hotkeys-announcer');

    act(() => announce('Hotkey cheat sheet. 12 bindings.'));
    expect(region).toHaveTextContent('Hotkey cheat sheet. 12 bindings.');

    act(() => announce('Terminal passthrough active. Press Ctrl plus Shift plus F 10 to release.'));
    expect(region).toHaveTextContent('Terminal passthrough active.');
    expect(region).not.toHaveTextContent('Hotkey cheat sheet');
  });

  it('resetHotkeyAnnouncer() clears the channel (test hygiene)', () => {
    const { getByTestId } = renderWithChakra(<HotkeyAnnouncer />);
    act(() => announce('Recording keystrokes.'));
    expect(getByTestId('hotkeys-announcer')).toHaveTextContent('Recording keystrokes.');

    act(() => resetHotkeyAnnouncer());
    expect(getByTestId('hotkeys-announcer')).toHaveTextContent('');
    expect(getAnnouncement()).toBe('');
  });
});

describe('announce — module-scoped store contract', () => {
  it('notifies subscribers and exposes the current announcement', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeAnnouncer(() => seen.push(getAnnouncement()));

    announce('G then G');
    announce('Leader then G');

    expect(seen).toEqual(['G then G', 'Leader then G']);
    expect(getAnnouncement()).toBe('Leader then G');

    unsubscribe();
    announce('after unsubscribe');
    expect(seen).toEqual(['G then G', 'Leader then G']);
  });

  it('is idempotent for the identical consecutive text', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeAnnouncer(() => seen.push(getAnnouncement()));

    announce('same');
    announce('same');

    expect(seen).toEqual(['same']);
    unsubscribe();
  });
});

describe('the announcer is the ONLY live region for hotkey surfaces', () => {
  it('keycaps + announcer yield exactly one aria-live node', () => {
    const { container } = renderWithChakra(
      <>
        <Keycap sequence="@leader g" platform="win32" />
        <HotkeyAnnouncer />
      </>,
    );

    const liveRegions = container.querySelectorAll('[aria-live]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute('data-testid', 'hotkeys-announcer');
  });

  it('the subscribe hook resolves to the shared channel text', () => {
    function Probe() {
      const text = useHotkeyAnnouncer();
      return <span data-testid="probe">{text}</span>;
    }

    const { getByTestId } = renderWithChakra(<Probe />);
    act(() => announce('Sequence cancelled.'));
    expect(getByTestId('probe')).toHaveTextContent('Sequence cancelled.');
  });
});
