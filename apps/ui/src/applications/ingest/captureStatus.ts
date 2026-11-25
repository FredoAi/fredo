/**
 * captureStatus — the pane-local capture-liveness read (Spec #3195 ST-1).
 *
 * Settings → Background capture renders a status line that answers ONE question:
 * is this process RECEIVING agent activity right now? That is a statement about
 * the Fredo PROCESS, not about the login entry and not about any window, so the
 * only legitimate source is a read the process itself answers: the EXISTING
 * `stream_health` command (`infrastructure/rtdb/health.rs`, registered in
 * `command_manifest.rs` and granted to the `app-*` window class — no new IPC).
 *
 * DELIBERATELY NOT `useStreamHealth()`. `StreamContext`'s cold start is
 * `degraded` by design (`StreamContext.tsx`), and `degraded` maps to "not
 * running"; a context-driven line would therefore claim capture is STOPPED for
 * one IPC round-trip on every mount — including every time the Settings webview
 * is recreated after its window closed (AC4's scenario). A one-shot probe
 * settles the line from backend truth on the first tick and cannot inherit an
 * unresolved local value.
 *
 * The mapping is the frozen shared truth table (`shared/hooks/streamHealth`):
 *   healthy  → running
 *   degraded → notRunning   (ingest not connected, or heartbeat stale)
 *   down     → unknown      (unreachable from an in-process probe that resolved)
 * A failed/unreadable read is `unknown` — NEVER `notRunning`. A false "stopped"
 * claim is exactly the defect this module exists to remove.
 */

import { adapterBridge } from '../../shared/utils/adapterBridge';
import {
  deriveStreamHealth,
  isIngestFailure,
  type IngestFailure,
  type StreamHealthProbe,
} from '../../shared/hooks/streamHealth';

/** The three observable capture states. `unknown` is a read failure, never a stopped claim. */
export type CaptureRunState = 'running' | 'notRunning' | 'unknown';

export interface CaptureStatusView {
  state: CaptureRunState;
  /** The typed OTLP start failure when the backend reported one, else null. */
  ingestFailure: IngestFailure | null;
}

/** The fail-closed value: a read we could not perform is never a stopped claim. */
export const UNKNOWN_CAPTURE_STATUS: CaptureStatusView = { state: 'unknown', ingestFailure: null };

/**
 * Normalize the `stream_health` snapshot
 * (`{ seq, ingestConnected, ageMs, forced, ingestFailure? }`) into a
 * `CaptureStatusView`.
 *
 * Boundary rules:
 *   - a non-object or an absent/non-boolean `ingestConnected` is NOT a snapshot
 *     → `unknown` (never `notRunning`);
 *   - a missing/invalid `ageMs` fails closed to `+Infinity` (stale) exactly as
 *     `useStreamHealthProducer.normalizeSnapshot` does, so an unreadable
 *     freshness can never read `running`;
 *   - the typed `ingestFailure` is carried ONLY when it survives
 *     `isIngestFailure` — the absent-key wire rule (G-413); a malformed failure
 *     is dropped, never rendered.
 */
export function normalizeCaptureSnapshot(raw: unknown): CaptureStatusView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return UNKNOWN_CAPTURE_STATUS;
  const snapshot = raw as { ingestConnected?: unknown; ageMs?: unknown; ingestFailure?: unknown };
  if (typeof snapshot.ingestConnected !== 'boolean') return UNKNOWN_CAPTURE_STATUS;

  const ageMs =
    typeof snapshot.ageMs === 'number' && Number.isFinite(snapshot.ageMs)
      ? snapshot.ageMs
      : Number.POSITIVE_INFINITY;
  const probe: StreamHealthProbe = {
    ok: true,
    ageMs,
    ingestConnected: snapshot.ingestConnected,
  };

  switch (deriveStreamHealth(probe)) {
    case 'healthy':
      return { state: 'running', ingestFailure: null };
    case 'degraded':
      return {
        state: 'notRunning',
        ingestFailure: isIngestFailure(snapshot.ingestFailure) ? snapshot.ingestFailure : null,
      };
    default:
      // `down` is unreachable from a resolved in-process probe (`ok: true` by
      // construction); treated as unreadable rather than as a stopped claim.
      return UNKNOWN_CAPTURE_STATUS;
  }
}

/**
 * ONE read of the existing `stream_health` command. Every rejection and every
 * non-snapshot resolves to `UNKNOWN_CAPTURE_STATUS` — this function never
 * throws, so the caller's poll cannot produce an unhandled rejection and the
 * line can never claim capture stopped because a transport was missing.
 */
export async function getCaptureStatus(): Promise<CaptureStatusView> {
  try {
    const raw = await adapterBridge.invoke<unknown>('stream_health');
    return normalizeCaptureSnapshot(raw);
  } catch {
    return UNKNOWN_CAPTURE_STATUS;
  }
}

/**
 * Equality on the RENDERED projection. The component's poll setter ignores a
 * projection that has not changed, so a steady 5 s poll produces no `setState`
 * (React bails out) and therefore no live-region announcement. Compared: the
 * state, plus the fields the reason sentence is built from when the state is
 * `notRunning` (receiver/port), plus the classification/message so a changed
 * cause is not swallowed.
 */
export function sameCaptureStatus(a: CaptureStatusView, b: CaptureStatusView): boolean {
  if (a.state !== b.state) return false;
  if (a.state !== 'notRunning') return a.ingestFailure === null && b.ingestFailure === null;
  const left = a.ingestFailure;
  const right = b.ingestFailure;
  if (left === null || right === null) return left === right;
  return (
    left.receiver === right.receiver &&
    left.port === right.port &&
    left.code === right.code &&
    left.message === right.message
  );
}
