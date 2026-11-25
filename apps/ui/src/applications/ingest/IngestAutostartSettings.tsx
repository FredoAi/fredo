/**
 * IngestAutostartSettings — Settings → Background capture (Spec #3193 ST-2;
 * reworked by Spec #3195 ST-2; originally #2992 ST-7).
 *
 * The card answers TWO separate questions, in two separate registers:
 *
 *   1. CAPTURE — is this process receiving agent activity right now? Capture runs
 *      while the Fredo PROCESS runs (including with no Fredo window open) and
 *      stops when Fredo is quit. The line is derived from the EXISTING
 *      `stream_health` command through the pane-local fetcher
 *      (`captureStatus.ts`) — never from the login-entry boolean, never from
 *      webview-local continuity.
 *   2. THE LOGIN ENTRY — should Fredo start when the operator signs in? The
 *      switch writes the per-user login entry (backend:
 *      `applications/settings/autostart.rs`) and reflects the EFFECTIVE registry
 *      state returned by `ingest_autostart_get`/`ingest_autostart_set`.
 *
 * The two subjects must never claim each other: a login-entry sentence may not
 * assert that capture is happening (it is false whenever the capture line above
 * reads "Not running"), and the capture line never speaks for the login item.
 * That separation IS the fix (#3195): the pre-change card rendered the
 * login-entry boolean in capture vocabulary (an On/Off "capture" line), so an
 * operator with capture working read a stopped claim.
 *
 * Aesthetic direction (UI/UX, binding): calm, single-question card per register —
 * one decision ("start with me at sign-in?"), one state line, no plumbing. The
 * registry path, the raw command line and the five headless lifecycle rows are
 * gone; the copy they carried described a separate background process that no
 * longer exists now that the login entry launches this same application resident.
 *
 * Platform availability and entry ownership come FROM THE BACKEND
 * (`IngestAutostartView.available`/`.owned`) — the renderer never sniffs the
 * platform (no `navigator`, no `platform()`), so a non-Windows host renders the
 * `unavailable` state from the truth rather than failing on a missing `reg.exe`.
 *
 * Timing is stated with every state (UI/UX wording rule 4): the
 * `settings-ingest-autostart-timing` line is PERMANENT ("the next time you sign
 * in"), and only the just-set sentences are component state (`justSet`), cleared
 * on unmount and on the next change — never persisted.
 *
 * Testids (the plan's UI/UX names block — consumed by the tester):
 *   settings-nav-ingest                     (sidebar nav button — SettingsSurface)
 *   settings-ingest-autostart-section       (section root)
 *   settings-ingest-autostart-toggle        (the Switch.Root)
 *   settings-ingest-autostart-toggle-skeleton (loading state)
 *   settings-ingest-autostart-help          (the switch's first described-by target)
 *   settings-ingest-capture-status          (the capture word line + state icon)
 *   settings-ingest-capture-detail          (the capture reason sentence; absent while running)
 *   settings-ingest-autostart-timing        (the takes-effect / applying / error line)
 * RETIRED by this change: the former login-entry status line (which rendered the
 * login-entry boolean in capture vocabulary) and the older daemon-status row —
 * the capture-status line replaces both, and the unit suite pins both ids absent
 * from the document.
 *
 * Accessibility (G-266): the switch is a real checkbox (`Switch.HiddenInput`)
 * with an accessible name and `aria-describedby` pointing at the help sentence
 * and the timing line. Status changes are announced by ONE SECTION-LOCAL
 * `role="status"` + `aria-live="polite"` + `aria-atomic="true"` region (never a
 * shared live-region hook, never a second region for the capture block); the
 * region is `aria-busy` while the first read is unresolved or a write is in
 * flight — never per poll. The capture state hue rides the DECORATIVE icon only
 * (`aria-hidden`): the word carries the state, and `fg.default` keeps the line at
 * the section title's contrast in every state. The error line is persistent and
 * icon + colour + text; the unavailable state is NEUTRAL (`fg.muted` +
 * `status.info`), because unsupported is not a failure.
 *
 * `CAPTURE_SCOPE` sits ABOVE the toggle, permanently, and OUTSIDE the live
 * region: the lifetime rule has to be read before the switch's label ("…and also
 * start it when I sign in"), and an invariant that never changes must not be
 * re-announced on every state change.
 *
 * No text is truncated — every line wraps in full, the disabled-exempt state
 * lines included.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, HStack, Icon, Separator, Skeleton, Switch, Text, VStack } from '@chakra-ui/react';
import { LuCircleCheck, LuInfo, LuTriangleAlert } from 'react-icons/lu';
import { STREAM_HEALTH_CHECK_INTERVAL_MS } from '../../shared/hooks/streamHealth';
import {
  DEFAULT_INGEST_AUTOSTART_VIEW,
  getIngestAutostart,
  setIngestAutostart,
  type IngestAutostartView,
} from './ingestAutostartStore';
import {
  getCaptureStatus,
  sameCaptureStatus,
  type CaptureStatusView,
  type CaptureRunState,
} from './captureStatus';

// ── Copy (verbatim from the plan's UI/UX copy table) ──────────────────────────

const SECTION_TITLE = 'Background capture';
const SECTION_HELP = 'Capture agent activity even when no Fredo window is open.';
const CAPTURE_SCOPE =
  'Capture runs whenever Fredo is running — including when no Fredo window is open. It stops when you quit Fredo.';
const TOGGLE_LABEL = 'Start background capture when I sign in';
const TOGGLE_HELP =
  'Fredo starts without a window when you sign in and stays in the notification area until you quit it.';
const TOGGLE_A11Y_LABEL = 'Start background capture when I sign in';

// CAPTURE zone — claims about capture liveness only.
const CAPTURE_RUNNING = 'Capture: Running';
const CAPTURE_NOT_RUNNING = 'Capture: Not running';
const CAPTURE_UNAVAILABLE = 'Capture: Status unavailable';
const CAPTURE_NOT_RUNNING_DETAIL = 'Capture is not receiving agent activity right now.';
const CAPTURE_UNAVAILABLE_DETAIL = 'Fredo could not report whether capture is running.';

/**
 * The typed-cause sentence. `code` (`addrInUse` / `bindFailed`) is deliberately
 * not rendered: both mean "could not start", and the port is the actionable
 * datum — the health LED's popover already carries the classification.
 */
function captureIngestDetail(receiver: 'grpc' | 'http', port: number): string {
  return `Capture is not receiving agent activity: the ${
    receiver === 'grpc' ? 'gRPC' : 'HTTP'
  } telemetry receiver on port ${port} could not start.`;
}

// TOGGLE / timing zone — claims about the LOGIN ENTRY only. No sentence here may
// assert that capture is (or is not) happening: the capture line above them can
// read "Not running" in a reachable state, so a capture claim would contradict it.
const DETAIL_ON = 'Fredo starts in the background the next time you sign in.';
const DETAIL_OFF = 'Fredo does not start when you sign in.';
const DETAIL_ON_JUST_SET = 'Takes effect the next time you sign in. Nothing else changes now.';
const DETAIL_OFF_JUST_SET =
  'The login item is removed. Nothing changes in this session until you quit Fredo.';
const DETAIL_UNAVAILABLE = 'The login item is available on Windows only for now.';
const APPLYING = 'Applying…';
const ERROR_PREFIX = 'Could not update background capture:';

const HELP_ID = 'settings-ingest-autostart-help';
const TIMING_ID = 'settings-ingest-autostart-timing';

// ── Capture state presentation (icon shape + hue; the WORD carries the state) ──

interface CapturePresentation {
  text: string;
  icon: typeof LuCircleCheck;
  /** Colour of the DECORATIVE icon only — the word line stays `fg.default`. */
  iconColor: string;
}

const CAPTURE_PRESENTATION: Record<CaptureRunState, CapturePresentation> = {
  running: { text: CAPTURE_RUNNING, icon: LuCircleCheck, iconColor: 'status.success' },
  notRunning: { text: CAPTURE_NOT_RUNNING, icon: LuTriangleAlert, iconColor: 'status.warning' },
  unknown: { text: CAPTURE_UNAVAILABLE, icon: LuInfo, iconColor: 'status.info' },
};

/** The reason sentence, or `null` while running (running needs no explanation). */
function captureDetail(status: CaptureStatusView): string | null {
  if (status.state === 'running') return null;
  if (status.state === 'unknown') return CAPTURE_UNAVAILABLE_DETAIL;
  const failure = status.ingestFailure;
  return failure
    ? captureIngestDetail(failure.receiver, failure.port)
    : CAPTURE_NOT_RUNNING_DETAIL;
}

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
  // the next change. Persisting it would make the timing note a lie after the
  // next restart.
  const [justSet, setJustSet] = useState<'on' | 'off' | null>(null);
  // The capture read: `null` until the FIRST probe resolves (skeleton), then a
  // settled projection. Nothing is seeded from a context/cached value.
  const [captureStatus, setCaptureStatus] = useState<CaptureStatusView | null>(null);

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

  // Capture liveness: ONE bounded probe on mount and per interval, cleaned up on
  // unmount. A monotonic guard drops a superseded response; the setter is
  // VALUE-GUARDED on the rendered projection, so a steady poll is a no-op
  // `setState` (React bails out) and the live region is never re-announced.
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const tick = async () => {
      const mine = (seq += 1);
      const next = await getCaptureStatus();
      if (cancelled || mine !== seq) return;
      setCaptureStatus((prev) => (prev && sameCaptureStatus(prev, next) ? prev : next));
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, STREAM_HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
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
  // never be displayed as a working On (that would claim Fredo starts at sign-in
  // while it silently does not). Enabling once rewrites it with the current form
  // — that is the recovery path, worded as an ordinary Off state.
  const effectiveOn = view ? view.enabled && view.owned : false;
  const unavailable = !loading && !available;
  const checked = !loading && !unavailable && effectiveOn;

  const timingText = applying
    ? APPLYING
    : justSet === 'on'
      ? DETAIL_ON_JUST_SET
      : justSet === 'off'
        ? DETAIL_OFF_JUST_SET
        : effectiveOn
          ? DETAIL_ON
          : DETAIL_OFF;

  const capture = captureStatus ? CAPTURE_PRESENTATION[captureStatus.state] : null;
  const captureReason = captureStatus ? captureDetail(captureStatus) : null;
  // Busy while the FIRST read is unresolved or a write is in flight. A settled
  // poll never flips this — a busy flip is itself an announcement-relevant
  // mutation.
  const busy = loading || applying || captureStatus === null;

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
        {/* ── Title + help + the permanent capture-scope sentence ──
            CAPTURE_SCOPE is deliberately OUTSIDE the live region: it never
            changes, so re-announcing it on every state change is noise on the
            one signal that matters. It primes the reader BEFORE the toggle's
            label so the switch reads as "…and also start it when I sign in". */}
        <VStack align="stretch" gap={0}>
          <Text as="h3" fontWeight="600" color="fg.default">
            {SECTION_TITLE}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {SECTION_HELP}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {CAPTURE_SCOPE}
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

        {/* ── ONE section-local live region (G-266): the capture line, its
            reason, and the login-entry timing line. Two subjects, one region —
            separated by position and weight, never by a second `role="status"`. */}
        <VStack
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-busy={busy}
          align="stretch"
          gap={1}
        >
          <VStack data-testid="settings-ingest-capture-status" align="stretch" gap={1}>
            {capture === null ? (
              // First probe in flight: a placeholder, NEVER a guessed word.
              <Skeleton height="4" width="45%" />
            ) : (
              <HStack gap={1} align="flex-start">
                <Icon
                  as={capture.icon}
                  boxSize="14px"
                  flexShrink={0}
                  mt="2px"
                  color={capture.iconColor}
                  aria-hidden="true"
                />
                <Text fontSize="sm" color="fg.default">
                  {capture.text}
                </Text>
              </HStack>
            )}
          </VStack>

          {captureReason === null ? null : (
            <Text data-testid="settings-ingest-capture-detail" fontSize="sm" color="fg.muted">
              {captureReason}
            </Text>
          )}

          <VStack data-testid={TIMING_ID} align="stretch" gap={1}>
            {loading ? null : error ? (
              <HStack color="status.error" gap={1} align="flex-start">
                <Icon as={LuTriangleAlert} boxSize="14px" flexShrink={0} mt="2px" aria-hidden="true" />
                <Text fontSize="sm">
                  {ERROR_PREFIX} {error}
                </Text>
              </HStack>
            ) : unavailable ? (
              <HStack color="fg.muted" gap={1} align="flex-start">
                <Icon
                  as={LuInfo}
                  boxSize="14px"
                  flexShrink={0}
                  mt="2px"
                  color="status.info"
                  aria-hidden="true"
                />
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
