/**
 * Canvas-scoped error boundary (Spec #3070, ST-2 round 2).
 *
 * A fault inside the Konva canvas must never unmount the editor shell: round 1
 * proved that an uncaught throw at canvas mount blanked the whole webview
 * (`#root` had 0 children) because nothing caught it. This boundary wraps the
 * lazy canvas (inside `WireframeCanvas.tsx`) so only the canvas subtree is
 * replaced by a themed message — the toolbar, property panel and status bar
 * stay mounted and interactive.
 *
 * Containment only: no retry/reload control, no error reporting/telemetry, no
 * global boundary. Imports no konva (`F-56`): the canvas stays its own chunk.
 */

import { Component, type ReactNode } from 'react';
import { Box, Text } from '@chakra-ui/react';

/** Message shown in place of the canvas after a caught fault. */
export const CANVAS_ERROR_MESSAGE =
  'The wireframe canvas could not be displayed. Your document is unchanged — use the toolbar, properties and file controls as usual.';

interface WireframeCanvasBoundaryProps {
  children: ReactNode;
}

interface WireframeCanvasBoundaryState {
  hasError: boolean;
}

export class WireframeCanvasBoundary extends Component<
  WireframeCanvasBoundaryProps,
  WireframeCanvasBoundaryState
> {
  state: WireframeCanvasBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WireframeCanvasBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(): void {
    // Intentionally silent: containment only. Reporting/retry are non-goals.
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box
          data-testid="wireframe-canvas-error"
          role="alert"
          flex="1"
          minW={0}
          minH={0}
          overflow="hidden"
          bg="bg.muted"
          display="flex"
          alignItems="center"
          justifyContent="center"
          px={6}
        >
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            {CANVAS_ERROR_MESSAGE}
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default WireframeCanvasBoundary;
