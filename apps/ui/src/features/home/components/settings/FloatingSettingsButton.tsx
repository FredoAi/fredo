import React, { useState } from 'react';
import { Box, IconButton } from '@chakra-ui/react';
import { LuSettings } from 'react-icons/lu';
import { tint } from '../../../../shared/utils/colorTint';
import { useWindows } from '../../../../shared/window-system/useWindows';
import { ProfileSettingsModal } from '../ProfileSettingsModal';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

interface FloatingSettingsButtonProps {
  features?: FredoFeatureClass[];
}

/**
 * Settings-buttion z-contract (Spec #2841 AC4 / R-4; Architect binding
 * `[architect]`): the button renders BEFORE `LauncherChrome` in DOM order
 * (`Home.tsx:193`→`195`), so at equal z the band would paint over it. 1250 is
 * required to sit ABOVE the chrome band (1200) + the resting launcher surface
 * (1100) so it is ALWAYS visible on a clean desktop (AC4), while staying UNDER
 * the Ctrl+Space overlay (1300) so a shortcut-opened launcher still covers it.
 */
const SETTINGS_Z_VISIBLE = 1250;
/** Covered (a maximized window covers the desktop): sink below the window stack (z=1). */
const SETTINGS_Z_COVERED = 0;
/** Bottom-right placement, clear of the top-right clock/LED cluster. */
const SETTINGS_RIGHT_PX = 24;
const SETTINGS_BOTTOM_PX = 24;

export const FloatingSettingsButton: React.FC<FloatingSettingsButtonProps> = ({ features = [] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const windows = useWindows();

  // A NON-minimized feature window covers the desktop (#2825 chrome-vs-window
  // rule). On a clean desktop the button joins the chrome tier (z1250 — always
  // visible); when a window covers the desktop it sinks to z0 so it never paints
  // over a maximized window or its titlebar min/max/close controls. Mirrors
  // `LauncherShell.tsx:195` — the button already sits inside the
  // `WindowSystemProvider`, so no Home.tsx mount change is needed.
  const coveredByWindow = windows.some((w) => !w.isMinimized);
  const zIndex = coveredByWindow ? SETTINGS_Z_COVERED : SETTINGS_Z_VISIBLE;

  return (
    <>
      <Box
        position="fixed"
        bottom={`${SETTINGS_BOTTOM_PX}px`}
        right={`${SETTINGS_RIGHT_PX}px`}
        zIndex={zIndex}
      >
        <IconButton
          aria-label="Settings"
          variant="subtle"
          size="sm"
          borderRadius="full"
          background="var(--card-bg)"
          border="1px solid var(--border-color)"
          color="var(--text-secondary)"
          backdropFilter="blur(10px)"
          boxShadow={`0 4px 12px ${tint('var(--border-color)', 30)}`}
          onClick={() => setIsOpen(true)}
          _hover={{
            background: 'var(--hover-bg)',
            color: 'var(--text-primary)',
            transform: 'scale(1.05)',
          }}
          _focusVisible={{
            outline: 'none',
            boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
          }}
          style={{ transition: 'all 0.2s' }}
        >
          <LuSettings size={16} />
        </IconButton>
      </Box>
      <ProfileSettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} features={features} />
    </>
  );
};
