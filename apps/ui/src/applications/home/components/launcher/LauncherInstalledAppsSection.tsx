/**
 * Launcher → Installed apps (Spec #3147, ST-6; UI/UX §3.2).
 *
 * The launcher half of the two entry points the acceptance criteria describe:
 * open an installed application. It is a **sibling** of the built-in app grid —
 * not inside it, not a gridcell, not part of `showableFeatures` — and it
 * contributes **no verb, no place and no stroke**: installed applications are
 * ordinary focusable buttons outside Fredo's declared navigation surface, so
 * arrow keys never move into them and the grid's keyboard contract is untouched.
 *
 * # Absence, not an empty container (§5)
 *
 * With nothing installed (or when the query filters everything out, or when every
 * installed application is turned off — Spec #3144) the section renders
 * **nothing** — no heading, no box. A user with no openable installed apps is
 * not taught about a shelf that has nothing on it.
 *
 * # "own window" (§8(iii))
 *
 * Every entry's secondary line names its version and the literal words
 * `own window`, in uppercase `fg.subtle`. This is the non-colour carrier of the
 * accepted v1 limitation, placed exactly where the user is about to click — the
 * one place they might otherwise expect the app to appear inside Fredo.
 *
 * # Open refused (§3.2)
 *
 * `integrity_mismatch`, `integrity_record_corrupt`, `id_not_installed` and
 * `id_is_installed_app` all refuse **before any window exists**, so the failure
 * has no child document to live in. It is therefore reported here, directly
 * below the entries, and it is not sticky — the next activation attempt clears it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, chakra, Icon, Text } from '@chakra-ui/react';
import { LuPackageOpen } from 'react-icons/lu';

import { tint } from '../../../../shared/utils/colorTint';
import { openInstalledApp, installedAppErrorFrom } from '../../../../shared/installed-apps/client';
import { InstalledAppOpenRefusal } from '../../../../shared/installed-apps/RefusalBlocks';
import { refreshInstalledApps } from '../../../../shared/installed-apps/store';
import { useInstalledApps } from '../../../../shared/installed-apps/useInstalledApps';
import type {
  InstalledAppEntry,
  InstalledAppError,
} from '../../../../shared/installed-apps/types';

/** The section's decorative heading (the region's `aria-label` is the accessible name). */
export const INSTALLED_APPS_HEADING = '| INSTALLED APPS';

/** The non-colour carrier of the v1 "not an in-window panel" limitation. */
export const OWN_WINDOW_LABEL = 'own window';

/**
 * The query filter — drops turned-off applications (Spec #3144), then matches
 * `displayName` only, case-insensitive substring (the grid's own rule).
 *
 * A `disabled` application cannot be opened, so offering it here would be a
 * dead button. A `failing` application STAYS listed (its own window renders the
 * failure + Retry — architect §5: hiding it would be "silently absent").
 */
export function filterInstalledApps(
  entries: readonly InstalledAppEntry[],
  query: string,
): readonly InstalledAppEntry[] {
  const openable = entries.filter((entry) => entry.state !== 'disabled');
  const needle = query.trim().toLowerCase();
  if (!needle) return openable;
  return openable.filter((entry) => entry.displayName.toLowerCase().includes(needle));
}

export interface LauncherInstalledAppsSectionProps {
  /** The launcher's live query — the SAME source the grid filters from. */
  query: string;
}

export const LauncherInstalledAppsSection: React.FC<LauncherInstalledAppsSectionProps> = ({
  query,
}) => {
  const entries = useInstalledApps();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<InstalledAppError | null>(null);

  // The section appears when the launcher engages, so this is a user action —
  // never startup work (R-5.5). A `[]` dependency: the store notifies on its own.
  useEffect(() => {
    void refreshInstalledApps();
  }, []);

  const handleOpen = useCallback(
    async (entry: InstalledAppEntry) => {
      if (openingId !== null) return;
      // Not sticky: the previous attempt's refusal is cleared by the next attempt.
      setOpenError(null);
      setOpeningId(entry.id);
      try {
        await openInstalledApp(entry.id);
      } catch (rejection) {
        setOpenError(installedAppErrorFrom(rejection));
      } finally {
        setOpeningId(null);
      }
    },
    [openingId],
  );

  const visible = filterInstalledApps(entries, query);
  // An all-filtered-out query (or an empty registry) is an ABSENCE, never an empty
  // `| INSTALLED APPS` box — and with no entries there is no row for the refusal to
  // sit under. The refusal state itself is not lost: it clears on the next
  // activation attempt and cannot be produced without a click on an entry.
  if (visible.length === 0) return null;

  return (
    <Box
      role="region"
      aria-label="Installed apps"
      data-testid="launcher-installed-apps-section"
      width="100%"
      display="flex"
      flexDirection="column"
      gap={3}
    >
      <Text
        as="div"
        aria-hidden="true"
        color="fg.muted"
        fontSize="11px"
        textTransform="uppercase"
        letterSpacing="0.05em"
      >
        {INSTALLED_APPS_HEADING}
      </Text>

      <Box display="flex" flexWrap="wrap" gap={3} width="100%">
        {visible.map((entry) => (
          <chakra.button
            key={entry.id}
            type="button"
            data-testid="launcher-installed-app"
            data-app-id={entry.id}
            aria-label={entry.displayName}
            aria-busy={openingId === entry.id ? 'true' : undefined}
            disabled={openingId !== null}
            onClick={() => void handleOpen(entry)}
            display="flex"
            alignItems="center"
            gap={2.5}
            textAlign="left"
            // G-274: the ONLY per-entry clamp; the name is the sole ellipsizing child.
            maxWidth="200px"
            paddingX={3}
            paddingY={2}
            borderRadius="8px"
            borderWidth="1px"
            borderStyle="solid"
            cursor="pointer"
            bg="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            transition="background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease"
            _hover={{ bg: tint('var(--accent-primary)', 14) }}
            _active={{ transform: 'translateY(1px)' }}
            _disabled={{ cursor: 'default', opacity: 0.7 }}
            css={{
              '&:focus-visible': {
                outline: '2px solid var(--accent-primary)',
                outlineOffset: '2px',
              },
            }}
          >
            <Box as="span" display="flex" flexShrink={0} aria-hidden="true">
              <Icon as={LuPackageOpen} boxSize="20px" color="var(--accent-primary)" />
            </Box>
            <Box display="flex" flexDirection="column" minWidth={0}>
              {/* The ONE ellipsizing child (G-274). */}
              <Text fontSize="12px" lineHeight="tight" lineClamp={1} color="fg.default">
                {entry.displayName}
              </Text>
              {/* Non-colour limitation label — exempt from the clamp (G-274). */}
              <Text fontSize="10px" color="fg.subtle" textTransform="uppercase" letterSpacing="0.04em">
                {entry.version} · {OWN_WINDOW_LABEL}
              </Text>
            </Box>
          </chakra.button>
        ))}
      </Box>

      {/* Below the entries, never sticky — the code names which app failed via its
          row immediately above (§3.2). */}
      {openError !== null ? (
        <InstalledAppOpenRefusal code={openError.code} detail={openError.detail} />
      ) : null}
    </Box>
  );
};
