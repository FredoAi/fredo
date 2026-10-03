import React, { useCallback, useState } from 'react';
import { Box, Button, Flex, HStack, Icon, Text } from '@chakra-ui/react';
import { LuGamepad2, LuRefreshCw, LuTriangleAlert } from 'react-icons/lu';
import { useWindowActions } from '../../shared/window-system/useWindowActions';
import { adapterBridge } from '../../shared/utils/adapterBridge';

// Module-level in-flight guard: survives React StrictMode double-mount and
// blocks a double-click from firing `open_doom_window` twice. Deliberately NOT a
// useRef — refs reset on every mount, so a ref guard would let a remount re-fire.
let _openInFlight = false;

/**
 * DoomEntry — the main-window entry host (Spec #2968 CU-4/ST-7, G-265).
 *
 * Rendered by `DoomFeature.render()` inside the pre-feature main window (the
 * launcher grid / dock desktop item), so the trigger to open Doom exists before
 * Doom runs. Clicking `doom-entry-button` invokes `open_doom_window` ONLY — it
 * never calls `launch_doom_runtime`; runtime start belongs to the `doom`
 * window's own mount. On success it closes the transient in-window entry via
 * `useWindowActions().closeWindow('doom')`; on reject it renders an inline
 * `role="alert"` error with a retry (mirrors `TerminalLauncher`).
 */
export const DoomEntry: React.FC = () => {
  const { closeWindow } = useWindowActions();
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = useCallback(async () => {
    if (_openInFlight) return;
    _openInFlight = true;
    setOpenError(null);
    try {
      await adapterBridge.invoke('open_doom_window');
      closeWindow('doom');
    } catch (err) {
      setOpenError(String(err));
    } finally {
      _openInFlight = false;
    }
  }, [closeWindow]);

  return (
    <Flex direction="column" gap={3} p={4} h="100%" w="100%" bg="bg.canvas" color="fg.default">
      <HStack gap={2}>
        <Icon as={LuGamepad2} boxSize="18px" color="accent.default" aria-hidden />
        <Text fontSize="sm" fontWeight="semibold" fontFamily="mono">
          Doom
        </Text>
      </HStack>
      <Button
        data-testid="doom-entry-button"
        colorPalette="accent"
        alignSelf="flex-start"
        onClick={() => void handleOpen()}
      >
        <Icon as={LuGamepad2} boxSize="14px" mr={1} aria-hidden />
        Open Doom
      </Button>
      {openError && (
        <Box
          role="alert"
          borderWidth="1px"
          borderColor="status.error"
          borderRadius="md"
          px={3}
          py={2}
        >
          <HStack gap={2} align="flex-start">
            <Icon as={LuTriangleAlert} boxSize="15px" color="status.error" mt="2px" flexShrink={0} aria-hidden />
            <Box minW={0}>
              <Text fontSize="sm" fontWeight="semibold" color="status.error">
                Could not open Doom
              </Text>
              <Text fontSize="xs" color="fg.muted" mt={1} lineHeight="1.4">
                {openError}
              </Text>
              <Button
                mt={2}
                size="xs"
                variant="outline"
                onClick={() => void handleOpen()}
              >
                <Icon as={LuRefreshCw} boxSize="13px" mr={1} aria-hidden />
                Retry
              </Button>
            </Box>
          </HStack>
        </Box>
      )}
    </Flex>
  );
};

export default DoomEntry;
