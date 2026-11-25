/**
 * fredoHealth — pure derivation unit pins (Spec #3052 ST-1; #3180 ST-3).
 *
 * Covers the frozen contract the LED and the aggregator hook consume: the fixed
 * order + labels, the source→state mapping, the worst-wins aggregate with
 * neutral handling, and #3180's honest engine precedence + cause/remedy copy.
 *
 * #3180 ST-3 inverted the shipped "engine idle ⇒ down + aggregate Degraded" pin
 * (an idle engine is now NEUTRAL `unknown`/"Idle", never a false `down`) and
 * added the typed-failure / Postgres-failure legs that carry `remedy` +
 * `technicalDetail` (R-5.1…R-5.3).
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
import { engineFailureCopy } from '../../components/companion/companionReadiness';
import type { IngestFailure } from '../streamHealth';

/** All-neutral base: nothing to degrade, everything settled healthy where possible. */
function snapshots(overrides: Partial<FredoHealthSnapshots> = {}): FredoHealthSnapshots {
  return {
    telemetry: 'healthy',
    companion: { modelFilesComplete: true },
    llamaServer: { running: true, healthy: true, starting: false },
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
      'Companion engine',
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

  it('postgres: ready → healthy, starting → unknown (the retired attach state is neutral)', () => {
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'ready' } })), 'postgres')).toMatchObject(
      { state: 'healthy', detail: 'Ready' },
    );
    // Spec #3194 ST-3 inverted the shipped `attached → healthy` pin: the attach
    // state no longer exists, so a foreign payload still reporting it settles to
    // the neutral default (U-8) instead of ever reading healthy.
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'attached' as never } })), 'postgres')).toMatchObject(
      { state: 'unknown', detail: 'Starting' },
    );
    expect(lineOf(deriveSubsystemLines(snapshots({ postgres: { state: 'starting' } })), 'postgres')).toMatchObject(
      { state: 'unknown', detail: 'Starting' },
    );
  });

  it('companionModel: complete → healthy; missing model files → notSetUp (neutral)', () => {
    expect(
      lineOf(
        deriveSubsystemLines(snapshots({ companion: { modelFilesComplete: true } })),
        'companionModel',
      ),
    ).toMatchObject({ state: 'healthy', detail: 'Model files present' });
    // Spec #3141 ST-6 — "set up" means the model files are present, so an empty
    // model set is NEUTRAL, never a `down` that would degrade a fresh machine.
    expect(
      lineOf(
        deriveSubsystemLines(snapshots({ companion: { modelFilesComplete: false } })),
        'companionModel',
      ),
    ).toMatchObject({ state: 'notSetUp', detail: 'Not set up' });
  });

  it('not-configured companion (no model files) → BOTH companion lines are neutral notSetUp', () => {
    const lines = deriveSubsystemLines(
      snapshots({
        companion: { modelFilesComplete: false },
        llamaServer: { running: false, healthy: false, starting: false },
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

describe('#3180 — llamaServer honest-state precedence', () => {
  function engineLine(overrides: Partial<FredoHealthSnapshots>) {
    return lineOf(deriveSubsystemLines(snapshots(overrides)), 'llamaServer');
  }

  it('unresolved companion probe → unknown "Checking"', () => {
    expect(engineLine({ companion: null })).toMatchObject({ state: 'unknown', detail: 'Checking' });
  });

  it('not configured (no model files) → notSetUp "Not set up" (wins over engine state)', () => {
    expect(
      engineLine({ companion: { modelFilesComplete: false } }),
    ).toMatchObject({ state: 'notSetUp', detail: 'Not set up' });
  });

  it('unresolved engine probe → unknown "Checking"', () => {
    expect(engineLine({ llamaServer: null })).toMatchObject({ state: 'unknown', detail: 'Checking' });
  });

  it('healthy → healthy "Running"', () => {
    expect(
      engineLine({ llamaServer: { running: true, healthy: true, starting: false } }),
    ).toMatchObject({ state: 'healthy', detail: 'Running' });
  });

  it('in-flight (starting) → NEUTRAL unknown "Starting", never down', () => {
    const line = engineLine({
      llamaServer: { running: false, healthy: false, starting: true },
    });
    expect(line).toMatchObject({ state: 'unknown', detail: 'Starting' });
    expect(line.state).not.toBe('down');
    expect(line).not.toHaveProperty('remedy');
    expect(line).not.toHaveProperty('technicalDetail');
  });

  it('legacy running-but-not-ready → degraded "Starting" (branch stays reachable)', () => {
    expect(
      engineLine({ llamaServer: { running: true, healthy: false, starting: false } }),
    ).toMatchObject({ state: 'degraded', detail: 'Starting' });
  });

  it('a TYPED failure → down "Could not start" + remedy + technicalDetail', () => {
    const line = engineLine({
      llamaServer: {
        running: false,
        healthy: false,
        starting: false,
        lastErrorCode: 'gpuUnavailable',
        lastError: 'no usable vulkan device',
      },
    });
    const copy = engineFailureCopy('gpuUnavailable');
    expect(line).toMatchObject({ state: 'down', detail: 'Could not start' });
    expect(line.remedy).toBe(`${copy.sentence} Open Settings → Companion.`);
    expect(line.technicalDetail).toBe('gpuUnavailable · no usable vulkan device');
  });

  it('a typed failure WITHOUT a raw error → technicalDetail is the code alone', () => {
    const line = engineLine({
      llamaServer: {
        running: false,
        healthy: false,
        starting: false,
        lastErrorCode: 'backendInitFailed',
      },
    });
    expect(line.state).toBe('down');
    expect(line.technicalDetail).toBe('backendInitFailed');
    expect(line.remedy).toContain('Open Settings → Companion.');
  });

  it('idle with no failure → NEUTRAL unknown "Idle", never down', () => {
    const line = engineLine({
      llamaServer: { running: false, healthy: false, starting: false },
    });
    expect(line).toMatchObject({ state: 'unknown', detail: 'Idle' });
    expect(line.state).not.toBe('down');
    expect(line.detail).not.toBe('Not running');
  });

  it('healthy/neutral rows carry NO remedy or technicalDetail (absent keys — G-413)', () => {
    const healthy = lineOf(deriveSubsystemLines(snapshots()), 'llamaServer');
    expect(healthy).not.toHaveProperty('remedy');
    expect(healthy).not.toHaveProperty('technicalDetail');

    const idle = engineLine({
      llamaServer: { running: false, healthy: false, starting: false },
    });
    expect(idle).not.toHaveProperty('remedy');
    expect(idle).not.toHaveProperty('technicalDetail');
  });
});

describe('#3180 — postgres cause + remedy + technical detail', () => {
  function pgLine(
    postgres: FredoHealthSnapshots['postgres'],
  ): FredoHealthLine {
    return lineOf(deriveSubsystemLines(snapshots({ postgres })), 'postgres');
  }

  it('dataDirNotEmpty → down, names the cluster folder, says move/rename, never tells the user to delete data', () => {
    const line = pgLine({
      state: 'failed',
      failureKind: 'dataDirNotEmpty',
      error: 'initdb: directory "postgres" exists but is not empty',
    });
    expect(line.state).toBe('down');
    expect(line.detail).toContain('database folder');
    expect(line.remedy).toContain('Move or rename');
    expect(line.remedy).toContain('postgres/cluster');
    expect(line.remedy).toContain('restart Fredo');
    // Non-destructive (R-2.2): the remedy never instructs a deletion.
    expect(line.remedy?.toLowerCase()).not.toContain('delete');
    expect(line.technicalDetail).toBe('initdb: directory "postgres" exists but is not empty');
  });

  it('dataDirPermissionDenied → down with the permission remedy, never tells the user to delete', () => {
    const line = pgLine({
      state: 'failed',
      failureKind: 'dataDirPermissionDenied',
      error:
        'the PostgreSQL cluster directory D:/a/run-fresh/postgres/cluster could not be prepared for initialisation',
    });
    expect(line.state).toBe('down');
    expect(line.detail).toBe('Windows is blocking Fredo from preparing the database folder.');
    expect(line.remedy).toBe(
      "Grant your Windows user modify permission on the PostgreSQL cluster folder's parent, or choose a writable folder with FREDO_PG_DATA_DIR, then restart Fredo. Nothing is removed.",
    );
    expect(line.technicalDetail).toBe(
      'the PostgreSQL cluster directory D:/a/run-fresh/postgres/cluster could not be prepared for initialisation',
    );
    // Non-destructive (R-2.2): the remedy never instructs a deletion.
    expect(line.remedy?.toLowerCase()).not.toContain('delete');
    expect(line.remedy).toContain('Nothing is removed.');
  });

  it('portInUse → down, names Settings → Database and the port control', () => {
    const line = pgLine({ state: 'failed', failureKind: 'portInUse', error: 'address in use' });
    expect(line.state).toBe('down');
    expect(line.detail).toContain('port');
    expect(line.remedy).toContain('Settings → Database');
    expect(line.remedy).toContain('port');
    expect(line.technicalDetail).toBe('address in use');
  });

  it('authMismatch → down, names Settings → Database and the destructive reset', () => {
    const line = pgLine({ state: 'failed', failureKind: 'authMismatch', error: 'password auth failed' });
    expect(line.state).toBe('down');
    expect(line.remedy).toContain('Settings → Database');
    expect(line.remedy).toContain('reset the database');
    expect(line.remedy).toContain('deletes local Fredo data');
    expect(line.technicalDetail).toBe('password auth failed');
  });

  it('a failed row with a null/absent cause falls back to the unknown remedy (restart Fredo)', () => {
    const absent = pgLine({ state: 'failed' });
    expect(absent.state).toBe('down');
    expect(absent.remedy).toContain('Restart Fredo');
    expect(absent).not.toHaveProperty('technicalDetail');

    const nullKind = pgLine({ state: 'failed', failureKind: null, error: 'boom' });
    expect(nullKind).toMatchObject({ state: 'down', technicalDetail: 'boom' });
    expect(nullKind.remedy).toContain('Restart Fredo');
  });

  it('disabled → down "Not available" + a remedy + state=disabled detail (R-5.3, resolution a)', () => {
    const line = pgLine({ state: 'disabled' });
    expect(line).toMatchObject({ state: 'down', detail: 'Not available' });
    expect(line.remedy).toBe('Turn Postgres on in Settings → Database.');
    expect(line.technicalDetail).toBe('state=disabled');
  });

  it('ready/starting rows carry NO remedy or technicalDetail (absent keys — G-413)', () => {
    expect(pgLine({ state: 'ready' })).not.toHaveProperty('remedy');
    expect(pgLine({ state: 'ready' })).not.toHaveProperty('technicalDetail');
    expect(pgLine({ state: 'starting' })).not.toHaveProperty('remedy');
    expect(pgLine({ state: 'starting' })).not.toHaveProperty('technicalDetail');
  });
});

describe('aggregateFredoHealth — worst-wins with neutral handling', () => {
  it('all-healthy → healthy', () => {
    expect(aggregateFredoHealth(deriveSubsystemLines(snapshots()))).toBe('healthy');
  });

  it('a mandatory subsystem down ⇒ overall down', () => {
    const telemetryDown = deriveSubsystemLines(snapshots({ telemetry: 'down' }));
    expect(aggregateFredoHealth(telemetryDown)).toBe('down');

    const postgresDown = deriveSubsystemLines(
      snapshots({ postgres: { state: 'failed', failureKind: 'unknown', error: 'boom' } }),
    );
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

  it('a TYPED optional engine failure ⇒ overall degraded (never down)', () => {
    const llamaDown = deriveSubsystemLines(
      snapshots({
        llamaServer: {
          running: false,
          healthy: false,
          starting: false,
          lastErrorCode: 'backendInitFailed',
        },
      }),
    );
    expect(aggregateFredoHealth(llamaDown)).toBe('degraded');

    const loading = deriveSubsystemLines(
      snapshots({ llamaServer: { running: true, healthy: false, starting: false } }),
    );
    expect(aggregateFredoHealth(loading)).toBe('degraded');
  });

  it('neutral states (notSetUp / unknown / idle) never degrade the aggregate', () => {
    const neutral = deriveSubsystemLines(
      snapshots({ companion: null, llamaServer: null, postgres: { state: 'starting' } }),
    );
    // companion lines unknown, postgres unknown — no `down` anywhere.
    expect(neutral.every((l) => l.state !== 'down')).toBe(true);
    expect(aggregateFredoHealth(neutral)).toBe('healthy');

    const notSetUp = deriveSubsystemLines(
      snapshots({
        companion: { modelFilesComplete: false },
        llamaServer: { running: false, healthy: false, starting: false },
      }),
    );
    expect(aggregateFredoHealth(notSetUp)).toBe('healthy');

    // #3180 — an idle engine (files present, no failure) is neutral, not `down`.
    const idle = deriveSubsystemLines(
      snapshots({ llamaServer: { running: false, healthy: false, starting: false } }),
    );
    expect(lineOf(idle, 'llamaServer')).toMatchObject({ state: 'unknown', detail: 'Idle' });
    expect(aggregateFredoHealth(idle)).toBe('healthy');
  });

  it('mandatory down outranks an optional down (down wins over degraded)', () => {
    const lines = deriveSubsystemLines(
      snapshots({
        telemetry: 'down',
        llamaServer: {
          running: false,
          healthy: false,
          starting: false,
          lastErrorCode: 'backendInitFailed',
        },
      }),
    );
    expect(aggregateFredoHealth(lines)).toBe('down');
  });
});

describe('F-4b (static/unit pin — NON-AC) — pg_supervisor_status `disabled` ⇒ postgres down ⇒ overall down', () => {
  it('maps `disabled` to postgres down (with remedy + state detail) and folds the aggregate to down', () => {
    const lines = deriveSubsystemLines(snapshots({ postgres: { state: 'disabled' } }));
    expect(lineOf(lines, 'postgres')).toMatchObject({
      state: 'down',
      detail: 'Not available',
      remedy: 'Turn Postgres on in Settings → Database.',
      technicalDetail: 'state=disabled',
    });
    expect(aggregateFredoHealth(lines)).toBe('down');
  });
});

// ── Spec #3194 ST-3 — the typed OTLP ingest cause on the telemetry line ─────

/** The wire shape the backend emits (camelCase, one value per failure). */
function ingestFailure(overrides: Partial<IngestFailure> = {}): IngestFailure {
  return {
    receiver: 'grpc',
    port: 4317,
    code: 'addrInUse',
    message: 'bind 127.0.0.1:4317: address already in use',
    ...overrides,
  };
}

function telemetryLineOf(overrides: Partial<FredoHealthSnapshots>): FredoHealthLine {
  return lineOf(deriveSubsystemLines(snapshots(overrides)), 'telemetry');
}

describe('#3194 ST-3 — degraded + typed ingest failure (U-4, U-8, U-9)', () => {
  it('U-4: `bindFailed` → detail "Could not start" (never the receiver token) + raw `otlp:` evidence', () => {
    const line = telemetryLineOf({
      telemetry: 'degraded',
      telemetryFailure: ingestFailure({
        receiver: 'http',
        port: 4318,
        code: 'bindFailed',
        message: 'failed to bind the HTTP receiver',
      }),
    });
    expect(line).toMatchObject({ state: 'degraded', detail: 'Could not start' });
    expect(line.technicalDetail).toBe(
      'otlp:http:4318:bindFailed · failed to bind the HTTP receiver',
    );
    // The receiver (`grpc`/`http`) is protocol jargon: it rides ONLY the raw
    // evidence line, never the user-facing `detail`.
    expect(line.detail).not.toContain('http');
    // No `remedy` on the telemetry line (the #3180 rule binds it to `down` rows).
    expect(line).not.toHaveProperty('remedy');
  });

  it('U-4 (sibling leg): `addrInUse` → detail names the failing PORT as a bare integer', () => {
    const line = telemetryLineOf({
      telemetry: 'degraded',
      telemetryFailure: ingestFailure({ port: 4318 }),
    });
    expect(line).toMatchObject({ state: 'degraded', detail: 'Port 4318 is in use' });
    expect(line.technicalDetail).toBe(
      'otlp:grpc:4318:addrInUse · bind 127.0.0.1:4317: address already in use',
    );
    expect(line).not.toHaveProperty('remedy');
  });

  it('U-9: the four existing telemetryLine pins are byte-identical', () => {
    expect(telemetryLineOf({ telemetry: 'healthy' })).toMatchObject({
      state: 'healthy',
      detail: 'Streaming',
    });
    expect(telemetryLineOf({ telemetry: 'degraded' })).toMatchObject({
      state: 'degraded',
      detail: 'Telemetry stalled',
    });
    expect(telemetryLineOf({ telemetry: 'down' })).toMatchObject({
      state: 'down',
      detail: 'Stream stopped',
    });
    // The failure-present degraded row keeps the SAME state word + mandatory line.
    const withFailure = telemetryLineOf({
      telemetry: 'degraded',
      telemetryFailure: ingestFailure(),
    });
    expect(withFailure).toMatchObject({ id: 'telemetry', label: 'Agent telemetry', state: 'degraded' });
    // No failure recorded → no raw evidence line at all (absent key, G-413).
    expect(telemetryLineOf({ telemetry: 'degraded' })).not.toHaveProperty('technicalDetail');
  });

  it('U-8: a foreign pg payload reporting the retired attach state is neutral and absent everywhere', () => {
    const lines = deriveSubsystemLines(
      snapshots({ postgres: { state: 'attached' as never } }),
    );
    expect(lineOf(lines, 'postgres')).toMatchObject({ state: 'unknown', detail: 'Starting' });
    // `unknown` is NEUTRAL — the mandatory `down` escalation must not fire.
    expect(aggregateFredoHealth(lines)).not.toBe('down');
    expect(aggregateFredoHealth(lines)).toBe('healthy');
    // No derived line carries the retired vocabulary (rendered-surface absence).
    expect(JSON.stringify(lines)).not.toContain('attached');
  });
});

describe('#3194 ST-3 — the typed cause is IGNORED outside the degraded branch (U-6)', () => {
  it('U-6: a failure present while healthy is ignored — "Streaming", no raw evidence', () => {
    const line = telemetryLineOf({ telemetry: 'healthy', telemetryFailure: ingestFailure() });
    expect(line).toMatchObject({ state: 'healthy', detail: 'Streaming' });
    expect(line).not.toHaveProperty('technicalDetail');
  });

  it('U-6: a failure present while down is ignored — "Stream stopped", no raw evidence', () => {
    const line = telemetryLineOf({ telemetry: 'down', telemetryFailure: ingestFailure() });
    expect(line).toMatchObject({ state: 'down', detail: 'Stream stopped' });
    expect(line).not.toHaveProperty('technicalDetail');
    // `down` keeps its #3180 cause-free copy: a stale bind failure never decorates it.
    expect(line).not.toHaveProperty('remedy');
  });
});

describe('#3194 ST-3 — a malformed failure fails closed (U-7)', () => {
  function malformed(failure: unknown): FredoHealthLine {
    return telemetryLineOf({
      telemetry: 'degraded',
      telemetryFailure: failure as IngestFailure,
    });
  }

  it('U-7: port 0 / missing / non-integer / non-numeric → "Telemetry stalled", no evidence line', () => {
    for (const failure of [
      ingestFailure({ port: 0 }),
      { ...ingestFailure(), port: undefined },
      { ...ingestFailure(), port: 4317.5 },
      { ...ingestFailure(), port: '4317' },
      { ...ingestFailure(), port: Number.NaN },
    ]) {
      const line = malformed(failure);
      expect(line).toMatchObject({ state: 'degraded', detail: 'Telemetry stalled' });
      expect(line).not.toHaveProperty('technicalDetail');
      expect(line.detail).not.toContain('undefined');
      expect(line.detail).not.toContain('NaN');
    }
  });

  it('U-7: an unknown code or a malformed shape → the unchanged stall copy, never a rendered cause', () => {
    for (const failure of [
      { ...ingestFailure(), code: 'somethingElse' },
      { ...ingestFailure(), receiver: 'bluetooth' },
      { ...ingestFailure(), message: 42 },
      null,
      undefined,
      'addrInUse',
      {},
    ]) {
      const line = malformed(failure);
      expect(line).toMatchObject({ state: 'degraded', detail: 'Telemetry stalled' });
      expect(line).not.toHaveProperty('technicalDetail');
      expect(JSON.stringify(line)).not.toContain('undefined');
      expect(JSON.stringify(line)).not.toContain('NaN');
    }
  });
});
