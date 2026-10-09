import React, { useEffect, useRef } from 'react';
import {
  Box,
  Button,
  Dialog,
  Field,
  Flex,
  HStack,
  Icon,
  Portal,
  Progress,
  Spinner,
  Text,
  chakra,
} from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import { tint } from '../../shared/utils/colorTint';
import {
  doomProvisionByteText,
  doomProvisionProgressValue,
  doomProvisionStepText,
  formatDoomProvisionDuration,
  type DoomProvisionDialogController,
} from '../../shared/doom-mode';
import { doomProvisionErrorMessage } from './types';

/**
 * The engine-source license name + corresponding-source offer (AC5). ONE source
 * of truth for the dialog copy so the regions cannot drift; both the vendored
 * path, the upstream URL, and the pinned commit are rendered in full so the
 * offer is verifiable from the DOM.
 */
export const DOOM_LICENSE_TEXT =
  'Engine source: RESTful DOOM — GNU GPL version 2 (GPL-2.0), a fork of Chocolate Doom.';
export const DOOM_SOURCE_OFFER_TEXT =
  'Corresponding source is included with Fredo at vendor/restful-doom/ (upstream ' +
  'https://github.com/mkschreder/restful-doom.git, commit ' +
  'eded41b5597b7738ec1fa06d24f62b53db982c2c). No engine binary is distributed; the engine is ' +
  'built from this source on your machine.';

const PROVISION_INTRO =
  'Doom runs an engine built from source in this repo. It downloads a pinned build toolchain ' +
  'and compiles the engine the first time you play. This can take several minutes.';

/**
 * DoomProvisionDialog — the single provisioning surface (Spec #3012, ST-4).
 *
 * Purely presentational: it renders whatever `controller` (from
 * `useDoomProvision()`) describes. It serves the whole slice (form → progress →
 * ready → result) and is reused by the `Home` `iddqd` host and by the
 * post-activation in-window "Engine location" affordance in `DoomWindow`.
 */
export const DoomProvisionDialog: React.FC<{ controller: DoomProvisionDialogController }> = ({
  controller,
}) => {
  const {
    open,
    mode,
    view,
    status,
    installDir,
    submitting,
    relocationSaved,
    relocationError,
    onInstallDirChange,
    onConfirm,
    onCancel,
    onRetry,
    onDismiss,
  } = controller;

  const inputRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const isRelocate = mode === 'relocate';
  const cancelled = status.phase === 'cancelled';
  const invalidDir = status.code === 'installDirInvalid';
  const running = view === 'progress';
  const busy = running || submitting;
  const copy = doomProvisionErrorMessage(status.code);
  const progress = status.progress;
  const progressValue = doomProvisionProgressValue(status);
  const stepText = doomProvisionStepText(status);
  const byteText = doomProvisionByteText(status);
  const elapsedText = progress ? formatDoomProvisionDuration(progress.elapsedMs) : null;
  const blankDir = installDir.trim() === '';

  // Focus management: the install-dir input on the form, the retry action after
  // a failure (the result region is a focusable fallback for AT).
  useEffect(() => {
    if (open && view === 'form') inputRef.current?.focus();
  }, [open, view]);
  useEffect(() => {
    if (open && view === 'result') retryRef.current?.focus();
  }, [open, view]);

  const title =
    view === 'checking'
      ? 'Checking the engine'
      : view === 'progress'
        ? 'Setting up the Doom engine'
        : view === 'ready'
          ? 'Engine ready'
          : view === 'result'
            ? cancelled
              ? 'Setup cancelled'
              : copy.title
            : isRelocate
              ? 'Engine location'
              : 'Set up the Doom engine';

  const description =
    view === 'checking'
      ? 'Looking for an existing Doom engine build.'
      : view === 'progress'
        ? 'Fredo is downloading a pinned build toolchain and compiling the engine. This can take several minutes.'
        : view === 'ready'
          ? 'Starting Doom…'
          : view === 'result'
            ? copy.message
            : isRelocate
              ? 'Choose where the Doom engine is built and stored.'
              : PROVISION_INTRO;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open) onDismiss();
      }}
      // Escape / outside-click are inert during a running build — a stray key
      // must never kill a multi-minute compile; the explicit Cancel is the path.
      closeOnEscape={!running}
      closeOnInteractOutside={!running}
      initialFocusEl={() => inputRef.current}
    >
      <Portal>
        <Dialog.Backdrop bg="var(--overlay-bg)" />
        <Dialog.Positioner>
          <Dialog.Content
            data-testid="doom-provision-dialog"
            aria-busy={busy}
            maxW="480px"
            bg="bg.surface"
            borderWidth="1px"
            borderColor="border.default"
            borderRadius="md"
            p="20px"
            display="flex"
            flexDirection="column"
            gap="16px"
          >
            <Dialog.Header p="0">
              <Dialog.Title color="fg.default" fontSize="md">
                {title}
              </Dialog.Title>
              <Dialog.Description color="fg.muted" fontSize="sm" mt="4px">
                {description}
              </Dialog.Description>
            </Dialog.Header>

            {view === 'checking' && (
              <HStack gap="8px" align="center">
                <Spinner size="sm" color="accent.default" />
                <Text fontSize="sm" color="fg.muted" fontFamily="mono">
                  Checking the engine…
                </Text>
              </HStack>
            )}

            {(view === 'form' || view === 'progress' || view === 'result') && (
              <Flex direction="column" gap="12px">
                {(view === 'form' || view === 'progress') && (
                  <Field.Root invalid={invalidDir}>
                    <Field.Label color="fg.default" fontSize="sm">
                      Install location
                    </Field.Label>
                    <chakra.input
                      ref={inputRef}
                      data-testid="doom-provision-install-dir"
                      type="text"
                      value={installDir}
                      onChange={(event) => onInstallDirChange(event.target.value)}
                      readOnly={view === 'progress'}
                      aria-invalid={invalidDir || undefined}
                      bg="bg.canvas"
                      color="fg.default"
                      borderColor="border.default"
                      borderWidth="1px"
                      borderRadius="sm"
                      px="12px"
                      h="36px"
                      fontFamily="mono"
                      w="100%"
                    />
                    <Field.HelperText color="fg.muted" fontSize="xs">
                      {isRelocate
                        ? 'The new location takes effect the next time Doom Mode starts.'
                        : `The toolchain and engine are stored here. Default: ${status.installDirDefault}.`}
                    </Field.HelperText>
                    {invalidDir && (
                      <Field.ErrorText
                        data-testid="doom-provision-install-dir-error"
                        color="status.error"
                        fontSize="xs"
                      >
                        {copy.message}
                      </Field.ErrorText>
                    )}
                  </Field.Root>
                )}

                {view === 'progress' && (
                  <Box>
                    <Progress.Root
                      data-testid="doom-provision-progress"
                      value={progressValue}
                      colorPalette="accent"
                      size="sm"
                      w="100%"
                      aria-label="Engine setup progress"
                    >
                      <Progress.Track>
                        <Progress.Range />
                      </Progress.Track>
                    </Progress.Root>
                    <Flex align="baseline" justify="space-between" gap="8px" mt="8px">
                      <Text
                        data-testid="doom-provision-step"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        fontSize="sm"
                        color="fg.default"
                        minW="0"
                        truncate
                      >
                        {stepText}
                      </Text>
                      {byteText && (
                        <Text
                          fontFamily="mono"
                          fontSize="xs"
                          color="fg.muted"
                          whiteSpace="nowrap"
                          flexShrink={0}
                        >
                          {byteText}
                        </Text>
                      )}
                    </Flex>
                    {progress?.message && (
                      <Text
                        fontFamily="mono"
                        fontSize="xs"
                        color="fg.muted"
                        mt="4px"
                        truncate
                        title={progress.message}
                      >
                        {progress.message}
                      </Text>
                    )}
                    {elapsedText && (
                      <Text fontFamily="mono" fontSize="xs" color="fg.muted" mt="4px" textAlign="right">
                        {elapsedText}
                      </Text>
                    )}
                  </Box>
                )}

                {view === 'result' && (
                  <Box
                    data-testid="doom-provision-error"
                    role="alert"
                    aria-live="assertive"
                    tabIndex={-1}
                    p="12px"
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor={cancelled ? 'status.warning' : 'status.error'}
                    bg={tint(cancelled ? 'var(--status-warning)' : 'var(--status-error)', 8)}
                  >
                    <HStack gap="8px" align="flex-start">
                      <Icon
                        as={LuTriangleAlert}
                        boxSize="16px"
                        color={cancelled ? 'status.warning' : 'status.error'}
                        mt="2px"
                        flexShrink={0}
                        aria-hidden
                      />
                      <Box minW="0">
                        <Text
                          fontSize="sm"
                          fontWeight="semibold"
                          color={cancelled ? 'status.warning' : 'status.error'}
                        >
                          {cancelled ? 'Setup cancelled' : copy.title}
                        </Text>
                        <Text fontSize="xs" color="fg.default" mt="4px" lineHeight="1.4">
                          {copy.message}
                        </Text>
                        {status.lastError && (
                          <Text
                            fontSize="xs"
                            color="fg.muted"
                            fontFamily="mono"
                            mt="4px"
                            truncate
                            title={status.lastError}
                          >
                            {status.lastError}
                          </Text>
                        )}
                      </Box>
                    </HStack>
                  </Box>
                )}

                {isRelocate && relocationError && (
                  <Text role="alert" fontSize="xs" color="status.error">
                    {relocationError}
                  </Text>
                )}
              </Flex>
            )}

            {(view === 'form' || view === 'progress') && (
              <Box>
                <Text
                  data-testid="doom-provision-license"
                  color="fg.muted"
                  fontSize="xs"
                  lineHeight="1.5"
                >
                  {DOOM_LICENSE_TEXT}
                </Text>
                <Text
                  data-testid="doom-provision-source-offer"
                  color="fg.muted"
                  fontSize="xs"
                  fontFamily="mono"
                  whiteSpace="pre-wrap"
                  mt="4px"
                  lineHeight="1.5"
                >
                  {DOOM_SOURCE_OFFER_TEXT}
                </Text>
              </Box>
            )}

            {view === 'ready' && (
              <Flex
                role="status"
                aria-live="polite"
                aria-atomic="true"
                align="center"
                gap="8px"
                css={{
                  '@keyframes doom-provision-ready-in': {
                    from: { opacity: 0, transform: 'translateY(-2px)' },
                    to: { opacity: 1, transform: 'translateY(0)' },
                  },
                  animation: 'doom-provision-ready-in 150ms ease-out',
                  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
                }}
              >
                <Box boxSize="8px" borderRadius="full" bg="status.success" aria-hidden />
                <Text fontSize="sm" color="status.success" fontWeight="semibold">
                  Engine ready
                </Text>
              </Flex>
            )}

            {(view === 'form' || view === 'progress' || view === 'result') && (
              <Flex justify="flex-end" gap="8px">
                {view === 'form' && (
                  <>
                    <Button
                      data-testid="doom-provision-cancel"
                      variant="ghost"
                      size="sm"
                      onClick={onCancel}
                    >
                      Cancel
                    </Button>
                    <Button
                      data-testid="doom-provision-confirm"
                      colorPalette="accent"
                      size="sm"
                      disabled={blankDir || submitting}
                      title={blankDir ? 'Enter an install location' : undefined}
                      onClick={onConfirm}
                    >
                      {isRelocate ? 'Save location' : 'Install engine'}
                    </Button>
                  </>
                )}

                {view === 'progress' && (
                  <Button
                    data-testid="doom-provision-cancel"
                    variant="outline"
                    size="sm"
                    borderColor="var(--status-warning)"
                    color="var(--status-warning)"
                    onClick={onCancel}
                  >
                    Cancel
                  </Button>
                )}

                {view === 'result' && (
                  <>
                    <Button
                      ref={retryRef}
                      data-testid="doom-provision-retry"
                      colorPalette="accent"
                      size="sm"
                      onClick={onRetry}
                    >
                      Retry
                    </Button>
                    <Button
                      data-testid="doom-provision-cancel"
                      variant="ghost"
                      size="sm"
                      onClick={onCancel}
                    >
                      Close
                    </Button>
                  </>
                )}
              </Flex>
            )}

            {relocationSaved && (
              <Text role="status" aria-live="polite" fontSize="xs" color="status.success">
                Location saved — it takes effect the next time Doom Mode starts.
              </Text>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default DoomProvisionDialog;
