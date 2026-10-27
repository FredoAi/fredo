/**
 * Segmented preset row for the wireframe property panel (Spec #3070, ST-4).
 *
 * A visible label above a Chakra v3 `SegmentGroup`. Every segment is a real
 * radio-style control (Ark renders a hidden radio input) so presets are
 * keyboard operable and announce their pressed state. `value === null` renders
 * no selection — the page-size row uses that for the derived `Custom` state.
 *
 * Tokens only: no colours are chosen here. Spec #3086 (ST-3) makes the control
 * chrome resolve the SAME contract token pairs the contrast gate validates
 * (`matrix.ts` `PAIR_SPECS`; one home per pair, G-366) — the group root paints
 * `bg.surface` (rail boundary `border.default`, from the `segmentGroup` recipe),
 * the selected indicator paints `accent.tint`, and the item label is `fg.default`
 * (selected AND unselected). The `data-contrast-*` anchors are ADDITIVE: they
 * expose the rendered fg/bg of each pair to the live rendered leg (G-154) and
 * change no role, name or state semantics.
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
        bg="bg.surface"
        data-contrast-bg="segmented|default|track"
        onValueChange={(details) => {
          if (details.value !== null) onChange(details.value as T);
        }}
      >
        <SegmentGroup.Indicator
          bg="accent.tint"
          data-contrast-bg="segmented|selected|indicator"
        />
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <SegmentGroup.Item
              key={option.value}
              value={option.value}
              data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
              aria-label={option.ariaLabel}
              color="fg.default"
            >
              <SegmentGroup.ItemText
                data-contrast-fg={
                  selected ? 'segmented|selected|label' : 'segmented|default|label'
                }
              >
                {option.label}
              </SegmentGroup.ItemText>
              <SegmentGroup.ItemHiddenInput
                data-testid={
                  testIdPrefix ? `${testIdPrefix}-${option.value}-input` : undefined
                }
              />
            </SegmentGroup.Item>
          );
        })}
      </SegmentGroup.Root>
    </Flex>
  );
}
