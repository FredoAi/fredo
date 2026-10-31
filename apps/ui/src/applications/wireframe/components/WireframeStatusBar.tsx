/**
 * Wireframe status bar (Spec #3070, ST-1, UI/UX section 2.6).
 *
 * Saved/unsaved live region + document name + pending-operation slot + page
 * size + zoom + Pan chip. The saved/unsaved text has exactly ONE input
 * (`dirty`), so `wireframe-status` and `data-wireframe-dirty` can never
 * disagree (C3 binding / R-4.10).
 */

import React, { useSyncExternalStore } from 'react';
import { Box, Flex, HStack, Spinner, Text } from '@chakra-ui/react';

import { documentDisplayName } from '../model/document';
import {
  getSnapshot,
  subscribe,
  type WireframeOperationStatus,
} from '../store/wireframeDocumentStore';

const OPERATION_LABEL: Record<Exclude<WireframeOperationStatus, 'idle'>, string> = {
  saving: 'Saving…',
  opening: 'Opening…',
  exporting: 'Exporting…',
};

export function WireframeStatusBar(): React.ReactElement {
  const { dirty, filePath, status, panMode, view, document } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  return (
    <Flex
      data-testid="wireframe-status-bar"
      align="center"
      gap={3}
      px={3}
      py={1}
      flexShrink={0}
      minHeight="24px"
      bg="bg.subtle"
      borderTopWidth="1px"
      borderColor="border.subtle"
      fontSize="xs"
    >
      <HStack
        role="status"
        aria-live="polite"
        aria-atomic="true"
        gap={2}
        minWidth={0}
        flex="1"
        overflow="hidden"
      >
        <Box
          boxSize="8px"
          borderRadius="full"
          bg={dirty ? 'status.warning' : 'status.success'}
          flexShrink={0}
          aria-hidden="true"
        />
        <Text
          data-testid="wireframe-status"
          color="fg.muted"
          whiteSpace="nowrap"
          flexShrink={0}
        >
          {dirty ? 'Unsaved' : 'Saved'}
        </Text>
        <Text color="fg.muted" display={{ base: 'none', md: 'block' }} flexShrink={0} aria-hidden="true">
          ·
        </Text>
        <Text
          color="fg.muted"
          display={{ base: 'none', md: 'block' }}
          truncate
          minWidth={0}
        >
          {documentDisplayName(filePath)}
        </Text>
        {status !== 'idle' ? (
          <HStack gap={1.5} flexShrink={0} color="fg.muted">
            <Spinner size="xs" aria-hidden="true" />
            <Text whiteSpace="nowrap">{OPERATION_LABEL[status]}</Text>
          </HStack>
        ) : null}
      </HStack>

      <HStack gap={3} flexShrink={0} color="fg.muted" whiteSpace="nowrap">
        <Text>
          {Math.round(document.page.width)} × {Math.round(document.page.height)}
        </Text>
        <Text>{Math.round(view.scale * 100)}%</Text>
        {panMode ? (
          <Box
            as="span"
            data-contrast-pair="subtle|default|chip-label"
            px={2}
            py={0.5}
            borderRadius="sm"
            // #3086 ST-4 — the chip fill is the preset-authored `bg.surface`
            // (the gate row `subtle|default|chip-label` is `fg.muted` on
            // `bg.surface`; the former `bg.muted` is not preset-authored and
            // could not clear the body floor on every preset).
            bg="bg.surface"
            color="fg.muted"
            fontSize="xs"
          >
            Pan
          </Box>
        ) : null}
      </HStack>
    </Flex>
  );
}
