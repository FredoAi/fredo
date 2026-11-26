/**
 * RemoveInstalledAppDialog — the removal confirmation (Spec #3144, AC-3;
 * UI/UX §3).
 *
 * The window between "the user asked to remove" and "the application is gone".
 * It exists for exactly ONE reason: to state, BEFORE any confirmation, what will
 * happen to the data the application stored — and the design keeps that data, so
 * the statement says so. Nothing is removed until
 * `installed-apps-remove-confirm` is pressed; opening the dialog is not an action
 * on the application.
 *
 * # The disclosure is SPECIFIC, never "some data may be affected"
 *
 * The datum is whether the application declares the ordinary `data.tables`
 * capability (it can store data). Two variants, both naming THIS application and
 * THIS treatment, both stating the stored data is kept (the binding
 * `dataKept: true` outcome):
 *
 *   - declares `data.tables`: "… Its stored data is kept, in the tables it
 *     declared."
 *   - otherwise:              "… Nothing of its own is removed. Its stored data
 *     is kept."
 *
 * # Focus contract
 *
 * Confirm is NEVER the initial focus (a destructive default). Cancel takes
 * initial focus, Escape cancels, and the parent restores focus to the row's
 * Remove control on close (the trigger is removed from the DOM on success, so
 * `restoreFocus` is disabled here and the parent owns it).
 *
 * Token-only presentation: `bg.surface` / `border.default` / `fg.default` /
 * `fg.muted`, the destructive confirm on the shipped `status.errorTint` +
 * `fg.default` pair — no hex, no rgba, no new contrast pair.
 */

import React, { useEffect, useRef } from 'react';
import { Button, Dialog, Text } from '@chakra-ui/react';

import type { InstalledAppEntry } from '../../../shared/installed-apps/types';

/** The dialog's heading element id — the `aria-labelledby` target (not a testid). */
export const REMOVE_DIALOG_HEADING_ID = 'installed-apps-remove-dialog-heading';

/** The confirm button's visible label (also its accessible name). */
export const REMOVE_CONFIRM_LABEL = 'Remove application';

/** The cancel button's visible label (also its accessible name). */
export const REMOVE_CANCEL_LABEL = 'Cancel';

/** The dialog's heading text — names the application being removed. */
export function removalDialogTitle(displayName: string): string {
  return `Remove ${displayName}?`;
}

/**
 * The disclosure sentence (AC-3's pre-confirmation data statement).
 *
 * Both variants name the treatment specifically and state the data is kept; only
 * the first clause differs (a `data.tables`-declaring application is told WHICH
 * tables are kept).
 */
export function removalDisclosureSentence(entry: InstalledAppEntry): string {
  const base = `Removing ${entry.displayName} removes it from Fredo and from the launcher.`;
  return entry.capabilities.declared.includes('data.tables')
    ? `${base} Its stored data is kept, in the tables it declared.`
    : `${base} Nothing of its own is removed. Its stored data is kept.`;
}

export interface RemoveInstalledAppDialogProps {
  /** The application being removed; `null` renders nothing. */
  entry: InstalledAppEntry | null;
  /** True while the removal command is in flight (Confirm shows its loading state). */
  busy: boolean;
  /** The user dismissed the dialog (Cancel / Escape) — nothing is removed. */
  onCancel: () => void;
  /** The user confirmed — the parent runs the removal. */
  onConfirm: () => void;
}

export const RemoveInstalledAppDialog: React.FC<RemoveInstalledAppDialogProps> = ({
  entry,
  busy,
  onCancel,
  onConfirm,
}) => {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Deterministic focus contract: Cancel wins even after Ark's mount focus.
  useEffect(() => {
    if (!entry) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [entry]);

  if (!entry) return null;

  return (
    <Dialog.Root
      open
      role="dialog"
      ids={{ title: REMOVE_DIALOG_HEADING_ID }}
      closeOnInteractOutside={false}
      restoreFocus={false}
      trapFocus
      initialFocusEl={() => cancelRef.current}
      onOpenChange={(details) => {
        if (!details.open && !busy) onCancel();
      }}
    >
      <Dialog.Backdrop bg="overlay.scrim" />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid="installed-apps-remove-dialog"
          aria-modal="true"
          aria-labelledby={REMOVE_DIALOG_HEADING_ID}
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          maxW="lg"
        >
          <Dialog.Header>
            <Dialog.Title
              id={REMOVE_DIALOG_HEADING_ID}
              as="h2"
              color="fg.default"
              fontSize="md"
              fontWeight="600"
            >
              {removalDialogTitle(entry.displayName)}
            </Dialog.Title>
          </Dialog.Header>

          <Dialog.Body>
            <Text
              data-testid="installed-apps-remove-disclosure"
              fontSize="sm"
              color="fg.default"
              lineHeight="short"
            >
              {removalDisclosureSentence(entry)}
            </Text>
          </Dialog.Body>

          <Dialog.Footer gap={2}>
            <Button
              ref={cancelRef}
              data-testid="installed-apps-remove-cancel"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onCancel}
            >
              {REMOVE_CANCEL_LABEL}
            </Button>
            <Button
              data-testid="installed-apps-remove-confirm"
              size="sm"
              bg="status.errorTint"
              color="fg.default"
              borderWidth="1px"
              borderStyle="solid"
              borderColor="status.errorStrong"
              loading={busy}
              disabled={busy}
              onClick={onConfirm}
            >
              {REMOVE_CONFIRM_LABEL}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
