/**
 * IngestAutostartSettings — Settings → Ingest (Spec #2992 ST-7; EARS R-4).
 *
 * The user-facing control for the per-user login auto-start entry that launches
 * `fredo ingest` (backend: `applications/settings/autostart.rs`, ST-6). Mirrors the
 * canonical `Switch.Root` + `settingsService` pattern of `TelemetrySettings`:
 * every toggle writes through the backend and reflects the EFFECTIVE registry
 * state returned by `ingest_autostart_get`/`ingest_autostart_set`.
 *
 * The daemon status is informational only (AC3): it reads the existing
 * `pg_supervisor_status` command — no daemon lifecycle control and no new IPC.
 *
 * Testids (the plan's UI/UX names block — consumed by the tester):
 *   settings-nav-ingest                  (sidebar nav button — SettingsSurface)
 *   settings-ingest-autostart-section    (section root)
 *   settings-ingest-autostart-toggle     (the Switch.Root)
 *   settings-ingest-autostart-status     ("Auto-start on login: On/Off" + detail)
 *   settings-ingest-daemon-status        (pg_supervisor_status.state)
 *
 * Accessibility (G-266): the switch is a real checkbox (`Switch.HiddenInput`)
 * with an accessible name; status changes are announced by a SECTION-LOCAL
 * `role="status"` + `aria-live="polite"` wrapper (never a shared live-region
 * hook). The error line is persistent and icon + color + text (never color alone).
 *
 * G-274: the ONE ellipsize target is the `Command: {view.command}` value (mono,
 * `truncate` + `title`). The `Auto-start on login: On/Off`, `Entry:` and
 * `No login entry installed.` lines are EXEMPT and never truncated.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Card,
  chakra,
  HStack,
  Icon,
  Separator,
  Skeleton,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircle,
  LuCircleCheck,
  LuInfo,
  LuLoader,
  LuTriangleAlert,
} from 'react-icons/lu';
import {
  DEFAULT_INGEST_AUTOSTART_VIEW,
  getIngestAutostart,
  getIngestDaemonStatus,
  setIngestAutostart,
  type IngestAutostartView,
  type IngestDaemonState,
  type PgSupervisorStatusView,
} from './ingestAutostartStore';

// ── Copy (exact strings from the plan's copy table) ──────────────────────────

const SECTION_TITLE = 'Headless ingest daemon';
const SECTION_HELP =
  'Runs fredo ingest at login so app events keep persisting while the desktop app is closed. No admin rights required.';
const TOGGLE_LABEL = 'Start daemon at login';
const TOGGLE_HELP = 'Installs a per-user Windows login entry. No admin rights required.';
const TOGGLE_A11Y_LABEL = 'Start headless ingest daemon at login';
const AUTOSTART_ON = 'Auto-start on login: On';
const AUTOSTART_OFF = 'Auto-start on login: Off';
const OFF_DETAIL = 'No login entry installed.';
const APPLYING = 'Applying…';
const ERROR_PREFIX = 'Could not update login auto-start:';

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DaemonDisplay {
  readonly label: string;
  readonly color: string;
  readonly icon: React.ElementType;
}

/** The five daemon states → label + semantic token + icon (state matrix). */
function daemonDisplay(state: IngestDaemonState): DaemonDisplay {
  switch (state) {
    case 'attached':
      return { label: 'Attached to a headless daemon', color: 'status.info', icon: LuInfo };
    case 'ready':
      return {
        label: 'Running (this app owns the cluster)',
        color: 'status.success',
        icon: LuCircleCheck,
      };
    case 'starting':
      return { label: 'Starting…', color: 'status.warning', icon: LuLoader };
    case 'failed':
      return { label: 'Stopped / failed', color: 'status.error', icon: LuTriangleAlert };
    case 'disabled':
    default:
      return { label: 'Not running', color: 'fg.muted', icon: LuCircle };
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export const IngestAutostartSettings: React.FC = () => {
  const [view, setView] = useState<IngestAutostartView | null>(null);
  const [daemon, setDaemon] = useState<PgSupervisorStatusView | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: reflect the EFFECTIVE registry state + the current daemon state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [autostart, status] = await Promise.allSettled([
        getIngestAutostart(),
        getIngestDaemonStatus(),
      ]);
      if (cancelled) return;
      setView(
        autostart.status === 'fulfilled'
          ? autostart.value
          : { ...DEFAULT_INGEST_AUTOSTART_VIEW },
      );
      setDaemon(status.status === 'fulfilled' ? status.value : { state: 'disabled' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      const confirmed = view;
      setError(null);
      setApplying(true);
      // Optimistic flip (<100 ms, Doherty) — reverted on rejection.
      setView((current) => (current ? { ...current, enabled: checked } : current));
      try {
        const next = await setIngestAutostart(checked);
        setView(next);
      } catch (cause) {
        setView(confirmed);
        setError(messageOf(cause));
      } finally {
        setApplying(false);
      }
    },
    [view],
  );

  const loading = view === null;
  const display = daemonDisplay(daemon?.state ?? 'disabled');

  return (
    <Card.Root
      data-testid="settings-ingest-autostart-section"
      bg="bg.surface"
      border="1px solid"
      borderColor="border.default"
      borderRadius="lg"
      w="100%"
    >
      <Card.Body display="flex" flexDirection="column" gap={4}>
        {/* ── Title + help ── */}
        <VStack align="stretch" gap={0}>
          <Text as="h3" fontWeight="600" color="fg.default">
            {SECTION_TITLE}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {SECTION_HELP}
          </Text>
        </VStack>

        {/* ── Toggle row ── */}
        <HStack justify="space-between" align="center" gap={4}>
          <VStack align="start" gap={0}>
            <Text fontSize="sm" fontWeight="500" color="fg.default">
              {TOGGLE_LABEL}
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {TOGGLE_HELP}
            </Text>
          </VStack>
          {loading ? (
            <Skeleton
              data-testid="settings-ingest-autostart-toggle-skeleton"
              height="24px"
              width="44px"
              borderRadius="full"
              flexShrink={0}
            />
          ) : (
            <Switch.Root
              data-testid="settings-ingest-autostart-toggle"
              checked={view.enabled}
              disabled={applying}
              onCheckedChange={(details) => void handleToggle(details.checked)}
              colorPalette="purple"
              size="md"
              label={TOGGLE_A11Y_LABEL}
              flexShrink={0}
            >
              <Switch.HiddenInput aria-label={TOGGLE_A11Y_LABEL} />
              <Switch.Control />
            </Switch.Root>
          )}
        </HStack>

        <Separator borderColor="border.default" />

        {/* ── Status region (section-local live region — G-266) ── */}
        <VStack role="status" aria-live="polite" aria-busy={applying} align="stretch" gap={2}>
          {/* Auto-start status */}
          <VStack data-testid="settings-ingest-autostart-status" align="stretch" gap={1}>
            {loading ? (
              <>
                <Skeleton height="4" width="60%" />
                <Skeleton height="4" width="80%" />
              </>
            ) : error ? (
              <HStack color="status.error" gap={1} align="flex-start">
                <Icon as={LuTriangleAlert} boxSize="14px" flexShrink={0} mt="2px" />
                <Text fontSize="sm">
                  {ERROR_PREFIX} {error}
                </Text>
              </HStack>
            ) : applying ? (
              <Text fontSize="sm" color="fg.muted">
                {APPLYING}
              </Text>
            ) : view.enabled ? (
              <>
                <Text fontSize="sm" color="fg.default">
                  {AUTOSTART_ON}
                </Text>
                <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
                  Entry: <chakra.span fontFamily="mono">{view.entry}</chakra.span>
                </Text>
                <HStack gap={1} minW={0} maxW="100%" align="baseline">
                  <Text fontSize="sm" color="fg.muted" flexShrink={0}>
                    Command:
                  </Text>
                  <Text
                    fontSize="sm"
                    color="fg.muted"
                    fontFamily="mono"
                    truncate
                    title={view.command ?? undefined}
                    minW={0}
                    flex={1}
                  >
                    {view.command}
                  </Text>
                </HStack>
              </>
            ) : (
              <>
                <Text fontSize="sm" color="fg.default">
                  {AUTOSTART_OFF}
                </Text>
                <Text fontSize="sm" color="fg.muted">
                  {OFF_DETAIL}
                </Text>
              </>
            )}
          </VStack>

          {/* Daemon status (informational — AC3) */}
          <HStack
            data-testid="settings-ingest-daemon-status"
            gap={2}
            align="center"
            color={loading ? 'fg.muted' : display.color}
          >
            <Text fontSize="sm" color="fg.muted">
              Daemon:
            </Text>
            {loading ? (
              <Skeleton height="4" width="140px" />
            ) : (
              <>
                <Icon as={display.icon} boxSize="14px" flexShrink={0} />
                <Text fontSize="sm">{display.label}</Text>
              </>
            )}
          </HStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
};
