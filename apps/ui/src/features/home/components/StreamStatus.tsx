import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box } from '@chakra-ui/react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  useConnectionStatus,
  subscribeToRowMutationLog,
  getRowMutationLogVersion,
} from '../../../shared/contexts/StreamContext';
import { TOAST_DURATION } from '../../../shared/constants';

const RECENT_ACTIVITY_WINDOW = TOAST_DURATION.SHORT; // 2 seconds

type ConnectionState = 'connected' | 'disconnected';
type ActivityState = 'active' | 'idle';

/**
 * Bottom status LED pair (Spec #2821 ST-4 / AC4).
 *
 * EXACTLY TWO passive (pointer-events:none) status dots live at the
 * bottom-center of the desktop surface, ~24px above the bottom edge, two 8px
 * dots spaced ~16px apart:
 *
 *   - LED-1 = connection/online: `var(--accent-primary)` when connected,
 *     `var(--status-error)` when disconnected.
 *   - LED-2 = activity/streaming: `var(--status-info)` when actively
 *     streaming/processing, `var(--card-hover-bg)` (bg.muted) when idle.
 *
 * This replaces the old single top-right LED that overlapped the
 * `LauncherChrome` clock/ONLINE readout (`bugs/led-overlay.png`). The
 * `LauncherChrome` ONLINE dot stays as the labeled READOUT CLUSTER (Asset
 * 1.6) — these two LEDs are the unlabeled live status pair (Asset 3) and
 * never render at the top-right.
 *
 * The connection/activity derivation is preserved: `useConnectionStatus()`
 * drives LED-1; the row-mutation log version (P5.1 replacement for the v1
 * delivery queue) drives LED-2 via a monotonic activity epoch. State is
 * announced as TEXT (never color-only) through `role="status"` +
 * `aria-live="polite"` on the wrapper + per-dot `aria-label` / `title`.
 *
 * Token-native: every color is a theme CSS var — no hardcoded hex/rgba, no
 * `var(--x)NN` alpha-append. Pulse suppressed under `prefers-reduced-motion`.
 */

/** LED-1 color — connection/online (Asset 3). */
const CONNECTION_COLOR: Record<ConnectionState, string> = {
  connected: 'var(--accent-primary)',
  disconnected: 'var(--status-error)',
};

/** LED-2 color — activity/streaming (Asset 3). */
const ACTIVITY_COLOR: Record<ActivityState, string> = {
  active: 'var(--status-info)',
  idle: 'var(--card-hover-bg)',
};

interface StatusDotProps {
  stateColor: string;
  label: string;
  description: string;
  /** Whether to pulse (active streaming) — suppressed under reduced-motion. */
  pulsing: boolean;
  reducedMotion: boolean;
}

/** One passive 8px status dot with an accessible name / title per state. */
const StatusDot: React.FC<StatusDotProps> = ({
  stateColor,
  label,
  description,
  pulsing,
  reducedMotion,
}) => {
  const animate = pulsing && !reducedMotion ? { scale: [1, 1.3, 1], opacity: [1, 0.55, 1] } : {};
  return (
    <motion.div
      animate={animate}
      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
      aria-label={label}
      title={`${label} — ${description}`}
      style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: stateColor }}
    />
  );
};

export const StreamStatus: React.FC = () => {
  const { isConnected } = useConnectionStatus();
  const [lastActivityEpoch, setLastActivityEpoch] = useState(0);
  const reducedMotion = useReducedMotion();

  // Track the latest RTDB row mutation — a stable primitive dependency, no
  // array-length churn. The version advances exactly when a row delivery
  // mutates the store (P5.1: replaces the deleted v1 delivery queue as the
  // activity signal).
  const mutationVersion = useSyncExternalStore(
    subscribeToRowMutationLog,
    getRowMutationLogVersion,
  );

  // When a new row mutation arrives, bump a monotonic epoch counter so the
  // activity derivation runs. Epoch counter (not array length) avoids
  // re-render cascades (Bug #523 cycle 1).
  useEffect(() => {
    if (mutationVersion > 0) setLastActivityEpoch((prev) => prev + 1);
  }, [mutationVersion]);

  // LED-2 derivation: active ONLY while a recent row mutation occurred and we
  // are connected; otherwise idle.
  const activityState = useMemo<ActivityState>(() => {
    if (!isConnected) return 'idle';
    return lastActivityEpoch > 0 ? 'active' : 'idle';
  }, [isConnected, lastActivityEpoch]);

  // Auto-reset active -> idle after the inactivity window. Uses
  // activityState as the sole dependency (no events.length churn).
  useEffect(() => {
    if (activityState !== 'active') return;
    const timeout = setTimeout(() => setLastActivityEpoch(0), RECENT_ACTIVITY_WINDOW);
    return () => clearTimeout(timeout);
  }, [activityState]);

  const connectionState: ConnectionState = isConnected ? 'connected' : 'disconnected';
  const connLabel = isConnected ? 'Online' : 'Offline';
  const actLabel = activityState === 'active' ? 'Streaming' : 'Idle';

  return (
    <Box
      role="status"
      aria-live="polite"
      aria-label="Desktop status"
      position="fixed"
      left="50%"
      bottom="24px"
      transform="translateX(-50%)"
      zIndex={1210}
      display="flex"
      alignItems="center"
      gap="16px"
      pointerEvents="none"
    >
      <StatusDot
        stateColor={CONNECTION_COLOR[connectionState]}
        label={connLabel}
        description="Connection / online status"
        pulsing={false}
        reducedMotion={reducedMotion ?? false}
      />
      <StatusDot
        stateColor={ACTIVITY_COLOR[activityState]}
        label={actLabel}
        description="Activity / streaming status"
        pulsing={activityState === 'active'}
        reducedMotion={reducedMotion ?? false}
      />
    </Box>
  );
};
