/**
 * Wireframe canvas host (Spec #3070, ST-2, C8).
 *
 * Thin lazy wrapper: the editor shell imports `WireframeCanvas` (no props) and
 * this file keeps `konva` / `react-konva` out of the eager startup chunk
 * (`allApplications.ts` is an eager glob — F-56). The implementation lives in
 * `WireframeCanvasImpl.tsx` and is only loaded behind `Suspense`.
 *
 * Fallback (UI/UX section 2.3/4): the viewport backdrop + an artboard-shaped
 * skeleton + "Loading canvas…".
 *
 * The lazy canvas is wrapped in a canvas-scoped error boundary (round 2): a
 * throw inside the Konva subtree must never unmount the editor shell.
 */

import { Suspense, lazy, type ReactElement } from 'react';
import { Box, Skeleton, Text } from '@chakra-ui/react';

import { WireframeCanvasBoundary } from './WireframeCanvasBoundary';

const WireframeCanvasImpl = lazy(() => import('./WireframeCanvasImpl'));

function CanvasFallback(): ReactElement {
  return (
    <Box
      data-testid="wireframe-canvas-loading"
      position="relative"
      flex="1"
      minW={0}
      minH={0}
      overflow="hidden"
      bg="bg.muted"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={3}
    >
      <Skeleton width="70%" height="70%" maxW="960px" maxH="640px" />
      <Text fontSize="sm" color="fg.muted">
        Loading canvas…
      </Text>
    </Box>
  );
}

export function WireframeCanvas(): ReactElement {
  return (
    <WireframeCanvasBoundary>
      <Suspense fallback={<CanvasFallback />}>
        <WireframeCanvasImpl />
      </Suspense>
    </WireframeCanvasBoundary>
  );
}

export default WireframeCanvas;
