import React, { useEffect, useState } from 'react';
import { Button, Dialog, HStack, Input, RadioCard, Text, VStack, chakra } from '@chakra-ui/react';
import { settingsService } from '../../settings';
import {
  ensureTerminalSettingsMigrated,
  DEFAULT_CLI_KEY,
  WORK_DIR_KEY,
} from '../settings';
import { DEFAULT_KIND, normalizeKind, type TerminalSessionKind } from '../sessionModel';
import { CliOption } from './CliOption';

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired on confirm with the chosen CLI + (possibly blank) working directory. */
  onConfirm: (cli: TerminalSessionKind, workDir: string) => void;
  /** Prefill overrides (Retry / Choose directory flows); null = read Settings. */
  initialCli?: TerminalSessionKind | null;
  initialWorkDir?: string | null;
}

/**
 * NewSessionDialog — the required OpenCode-vs-GitHub prompt (Spec 2934 ST-3,
 * AC2/AC3).
 *
 * A deliberate two-input flow (CLI + working directory), so it is a Chakra v3
 * `Dialog.Root` and not a `Menu`. On open it (idempotently) migrates the
 * pre-rename working directory, then prefills from Settings: the CLI chooser is
 * preselected from `terminal_default_cli` and the work-dir field from
 * `terminal_work_dir` — the user never re-enters the migrated value. Enter
 * confirms, Esc cancels.
 */
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  initialCli = null,
  initialWorkDir = null,
}) => {
  const [cli, setCli] = useState<TerminalSessionKind>(DEFAULT_KIND);
  const [workDir, setWorkDir] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      await ensureTerminalSettingsMigrated();
      const [savedCli, savedDir] = await Promise.all([
        settingsService.get<string>(DEFAULT_CLI_KEY, DEFAULT_KIND),
        settingsService.get<string>(WORK_DIR_KEY, ''),
      ]);
      if (cancelled) return;
      setCli(initialCli ?? normalizeKind(savedCli));
      setWorkDir(initialWorkDir ?? savedDir ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialCli, initialWorkDir]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onConfirm(cli, workDir.trim());
  };

  return (
    <Dialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)}>
      <Dialog.Backdrop bg="var(--overlay-bg)" />
      <Dialog.Positioner>
        <Dialog.Content
          maxW="lg"
          // Spec 2940 ST-4 (R-3.7 parity): at the 560×360 window minimum the two
          // radio cards + work-dir field exceed the viewport, which used to clip
          // the footer. Cap to the positioner height and scroll so "Add session"
          // stays reachable. No viewport unit — the fixed Positioner is the
          // definite containing block.
          maxH="calc(100% - 32px)"
          overflowY="auto"
          background="var(--card-bg)"
          borderColor="var(--border-color)"
          borderWidth="1px"
          borderRadius="lg"
        >
          <chakra.form onSubmit={handleSubmit}>
            <Dialog.Header>
              <Dialog.Title color="fg.default">New session</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={5}>
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" fontWeight="600" color="fg.default">
                    Which CLI?
                  </Text>
                  <RadioCard.Root
                    value={cli}
                    onValueChange={(details) => setCli(normalizeKind(details.value))}
                    orientation="horizontal"
                    gap={3}
                  >
                    <HStack align="stretch" gap={3}>
                      <CliOption value="shell" selected={cli === 'shell'} />
                      <CliOption value="opencode" selected={cli === 'opencode'} />
                      <CliOption value="copilot" selected={cli === 'copilot'} />
                    </HStack>
                  </RadioCard.Root>
                </VStack>

                <VStack align="stretch" gap={1}>
                  <chakra.label htmlFor="terminal-new-session-workdir">
                    <Text fontSize="sm" fontWeight="600" color="fg.default">
                      Working directory
                    </Text>
                  </chakra.label>
                  <Input
                    id="terminal-new-session-workdir"
                    size="sm"
                    placeholder="C:\Users\you\my-repo"
                    value={workDir}
                    onChange={(e) => setWorkDir(e.target.value)}
                    aria-describedby="terminal-new-session-workdir-help"
                  />
                  <Text
                    id="terminal-new-session-workdir-help"
                    fontSize="xs"
                    color="fg.muted"
                  >
                    Directory this CLI runs in. Prefilled from Settings → Terminal. Blank = home
                    folder.
                  </Text>
                </VStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer gap={2}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                color="var(--text-secondary)"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                background="var(--accent-primary)"
                color="var(--accent-contrast)"
                _hover={{ opacity: 0.9 }}
              >
                Add session
              </Button>
            </Dialog.Footer>
          </chakra.form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};
