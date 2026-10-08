import React, { useEffect, useRef } from 'react';
import { Button, Dialog, Text, VStack, chakra } from '@chakra-ui/react';

interface NewPresetPromptProps {
  isOpen: boolean;
  /** The preset being diverged from, e.g. 'Tokyo Night'. */
  presetName: string;
  /** Count of diverging color/font tokens — surfaces in the body text (R-5). */
  dirtyCount: number;
  /** R-4: persist the current effective palette as a new user preset. */
  onSave: (name: string) => void;
  /** R-3: revert ALL dirty tokens back to the preset value. */
  onDiscard: () => void;
  /** R-3: behaves as Discard (no silent drift). */
  onClose: () => void;
}

/**
 * NewPresetPrompt — a self-contained, keyboard-accessible Chakra v3 `Dialog.Root`
 * for the #2845 dirty-edit flow. It fires when the user edits a color/font input
 * away from a selected preset, offering "Save as new preset" (persist the current
 * effective palette) or "Discard" (revert the dirty tokens to the preset). The
 * message text is the mandatory, color-neutral divergence signal (R-5) — it names
 * the action and the preset, never relying on a color cue alone.
 *
 * Token/vars only: every surface reads a semantic token or `var(--...)` from
 * `system.ts`, so the dialog is readable across both light- and dark-coloured
 * presets. Esc / X = Discard (revert + close) — exactly one non-save path.
 */
export const NewPresetPrompt: React.FC<NewPresetPromptProps> = ({
  isOpen,
  presetName,
  dirtyCount,
  onSave,
  onDiscard,
  onClose,
}) => {
  // Prefill the name field with a sensible per-preset default; reset on open so a
  // new edit always starts fresh (the panel remounts per section switch anyway).
  const [name, setName] = React.useState(`${presetName} (custom)`);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(`${presetName} (custom)`);
      // Focus the prefilled name field on open (keyboard/SR users can type or Tab).
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [isOpen, presetName]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop bg="var(--card-bg)" opacity={0.6} backdropFilter="blur(2px)" />
      <Dialog.Positioner>
        <Dialog.Content
          maxW="md"
          background="var(--card-bg)"
          borderColor="var(--border-color)"
          borderWidth="1px"
          borderRadius="lg"
        >
          <Dialog.Header>
            <Dialog.Title color="var(--text-primary)">Create a new preset?</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <VStack align="start" gap={3}>
              <Text color="var(--text-primary)">
                You've changed {dirtyCount} theme setting{dirtyCount === 1 ? '' : 's'} from the “
                {presetName}” preset. Save these changes as a new preset, or discard them to return
                to the preset.
              </Text>
              <chakra.label
                display="flex"
                flexDirection="column"
                gap={1}
                w="full"
                color="var(--text-secondary)"
                fontSize="sm"
                fontWeight="500"
              >
                New preset name
                <chakra.input
                  ref={inputRef}
                  aria-label="New preset name"
                  value={name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  bg="var(--card-bg)"
                  border="1px solid"
                  borderColor="var(--border-color)"
                  color="var(--text-primary)"
                  borderRadius="md"
                  px={2}
                  py={1.5}
                  fontSize="sm"
                  _hover={{ borderColor: 'var(--accent-primary)' }}
                  _focus={{ outline: 'none', borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
                />
              </chakra.label>
            </VStack>
          </Dialog.Body>
          <Dialog.Footer gap={2}>
            <Text fontSize="xs" color="var(--text-secondary)" mr="auto">
              Discarding reverts your changes to the {presetName} preset.
            </Text>
            <Button
              variant="outline"
              size="sm"
              color="var(--text-secondary)"
              borderColor="var(--border-color)"
              onClick={onDiscard}
            >
              Discard
            </Button>
            <Button
              size="sm"
              background="var(--accent-primary)"
              color="white"
              disabled={!name.trim()}
              onClick={() => onSave(name.trim())}
              _hover={{ opacity: 0.85 }}
            >
              Save as new preset
            </Button>
          </Dialog.Footer>
          <Dialog.CloseTrigger
            position="absolute"
            top="8px"
            right="8px"
            color="var(--text-secondary)"
            onClick={onClose}
          />
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
