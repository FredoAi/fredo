/**
 * Corner radius control (Spec #3070, ST-4, SI adjudication 5).
 *
 * The document keeps the 4-value enum `none | s | m | l` — no schema change.
 * BOTH controls write that same enum: preset chips (None/S/M/L) and a 4-stop
 * slider (`min=0 max=3 step=1`) whose stops map 1:1 onto the enum. Numeric
 * entry is never the only way (R-3.6).
 */

import React from 'react';
import { Slider, VStack } from '@chakra-ui/react';

import type { WireframeRadius } from '../../model/elements';
import { SegmentedField } from './SegmentedField';

/** Slider stop order == the enum order. */
export const WIREFRAME_RADIUS_VALUES: readonly WireframeRadius[] = ['none', 's', 'm', 'l'] as const;

export const WIREFRAME_RADIUS_LABELS: Readonly<Record<WireframeRadius, string>> = {
  none: 'None',
  s: 'S',
  m: 'M',
  l: 'L',
};

export interface CornerRadiusFieldProps {
  value: WireframeRadius;
  onChange: (value: WireframeRadius) => void;
}

export function CornerRadiusField({
  value,
  onChange,
}: CornerRadiusFieldProps): React.ReactElement {
  const stop = Math.max(0, WIREFRAME_RADIUS_VALUES.indexOf(value));

  return (
    <VStack align="stretch" gap={2} minWidth={0} data-testid="wireframe-corner-radius">
      <SegmentedField
        label="Corner radius"
        value={value}
        testIdPrefix="wireframe-radius"
        options={WIREFRAME_RADIUS_VALUES.map((radius) => ({
          value: radius,
          label: WIREFRAME_RADIUS_LABELS[radius],
          ariaLabel: `Corner radius ${WIREFRAME_RADIUS_LABELS[radius]}`,
        }))}
        onChange={onChange}
      />
      <Slider.Root
        aria-label={['Corner radius']}
        min={0}
        max={3}
        step={1}
        value={[stop]}
        onValueChange={(details) => {
          const next = details.value[0];
          if (!Number.isFinite(next)) return;
          const radius = WIREFRAME_RADIUS_VALUES[next];
          if (radius) onChange(radius);
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
          <Slider.MarkerGroup>
            {WIREFRAME_RADIUS_VALUES.map((radius, index) => (
              <Slider.Marker key={radius} value={index}>
                <Slider.MarkerIndicator />
              </Slider.Marker>
            ))}
          </Slider.MarkerGroup>
        </Slider.Control>
      </Slider.Root>
    </VStack>
  );
}
