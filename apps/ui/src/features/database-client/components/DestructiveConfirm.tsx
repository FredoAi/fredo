import React, { useEffect, useId, useRef } from 'react';
import { Box, Button, Dialog, HStack, Icon, Text, VStack } from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import type { DbConfirmationRequired } from '../lib/types';

/**
 * DestructiveConfirm — blocking confirmation for a destructive/unknown statement
 * (Spec #2950, ST-5; R-5.3 UI).
 *
 * The backend returns `confirmationRequired` (class + statement hash + preview)
 * instead of executing. This dialog names the detected class and shows the
 * preview, then requires an EXPLICIT confirm — it never auto-confirms:
 *
 *   - the backdrop is not dismissible and Escape is disabled;
 *   - initial focus lands on Cancel (least destructive);
 *   - the parent echoes `statementHash` back via `confirmedStatementHashes` only
 *     after the user presses "Run statement".
 *
 * Token-only presentation: semantic tokens, never a hex/rgba literal.
 */

export interface DestructiveConfirmProps {
  /** `null` renders nothing (no pending confirmation). */
  confirmation: DbConfirmationRequired | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DestructiveConfirm: React.FC<DestructiveConfirmProps> = ({
  confirmation,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Deterministic focus contract: Cancel wins even after Ark's mount focus.
  useEffect(() => {
    if (!confirmation) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmation]);

  if (!confirmation) return null;

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
        if (!details.open) onCancel();
      }}
    >
      <Dialog.Backdrop data-testid="db-destructive-backdrop" bg="overlay.scrim" />
      <Dialog.Positioner>
        <Dialog.Content
          data-testid="db-destructive-confirm"
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
                Confirm destructive statement
              </Dialog.Title>
            </HStack>
          </Dialog.Header>

          <Dialog.Body>
            <VStack align="stretch" gap={3}>
              <Text fontSize="sm" color="fg.default">
                This statement is classified{' '}
                <Text as="span" data-testid="db-destructive-class" fontWeight="700" color="status.error" textTransform="uppercase">
                  {confirmation.statementClass}
                </Text>{' '}
                and will modify data. Nothing runs until you confirm.
              </Text>
              <Box
                data-testid="db-destructive-preview"
                bg="bg.subtle"
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="sm"
                p={2}
                maxHeight="180px"
                overflowY="auto"
              >
                <Text fontFamily="mono" fontSize="xs" color="fg.default" whiteSpace="pre-wrap" wordBreak="break-word">
                  {confirmation.preview}
                </Text>
              </Box>
            </VStack>
          </Dialog.Body>

          <Dialog.Footer gap={2}>
            <Button
              ref={cancelRef}
              data-testid="db-destructive-cancel"
              size="sm"
              variant="ghost"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              data-testid="db-destructive-run"
              size="sm"
              variant="solid"
              bg="status.error"
              color="white"
              onClick={onConfirm}
            >
              Run statement
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
