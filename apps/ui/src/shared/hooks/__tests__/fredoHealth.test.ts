/**
 * fredoHealth — pure derivation unit pins (Spec #3052 ST-1).
 *
 * Covers the frozen contract the LED (ST-3) and the aggregator hook (ST-2)
 * consume: the fixed order + labels, the source→state mapping, the worst-wins
 * aggregate with neutral handling, and the non-AC F-4b static pin
 * (`pg_supervisor_status.state === 'disabled'` → `postgres` `down` → overall `down`).
 */

import { describe, it, expect } from 'vitest';

import {
  aggregateFredoHealth,
  deriveSubsystemLines,
  type FredoHealthLine,
  type FredoHealthSnapshots,
  type FredoSubsystemId,
  type SubsystemHealth,
} from '../fredoHealth';

/** All-neutral base: nothing to degrade, everything settled healthy where possible. */
function snapshots(overrides: Partial<FredoHealthSnapshots> = {}): FredoHealthSnapshots {
  return {
    telemetry: 'healthy',
    companion: { llamaServerInstalled: true, modelFilesComplete: true },
    llamaServer: { running: true, healthy: true },
    postgres: { state: 'ready' },
    ...overrides,
  };
}

function lineOf(lines: FredoHealthLine[], id: FredoSubsystemId): FredoHealthLine {
  const line = lines.find((l) => l.id === id);
  if (!line) throw new Error(`missing line ${id}`);
  return line;
}

function statesOf(lines: FredoHealthLine[]): Record<FredoSubsystemId, SubsystemHealth> {
  return {
    telemetry: lineOf(lines, 'telemetry').state,
    llamaServer: lineOf(lines, 'llamaServer').state,
    companionModel: lineOf(lines, 'companionModel').state,
    postgres: lineOf(lines, 'postgres').state,
  };
}

describe('deriveSubsystemLines — order, ids, labels', () => {
  it('emits exactly the four ids in the frozen order with fixed labels', () => {
    const lines = deriveSubsystemLines(snapshots());
    expect(lines.map((l) => l.id)).toEqual([
      'telemetry',
      'llamaServer',
      'companionModel',
      'postgres',
    ]);
    expect(lines.map((l) => l.label)).toEqual([
      'Agent telemetry',
      'Llama server',
      'Companion model',
      'Postgres',
    ]);
  });

  it('all-healthy sources produce four healthy lines', () => {
    expect(statesOf(deriveSubsystemLines(snapshots()))).toEqual({
      telemetry: 'healthy',
      llamaServer: 'healthy',
      companionModel: 'healthy',
      postgres: 'healthy',
    });
  });
});

describe('deriveSubsystemLines — frozen source → state mapping', () => {
  it('telemetry: StreamHealth maps 1:1 (healthy/degraded/down) with binding copy', () => {
    expect(lineOf(deriveSubsystemLines(snapshots({ telemetry: 'healthy' })), 'telemetry')).toMatchObject(
      { state: 'healthy', detail: 'Streaming' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ telemetry: 'degraded' })), 'telemetry')).toMatchObject(
      { state: 'degraded', detail: 'Telemetry stalled' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ telemetry: 'down' })), 'telemetry')).toMatchObject(
      { state: 'down', detail: 'Stream stopped' },
    );
  });

  it('postgres: ready/attached → healthy, starting → unknown, failed/disabled → down', () => {
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'ready' } })), 'postgres')).toMatchObject(
      { state: 'healthy', detail: 'Ready' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'attached' } })), 'postgres')).toMatchObject(
      { state: 'healthy', detail: 'Ready' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'starting' } })), 'postgres')).toMatchObject(
      { state: 'unknown', detail: 'Starting' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'failed' } })), 'postgres')).toMatchObject(
      { state: 'down', detail: 'Not available' },
    );
  });

  it('llamaServer: healthy → healthy; running-but-unhealthy / stopped → down', () => {
    expect(
      lineOf(deriveSubsystemLines(snapshots({ llamaServer: { running: true, healthy: true } })), 'llamaServer'),
    ).toMatchObject({ state: 'healthy', detail: 'Running' });
    expect(
      lineOf(deriveSubsystemLines(snapshots({ llamaServer: { running: true, healthy: false } })), 'llamaServer'),
    ).toMatchObject({ state: 'down', detail: 'Stopped or unhealthy' });
    expect(
      lineOf(deriveSubsystemLines(snapshots({ llamaServer: { running: false, healthy: false } })), 'llamaServer'),
    ).toMatchObject({ state: 'down', detail: 'Stopped or unhealthy' });
  });

  it('companionModel: complete → healthy; installed-but-incomplete → down', () => {
    expect(
      lineOf(
        deriveSubsystemLines(
          snapshots({ companion: { llamaServerInstalled: true, modelFilesComplete: true } }),
        ),
        'companionModel',
      ),
    ).toMatchObject({ state: 'healthy', detail: 'Model files present' });
    expect(
      lineOf(
        deriveSubsystemLines(
          snapshots({ companion: { llamaServerInstalled: true, modelFilesComplete: false } }),
        ),
        'companionModel',
      ),
    ).toMatchObject({ state: 'down', detail: 'Model files missing' });
  });

  it('never-installed companion → BOTH companion lines are neutral notSetUp', () => {
    const lines = deriveSubsystemLines(
      snapshots({
        companion: { llamaServerInstalled: false, modelFilesComplete: false },
        llamaServer: { running: false, healthy: false },
      }),
    );
    expect(lineOf(lines, 'llamaServer')).toMatchObject({ state: 'notSetUp', detail: 'Not set up' });
    expect(lineOf(lines, 'companionModel')).toMatchObject({ state: 'notSetUp', detail: 'Not set up' });
  });

  it('unresolved probes → neutral unknown (R-7 settle)', () => {
    const lines = deriveSubsystemLines(
      snapshots({ companion: null, llamaServer: null, postgres: null }),
    );
    expect(statesOf(lines)).toEqual({
      telemetry: 'healthy',
      llamaServer: 'unknown',
      companionModel: 'unknown',
      postgres: 'unknown',
    });
  });
});

describe('aggregateFredoHealth — worst-wins with neutral handling', () => {
  it('all-healthy → healthy', () => {
    expect(aggregateFredoHealth(deriveSubsystemLines(snapshots()))).toBe('healthy');
  });

  it('a mandatory subsystem down ⇒ overall down', () => {
    const telemetryDown = deriveSubsystemLines(snapshots({ telemetry: 'down' }));
    expect(aggregateFredoHealth(telemetryDown)).toBe('down');

    const postgresDown = deriveSubsystemLines(snapshots({ postgres: { state: 'failed' } }));
    expect(aggregateFredoHealth(postgresDown)).toBe('down');

    const postgresDisabled = deriveSubsystemLines(snapshots({ postgres: { state: 'disabled' } }));
    expect(aggregateFredoHealth(postgresDisabled)).toBe('down');
  });

  it('a non-neutral `degraded` line raises the overall to `degraded` (never healthy)', () => {
    const telemetryDegraded = deriveSubsystemLines(snapshots({ telemetry: 'degraded' }));
    expect(aggregateFredoHealth(telemetryDegraded)).toBe('degraded');
    // The mandatory telemetry line is `degraded` (not `down`) → overall `degraded`, not `down`.
    expect(telemetryDegraded.some((l) => l.state === 'down')).toBe(false);
  });

  it('only an OPTIONAL subsystem down ⇒ overall degraded (never down)', () => {
    const llamaDown = deriveSubsystemLines(
      snapshots({ llamaServer: { running: false, healthy: false } }),
    );
    expect(aggregateFredoHealth(llamaDown)).toBe('degraded');

    const modelDown = deriveSubsystemLines(
      snapshots({ companion: { llamaServerInstalled: true, modelFilesComplete: false } }),
    );
    expect(aggregateFredoHealth(modelDown)).toBe('degraded');
  });

  it('neutral states (notSetUp / unknown) never degrade the aggregate', () => {
    const neutral = deriveSubsystemLines(
      snapshots({ companion: null, llamaServer: null, postgres: { state: 'starting' } }),
    );
    // companion lines unknown, postgres unknown — no `down` anywhere.
    expect(neutral.every((l) => l.state !== 'down')).toBe(true);
    expect(aggregateFredoHealth(neutral)).toBe('healthy');

    const notSetUp = deriveSubsystemLines(
      snapshots({
        companion: { llamaServerInstalled: false, modelFilesComplete: false },
        llamaServer: { running: false, healthy: false },
      }),
    );
    expect(aggregateFredoHealth(notSetUp)).toBe('healthy');
  });

  it('mandatory down outranks an optional down (down wins over degraded)', () => {
    const lines = deriveSubsystemLines(
      snapshots({
        telemetry: 'down',
        llamaServer: { running: false, healthy: false },
      }),
    );
    expect(aggregateFredoHealth(lines)).toBe('down');
  });
});

describe('F-4b (static/unit pin — NON-AC) — pg_supervisor_status `disabled` ⇒ postgres down ⇒ overall down', () => {
  it('maps `disabled` to postgres down and folds the aggregate to down', () => {
    const lines = deriveSubsystemLines(snapshots({ postgres: { state: 'disabled' } }));
    expect(lineOf(lines, 'postgres')).toMatchObject({ state: 'down', detail: 'Not available' });
    expect(aggregateFredoHealth(lines)).toBe('down');
  });
});
