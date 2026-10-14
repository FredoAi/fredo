/**
 * Spec #3052 ST-3 — the consolidated top-right LED wired to the AGGREGATE
 * `FredoHealth` (not the telemetry stream alone).
 *
 * This pin covers the ST-3 acceptance clauses:
 *   (a) the tooltip renders exactly ONE overall line + the four subsystem lines
 *       in the fixed order `telemetry → llamaServer → companionModel → postgres`,
 *       each with its `data-testid` + `data-health-state`;
 *   (b) each line shows its state TEXT (never colour alone);
 *   (c) the trigger's composed `aria-label` carries the overall + all four
 *       subsystem state words;
 *   (d) the trigger keeps `role="status"` / `aria-live="polite"` /
 *       `aria-atomic="true"` / `tabIndex={0}`.
 *
 * The fixtures are built through ST-1's REAL `deriveSubsystemLines` +
 * `aggregateFredoHealth` so this test also proves the ST-3 wiring consumes the
 * shared contract (worst-wins, neutral `notSetUp`, mandatory escalation) rather
 * than re-deriving it in the component.
 *
 * The tooltip content is opened the way a user does — a pointer-over on the
 * focusable trigger (Ark opens on `pointer.move` after `openDelay`); the content
 * is portalled, so `screen` queries resolve it in `document.body`.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  aggregateFredoHealth,
  deriveSubsystemLines,
  type FredoHealth,
  type FredoHealthSnapshots,
} from '@/shared/hooks/fredoHealth';
import { LauncherChrome } from '../LauncherChrome';

/** The frozen tooltip order (ST-1 emits this; ST-3 must render it unchanged). */
const FIXED_ORDER = [
  'health-line-telemetry',
  'health-line-llamaServer',
  'health-line-companionModel',
  'health-line-postgres',
] as const;

/** Build a `FredoHealth` through the real ST-1 derivation. */
function healthFrom(snapshots: FredoHealthSnapshots): FredoHealth {
  const subsystems = deriveSubsystemLines(snapshots);
  return { overall: aggregateFredoHealth(subsystems), subsystems };
}

const ALL_HEALTHY: FredoHealthSnapshots = {
  telemetryConnected: true,
  companion: { llamaServerInstalled: true, modelFilesComplete: true },
  llamaServer: { running: true, healthy: true },
  postgres: { state: 'ready' },
};

function renderLed(health: FredoHealth): void {
  renderWithChakra(<LauncherChrome entryCount={3} health={health} />);
}

/** Open the tooltip the way a user does (pointer-over on the trigger). */
async function triggerLed(): Promise<HTMLElement> {
  const trigger = screen.getByTestId('desktop-status-led');
  fireEvent.pointerOver(trigger);
  await waitFor(() =>
    expect(screen.getByTestId('desktop-status-led-tooltip')).toBeInTheDocument(),
  );
  return trigger;
}

beforeEach(() => {
  // jsdom lacks ResizeObserver; the Chakra tooltip's popper (floating-ui
  // `autoUpdate`) observes the trigger on open and would throw in a rAF tick.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Spec #3052 ST-3 — consolidated LED reads the aggregate health', () => {
  it('renders exactly one overall line + the four subsystem lines in the fixed order', async () => {
    renderLed(healthFrom(ALL_HEALTHY));
    await triggerLed();

    const tooltip = screen.getByTestId('desktop-status-led-tooltip');

    // Exactly ONE overall line.
    expect(
      tooltip.querySelectorAll('[data-testid="desktop-status-led-overall"]'),
    ).toHaveLength(1);

    // The four subsystem lines, in the frozen DOM order, exactly once each.
    const lines = Array.from(
      tooltip.querySelectorAll<HTMLElement>('[data-testid^="health-line-"]'),
    );
    expect(lines.map((line) => line.getAttribute('data-testid'))).toEqual([...FIXED_ORDER]);

    // Every line carries a `data-health-state` (the colour-independent hook).
    for (const line of lines) {
      expect(line.getAttribute('data-health-state')).toBe('healthy');
    }

    // The overall line precedes every subsystem line in the DOM.
    const overall = screen.getByTestId('desktop-status-led-overall');
    expect(overall.getAttribute('data-health-state')).toBe('healthy');
    expect(overall.compareDocumentPosition(lines[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // (b) Each line renders its state word, and its label + detail as text.
    expect(lines[0]).toHaveTextContent('Agent telemetry');
    expect(lines[0]).toHaveTextContent('Healthy');
    expect(lines[0]).toHaveTextContent('Streaming');
    expect(lines[3]).toHaveTextContent('Postgres');
    expect(lines[3]).toHaveTextContent('Ready');
  });

  it('exposes the overall state as the trigger data-attr and a composed aria-label (all healthy)', async () => {
    renderLed(healthFrom(ALL_HEALTHY));
    const trigger = await triggerLed();

    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Healthy — Agent telemetry: Healthy; Llama server: Healthy; Companion model: Healthy; Postgres: Healthy',
    );
  });

  it('renders the neutral "Not set up" companion lines without degrading the overall', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        companion: { llamaServerInstalled: false, modelFilesComplete: false },
      }),
    );
    const trigger = await triggerLed();

    expect(screen.getByTestId('health-line-llamaServer')).toHaveAttribute(
      'data-health-state',
      'notSetUp',
    );
    expect(screen.getByTestId('health-line-companionModel')).toHaveAttribute(
      'data-health-state',
      'notSetUp',
    );
    expect(screen.getByTestId('health-line-llamaServer')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('health-line-companionModel')).toHaveTextContent('Not set up');

    // The neutral companion does not degrade: both mandatory subsystems are healthy.
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'healthy',
    );
    expect(trigger.getAttribute('aria-label')).toContain('Not set up');
  });

  it('a mandatory Postgres failure colours the overall `down` (never healthy)', async () => {
    renderLed(healthFrom({ ...ALL_HEALTHY, postgres: { state: 'failed' } }));
    const trigger = await triggerLed();

    // (c) The overall dot's state is `down` (the colour-independent data-attr).
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'down',
    );
    expect(screen.getByTestId('health-line-postgres')).toHaveAttribute('data-health-state', 'down');
    expect(screen.getByTestId('health-line-telemetry')).toHaveAttribute(
      'data-health-state',
      'healthy',
    );

    expect(screen.getByTestId('desktop-status-led-overall')).toHaveTextContent('Down');
    expect(screen.getByTestId('health-line-postgres')).toHaveTextContent('Not available');

    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Down — Agent telemetry: Healthy; Llama server: Healthy; Companion model: Healthy; Postgres: Down',
    );
  });

  it('an installed-but-down companion degrades the overall to `degraded`', async () => {
    renderLed(
      healthFrom({ ...ALL_HEALTHY, llamaServer: { running: false, healthy: false } }),
    );
    const trigger = await triggerLed();

    // (c) The overall dot's state is `degraded` (optional subsystem down).
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'degraded',
    );
    expect(screen.getByTestId('health-line-llamaServer')).toHaveAttribute(
      'data-health-state',
      'down',
    );
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveTextContent('Degraded');

    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Degraded — Agent telemetry: Healthy; Llama server: Down; Companion model: Healthy; Postgres: Healthy',
    );
  });

  it('keeps the trigger accessible (role/live/atomic/focusable) and uses the existing testid', async () => {
    renderLed(healthFrom(ALL_HEALTHY));
    const trigger = screen.getByTestId('desktop-status-led');

    expect(trigger).toHaveAttribute('role', 'status');
    expect(trigger).toHaveAttribute('aria-live', 'polite');
    expect(trigger).toHaveAttribute('aria-atomic', 'true');
    expect(trigger).toHaveAttribute('tabindex', '0');
  });
});
