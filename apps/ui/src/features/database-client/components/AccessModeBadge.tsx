import React from 'react';
import { Box, HStack, Text } from '@chakra-ui/react';
import { LuLock, LuLockOpen } from 'react-icons/lu';
import type { AccessMode } from '../lib/types';

/**
 * AccessModeBadge — the always-visible connection access-mode indicator
 * (Spec #2950, ST-7; R-5.1/R-5.7).
 *
 * R-5.1: the current mode is visible at all times — `mode === null` renders the
 * "Not connected" state, so the badge never disappears.
 * R-5.7: `readWrite` uses a DISTINCT semantic status token (`status.warning`)
 * versus `readOnly` (`status.info`) and the badge is keyboard-focusable
 * (`tabIndex={0}`) with a text label — colour is never the only signal.
 *
 * Token-first: semantic tokens only, no hex/rgba literal.
 */

export interface AccessModeBadgeProps {
  /** The active connection's mode, or `null` when no session is active. */
  mode: AccessMode | null;
}

interface BadgeStyle {
  label: string;
  token: string;
  bg: string;
  fg: string;
  icon: React.ReactNode;
}

function styleFor(mode: AccessMode | null): BadgeStyle {
  if (mode === 'readWrite') {
    return {
      label: 'Read/write',
      token: 'status.warning',
      bg: 'bg.subtle',
      fg: 'status.warning',
      icon: <LuLockOpen size={12} />,
    };
  }
  if (mode === 'readOnly') {
    return {
      label: 'Read-only',
      token: 'status.info',
      bg: 'bg.subtle',
      fg: 'status.info',
      icon: <LuLock size={12} />,
    };
  }
  return {
    label: 'Not connected',
    token: 'fg.muted',
    bg: 'bg.subtle',
    fg: 'fg.muted',
    icon: <LuLock size={12} />,
  };
}

export const AccessModeBadge: React.FC<AccessModeBadgeProps> = ({ mode }) => {
  const style = styleFor(mode);
  return (
    <Box
      data-testid="db-access-mode-badge"
      data-mode={mode ?? 'none'}
      data-token={style.token}
      role="status"
      aria-label={`Access mode: ${style.label}`}
      tabIndex={0}
      display="inline-flex"
      alignItems="center"
      gap={1}
      px="8px"
      py="2px"
      borderRadius="full"
      borderWidth="1px"
      borderColor="border.default"
      bg={style.bg}
      color={style.fg}
      flexShrink={0}
      title={`Access mode: ${style.label}`}
    >
      <HStack gap={1}>
        <Box display="flex" alignItems="center" flexShrink={0} aria-hidden="true">
          {style.icon}
        </Box>
        <Text fontSize="2xs" fontWeight="700" textTransform="uppercase" letterSpacing="wide">
          {style.label}
        </Text>
      </HStack>
    </Box>
  );
};
