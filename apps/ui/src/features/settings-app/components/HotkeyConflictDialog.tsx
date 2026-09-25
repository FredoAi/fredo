/**
 * Spec #2946 ST-7 — the resolve-before-save conflict dialog (AC5 complex
 * scenario; EARS R-5.1, R-5.2, R-5.4).
 *
 * A rebind that collides with an existing binding in the SAME tier is surfaced
 * BEFORE it takes effect: this dialog names the captured chord, names every
 * colliding action + its tier, BLOCKS the save, and offers exactly three
 * explicit resolutions:
 *
 *   - `hotkeys-conflict-rebind-other` — clear the colliding binding(s), then save
 *     this one (the other action ends up unbound; it is never overwritten silently).
 *   - `hotkeys-conflict-override`     — keep BOTH bindings, apply precedence, and
 *     leave the displaced binding recorded + labelled in the listing (R-5.2).
 *   - `hotkeys-conflict-cancel`       — discard the capture; neither binding changes.
 *
 * The backdrop is NOT dismissible (`closeOnInteractOutside={false}`): a conflict
 * always requires an explicit decision. Focus contract (H-15/H-26): initial focus
 * lands on `hotkeys-conflict-cancel` (least destructive), the dialog owns the
 * keyboard while open (Chakra/Zag focus trap), Escape resolves as `cancel` and
 * never commits, and the parent restores focus to the invoking rebind button.
 *
 * Presentation is token-only: semantic tokens + CSS vars, never a hex/rgba
 * literal and never an alpha-append onto a `var()`. The chord + every colliding
 * entry carry text, so the state is never colour-only.
 *
 * The classifier is never bypassed: this component only ever describes a
 * `ConflictReport` produced by `classifyBinding` (ST-1); the pane re-classifies
 * the live keymap before applying either resolution.
 */

import React, { useEffect, useId, useRef } from 'react';
import { Button, Dialog, HStack, Icon, Text, VStack, chakra } from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';

import { Keycap } from '../../../shared/components/hotkeys/Keycap';
import { listHotkeyActions } from '../../../shared/hotkeys/registry';
import type {
  ConflictReport,
  HotkeyActionId,
  HotkeyTier,
  RegisteredHotkeyAction,
} from '../../../shared/hotkeys/types';

/** The three explicit conflict resolutions (R-5.1). */
export type HotkeyConflictResolution = 'override' | 'rebind-other' | 'cancel';

export interface HotkeyConflictDialogProps {
  /** The serialized chord being captured. */
  readonly candidate: string;
  /** The action the user is trying to bind the chord to (may be unknown). */
  readonly targetAction: RegisteredHotkeyAction | null;
  /** The classifier's verdict — always `same-tier` for this dialog. */
  readonly report: ConflictReport;
  readonly onResolve: (resolution: HotkeyConflictResolution) => void;
}

/** The human tier label for a colliding action (R-5.1 "names the tier"). */
export function conflictTierLabel(tier: HotkeyTier, actionId: HotkeyActionId): string {
  if (tier === 'fredo') return 'Global';
  const featureId = actionId.split('.')[0] ?? actionId;
  return `Feature: ${featureId}`;
}

/** Resolve a colliding action's display title from the live registry. */
export function conflictActionTitle(
  actionId: HotkeyActionId,
  actions: readonly RegisteredHotkeyAction[],
): string {
  return actions.find((entry) => entry.actionId === actionId)?.title ?? actionId;
}

export const HotkeyConflictDialog: React.FC<HotkeyConflictDialogProps> = ({
  candidate,
  targetAction,
  report,
  onResolve,
}) => {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const actions = listHotkeyActions();

  // Deterministic focus contract: initial focus on the least-destructive action.
  // Runs after Ark's own mount focus (child effects run first), so the cancel
  // button wins even where the machine would otherwise focus the content region.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Escape always resolves as cancel and NEVER commits. Owned explicitly (the
  // machine's own escape handling is disabled) so there is exactly one path.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      event.preventDefault();
      event.stopPropagation();
      onResolve('cancel');
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onResolve]);

  return (
    <Dialog.Root
      open
      role="dialog"
      ids={{ title: titleId }}
      closeOnInteractOutside={false}
      closeOnEscape={false}
      restoreFocus={false}
      trapFocus
      initialFocusEl={() => cancelRef.current}
      onOpenChange={(details) => {
        // Any machine-driven close (other than the disabled backdrop/Escape paths)
        // resolves as cancel — never a commit.
        if (!details.open) onResolve('cancel');
      }}
    >
      <Dialog.Backdrop data-testid="hotkeys-conflict-backdrop" bg="overlay.scrim" />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid="hotkeys-conflict-dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          boxShadow="shadow.dialog"
          maxW="lg"
        >
          <Dialog.Header>
            <HStack gap={2} align="center">
              <Icon as={LuTriangleAlert} boxSize="16px" color="status.error" />
              <Dialog.Title id={titleId} color="fg.default" fontSize="md" fontWeight="600">
                Key already in use
              </Dialog.Title>
            </HStack>
          </Dialog.Header>

          <Dialog.Body>
            <HStack data-testid="hotkeys-conflict-chord" gap={2} wrap="wrap" align="center">
              <Keycap sequence={candidate} />
              <Text fontSize="sm" color="fg.default">
                {targetAction?.title ?? 'This action'}
              </Text>
            </HStack>

            <VStack data-testid="hotkeys-conflict-entries" align="stretch" gap={1} mt={3}>
              {report.colliding.map((entry) => (
                <HStack
                  key={`${entry.actionId}:${entry.sequence}`}
                  data-testid="hotkeys-conflict-entry"
                  data-hotkey-action={entry.actionId}
                  gap={2}
                  wrap="wrap"
                  align="center"
                >
                  <Text fontSize="sm" color="fg.default">
                    {conflictActionTitle(entry.actionId, actions)}
                  </Text>
                  <chakra.span
                    data-testid="hotkeys-conflict-tier"
                    data-hotkey-tier={entry.tier}
                    fontSize="xs"
                    color="fg.muted"
                    bg="bg.subtle"
                    borderRadius="sm"
                    px={1.5}
                    py={0.5}
                  >
                    {conflictTierLabel(entry.tier, entry.actionId)}
                  </chakra.span>
                  <Keycap sequence={entry.sequence} />
                  <Text fontFamily="mono" fontSize="xs" color="fg.muted">
                    {entry.actionId}
                  </Text>
                </HStack>
              ))}
            </VStack>

            <Text
              data-testid="hotkeys-conflict-precedence"
              fontSize="xs"
              color="fg.muted"
              mt={3}
            >
              While a feature is focused, its binding wins; the global binding resumes when the
              feature releases the key.
            </Text>
          </Dialog.Body>

          <Dialog.Footer gap={2}>
            <Button
              data-testid="hotkeys-conflict-rebind-other"
              size="xs"
              variant="outline"
              onClick={() => onResolve('rebind-other')}
            >
              Rebind the other key
            </Button>
            <Button
              data-testid="hotkeys-conflict-override"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={() => onResolve('override')}
            >
              Override
            </Button>
            <Button
              ref={cancelRef}
              data-testid="hotkeys-conflict-cancel"
              size="xs"
              variant="ghost"
              onClick={() => onResolve('cancel')}
            >
              Cancel
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
