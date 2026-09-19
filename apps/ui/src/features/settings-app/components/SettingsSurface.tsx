import React, { useMemo, useState } from 'react';
import { Box, Button, HStack, Icon, Text, VStack } from '@chakra-ui/react';
import { LuPalette, LuBot, LuSave, LuSettings2, LuActivity } from 'react-icons/lu';
import { CompanionSettingsPanel } from '../../../shared/components/companion/CompanionSettingsPanel';
import { SettingsSaveProvider, useSettingsSaveContext } from '../../settings/SettingsSaveContext';
import { ThemingSettings } from '../../theming';
import { SetupWizard } from '../../setup';
import { TelemetrySettings, DockPositionSettings, BackgroundSettings } from '../../home';
import { getFeatures, dedupeByFeatureId } from '../../featureRegistry';
import { tint } from '../../../shared/utils/colorTint';

/**
 * SettingsSurface — the inner Settings shell (Spec #2868 ST-1).
 *
 * Moved verbatim from the retired modal's inner container (sidebar nav,
 * section composition, keyed Save provider, unified footer), MINUS the
 * `<Dialog.*>` chrome / `Dialog.Title` / internal close button — the feature
 * window frame now owns the title, icon, and min/max/close controls. Section
 * content is unchanged; only the container moved.
 */

const thinScrollbar = {
  '&::-webkit-scrollbar': { width: '5px', height: '5px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--scrollbar-thumb)',
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': { background: 'var(--scrollbar-thumb-hover)' },
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
      color={isActive ? 'var(--text-primary)' : 'var(--text-secondary)'}
      bg={isActive ? tint('var(--accent-primary)', 12) : 'transparent'}
      borderLeft="3px solid"
      borderColor={isActive ? 'var(--accent-strong)' : 'transparent'}
      aria-current={isActive ? 'page' : undefined}
      textAlign="left"
      w="100%"
      cursor="pointer"
      transition="all 0.15s"
      onClick={() => onClick(id)}
      _hover={{
        color: 'var(--text-primary)',
        bg: isActive ? tint('var(--accent-primary)', 12) : 'var(--hover-bg)',
      }}
      _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '-2px' }}
    >
      <Icon as={icon as any} boxSize="14px" flexShrink={0} />
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
        color="var(--accent-contrast)"
        _hover={{ opacity: 0.9 }}
      >
        <LuSave /> Save
      </Button>
    </HStack>
  );
};

export const SettingsSurface: React.FC = () => {
  // Computed at render, never at module scope: the `allFeatures` glob may
  // evaluate this module before later features register. The registry is
  // immutable after startup, so a single memo is stable for the app lifetime.
  const featureSettingsTabs = useMemo(
    () => dedupeByFeatureId(getFeatures()).filter(
      (f) => f.hasSettings && typeof f.renderSettings === 'function',
    ),
    [],
  );

  type StaticSection = 'appearance' | 'companion' | 'telemetry';
  type SectionId = StaticSection | string;
  const [activeSection, setActiveSection] = useState<SectionId>('companion');

  return (
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
        {/* Sidebar header — plain semantic heading; the window frame owns
            the title/close chrome (no Dialog.Title outside Dialog.Root). */}
        <HStack px={5} pt={5} pb={3} flexShrink={0}>
          <Text
            as="h2"
            fontSize="xs"
            fontWeight="700"
            color="var(--text-secondary)"
            textTransform="uppercase"
            letterSpacing="0.1em"
          >
            Settings
          </Text>
        </HStack>

        {/* Nav items */}

        {/* Static: Companion */}
        <NavItem id="companion" label="Companion" icon={LuBot} activeSection={activeSection} onClick={setActiveSection} />

        {/* Static: Appearance */}
        <NavItem id="appearance" label="Appearance" icon={LuPalette} activeSection={activeSection} onClick={setActiveSection} />

        {/* Static: Fredo Setup */}
        <NavItem id="plugin-setup" label="Fredo Setup" icon={LuSettings2} activeSection={activeSection} onClick={setActiveSection} />

        {/* Static: Telemetry */}
        <NavItem id="telemetry" label="Telemetry" icon={LuActivity} activeSection={activeSection} onClick={setActiveSection} />

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
              <Box p={0} minH="100%">
                {/* Desktop background (Spec #2899 ST-4) — home-owned, rendered
                    FIRST so the headline control is discoverable without
                    scrolling; immediate write-through via the background store
                    (no Save-footer gating). */}
                <BackgroundSettings />
                <ThemingSettings />
                {/* Dock position (Spec #2848 ST-4) — home-owned, rendered
                    BENEATH ThemingSettings; immediate write-through via the
                    dock-position store (no Save-footer gating). */}
                <DockPositionSettings />
              </Box>
            )}
            {activeSection === 'plugin-setup' && (
              <Box minH="100%"><SetupWizard /></Box>
            )}
            {activeSection === 'telemetry' && (
              <Box p={5} minH="100%"><TelemetrySettings /></Box>
            )}
            {featureSettingsTabs.map((feature) =>
              activeSection === feature.id ? (
                <Box key={feature.id} minH="100%">
                  {feature.renderSettings!() as React.ReactNode}
                </Box>
              ) : null
            )}
          </Box>
          <SaveFooter />
        </Box>
      </SettingsSaveProvider>

    </HStack>
  );
};
