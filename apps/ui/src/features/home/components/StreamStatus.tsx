import React, { useEffect, useState } from 'react';
import { Box, VStack, Popover } from '@chakra-ui/react';
import { motion } from 'framer-motion';
import { useStream } from '../../../shared/contexts/StreamContext';
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
  const { isConnected, events } = useStream();
  const [ipcState, setIpcState] = useState<LEDState>('disconnected');

  // Derive LED state from connection flag and recent event activity
  useEffect(() => {
    if (!isConnected) {
      setIpcState('disconnected');
      return;
    }

    const now = Date.now();
    const hasRecentActivity = events.slice(-10).some((event) => {
      return now - new Date(event.timestamp).getTime() < RECENT_ACTIVITY_WINDOW;
    });

    setIpcState(hasRecentActivity ? 'active' : 'connected');
  }, [isConnected, events.length]);

  // Auto-reset active state after inactivity window
  useEffect(() => {
    if (ipcState === 'active') {
      const timeout = setTimeout(() => setIpcState('connected'), RECENT_ACTIVITY_WINDOW);
      return () => clearTimeout(timeout);
    }
  }, [ipcState, events.length]);

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
