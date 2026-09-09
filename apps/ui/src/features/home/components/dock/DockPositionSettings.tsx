/**
 * DockPositionSettings — Settings → Appearance "Dock" group (Spec #2848 ST-4).
 *
 * Home-owned control for the dock position choice (Sidebar / Bottom bar). It
 * reads the module-scoped `useDockPosition()` store (ST-1) and writes through on
 * every change via `setDockPosition`, so a mounted AppDock repositions on the
 * SAME tick (AC1 / R-1.1 — the move is immediate, never gated on the modal's
 * Save footer). `setDockPosition` persists through `settingsService` → Tauri
 * `save_setting` → AppStore SQLite under `Fredo_dock_position` (R-1.2); the
 * default is `'sidebar'` for existing installs (R-1.3). A mount-time
 * `hydrateDockPosition()` restores the persisted value into the module store at
 * first consumer mount (idempotent + dirty-guarded — never clobbers a user
 * selection; ST-1 contract).
 *
 * This is an IMMEDIATE-APPLY control (like the Theme Preset selector) — it
 * registers NO save fn, so the appearance pane keeps no Save footer button.
 *
 * Import discipline (Architect-binding, UI/UX §9): this component is HOME-owned
 * and imports ONLY the home-owned dock store (`./dockPositionStore`) + shared
 * primitives. It must NOT import from the theming feature (and the theming
 * feature must never import it — that would be a cross-feature import). The
 * `chakra.select` token styling is therefore reproduced locally following the
 * `selectStyles` object pattern from `ThemingSettings.tsx:47-61` — `NativeSelect`
 * is NOT used because it loses Fredo's theme tokens (AGENTS NativeSelect rule).
 */

import React, { useEffect } from 'react';
import { Box, Text, chakra } from '@chakra-ui/react';
import {
  type DockPosition,
  setDockPosition,
  hydrateDockPosition,
  useDockPosition,
} from './dockPositionStore';

/** Dock position choices (labels match the backlog wording / wireframe). */
const DOCK_POSITION_OPTIONS = [
  { value: 'sidebar', label: 'Sidebar (left edge)' },
  { value: 'bottom', label: 'Bottom bar (bottom-center)' },
] as const;

/** Theme-var select styling — mirrors `ThemingSettings.tsx:47-61` so the
 *  dropdown adapts to Fredo's light/dark themes + user accent (NativeSelect
 *  renders unstyled browser defaults). */
const selectStyles = {
  width: '100%',
  p: 2,
  borderRadius: 'md',
  bg: 'var(--card-bg)',
  border: '1px solid',
  borderColor: 'var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 'sm',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'all 0.2s',
  _hover: { borderColor: 'var(--accent-primary)' },
  _focus: { outline: 'none', borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' },
} as const;

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="var(--text-secondary)"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {children as React.ReactNode}
  </Text>
);

export const DockPositionSettings: React.FC = () => {
  const position = useDockPosition();

  // Restore the persisted position into the module store at first consumer
  // mount. Idempotent (runs once) and skipped once the store is dirty — a
  // hydration read resolving late can never overwrite an in-flight selection.
  useEffect(() => {
    void hydrateDockPosition();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    void setDockPosition(e.target.value as DockPosition);
  };

  return (
    <Box p={6} borderTop="1px solid" borderColor="var(--border-color)">
      <SectionLabel>Dock</SectionLabel>
      <chakra.select
        {...selectStyles}
        value={position}
        onChange={handleChange}
        aria-label="Dock position"
      >
        {DOCK_POSITION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </chakra.select>
      <Text fontSize="xs" color="var(--text-secondary)" mt={2} lineHeight="short">
        Where the open-apps dock sits. When a window covers the desktop, the dock
        is revealed at this edge.
      </Text>
    </Box>
  );
};
