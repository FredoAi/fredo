/**
 * Own window manager (Spec #2807 ST-1 + ST-3) — renders the window stack.
 *
 * ST-1 provides the kernel store + a minimal skeleton; ST-3 upgrades each
 * entry to the owned Fredo-brand `WindowFrame` (header/title/icon/min/max/
 * close + drag/resize/float) drawn from Chakra v3 + theme tokens. This
 * component stays a thin pivoter: it reads the store via useSyncExternalStore,
 * sorts by z-order (focused/topmost last so it stacks on top), and renders
 * each entry as a `WindowFrame`. It deliberately does NOT own geometry or the
 * chrome — that is `WindowFrame`'s concern. The kernel store/actions contract
 * (open/close/update/focus/re-entrancy) is untouched.
 */

import { useSyncExternalStore } from 'react';
import { Box } from '@chakra-ui/react';
import { subscribeWindows, getWindowSnapshot } from './windowStore';
import { WindowFrame } from './WindowFrame';

export function WindowManager() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  // Render lowest z-order first so a focused (higher-z) window stacks on top.
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <Box position="absolute" inset="0" overflow="hidden" zIndex={1} bg="transparent">
      {ordered.map((win, idx) => (
        <WindowFrame key={win.id} window={win} stackIndex={idx} />
      ))}
    </Box>
  );
}
