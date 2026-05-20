import React, { useState } from 'react';
import { Box, IconButton } from '@chakra-ui/react';
import { LuSettings } from 'react-icons/lu';
import { ProfileSettingsModal } from '../ProfileSettingsModal';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

interface FloatingSettingsButtonProps {
  features?: FredoFeatureClass[];
}

export const FloatingSettingsButton: React.FC<FloatingSettingsButtonProps> = ({ features = [] }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Box
        position="fixed"
        bottom="72px"
        right="16px"
        zIndex={10}
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
          boxShadow="0 4px 12px rgba(0, 0, 0, 0.2)"
          onClick={() => setIsOpen(true)}
          _hover={{
            background: 'var(--hover-bg)',
            color: 'var(--text-primary)',
            transform: 'scale(1.05)',
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
