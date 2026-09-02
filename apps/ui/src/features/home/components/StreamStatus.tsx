import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, VStack, Popover } from '@chakra-ui/react';
import { motion } from 'framer-motion';
import {
  useConnectionStatus,
  subscribeToRowMutationLog,
  getRowMutationLogVersion,
} from '../../../shared/contexts/StreamContext';
import { TOAST_DURATION } from '../../../shared/constants';

const RECENT_ACTIVITY_WINDOW = TOAST_DURATION.SHORT; // 2 seconds

type LEDState = 'connected' | 'active' | 'disconnected';

const LED: React.FC<{ state: LEDState; label: string; description: string }> = ({ state, label, description }) => {
  const getColor = () => {
    switch (state) {
      case 'connected':
        return 'var(--status-success)';
      case 'active':
        return 'var(--accent-primary)';
      case 'disconnected':
        return 'var(--status-error)';
    }
  };

  const getPulse = () => {
    if (state === 'active') {
      return {
        scale: [1, 1.2, 1],
        opacity: [1, 0.6, 1],
      };
    }
    return {};
  };

  const getStatusText = () => {
    switch (state) {
      case 'connected':
        return 'Connected';
      case 'active':
        return 'Active - Data I/O';
      case 'disconnected':
        return 'Disconnected';
    }
  };

  return (
    <Popover.Root positioning={{ placement: 'left' }}>
      <Popover.Trigger asChild>
        <Box cursor="help">
          <motion.div
            animate={getPulse()}
            transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: getColor(),
              boxShadow: `0 0 8px ${getColor()}`,
            }}
          />
        </Box>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content
          background="var(--card-bg)"
          border="1px solid var(--border-color)"
          borderRadius="md"
          padding={2}
          boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"
          maxWidth="250px"
        >
          <Popover.Arrow />
          <Box fontSize="xs" color="var(--text-primary)">
            <Box fontWeight="600" marginBottom={1}>
              {label}
            </Box>
            <Box color="var(--text-secondary)" marginBottom={1}>
              {description}
            </Box>
            <Box fontSize="2xs" color="var(--accent-primary)">
              Status: {getStatusText()}
            </Box>
          </Box>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
};

export const StreamStatus: React.FC = () => {
  const { isConnected } = useConnectionStatus();
  const [lastActivityEpoch, setLastActivityEpoch] = useState(0);

  // Track latest RTDB row mutation — stable primitive dependency, no
  // array-length churn. The row-mutation log version advances exactly when a
  // row delivery mutates the store (P5.1: replaces the deleted v1 delivery
  // queue as the activity signal).
  const mutationVersion = useSyncExternalStore(
    subscribeToRowMutationLog,
    getRowMutationLogVersion,
  );

  // When a new row mutation arrives, bump a monotonic epoch counter
  // so the LED state derivation runs. Using an epoch counter instead of
  // array length avoids re-render cascades (Bug #523 cycle 1).
  useEffect(() => {
    if (mutationVersion > 0) {
      setLastActivityEpoch((prev) => prev + 1);
    }
  }, [mutationVersion]);

  // Derive LED state from connection flag and last activity epoch.
  // Memoized — no setState inside effect, eliminating re-render loops.
  const ipcState = useMemo<LEDState>(() => {
    if (!isConnected) return 'disconnected';
    // On first mount (epoch 0), show connected
    if (lastActivityEpoch === 0) return 'connected';
    return 'active';
  }, [isConnected, lastActivityEpoch]);

  // Auto-reset active state after inactivity window.
  // Uses ipcState as the sole dependency — no events.length churn.
  useEffect(() => {
    if (ipcState !== 'active') return;
    const timeout = setTimeout(() => setLastActivityEpoch(0), RECENT_ACTIVITY_WINDOW);
    return () => clearTimeout(timeout);
  }, [ipcState]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      style={{
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: 10,
      }}
    >
      <VStack
        gap={3}
        padding={3}
        background="var(--card-bg)"
        borderRadius="lg"
        border="1px solid var(--border-color)"
        backdropFilter="blur(10px)"
        boxShadow="0 4px 12px rgba(0, 0, 0, 0.2)"
      >
        <LED
          state={ipcState}
          label="Tauri IPC"
          description="Tauri IPC event stream for real-time tool execution updates"
        />
      </VStack>
    </motion.div>
  );
};
