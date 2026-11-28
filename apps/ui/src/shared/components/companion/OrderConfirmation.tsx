/**
 * Spec #3243 ST-5 — the order confirmation. **The only surface that can run a
 * change**, and the sole non-test caller of `confirmOrder`.
 *
 * ## The root's accessible name comes from `aria-labelledby`, NEVER `aria-label`
 *
 * `aria-label` on a `role="dialog"` node REPLACES the name computed from its
 * subtree. The dialog's whole point is to expose, in one place, the verb
 * (`Fill element`), the target app, the undoability statement and — for an
 * irreversible action — the declared consequence and a warning. Putting an
 * `aria-label` on the root would make ALL of that invisible to a screen-reader
 * user while still passing a naive "does the root have its name?" check: the
 * #3241 C-1 defect (painted but unannounced) in a new medium.
 *
 * So the title's text IS `Confirm this order`, the root is named by
 * `aria-labelledby`-pointing at it, and the COMPUTED name is byte-identical to
 * the published contract. The QA row reads the computed name, which is what
 * makes an `aria-label` implementation fail the real check.
 *
 * ## The confirm control is the AC-7 user event
 *
 * `onConfirm` is wired by ST-8 to `confirmOrder(invocation)`. There is
 * deliberately NO keyboard shortcut, NO Enter-to-confirm, NO timer and NO
 * auto-focus on Confirm — a second confirm path would be a second entry into
 * `confirmOrder`, which is exactly what AC-7's structural chain forbids.
 *
 * ## Non-goals (BINDING)
 *
 *  - It adds NO `aria-live` region. The ONE polite region in the product stays
 *    `CompanionEntity`'s; a dialog is announced by focus entering a `dialog`,
 *    which is a different mechanism carrying a different fact (the dialog's
 *    name, not the order's outcome).
 *  - It adds NO second submit/dispatch route: it calls `onConfirm`/`onCancel`.
 *  - A `read` NEVER renders it (the gate returns `granted`); this component
 *    renders only when asked to.
 */

import React, { useEffect, useId, useRef } from 'react';
import { Box, chakra, Dialog, HStack, Icon, Text } from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';

import type { OrderInvocation } from '../../order/orderActions';
import {
  ORDER_IRREVERSIBLE_NOTICE,
  ORDER_UNDOABLE_NOTICE,
  orderIrreversibleWarning,
} from '../../order/orderReply';

// ── Bound DOM hooks (the published names block — consumed verbatim) ──────────

export const ORDER_CONFIRMATION_TESTID = 'fredo-order-confirmation';
export const ORDER_CONFIRMATION_VERB_TESTID = 'fredo-order-confirmation-verb';
export const ORDER_CONFIRMATION_CONSEQUENCE_TESTID = 'fredo-order-confirmation-consequence';
export const ORDER_CONFIRMATION_CONFIRM_TESTID = 'fredo-order-confirmation-confirm';
export const ORDER_CONFIRMATION_CANCEL_TESTID = 'fredo-order-confirmation-cancel';

/** The root's accessible name — produced by `aria-labelledby`, not `aria-label`. */
export const ORDER_CONFIRMATION_TITLE = 'Confirm this order';
/** The cancel control's name (and visible text). */
export const ORDER_CONFIRMATION_CANCEL_LABEL = 'Cancel';

/** `Run <label>` — the confirm control's accessible name AND its visible text. */
export function orderConfirmationConfirmLabel(label: string): string {
  return `Run ${label}`;
}

export interface OrderConfirmationProps {
  /** The invocation awaiting the user's decision. `null` renders nothing. */
  readonly invocation: OrderInvocation | null;
  /** The application's display name (the dialog repeats it: the chip is behind the scrim). */
  readonly appName: string;
  /** The action's declared label — the verb. */
  readonly label: string;
  /**
   * The user confirmed. ST-8 wires this to `confirmOrder(invocation)`; the
   * dialog closes into `running` ONLY when that returned `true`.
   */
  readonly onConfirm: () => void;
  /** The user cancelled (the control, or Escape) — execute nothing. */
  readonly onCancel: () => void;
}

/**
 * The confirmation. A normal Chakra `Dialog.Root`, Cancel-focused first, with
 * an irreversible VARIANT distinguished on text first, icon second and fill
 * third (never colour alone).
 */
export function OrderConfirmation(props: OrderConfirmationProps): React.ReactElement | null {
  const { invocation, appName, label, onConfirm, onCancel } = props;
  const titleId = useId();
  const consequenceId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Deterministic focus contract for a SAVE decision: Cancel wins, even after
  // Ark's mount focus. A safety dialog must never open with focus on the
  // destructive choice.
  useEffect(() => {
    if (invocation === null) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [invocation]);

  if (invocation === null) return null;

  const undoable = invocation.undoable;
  const consequence = invocation.consequence;
  const irreversible = !undoable;
  const confirmLabel = orderConfirmationConfirmLabel(label);

  return (
    <Dialog.Root
      role="dialog"
      open
      ids={{ title: titleId }}
      // A stray click must neither kill an order nor be confusable with
      // confirming it: the scrim does nothing.
      closeOnInteractOutside={false}
      // Escape CANCELS (the fail-closed direction) — ST-8's onCancel path.
      closeOnEscape
      restoreFocus={false}
      trapFocus
      initialFocusEl={() => cancelRef.current}
      onOpenChange={(details) => {
        if (!details.open) onCancel();
      }}
    >
      <Dialog.Backdrop bg="overlay.scrim" />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid={ORDER_CONFIRMATION_TESTID}
          // The variant discriminator a row can read without parsing prose.
          data-order-undoable={undoable ? 'true' : 'false'}
          // aria-modal EXPLICITLY: chord suppression keys on
          // `[role="dialog"][aria-modal="true"]`, not on the role alone, so
          // focus inside an undecided confirmation cannot be stolen.
          aria-modal="true"
          // NAMED FROM THE SUBTREE. An `aria-label` here would erase the verb,
          // the consequence and the warning from a screen-reader user.
          aria-labelledby={titleId}
          aria-describedby={irreversible ? consequenceId : undefined}
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          boxShadow="shadow.dialog"
          maxW="md"
        >
          <Dialog.Header>
            <HStack gap="2" align="center">
              {irreversible ? (
                <Icon as={LuTriangleAlert} boxSize="16px" color="status.error" aria-hidden="true" />
              ) : null}
              <Dialog.Title id={titleId} color="fg.default" fontSize="md" fontWeight="600">
                {ORDER_CONFIRMATION_TITLE}
              </Dialog.Title>
            </HStack>
          </Dialog.Header>

          <Dialog.Body>
            <HStack align="baseline" gap="1" wrap="wrap">
              <Text
                data-testid={ORDER_CONFIRMATION_VERB_TESTID}
                color="fg.default"
                fontSize="sm"
                fontWeight="600"
              >
                {label}
              </Text>
              <Text color="fg.muted" fontSize="sm">
                in {appName}
              </Text>
            </HStack>

            {irreversible ? (
              <Box id={consequenceId} data-testid={ORDER_CONFIRMATION_CONSEQUENCE_TESTID} mt="2">
                {/* The warning is SEPARATE exposed text, never inside a button —
                    so no control's `aria-label` can hide it. */}
                <Text color="status.error" fontSize="sm" fontWeight="600">
                  {orderIrreversibleWarning(appName, label, consequence ?? '')}
                </Text>
                <Text color="fg.muted" fontSize="sm">
                  {ORDER_IRREVERSIBLE_NOTICE}
                </Text>
              </Box>
            ) : (
              <Box data-testid={ORDER_CONFIRMATION_CONSEQUENCE_TESTID} mt="2">
                {/* Bound to the DECLARED `undoable` datum — not a promise about
                    what the registry will hold. */}
                <Text color="fg.muted" fontSize="sm">
                  {ORDER_UNDOABLE_NOTICE}
                </Text>
              </Box>
            )}
          </Dialog.Body>

          <Dialog.Footer gap="2">
            <chakra.button
              type="button"
              ref={cancelRef}
              data-testid={ORDER_CONFIRMATION_CANCEL_TESTID}
              onClick={onCancel}
              px="3"
              height="28px"
              borderRadius="sm"
              fontSize="13px"
              color="fg.muted"
              bg="transparent"
              border="1px solid"
              borderColor="border.default"
              cursor="pointer"
              _hover={{ bg: 'bg.hover', color: 'fg.default' }}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: 'accent.focusRing',
                outlineOffset: '2px',
              }}
            >
              {ORDER_CONFIRMATION_CANCEL_LABEL}
            </chakra.button>

            {/*
              The confirm control: visible text EQUALS its accessible name (no
              icon, no badge, no aria-label) — an aria-label here would erase the
              only thing that names the action.

              THE AC-7 USER EVENT: `onConfirm` is the sole entry into
              `confirmOrder`. No keyboard shortcut, no Enter-to-confirm, no timer.
            */}
            <chakra.button
              type="button"
              data-testid={ORDER_CONFIRMATION_CONFIRM_TESTID}
              data-contrast-pair={
                irreversible ? 'status-solid|default|label' : 'control-solid|default|label'
              }
              onClick={onConfirm}
              px="3"
              height="28px"
              borderRadius="sm"
              fontSize="13px"
              fontWeight="600"
              bg={irreversible ? 'status.errorTint' : 'accent.solid'}
              color={irreversible ? 'fg.default' : 'accent.contrast'}
              cursor="pointer"
              _hover={{ bg: irreversible ? 'status.errorTint' : 'accent.strong' }}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: 'accent.focusRing',
                outlineOffset: '2px',
              }}
            >
              {confirmLabel}
            </chakra.button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
