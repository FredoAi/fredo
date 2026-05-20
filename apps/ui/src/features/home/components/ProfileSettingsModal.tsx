import React, { useState } from 'react';
import { Box, Button, Dialog, HStack, Icon, IconButton, Spacer, Text, VStack } from '@chakra-ui/react';
import { LuX, LuPalette, LuBot, LuSave, LuSettings2 } from 'react-icons/lu';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';
import { CompanionSettingsPanel } from '../../../shared/components/companion/CompanionSettingsPanel';
import { SettingsSaveProvider, useSettingsSaveContext } from '../../settings/SettingsSaveContext';
import { ThemingSettings } from '../../theming/components/ThemingSettings';
import { SetupWizard } from '../../setup/components/SetupWizard';

interface ProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  features?: FredoFeatureClass[];
}

const thinScrollbar = {
  '&::-webkit-scrollbar': { width: '5px', height: '5px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    background: 'rgba(255,255,255,0.12)',
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(255,255,255,0.22)' },
  '&::-webkit-scrollbar-corner': { background: 'transparent' },
} as const;

// ── Reusable sidebar nav item ─────────────────────────────────────────────────

interface NavItemProps {
  id: string;
  label: string;
  icon: React.ElementType;
  activeSection: string;
  onClick: (id: string) => void;
}

const NavItem: React.FC<NavItemProps> = ({ id, label, icon, activeSection, onClick }) => {
  const isActive = activeSection === id;
  return (
    <HStack
      as="button"
      gap={2}
      px={5}
      py={2}
      fontWeight={isActive ? '600' : '500'}
      color={isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'}
      bg={isActive ? 'rgba(147, 51, 234, 0.12)' : 'transparent'}
      borderLeft="2px solid"
      borderColor={isActive ? 'var(--accent-primary)' : 'transparent'}
      textAlign="left"
      w="100%"
      cursor="pointer"
      transition="all 0.15s"
      onClick={() => onClick(id)}
      _hover={{ color: 'var(--text-primary)', bg: 'rgba(255,255,255,0.04)' }}
    >
      <Icon as={icon} boxSize="14px" flexShrink={0} />
      <Text fontSize="sm" fontWeight="inherit" lineHeight="short">
        {label}
      </Text>
    </HStack>
  );
};

// ── Unified save footer — reads save fn from context ─────────────────────────
const SaveFooter: React.FC = () => {
  const { saveFn } = useSettingsSaveContext();
  const [saving, setSaving] = useState(false);

  if (!saveFn) return null;

  const handleSave = async () => {
    setSaving(true);
    try { await saveFn(); } finally { setSaving(false); }
  };

  return (
    <HStack
      px={5} py={3}
      borderTop="1px solid"
      borderColor="var(--border-color)"
      justify="flex-end"
      flexShrink={0}
      bg="var(--card-bg)"
    >
      <Button
        size="sm"
        loading={saving}
        onClick={handleSave}
        background="var(--accent-primary)"
        color="white"
        _hover={{ opacity: 0.9 }}
      >
        <LuSave /> Save
      </Button>
    </HStack>
  );
};

export const ProfileSettingsModal: React.FC<ProfileSettingsModalProps> = ({ isOpen, onClose, features = [] }) => {
  const featureSettingsTabs = features.filter((f) => f.hasSettings && typeof f.renderSettings === 'function');

  type StaticSection = 'appearance' | 'companion';
  type SectionId = StaticSection | string;
  const [activeSection, setActiveSection] = useState<SectionId>('companion');

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <Dialog.Backdrop bg="rgba(0, 0, 0, 0.6)" backdropFilter="blur(4px)" />
      <Dialog.Positioner>
        <Dialog.Content
          bg="var(--card-bg)"
          borderColor="var(--border-color)"
          borderWidth="1px"
          borderRadius="xl"
          boxShadow="0 24px 80px rgba(0, 0, 0, 0.4)"
          maxW="960px"
          w="960px"
          h="620px"
          overflow="hidden"
        >
          <Dialog.Body padding={0} h="100%" overflow="hidden">
            <HStack align="stretch" h="100%" gap={0}>

              {/* Left sidebar */}
              <VStack
                align="stretch"
                gap={0}
                w="220px"
                flexShrink={0}
                bg="var(--header-bg)"
                borderRight="1px solid"
                borderColor="var(--border-color)"
                overflowY="auto"
                css={thinScrollbar}
              >
                {/* Sidebar header with close button */}
                <HStack px={5} pt={5} pb={3} flexShrink={0}>
                  <Text
                    fontSize="xs"
                    fontWeight="700"
                    color="var(--text-secondary)"
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                  >
                    Settings
                  </Text>
                  <Spacer />
                  <IconButton
                    aria-label="Close"
                    size="xs"
                    onClick={onClose}
                    css={{
                      background: 'var(--status-error)',
                      color: 'white',
                      borderRadius: '4px',
                      minWidth: '22px',
                      height: '22px',
                      padding: '0',
                      '&:hover': { background: 'var(--status-error)', opacity: 0.8, transform: 'scale(1.05)' },
                      '&:active': { transform: 'scale(0.95)' },
                      transition: 'all 0.2s',
                    }}
                  >
                    <LuX size={12} />
                  </IconButton>
                </HStack>

                {/* Nav items */}

                {/* Static: Companion */}
                <NavItem id="companion" label="Companion" icon={LuBot} activeSection={activeSection} onClick={setActiveSection} />

                {/* Static: Appearance */}
                <NavItem id="appearance" label="Appearance" icon={LuPalette} activeSection={activeSection} onClick={setActiveSection} />

                {/* Static: Fredo Setup */}
                <NavItem id="plugin-setup" label="Fredo Setup" icon={LuSettings2} activeSection={activeSection} onClick={setActiveSection} />

                {/* Feature settings */}
                {featureSettingsTabs.length > 0 && (
                  <Text
                    fontSize="xs"
                    fontWeight="700"
                    color="var(--text-secondary)"
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    px={5}
                    pt={4}
                    pb={1}
                  >
                    Features
                  </Text>
                )}
                {featureSettingsTabs.map((feature) => {
                  const FeatureIcon = feature.icon;
                  return (
                    <NavItem key={feature.id} id={feature.id} label={feature.name} icon={FeatureIcon} activeSection={activeSection} onClick={setActiveSection} />
                  );
                })}
              </VStack>

              {/* Right content area — provider resets on section change via key */}
              <SettingsSaveProvider key={activeSection}>
                <Box flex={1} display="flex" flexDirection="column" overflow="hidden">
                  <Box flex={1} overflowY="auto" css={thinScrollbar}>
                    {activeSection === 'companion' && (
                      <Box minH="100%"><CompanionSettingsPanel /></Box>
                    )}
                    {activeSection === 'appearance' && (
                      <Box p={0} minH="100%"><ThemingSettings /></Box>
                    )}
                    {activeSection === 'plugin-setup' && (
                      <Box minH="100%"><SetupWizard /></Box>
                    )}
                    {featureSettingsTabs.map((feature) =>
                      activeSection === feature.id ? (
                        <Box key={feature.id} minH="100%">
                          {feature.renderSettings!()}
                        </Box>
                      ) : null
                    )}
                  </Box>
                  <SaveFooter />
                </Box>
              </SettingsSaveProvider>

            </HStack>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
