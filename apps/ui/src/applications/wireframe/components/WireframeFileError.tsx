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
      // #3086 ST-4 (G-235 substitution) — the raw `status.error` is below the
      // 3:1 UI floor against the tinted canvas on light presets (arctic 2.84),
      // so the banner's identifiable boundary is the deepened
      // `status.errorStrong` (gate row `banner|default|border`).
      borderColor="status.errorStrong"
    >
      <Icon
        as={LuTriangleAlert}
        boxSize="4"
        // `banner|default|icon` = `status.errorStrong` on the 10 % error tint.
        color="status.errorStrong"
        aria-hidden="true"
        flexShrink={0}
      />
      <Text
        fontSize="sm"
        // `banner|default|label` = `fg.default` on the 10 % error tint — the
        // message never relies on colour alone (the red icon + border carry the
        // error semantics). The `data-contrast-pair` anchor lets the live leg
        // recompute the ratio from computed styles.
        data-contrast-pair="banner|default|label"
        color="fg.default"
        flex="1"
        minW={0}
      >
        {error}
      </Text>
      <Button
        size="xs"
        variant="ghost"
        color="status.errorStrong"
        aria-label="Dismiss file error"
        onClick={() => setError(null)}
        flexShrink={0}
      >
        <Icon as={LuX} boxSize="3.5" aria-hidden="true" />
      </Button>
    </Flex>
  );
}
