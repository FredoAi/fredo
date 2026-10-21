/**
 * Numeric property control: stepper + slider (Spec #3070, ST-4, R-3.6).
 *
 * Every numeric property ships THREE ways to set it: the numeric field, the
 * stepper buttons and a slider. Numeric entry is therefore never the only way
 * (R-3.6). Slider moves and stepper clicks commit on the interaction tick; a
 * typed value commits on Enter/blur through the NumberInput's own commit hook
 * (the shipped CompanionSettingsPanel convention) so a half-typed number never
 * churns the undo history.
 */

import React, { useEffect, useState } from 'react';
import {
  HStack,
  NumberInput,
  Slider,
  Text,
  VStack,
} from '@chakra-ui/react';

export interface NumberSliderFieldProps {
  /** Visible label and the numeric input's accessible name. */
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** `data-testid` on the controls wrapper. */
  testId: string;
  /** Accessible name for the slider; defaults to `${label} slider`. */
  sliderName?: string;
  onChange: (value: number) => void;
}

export function NumberSliderField({
  label,
  value,
  min,
  max,
  step = 1,
  testId,
  sliderName,
  onChange,
}: NumberSliderFieldProps): React.ReactElement {
  const [draft, setDraft] = useState(String(value));

  // Re-sync the displayed draft whenever the store value changes (undo, preset,
  // slider, stepper). `value` is a scalar — no re-render loop.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(parsed);
  };

  return (
    <VStack align="stretch" gap={2} minWidth={0} data-testid={testId}>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      <HStack gap={2} align="center">
        <NumberInput.Root
          data-testid={`${testId}-number`}
          value={draft}
          onValueChange={(details) => setDraft(details.value)}
          onValueCommit={(details) => commit(details.value)}
          min={min}
          max={max}
          step={step}
          size="sm"
          width="110px"
        >
          {/* Zag only commits on blur/Enter; a stepper click persists the
              stepped draft explicitly (shipped Companion panel convention). */}
          <NumberInput.Control onClick={() => commit(draft)} />
          <NumberInput.Input
            aria-label={label}
            bg="bg.surface"
            color="fg.default"
            borderColor="border.default"
          />
        </NumberInput.Root>
        <Text as="span" fontSize="xs" color="fg.muted">
          px
        </Text>
      </HStack>
      <Slider.Root
        aria-label={[sliderName ?? `${label} slider`]}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(details) => {
          const next = details.value[0];
          if (Number.isFinite(next)) onChange(next);
        }}
        size="sm"
        width="full"
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumb index={0}>
            <Slider.HiddenInput />
          </Slider.Thumb>
        </Slider.Control>
      </Slider.Root>
    </VStack>
  );
}
