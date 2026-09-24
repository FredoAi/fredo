import React from 'react';
import { HStack, Icon, RadioCard, Text } from '@chakra-ui/react';
import { LuGithub, LuTerminal } from 'react-icons/lu';
import { CLI_DESCRIPTION, CLI_LABEL, type TerminalCli } from '../sessionModel';

/**
 * One CLI choice in a single-select `RadioCard` group (shared by the
 * add-session dialog and Settings → Default CLI).
 *
 * The CLI identity is always icon + text (never colour alone). `LuGithub` is a
 * verified `react-icons/lu` export (v5.6.0) — the `OC`/`GH` text chip is the
 * documented fallback and is not needed here.
 *
 * `aria-checked` is set explicitly on the hidden radio input: it is the
 * DOM-observable selected state the QA plan reads (Ark's native radio carries a
 * `checked` property but no `aria-checked` attribute).
 */
export const CliOption: React.FC<{ value: TerminalCli; selected: boolean }> = ({
  value,
  selected,
}) => (
  <RadioCard.Item value={value}>
    <RadioCard.ItemHiddenInput aria-checked={selected} />
    <RadioCard.ItemControl>
      <RadioCard.ItemContent>
        <HStack gap={2}>
          <Icon
            as={value === 'copilot' ? LuGithub : LuTerminal}
            boxSize="16px"
            color="fg.muted"
          />
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
