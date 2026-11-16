/**
 * usePgSupervisorStatus — a bounded poll of the EXISTING `pg_supervisor_status`
 * command (Spec #3067 ST-4; EARS R-1/R-2/R-4).
 *
 * There is no supervisor status event (the backend `status` is an in-process
 * `watch` channel, never emitted to the webview), so the recovery banner reads
 * the read-only snapshot on a fixed interval. This hook owns the ONLY poll: it
 * clears its interval on unmount (N-3, no leaked timer) and re-renders ONLY when
 * the observed snapshot meaningfully changes — the update is gated on a
 * PRIMITIVE signature, never on object identity, so a 3 s poll can never drive a
 * re-render loop (#523 / N-4).
 *
 * No new IPC, no new event: this is `getPgSupervisorStatus()` on a timer.
 */

import { useEffect, useRef, useState } from 'react';

import { getPgSupervisorStatus, type PgSupervisorStatusView } from './postgresConfigStore';

/** The poll cadence: one read every 3 s. */
export const PG_STATUS_POLL_MS = 3000;

/**
 * A primitive signature of the fields the banner renders from. Two snapshots
 * with the same signature are visually identical, so a poll that returns an
 * unchanged snapshot does NOT trigger a re-render (no re-render loop, and the
 * `role="status"` region is not re-announced per tick).
 */
function signatureOf(status: PgSupervisorStatusView | null): string {
  if (!status) return 'null';
  return [
    status.state,
    status.failureKind ?? '',
    status.port ?? '',
    status.pid ?? '',
    status.attached ? '1' : '0',
    status.error ?? '',
  ].join('|');
}

/**
 * Poll `pg_supervisor_status` every `PG_STATUS_POLL_MS`; returns the latest
 * snapshot (or `null` before the first successful read). A transient read
 * failure keeps the last known snapshot and retries on the next tick.
 */
export function usePgSupervisorStatus(): PgSupervisorStatusView | null {
  const [status, setStatus] = useState<PgSupervisorStatusView | null>(null);
  // The last applied signature. Starts sentinel-different from every real
  // signature so the first snapshot always lands.
  const signatureRef = useRef<string>('__unset__');

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await getPgSupervisorStatus();
        if (cancelled) return;
        const signature = signatureOf(next);
        if (signature !== signatureRef.current) {
          signatureRef.current = signature;
          setStatus(next);
        }
      } catch {
        // Transient read failure: keep the last known status; retry next tick.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, PG_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return status;
}
