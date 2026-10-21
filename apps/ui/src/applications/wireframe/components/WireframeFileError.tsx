/**
 * Wireframe file-error banner (Spec #3070, ST-6, UI/UX section 2.7).
 *
 * Store-connected and prop-less: rendered only while `error !== null`, between
 * the editor's `main` region and the status bar (ST-1 owns the mount point).
 * Never a toast and never auto-dismissed — the document is unchanged and the
 * dirty state remains until the user dismisses the message (R-4.11).
 */

import React, { useSyncExternalStore } from 'react';
import { Button, Flex, Icon, Text } from '@chakra-ui/react';
import { LuTriangleAlert, LuX } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { getSnapshot, setError, subscribe } from '../store/wireframeDocumentStore';

export function WireframeFileError(): React.ReactElement | null {
  const { error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (error === null) return null;

  return (
    <Flex
      data-testid="wireframe-file-error"
      role="alert"
      align="center"
      gap={2}
      px={3}
      py={2}
      flexShrink={0}
      bg={tint('var(--status-error)', 10)}
      borderTopWidth="1px"
      borderColor="status.error"
    >
      <Icon
        as={LuTriangleAlert}
        boxSize="4"
        color="status.error"
        aria-hidden="true"
        flexShrink={0}
      />
      <Text fontSize="sm" color="status.error" flex="1" minW={0}>
        {error}
      </Text>
      <Button
        size="xs"
        variant="ghost"
        color="status.error"
        aria-label="Dismiss file error"
        onClick={() => setError(null)}
        flexShrink={0}
      >
        <Icon as={LuX} boxSize="3.5" aria-hidden="true" />
      </Button>
    </Flex>
  );
}
