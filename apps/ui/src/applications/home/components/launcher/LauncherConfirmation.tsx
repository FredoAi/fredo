/**
 * Spec #3120 (P6), ST-5 — `LauncherConfirmation`, the launcher's ONLY await (UI/UX §2.4).
 *
 * A Chakra v3 `Dialog.Root` rendered as a real `role="alertdialog"`:
 *   - it NAMES the verb (`launcherConfirmTitle`), the target(s), the consequence, the undo
 *     availability and (for an external verb) the outside party;
 *   - **Cancel is the initial focus** and the visually secondary control — a reflexive
 *     Return can never confirm by accident;
 *   - `Esc`, Cancel and an outside click all resolve `false`; Accept resolves `true`;
 *   - there is NO auto-confirm, no timeout and no default action — the promise resolves only
 *     from an explicit user gesture, so a dismissed confirmation can never apply later.
 *
 * The component is presentational: the ST-6 shell subscribes to the ST-1 confirmation store
 * and passes the pending `request` + `onResolve`. The dialog resolves exactly once (the store
 * guards double resolution); this component never dispatches.
 *
 * Token-only: semantic tokens and `tint()` over vars, no colour literals, no alpha-append.
 * Reduced motion removes the content/scrim animations (`useNavReducedMotion`).
 */

import React from 'react';
import { Box, Button, Dialog, Flex, Icon, Text } from '@chakra-ui/react';
import { LuExternalLink, LuTriangleAlert, LuUndo2 } from 'react-icons/lu';

import type { ConfirmationRequest } from '../../../../shared/navigation';
import { useNavReducedMotion } from '../../../../shared/navigation/ui/useReducedMotion';
import { tint } from '../../../../shared/utils/colorTint';
import {
  LAUNCHER_CONFIRM_CANCEL,
  LAUNCHER_CONFIRM_CONSEQUENCE_LABEL,
  LAUNCHER_CONFIRM_NOT_UNDOABLE,
  LAUNCHER_CONFIRM_TARGET_LABEL,
  LAUNCHER_CONFIRM_UNDOABLE,
  LAUNCHER_CONFIRM_VERB_LABEL,
  LAUNCHER_CONFIRMATION_ACCEPT_TESTID,
  LAUNCHER_CONFIRMATION_CANCEL_TESTID,
  LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID,
  LAUNCHER_CONFIRMATION_TARGET_TESTID,
  LAUNCHER_CONFIRMATION_TESTID,
  LAUNCHER_CONFIRMATION_UNDO_TESTID,
  LAUNCHER_CONFIRMATION_VERB_TESTID,
  launcherConfirmAccept,
  launcherConfirmExternal,
  launcherConfirmTitle,
} from './launcherConstants';

export interface LauncherConfirmationProps {
  /** The pending request; `null` renders nothing (no launcher confirmation). */
  readonly request: ConfirmationRequest | null;
  /** Resolve the pending promise: `true` = apply, `false` = dismiss (journals nothing). */
  readonly onResolve: (accepted: boolean) => void;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/* ───────────────────────────── motion (UI/UX §4) ───────────────────────────── */

const CONFIRM_CONTENT_MOTION: React.CSSProperties = {
  animation: 'launcher-confirm-in 150ms ease',
};
const CONFIRM_SCRIM_MOTION: React.CSSProperties = {
  animation: 'launcher-confirm-scrim-in 150ms ease',
};
const CONFIRM_NO_MOTION: React.CSSProperties = { animation: 'none', transition: 'none' };

/** Text for the undo-availability line (the machine reason is appended verbatim). */
function undoLine(request: ConfirmationRequest): string {
  const availability = request.undoAvailability;
  return availability.undoable
    ? LAUNCHER_CONFIRM_UNDOABLE
    : `${LAUNCHER_CONFIRM_NOT_UNDOABLE} — ${availability.reason}`;
}

/** A labelled detail row (label + value). */
function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex gap={3} align="flex-start" minWidth={0}>
      <Text
        as="span"
        width="92px"
        flexShrink={0}
        fontSize="10px"
        textTransform="uppercase"
        letterSpacing="0.05em"
        color="fg.subtle"
      >
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/**
 * The launcher confirmation dialog. Renders nothing when `request` is `null`.
 */
export function LauncherConfirmation({
  request,
  onResolve,
  reducedMotion,
}: LauncherConfirmationProps): React.ReactElement | null {
  const hookReduced = useNavReducedMotion();
  const motionReduced = reducedMotion ?? hookReduced;
  const titleId = React.useId();
  const consequenceId = React.useId();
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const settledRef = React.useRef(false);

  const open = request !== null;

  // A new pending request is a fresh decision (the store's double-resolve guard is the
  // backstop; this keeps the component itself single-shot per request).
  React.useEffect(() => {
    settledRef.current = false;
  }, [request]);

  const settle = React.useCallback(
    (accepted: boolean): void => {
      if (settledRef.current) return;
      settledRef.current = true;
      onResolve(accepted);
    },
    [onResolve],
  );

  // Deterministic focus contract: Cancel wins even if Ark's mount focus races it.
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (request === null) return null;

  const external = request.externalParty !== null;
  const severityVar = external ? 'var(--status-info)' : 'var(--status-error)';
  const severityToken = external ? 'status.info' : 'status.error';
  const showTarget = request.targetLabels.length > 0 || request.targetOverflow > 0;
  const targetText =
    request.targetOverflow > 0
      ? `${request.targetLabels.join(', ')} +${request.targetOverflow}`
      : request.targetLabels.join(', ');

  return (
    <Dialog.Root
      role="alertdialog"
      open
      restoreFocus={false}
      trapFocus
      closeOnEscape={false}
      closeOnInteractOutside={false}
      initialFocusEl={() => cancelRef.current}
      onOpenChange={(details) => {
        if (!details.open) settle(false);
      }}
    >
      <Dialog.Backdrop
        bg="overlay.scrim"
        onClick={() => settle(false)}
        style={motionReduced ? CONFIRM_NO_MOTION : CONFIRM_SCRIM_MOTION}
      />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid={LAUNCHER_CONFIRMATION_TESTID}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={request.consequence === null ? undefined : consequenceId}
          onKeyDown={(event) => {
            // Esc = cancel. Handled here (never a document listener) so the dialog owns the
            // key and the behaviour is deterministic in every host.
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              settle(false);
            }
          }}
          width="calc(100% - 32px)"
          maxWidth="440px"
          p={0}
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="lg"
          boxShadow="shadow.dialog"
          overflow="hidden"
          style={motionReduced ? CONFIRM_NO_MOTION : CONFIRM_CONTENT_MOTION}
        >
          <style>{`@keyframes launcher-confirm-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes launcher-confirm-scrim-in {
  from { opacity: 0; }
  to { opacity: 1; }
}`}</style>

          <Flex
            align="center"
            gap={3}
            px={5}
            py={4}
            bg={tint(severityVar, 10)}
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Icon
              as={external ? LuExternalLink : LuTriangleAlert}
              boxSize="5"
              color={severityToken}
              aria-hidden="true"
              flexShrink={0}
            />
            <Text id={titleId} fontSize="15px" fontWeight="600" color="fg.default">
              {launcherConfirmTitle(request.title)}
            </Text>
          </Flex>

          <Box px={5} py={4} display="flex" flexDirection="column" gap={3} minWidth={0}>
            <DetailRow label={LAUNCHER_CONFIRM_VERB_LABEL}>
              <Text
                data-testid={LAUNCHER_CONFIRMATION_VERB_TESTID}
                fontSize="13px"
                color="fg.default"
                minWidth={0}
              >
                {request.title}
              </Text>
            </DetailRow>

            {showTarget ? (
              <DetailRow label={LAUNCHER_CONFIRM_TARGET_LABEL}>
                <Text
                  data-testid={LAUNCHER_CONFIRMATION_TARGET_TESTID}
                  fontSize="13px"
                  color="fg.default"
                  minWidth={0}
                >
                  {targetText}
                </Text>
              </DetailRow>
            ) : null}

            {request.consequence === null ? null : (
              <DetailRow label={LAUNCHER_CONFIRM_CONSEQUENCE_LABEL}>
                <Text
                  id={consequenceId}
                  data-testid={LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID}
                  fontSize="13px"
                  color="fg.default"
                  minWidth={0}
                >
                  {request.consequence}
                </Text>
              </DetailRow>
            )}

            {request.externalParty === null ? null : (
              <Text
                alignSelf="flex-start"
                px={2}
                py={1}
                borderRadius="sm"
                borderWidth="1px"
                borderColor="status.info"
                bg={tint('var(--status-info)', 10)}
                color="fg.default"
                fontSize="11px"
              >
                {launcherConfirmExternal(request.externalParty)}
              </Text>
            )}
          </Box>

          <Flex
            align="center"
            gap={2}
            px={5}
            py={2}
            borderTopWidth="1px"
            borderColor="border.subtle"
          >
            <Icon as={LuUndo2} boxSize="3" color="fg.subtle" aria-hidden="true" flexShrink={0} />
            <Text data-testid={LAUNCHER_CONFIRMATION_UNDO_TESTID} fontSize="11px" color="fg.muted">
              {undoLine(request)}
            </Text>
          </Flex>

          <Flex justify="flex-end" gap={2} px={5} py={4}>
            <Button
              ref={cancelRef}
              data-testid={LAUNCHER_CONFIRMATION_CANCEL_TESTID}
              variant="outline"
              borderColor="border.default"
              color="fg.default"
              onClick={() => settle(false)}
            >
              {LAUNCHER_CONFIRM_CANCEL}
            </Button>
            <Button
              data-testid={LAUNCHER_CONFIRMATION_ACCEPT_TESTID}
              variant="solid"
              bg={severityToken}
              color="status.onSolids"
              _hover={{ bg: severityToken }}
              _active={motionReduced ? undefined : { transform: 'translateY(1px)' }}
              onClick={() => settle(true)}
            >
              {launcherConfirmAccept(request.title)}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
