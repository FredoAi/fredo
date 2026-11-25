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
 *
 * Spec #3180 ST-4 extends this artifact: a `down` row renders its `remedy`
 * (wrapping, never truncated) and its raw `technicalDetail` (mono, single line,
 * native `title`), the composed `aria-label` appends the remedy for down rows
 * only (never the technical detail), a `starting` engine row is neutral, and the
 * presentational de-dupe renders a state phrase once. No new control, testid or
 * tab stop is introduced.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  aggregateFredoHealth,
  deriveSubsystemLines,
  type FredoHealth,
  type FredoHealthSnapshots,
} from '@/shared/hooks/fredoHealth';
import type { IngestFailure } from '@/shared/hooks/streamHealth';
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
  telemetry: 'healthy',
  companion: { modelFilesComplete: true },
  llamaServer: { running: true, healthy: true, starting: false },
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
      'Fredo health: Healthy — Agent telemetry: Healthy; Companion engine: Healthy; Companion model: Healthy; Postgres: Healthy',
    );
  });

  it('renders the neutral "Not set up" companion lines without degrading the overall', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        companion: { modelFilesComplete: false },
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
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        postgres: { state: 'failed', failureKind: 'unknown', error: 'boom' },
      }),
    );
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
    // #3180 — a `failed` row carries its typed cause, not a bare "Not available".
    expect(screen.getByTestId('health-line-postgres')).toHaveTextContent("didn't start");

    // #3180 ST-4 — the composed label appends the down row's remedy.
    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Down — Agent telemetry: Healthy; Companion engine: Healthy; Companion model: Healthy; Postgres: Down — Restart Fredo. If it keeps failing, open Settings → Database.',
    );
  });

  it('an idle (not failed) companion engine is NEUTRAL and never degrades the overall (#3180)', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        llamaServer: { running: false, healthy: false, starting: false },
      }),
    );
    const trigger = await triggerLed();

    // #3180 — idle is `unknown` ("Checking"), never `down`/"Not running".
    expect(screen.getByTestId('health-line-llamaServer')).toHaveAttribute(
      'data-health-state',
      'unknown',
    );
    expect(screen.getByTestId('health-line-llamaServer')).toHaveTextContent('Idle');
    // A neutral engine does NOT degrade the aggregate.
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'healthy',
    );

    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Healthy — Agent telemetry: Healthy; Companion engine: Checking; Companion model: Healthy; Postgres: Healthy',
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

describe('Spec #3064 ST-4 — the telemetry line gains the `degraded` state (text + label)', () => {
  it('a `degraded` telemetry stream renders "Degraded / Telemetry stalled" and raises the overall to `degraded`', async () => {
    renderLed(healthFrom({ ...ALL_HEALTHY, telemetry: 'degraded' }));
    const trigger = await triggerLed();

    const line = screen.getByTestId('health-line-telemetry');
    expect(line).toHaveAttribute('data-health-state', 'degraded');
    // State word + binding detail, both as TEXT (never colour alone).
    expect(line).toHaveTextContent('Degraded');
    expect(line).toHaveTextContent('Telemetry stalled');

    // Telemetry is MANDATORY and non-neutral → the overall is `degraded` (never healthy).
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'degraded',
    );
    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Degraded — Agent telemetry: Degraded; Companion engine: Healthy; Companion model: Healthy; Postgres: Healthy',
    );
  });

  it('a `down` telemetry stream renders "Down / Stream stopped" and folds the overall to `down`', async () => {
    renderLed(healthFrom({ ...ALL_HEALTHY, telemetry: 'down' }));
    const trigger = await triggerLed();

    const line = screen.getByTestId('health-line-telemetry');
    expect(line).toHaveAttribute('data-health-state', 'down');
    expect(line).toHaveTextContent('Down');
    expect(line).toHaveTextContent('Stream stopped');

    // Telemetry is a MANDATORY subsystem → overall `down`.
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'down',
    );
    expect(trigger).toHaveAttribute(
      'aria-label',
      'Fredo health: Down — Agent telemetry: Down; Companion engine: Healthy; Companion model: Healthy; Postgres: Healthy',
    );
  });

  it('the `healthy` telemetry line still reads "Healthy / Streaming"', async () => {
    renderLed(healthFrom(ALL_HEALTHY));
    await triggerLed();

    const line = screen.getByTestId('health-line-telemetry');
    expect(line).toHaveAttribute('data-health-state', 'healthy');
    expect(line).toHaveTextContent('Healthy');
    expect(line).toHaveTextContent('Streaming');
  });
});

describe('Spec #3180 ST-4 — remedy + technical detail rendered in the LED rows', () => {
  /** The binding `dataDirNotEmpty` remedy copy (authored by ST-3). */
  const DATA_DIR_REMEDY =
    "Move or rename the PostgreSQL cluster folder (postgres/cluster in Fredo's app-data folder), then restart Fredo. Nothing is removed.";
  const RAW_PG_ERROR = 'initdb: error: el directorio no esta vacio';

  /** A Postgres `failed` snapshot with the typed non-empty-dir cause. */
  function failedPostgresHealth(): FredoHealth {
    return healthFrom({
      ...ALL_HEALTHY,
      postgres: { state: 'failed', failureKind: 'dataDirNotEmpty', error: RAW_PG_ERROR },
    });
  }

  it('a `down` row renders its remedy (wrapping) and the raw technical detail with a title', async () => {
    renderLed(failedPostgresHealth());
    await triggerLed();

    const row = screen.getByTestId('health-line-postgres');
    expect(row).toHaveAttribute('data-health-state', 'down');
    // The inline scan line still carries the typed cause sentence.
    expect(row).toHaveTextContent('The database folder Fredo uses already contains files.');

    // The remedy is rendered and wraps (never truncated — AC-5).
    const remedy = within(row).getByText((content) =>
      content.includes('Move or rename the PostgreSQL cluster folder'),
    );
    expect(remedy).toHaveTextContent(DATA_DIR_REMEDY);
    expect(getComputedStyle(remedy).whiteSpace).toBe('normal');
    expect(getComputedStyle(remedy).whiteSpace).not.toBe('nowrap');
    expect(getComputedStyle(remedy).overflowWrap).toBe('anywhere');

    // The technical detail is a single ellipsised line whose title is its text.
    const technical = row.querySelector<HTMLElement>('[title]');
    expect(technical).not.toBeNull();
    expect(technical).toHaveAttribute('title', RAW_PG_ERROR);
    expect(technical).toHaveTextContent(RAW_PG_ERROR);
    expect(getComputedStyle(technical as HTMLElement).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(technical as HTMLElement).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(technical as HTMLElement).fontFamily.toLowerCase()).toContain('mono');
  });

  it('a typed engine failure renders "Could not start" + remedy and code · lastError', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        llamaServer: {
          running: false,
          healthy: false,
          starting: false,
          lastErrorCode: 'gpuUnavailable',
          lastError: 'no usable GPU on this machine',
        },
      }),
    );
    await triggerLed();

    const row = screen.getByTestId('health-line-llamaServer');
    expect(row).toHaveAttribute('data-health-state', 'down');
    expect(row).toHaveTextContent('Could not start');
    // The remedy names the surface that owns the action.
    expect(row).toHaveTextContent('Open Settings → Companion.');
    // The raw evidence survives in the technical detail (and its title).
    const technical = row.querySelector<HTMLElement>('[title]');
    expect(technical).toHaveAttribute(
      'title',
      'gpuUnavailable · no usable GPU on this machine',
    );
    expect(row).not.toHaveTextContent('Not running');
  });

  it('a `starting` engine row is neutral — never Down / Not running', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        llamaServer: { running: false, healthy: false, starting: true },
      }),
    );
    await triggerLed();

    const row = screen.getByTestId('health-line-llamaServer');
    expect(row).toHaveAttribute('data-health-state', 'unknown');
    expect(row).toHaveTextContent('Starting');
    expect(row).not.toHaveTextContent('Not running');
    expect(row).not.toHaveTextContent('Down');
    // A neutral in-flight row never degrades the overall.
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'healthy',
    );
  });

  it('the aria-label carries the down remedy but never the technical detail', async () => {
    renderLed(failedPostgresHealth());
    const trigger = await triggerLed();

    const label = trigger.getAttribute('aria-label') ?? '';
    expect(label).toContain(DATA_DIR_REMEDY);
    expect(label).not.toContain(RAW_PG_ERROR);
    // Only the down row gains the clause; healthy rows stay byte-identical.
    expect(label).toContain('Postgres: Down — ');
    expect(label).toContain('Agent telemetry: Healthy; Companion engine: Healthy');
  });

  it('keeps exactly 4 health lines + 1 overall and zero interactive descendants', async () => {
    renderLed(failedPostgresHealth());
    await triggerLed();

    const tooltip = screen.getByTestId('desktop-status-led-tooltip');
    expect(
      tooltip.querySelectorAll('[data-testid="desktop-status-led-overall"]'),
    ).toHaveLength(1);
    expect(tooltip.querySelectorAll('[data-testid^="health-line-"]')).toHaveLength(4);
    // Hover/focus disclosure only — no button/link/tab-stop inside the tooltip.
    expect(tooltip.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('renders a neutral row state phrase exactly once (presentational de-dupe)', async () => {
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        companion: { modelFilesComplete: false },
      }),
    );
    await triggerLed();

    const countPhrase = (row: HTMLElement, phrase: string): number =>
      (row.textContent?.match(new RegExp(phrase, 'g')) ?? []).length;

    // "Not set up" appears as the state word only (detail suppressed).
    expect(countPhrase(screen.getByTestId('health-line-llamaServer'), 'Not set up')).toBe(1);
    expect(countPhrase(screen.getByTestId('health-line-companionModel'), 'Not set up')).toBe(1);

    cleanup();
    // "Checking" likewise collapses for an unresolved probe.
    renderLed(
      healthFrom({
        ...ALL_HEALTHY,
        companion: null,
      }),
    );
    await triggerLed();
    expect(countPhrase(screen.getByTestId('health-line-llamaServer'), 'Checking')).toBe(1);
  });
});

// ── Spec #3194 ST-3 — a `degraded` row carrying raw ingest evidence ──────────
//
// This is a NEW combination for the shipped renderer: a non-`down` row that
// carries BOTH a human `detail` and a raw `technicalDetail`. The component is
// NOT edited — it already renders `technicalDetail` for any line state — so
// these pins prove the existing rendering carries the typed OTLP cause.

describe('#3194 ST-3 — typed OTLP ingest failure on the telemetry row (U-10, U-11)', () => {
  const FAILURE: IngestFailure = {
    receiver: 'grpc',
    port: 4317,
    code: 'addrInUse',
    message: 'bind 127.0.0.1:4317: address already in use',
  };
  const EVIDENCE =
    'otlp:grpc:4317:addrInUse · bind 127.0.0.1:4317: address already in use';

  function degradedHealth(failure: IngestFailure | null): FredoHealth {
    return healthFrom({ ...ALL_HEALTHY, telemetry: 'degraded', telemetryFailure: failure });
  }

  it('U-10: renders the port cause inline + the mono evidence line, with an UNCHANGED aria-label', async () => {
    // Baseline first: a degraded row with NO failure (the shipped `Telemetry stalled`).
    renderLed(degradedHealth(null));
    const baselineLabel = (await triggerLed()).getAttribute('aria-label');
    cleanup();

    renderLed(degradedHealth(FAILURE));
    const trigger = await triggerLed();
    const row = screen.getByTestId('health-line-telemetry');

    expect(row).toHaveAttribute('data-health-state', 'degraded');
    expect(row).toHaveTextContent('Agent telemetry');
    expect(row).toHaveTextContent('Degraded');
    expect(row).toHaveTextContent('Port 4317 is in use');
    // The typed cause REPLACES the generic stall copy (not an addition).
    expect(row).not.toHaveTextContent('Telemetry stalled');

    // The raw evidence line: one node, full text + native title, mono/nowrap/ellipsised.
    const evidenceNodes = row.querySelectorAll<HTMLElement>('[title]');
    expect(evidenceNodes).toHaveLength(1);
    const technical = evidenceNodes[0];
    expect(technical).toHaveAttribute('title', EVIDENCE);
    expect(technical).toHaveTextContent(EVIDENCE);
    expect(getComputedStyle(technical).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(technical).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(technical).fontFamily.toLowerCase()).toContain('mono');

    // The receiver token (`grpc`) rides ONLY the evidence line — never the scan line.
    const scanLine = row.firstElementChild as HTMLElement;
    expect(scanLine).toHaveTextContent('Port 4317 is in use');
    expect(scanLine).not.toHaveTextContent('grpc');

    // No remedy node: the cause is the detail, and the row gains no second sentence.
    expect(row).not.toHaveTextContent('Settings →');
    expect(row).not.toHaveTextContent('restart Fredo');

    // The cause is NOT in the polite live label — byte-identical to the no-failure row.
    expect(baselineLabel).toBe(
      'Fredo health: Degraded — Agent telemetry: Degraded; Companion engine: Healthy; Companion model: Healthy; Postgres: Healthy',
    );
    expect(trigger.getAttribute('aria-label')).toBe(baselineLabel);

    // The trigger contract and the overall state are unchanged (degraded, not down).
    expect(trigger).toHaveAttribute('role', 'status');
    expect(trigger).toHaveAttribute('aria-live', 'polite');
    expect(trigger).toHaveAttribute('aria-atomic', 'true');
    expect(trigger).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('desktop-status-led-overall')).toHaveAttribute(
      'data-health-state',
      'degraded',
    );
    // Still exactly four subsystem lines + one overall (no new DOM row).
    const tooltip = screen.getByTestId('desktop-status-led-tooltip');
    expect(tooltip.querySelectorAll('[data-testid^="health-line-"]')).toHaveLength(4);
    expect(tooltip.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('U-11: a >120-char message stays ONE constrained ellipsised line with the full title', async () => {
    const longMessage =
      'bind 127.0.0.1:4317: address already in use — the OTLP receiver could not publish its ' +
      'surface because another process already owns the configured port for this profile';
    expect(longMessage.length).toBeGreaterThan(120);

    renderLed(degradedHealth({ ...FAILURE, message: longMessage }));
    await triggerLed();

    const row = screen.getByTestId('health-line-telemetry');
    const technical = row.querySelector<HTMLElement>('[title]');
    expect(technical).not.toBeNull();
    const fullEvidence = `otlp:grpc:4317:addrInUse · ${longMessage}`;
    // The DOM text is the FULL string (the ellipsis is paint-time only) and the
    // native title carries it verbatim for the truncated view.
    expect(technical).toHaveTextContent(fullEvidence);
    expect(technical).toHaveAttribute('title', fullEvidence);

    // ONE line: nowrap + hidden overflow + ellipsis + maxWidth 100% is the shipped
    // mechanism that keeps the tooltip from scrolling horizontally (jsdom has no
    // layout, so the constraint is asserted structurally, not by pixel width).
    const style = getComputedStyle(technical as HTMLElement);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.maxWidth).toBe('100%');
    // The long message never leaks into the scan line (the sentence stays short).
    const scanLine = row.firstElementChild as HTMLElement;
    expect(scanLine.textContent).not.toContain(longMessage);
    expect(scanLine).toHaveTextContent('Port 4317 is in use');
  });
});
