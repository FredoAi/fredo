/**
 * IngestAutostartSettings — Settings → Background capture (Spec #3193 ST-2;
 * originally #2992 ST-7).
 *
 * The user-facing control for the per-user login entry that starts the RESIDENT
 * Fredo at sign-in (backend: `applications/settings/autostart.rs`). Mirrors the
 * canonical `Switch.Root` + `settingsService` pattern of `TelemetrySettings`:
 * every toggle writes through the backend and reflects the EFFECTIVE registry
 * state returned by `ingest_autostart_get`/`ingest_autostart_set`.
 *
 * Aesthetic direction (UI/UX, binding): calm, single-question card — one
 * decision ("start with me at sign-in?"), one state line, no plumbing. The
 * registry path, the raw command line and the five headless lifecycle rows are
 * gone: they were extraneous load on a binary toggle, and the copy they carried
 * described a separate background process that no longer exists now that the
 * login entry launches this same application resident.
 *
 * Platform availability and entry ownership come FROM THE BACKEND
 * (`IngestAutostartView.available`/`.owned`) — the renderer never sniffs the
 * platform (no `navigator`, no `platform()`), so a non-Windows host renders the
 * `unavailable` state from the truth rather than failing on a missing `reg.exe`.
 *
 * Timing is stated with every state (UI/UX wording rule 4): the
 * `settings-ingest-autostart-timing` line is PERMANENT ("the next time you sign
 * in"), and only the just-set sentences are component state (`justSet`), cleared
 * on unmount and on the next change — never persisted, because "this session is
 * already capturing" is false after a restart.
 *
 * Testids (the plan's UI/UX names block — consumed by the tester):
 *   settings-nav-ingest                  (sidebar nav button — SettingsSurface)
 *   settings-ingest-autostart-section    (section root)
 *   settings-ingest-autostart-toggle     (the Switch.Root)
 *   settings-ingest-autostart-toggle-skeleton (loading state)
 *   settings-ingest-autostart-status     (STATUS_ON / STATUS_OFF / STATUS_UNAVAILABLE)
 *   settings-ingest-autostart-timing     (the takes-effect / applying / error line)
 * The retired daemon-status hook and its status row were removed by this change —
 * capture liveness is `PostgresSettings`' job, not this surface's.
 *
 * Accessibility (G-266): the switch is a real checkbox (`Switch.HiddenInput`)
 * with an accessible name and `aria-describedby` pointing at the help sentence
 * and the timing line. Status changes are announced by ONE SECTION-LOCAL
 * `role="status"` + `aria-live="polite"` region (never a shared live-region
 * hook); the region is `aria-busy` while loading or applying. The error line is
 * persistent and icon + colour + text (never colour alone); the unavailable
 * state is NEUTRAL (`fg.muted` + `status.info`), because unsupported is not a
 * failure.
 *
 * No text is truncated any more (the raw command value was the one ellipsize
 * target) — every line wraps in full, the disabled-exempt state lines included.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, HStack, Icon, Separator, Skeleton, Switch, Text, VStack } from '@chakra-ui/react';
import { LuInfo, LuTriangleAlert } from 'react-icons/lu';
import {
  DEFAULT_INGEST_AUTOSTART_VIEW,
  getIngestAutostart,
  setIngestAutostart,
  type IngestAutostartView,
} from './ingestAutostartStore';

// ── Copy (verbatim from the plan's UI/UX copy table) ──────────────────────────

const SECTION_TITLE = 'Background capture';
const SECTION_HELP = 'Capture agent activity even when no Fredo window is open.';
const TOGGLE_LABEL = 'Start background capture when I sign in';
const TOGGLE_HELP =
  'Fredo starts without a window when you sign in and stays in the notification area until you quit it.';
const TOGGLE_A11Y_LABEL = 'Start background capture when I sign in';
const STATUS_ON = 'Background capture: On';
const STATUS_OFF = 'Background capture: Off';
const STATUS_UNAVAILABLE = 'Background capture: Unavailable on this platform';
const DETAIL_ON = 'Fredo starts in the background the next time you sign in.';
const DETAIL_OFF = 'Fredo does not start when you sign in. Capture runs only while Fredo is open.';
const DETAIL_ON_JUST_SET =
  'Takes effect the next time you sign in. This session is already capturing, so nothing changes right now.';
const DETAIL_OFF_JUST_SET =
  'The login item is removed. This session keeps capturing until you quit Fredo.';
const DETAIL_UNAVAILABLE =
  'The login item is available on Windows only for now. Fredo still captures while it is open.';
const APPLYING = 'Applying…';
const ERROR_PREFIX = 'Could not update background capture:';

const HELP_ID = 'settings-ingest-autostart-help';
const TIMING_ID = 'settings-ingest-autostart-timing';

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Component ─────────────────────────────────────────────────────────────────

export const IngestAutostartSettings: React.FC = () => {
  const [view, setView] = useState<IngestAutostartView | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Just-set timing sentence — COMPONENT STATE ONLY: cleared on unmount and on
  // the next change. Persisting it would make "this session is already
  // capturing" a lie after the next restart.
  const [justSet, setJustSet] = useState<'on' | 'off' | null>(null);

  // On mount: reflect the EFFECTIVE login-entry state (backend read-back).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: IngestAutostartView;
      try {
        next = await getIngestAutostart();
      } catch {
        next = { ...DEFAULT_INGEST_AUTOSTART_VIEW };
      }
      if (!cancelled) setView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      const confirmed = view;
      if (!confirmed) return;
      setError(null);
      setJustSet(null);
      setApplying(true);
      // Optimistic flip (<100 ms, Doherty) — reverted on rejection. Enabling
      // always rewrites the entry with THIS binary's current form, so it is
      // optimistically ours; the backend read-back below is authoritative.
      setView({ ...confirmed, enabled: checked, owned: checked ? true : confirmed.owned });
      try {
        const next = await setIngestAutostart(checked);
        setView(next);
        setJustSet(next.enabled && next.owned ? 'on' : 'off');
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
  const available = view ? view.available : true;
  // "On" means THIS Fredo owns a login entry that starts it at sign-in. A value
  // that is present but points at a different executable is not ours: it must
  // never be displayed as a working On (that would claim capture starts at
  // sign-in while it silently does not). Enabling once rewrites it with the
  // current form — that is the recovery path, worded as an ordinary Off state.
  const effectiveOn = view ? view.enabled && view.owned : false;
  const unavailable = !loading && !available;
  const checked = !loading && !unavailable && effectiveOn;

  const statusText = unavailable ? STATUS_UNAVAILABLE : effectiveOn ? STATUS_ON : STATUS_OFF;
  const timingText = applying
    ? APPLYING
    : justSet === 'on'
      ? DETAIL_ON_JUST_SET
      : justSet === 'off'
        ? DETAIL_OFF_JUST_SET
        : effectiveOn
          ? DETAIL_ON
          : DETAIL_OFF;

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
            <Text id={HELP_ID} fontSize="xs" color="fg.muted">
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
              checked={checked}
              disabled={applying || unavailable}
              onCheckedChange={(details) => void handleToggle(details.checked)}
              colorPalette="purple"
              size="md"
              label={TOGGLE_A11Y_LABEL}
              flexShrink={0}
            >
              <Switch.HiddenInput
                aria-label={TOGGLE_A11Y_LABEL}
                aria-describedby={`${HELP_ID} ${TIMING_ID}`}
              />
              <Switch.Control />
            </Switch.Root>
          )}
        </HStack>

        <Separator borderColor="border.default" />

        {/* ── State line + timing (ONE section-local live region — G-266) ── */}
        <VStack
          role="status"
          aria-live="polite"
          aria-busy={applying || loading}
          align="stretch"
          gap={1}
        >
          <VStack data-testid="settings-ingest-autostart-status" align="stretch" gap={1}>
            {loading ? (
              <>
                <Skeleton height="4" width="60%" />
                <Skeleton height="4" width="80%" />
              </>
            ) : (
              <Text fontSize="sm" color="fg.default">
                {statusText}
              </Text>
            )}
          </VStack>

          <VStack data-testid={TIMING_ID} align="stretch" gap={1}>
            {loading ? null : error ? (
              <HStack color="status.error" gap={1} align="flex-start">
                <Icon as={LuTriangleAlert} boxSize="14px" flexShrink={0} mt="2px" />
                <Text fontSize="sm">
                  {ERROR_PREFIX} {error}
                </Text>
              </HStack>
            ) : unavailable ? (
              <HStack color="fg.muted" gap={1} align="flex-start">
                <Icon as={LuInfo} boxSize="14px" flexShrink={0} mt="2px" color="status.info" />
                <Text fontSize="sm">{DETAIL_UNAVAILABLE}</Text>
              </HStack>
            ) : (
              <Text fontSize="sm" color="fg.muted">
                {timingText}
              </Text>
            )}
          </VStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
};
