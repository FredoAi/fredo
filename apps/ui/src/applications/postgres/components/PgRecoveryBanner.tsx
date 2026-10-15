/**
 * PgRecoveryBanner — the prominent, NON-MODAL app-shell recovery affordance for
 * the embedded-PostgreSQL credential mismatch (Spec #3067 ST-5; EARS R-1..R-4).
 *
 * Self-contained: it polls the EXISTING `pg_supervisor_status` command
 * (`usePgSupervisorStatus`), renders ONLY when the shared classifier says
 * `'drifted'` (`state === 'failed' && failureKind === 'authMismatch'`), and routes
 * the explicitly-acknowledged reset through the EXISTING `resetPostgresDatabase()`
 * — there is no new IPC and no new credential mechanism.
 *
 * Design contract (plan UI/UX §Component spec):
 *  - Returns a FRAGMENT so the bar and the portaled dialog are siblings; returns
 *    `null` for every non-drifted status (`ready`, `unavailable`, or a `failed`
 *    with `portInUse`/`unknown` — R-4). No DOM at all when hidden.
 *  - Non-modal: `role="status"` + `aria-live="polite"` + `aria-atomic`, no
 *    backdrop for the bar, no focus theft on appearance; the alertdialog traps
 *    focus only while it is open (initial focus = Cancel, final focus = trigger).
 *  - Never auto-invokes reset (R-3): the confirm handler is the ONLY call site of
 *    `resetPostgresDatabase()`, and it is ack-gated.
 *  - Colour is never the only signal (icon + literal words); every value is a
 *    theming token / CSS var — no hardcoded hex/rgba, no alpha-append onto a
 *    `var()`. The destructive pair is the contract-registered
 *    `status.onSolids` on `status.error` (matrix row `status-error-label`).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  Flex,
  Heading,
  HStack,
  Icon,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';

import { classifySupervisorStatus, resetPostgresDatabase } from '../postgresConfigStore';
import { usePgSupervisorStatus } from '../usePgSupervisorStatus';

// ── Copy (exact strings from the plan's copy table) ───────────────────────────

const BANNER_TITLE = 'Database failed to start — password mismatch';
const BANNER_CAUSE = 'The saved database password no longer matches the running cluster.';
const BANNER_WARNING =
  'Resetting permanently deletes all local data — sessions, telemetry, and application data. There is no backup.';
const RESET_LABEL = 'Reset database…';
const RECONNECTING_LABEL = 'Reconnecting…';
const DIALOG_TITLE = 'Reset the database?';
const DIALOG_BODY =
  'This re-initializes the embedded PostgreSQL cluster with the currently stored password. All data — sessions, events, telemetry, and application data — will be permanently deleted. This cannot be undone and there is no backup.';
const ACK_LABEL = 'I understand all local data will be permanently deleted.';
const CONFIRM_LABEL = 'Reset database';
const CANCEL_LABEL = 'Cancel';
const RESET_IN_PROGRESS = 'Re-initializing the database… all data will be deleted.';

/** Entrance motion (opacity + translate only), suppressed under reduced motion. */
const BANNER_MOTION = {
  '@keyframes pgBannerIn': {
    '0%': { opacity: 0, transform: 'translateY(-6px)' },
    '100%': { opacity: 1, transform: 'translateY(0)' },
  },
  animation: 'pgBannerIn 200ms ease-out',
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
} as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Component ─────────────────────────────────────────────────────────────────

export const PgRecoveryBanner: React.FC = () => {
  const status = usePgSupervisorStatus();
  const kind = classifySupervisorStatus(status);
  const titleId = React.useId();

  // Reset-confirmation state.
  const [resetOpen, setResetOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // True between a successful reset and the poll observing a non-drifted status
  // (Doherty acknowledgement; the poll stays the source of truth for clearing).
  const [justReset, setJustReset] = useState(false);

  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Clear the "awaiting ready" acknowledgement once the poll observes a
  // non-drifted status, so a later drift episode starts fresh. Guarded by the
  // PRIMITIVE `kind` (not snapshot identity) — no re-render loop (#523).
  useEffect(() => {
    if (kind !== 'drifted') setJustReset(false);
  }, [kind]);

  const openReset = useCallback(() => {
    setAck(false);
    setResetError(null);
    setJustReset(false);
    setResetOpen(true);
  }, []);

  const closeReset = useCallback(() => {
    if (resetting) return;
    setResetOpen(false);
    setAck(false);
    setResetError(null);
  }, [resetting]);

  // The ONLY call site of `resetPostgresDatabase()` — never auto-invoked (R-3).
  const confirmReset = useCallback(async () => {
    if (resetting || !ack) return;
    setResetError(null);
    setResetting(true);
    try {
      const result = await resetPostgresDatabase();
      if (!result.ok) {
        // Failure: stay open, show the error inline, keep the ack for a retry.
        setResetError(result.error ?? 'unknown error');
        return;
      }
      // Success: close the dialog and acknowledge. The banner is NOT cleared
      // optimistically — the poll is the source of truth (R-2).
      setResetOpen(false);
      setAck(false);
      setJustReset(true);
    } catch (cause) {
      setResetError(messageOf(cause));
    } finally {
      setResetting(false);
    }
  }, [resetting, ack]);

  // Hidden for every non-drifted status (R-4) — no DOM at all.
  if (kind !== 'drifted') return null;

  return (
    <>
      <Flex
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-labelledby={titleId}
        data-testid="pg-recovery-banner"
        width="100%"
        flexShrink={0}
        direction={{ base: 'column', sm: 'row' }}
        align={{ base: 'stretch', sm: 'flex-start' }}
        gap={3}
        px={{ base: 3, md: 4 }}
        py={3}
        bg="bg.surface"
        borderLeftWidth="4px"
        borderLeftColor="status.error"
        borderBottomWidth="1px"
        borderBottomColor="border.subtle"
        css={BANNER_MOTION}
      >
        <HStack align="flex-start" gap={3} flex="1" minW={0}>
          <Icon
            as={LuTriangleAlert}
            boxSize="18px"
            color="status.error"
            flexShrink={0}
            mt="2px"
            aria-hidden="true"
          />
          <VStack align="flex-start" gap={1} minW={0}>
            <Heading
              as="h2"
              id={titleId}
              size="sm"
              color="fg.default"
              data-testid="pg-recovery-banner-title"
            >
              {BANNER_TITLE}
            </Heading>
            <Text fontSize="sm" color="fg.muted">
              {BANNER_CAUSE}
            </Text>
            <Text fontSize="sm" color="fg.muted" data-testid="pg-recovery-banner-warning">
              {BANNER_WARNING}
            </Text>
          </VStack>
        </HStack>
        {justReset ? (
          <HStack
            flexShrink={0}
            alignSelf={{ base: 'flex-start', sm: 'center' }}
            gap={2}
            color="fg.muted"
          >
            <Spinner size="xs" />
            <Text fontSize="sm">{RECONNECTING_LABEL}</Text>
          </HStack>
        ) : (
          <Button
            ref={resetTriggerRef}
            data-testid="pg-recovery-banner-reset"
            variant="solid"
            bg="status.error"
            color="status.onSolids"
            flexShrink={0}
            alignSelf={{ base: 'flex-start', sm: 'center' }}
            onClick={openReset}
          >
            {RESET_LABEL}
          </Button>
        )}
      </Flex>

      {/* Confirmation — real alertdialog (same Dialog.Root shape as the pane). */}
      <Dialog.Root
        open={resetOpen}
        onOpenChange={(details) => {
          if (!details.open) closeReset();
        }}
        role="alertdialog"
        initialFocusEl={() => cancelRef.current}
        finalFocusEl={() => resetTriggerRef.current ?? document.body}
      >
        <Portal>
          <Dialog.Backdrop bg="var(--overlay-bg)" />
          <Dialog.Positioner>
            <Dialog.Content
              data-testid="pg-recovery-banner-reset-dialog"
              bg="bg.surface"
              borderColor="border.subtle"
              borderWidth="1px"
              borderRadius="lg"
              maxW="lg"
            >
              <Dialog.Header>
                <Dialog.Title color="fg.default">{DIALOG_TITLE}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  {resetting ? (
                    <HStack role="status" aria-live="polite" gap={2} color="status.warning">
                      <Spinner size="xs" />
                      <Text fontSize="sm">{RESET_IN_PROGRESS}</Text>
                    </HStack>
                  ) : (
                    <>
                      <Dialog.Description color="fg.muted" fontSize="sm">
                        {DIALOG_BODY}
                      </Dialog.Description>
                      <Checkbox.Root
                        checked={ack}
                        onCheckedChange={(details) => setAck(!!details.checked)}
                      >
                        <Checkbox.HiddenInput data-testid="pg-recovery-banner-reset-ack" />
                        <Checkbox.Control />
                        <Checkbox.Label>{ACK_LABEL}</Checkbox.Label>
                      </Checkbox.Root>
                      {resetError ? (
                        <HStack
                          data-testid="pg-recovery-banner-reset-error"
                          gap={2}
                          align="flex-start"
                          color="status.error"
                        >
                          <Icon
                            as={LuTriangleAlert}
                            boxSize="14px"
                            flexShrink={0}
                            mt="2px"
                            aria-hidden="true"
                          />
                          <Text fontSize="sm" wordBreak="break-word" maxH="10rem" overflow="auto">
                            Could not reset the database: {resetError}
                          </Text>
                        </HStack>
                      ) : null}
                    </>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button
                  ref={cancelRef}
                  data-testid="pg-recovery-banner-reset-cancel"
                  variant="ghost"
                  color="var(--text-secondary)"
                  disabled={resetting}
                  onClick={closeReset}
                >
                  {CANCEL_LABEL}
                </Button>
                <Button
                  data-testid="pg-recovery-banner-reset-confirm"
                  variant="solid"
                  bg="status.error"
                  color="status.onSolids"
                  loading={resetting}
                  disabled={!ack}
                  onClick={() => void confirmReset()}
                >
                  {CONFIRM_LABEL}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};
