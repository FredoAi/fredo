/**
 * Segmented preset row for the wireframe property panel (Spec #3070, ST-4).
 *
 * A visible label above a Chakra v3 `SegmentGroup`. Every segment is a real
 * radio-style control (Ark renders a hidden radio input) so presets are
 * keyboard operable and announce their pressed state. `value === null` renders
 * no selection — the page-size row uses that for the derived `Custom` state.
 *
 * Tokens only: no colours are chosen here; the segment recipe inherits the
 * theme's `bg.*`/`fg.*`/`border.*` tokens.
 */

import React, { type ReactNode } from 'react';
import { Flex, SegmentGroup, Text } from '@chakra-ui/react';

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible segment content (may be an icon/preview). */
  label: ReactNode;
  /** Accessible name when `label` is not self-describing (e.g. an "A" preview). */
  ariaLabel?: string;
}

export interface SegmentedFieldProps<T extends string> {
  /** Visible label above the control. */
  label: string;
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Optional caption rendered at the right of the label row (`Custom`). */
  caption?: ReactNode;
  captionTestId?: string;
  /** Rendered as `${testIdPrefix}-${value}` on each segment. */
  testIdPrefix?: string;
  /** `data-testid` on the group root. */
  testId?: string;
  size?: 'xs' | 'sm' | 'md';
}

export function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
  caption,
  captionTestId,
  testIdPrefix,
  testId,
  size = 'sm',
}: SegmentedFieldProps<T>): React.ReactElement {
  return (
    <Flex direction="column" gap={1} minWidth={0}>
      <Flex justify="space-between" align="baseline" gap={2}>
        <Text fontSize="xs" color="fg.muted">
          {label}
        </Text>
        {caption !== undefined ? (
          <Text fontSize="xs" color="fg.muted" data-testid={captionTestId}>
            {caption}
          </Text>
        ) : null}
      </Flex>
      <SegmentGroup.Root
        data-testid={testId}
        aria-label={label}
        size={size}
        width="full"
        value={value}
        onValueChange={(details) => {
          if (details.value !== null) onChange(details.value as T);
        }}
      >
        <SegmentGroup.Indicator />
        {options.map((option) => (
          <SegmentGroup.Item
            key={option.value}
            value={option.value}
            data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
            aria-label={option.ariaLabel}
          >
            <SegmentGroup.ItemText>{option.label}</SegmentGroup.ItemText>
            <SegmentGroup.ItemHiddenInput
              data-testid={
                testIdPrefix ? `${testIdPrefix}-${option.value}-input` : undefined
              }
            />
          </SegmentGroup.Item>
        ))}
      </SegmentGroup.Root>
    </Flex>
  );
}
