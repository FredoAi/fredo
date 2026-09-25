import React from 'react';
import { HStack, Icon, RadioCard, Text } from '@chakra-ui/react';
import { LuGithub, LuSquareTerminal, LuTerminal } from 'react-icons/lu';
import { CLI_DESCRIPTION, CLI_LABEL, type TerminalSessionKind } from '../sessionModel';

/**
 * One session-type choice in a single-select `RadioCard` group (shared by the
 * add-session dialog and Settings → Default session type).
 *
 * The identity is always icon + text (never colour alone). All three glyphs are
 * verified `react-icons/lu` exports (v5.6.0): `LuGithub` (Copilot),
 * `LuSquareTerminal` (the plain shell, Spec #2942), `LuTerminal` (OpenCode) —
 * distinct per kind so no two options share a glyph.
 *
 * `aria-checked` is set explicitly on the hidden radio input: it is the
 * DOM-observable selected state the QA plan reads (Ark's native radio carries a
 * `checked` property but no `aria-checked` attribute). The same input carries
 * the `terminal-default-type-<value>` hook (Spec 2942), so the type control is
 * observable in BOTH the add-session dialog and Settings.
 */
function kindIcon(value: TerminalSessionKind) {
  if (value === 'copilot') return LuGithub;
  if (value === 'shell') return LuSquareTerminal;
  return LuTerminal;
}

export const CliOption: React.FC<{ value: TerminalSessionKind; selected: boolean }> = ({
  value,
  selected,
}) => (
  <RadioCard.Item value={value}>
    <RadioCard.ItemHiddenInput
      aria-checked={selected}
      data-testid={`terminal-default-type-${value}`}
    />
    <RadioCard.ItemControl>
      <RadioCard.ItemContent>
        <HStack gap={2}>
          <Icon as={kindIcon(value)} boxSize="16px" color="fg.muted" />
          <RadioCard.ItemText fontWeight="600">{CLI_LABEL[value]}</RadioCard.ItemText>
        </HStack>
        <RadioCard.ItemDescription>
          <Text fontSize="xs" color="fg.muted">
            {CLI_DESCRIPTION[value]}
          </Text>
        </RadioCard.ItemDescription>
      </RadioCard.ItemContent>
      <RadioCard.ItemIndicator />
    </RadioCard.ItemControl>
  </RadioCard.Item>
);
