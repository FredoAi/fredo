/**
 * Own window manager (Spec #2807 ST-1) — renders the window stack.
 *
 * ST-1 provides a MINIMAL render skeleton for the stack so `WindowManager`
 * observes the kernel store and vends each entry's title + content. The full
 * Fredo-brand chrome (header, title, icon, min/max/close controls, resize
 * grip, float) is ST-3 — this component intentionally stays a thin layer and
 * does NOT restyle. Every surface here uses theme tokens (never hex/rgba) so
 * the R-7 token contract holds across the whole slice.
 */

import { useSyncExternalStore } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { subscribeWindows, getWindowSnapshot } from './windowStore';

export function WindowManager() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  // Render lowest z-order first so a focused (higher-z) window stacks on top.
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <Box position="absolute" inset="0" overflow="hidden">
      {ordered.map((win, idx) => (
        <Box
          key={win.id}
          position="absolute"
          display="flex"
          flexDirection="column"
          bg="bg.surface"
          border="1px solid"
          borderColor={win.focused ? 'accent.default' : 'border.default'}
          borderRadius="8px"
          width="480px"
          height="320px"
          top={`${48 + idx * 12}px`}
          left={`${48 + idx * 12}px`}
          zIndex={win.zIndex}
        >
          <Box
            display="flex"
            alignItems="center"
            gap="2"
            bg="bg.subtle"
            borderBottom="1px solid"
            borderBottomColor="border.subtle"
            px="3"
            py="1"
          >
            {win.icon}
            <Text color="fg.default" fontSize="sm" fontWeight="medium">
              {win.title}
            </Text>
          </Box>
          <Box flex="1" overflow="hidden" bg="bg.surface">
            {win.component}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
