/**
 * New-document discard prompt (Spec #3119, ST-4).
 *
 * Re-homed VERBATIM from the retired `WireframeToolbar.tsx` (Spec #3081 / #3086) so the
 * dirty guard survives the toolbar removal: the same `wireframe-new-document-dialog` /
 * `-cancel` / `-discard` test ids, the same copy, the same token-coloured Discard
 * (`status.errorTint` + `fg.default`, `data-contrast-pair="status-solid|default|label"`)
 * and the same Cancel-first focus contract.
 *
 * The SHELL owns the dirty guard: `wireframe.document.new` shows this dialog when the
 * document is dirty (File `n`, the rail File row and the map row all route through the
 * shell's `onRunVerb` wrapper); Discard runs the verb, Cancel changes nothing.
 */

import React from 'react';
import { Button, Dialog, Text } from '@chakra-ui/react';

export interface WireframeNewDocumentDialogProps {
  readonly open: boolean;
  /** Dismiss without touching the document. */
  readonly onCancel: () => void;
  /** Proceed with `wireframe.document.new`. */
  readonly onDiscard: () => void;
}

export function WireframeNewDocumentDialog({
  open,
  onCancel,
  onDiscard,
}: WireframeNewDocumentDialogProps): React.ReactElement {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);

  // Deterministic focus contract for the discard prompt: Cancel wins.
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={(details) => {
        if (!details.open) onCancel();
      }}
      initialFocusEl={() => cancelRef.current}
    >
      <Dialog.Backdrop bg="overlay.scrim" />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid="wireframe-new-document-dialog"
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          boxShadow="shadow.dialog"
          maxW="md"
        >
          <Dialog.Header>
            <Dialog.Title color="fg.default" fontSize="md" fontWeight="600">
              Discard unsaved changes?
            </Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Text fontSize="sm" color="fg.default">
              Starting a new wireframe discards the current unsaved document.
            </Text>
          </Dialog.Body>
          <Dialog.Footer gap={2}>
            <Button
              ref={cancelRef}
              data-testid="wireframe-new-document-cancel"
              size="sm"
              variant="ghost"
              onClick={onCancel}
            >
              Cancel
            </Button>
            {/*
              #3086 ST-4 (G-235 substitution) — the destructive fill is the
              bounded `status.errorTint` with the `fg.default` label. The
              `data-contrast-pair` anchor lets the live leg recompute the ratio
              from computed styles.
            */}
            <Button
              data-testid="wireframe-new-document-discard"
              data-contrast-pair="status-solid|default|label"
              size="sm"
              bg="status.errorTint"
              color="fg.default"
              _hover={{ bg: 'status.errorTint' }}
              onClick={onDiscard}
            >
              Discard
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
