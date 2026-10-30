/**
 * Page controls (Spec #3070, ST-4, R-3.5 / R-4.6 / UI/UX section 2.5;
 * verb-routed by Spec #3119, ST-6 — UI/UX §4).
 *
 * Shown whenever nothing is selected (`selectedId === null`). Three named page
 * presets plus editable width/height; a segment is selected only when the page
 * dimensions equal that preset exactly, otherwise NOTHING is selected and the
 * derived `Custom` caption appears (there is deliberately no fourth chip).
 * Page dimensions clamp to the declared 64..4096 range inside the store's
 * `page.update` plan.
 *
 * EXECUTION SEAM (Spec #3119, R-6): every control dispatches the DECLARED
 * `wireframe.page.update` verb through the navigation host — `{field, value}`
 * for a preset or a dimension — instead of mutating the store. One interaction
 * tick = one journal entry (`coalesceKey: null`).
 */

import React, { useSyncExternalStore } from 'react';
import { Text, VStack } from '@chakra-ui/react';

import { MAX_PAGE_SIZE, MIN_PAGE_SIZE } from '../../model/geometry';
import { type WireframeNamedPagePreset, matchPagePreset } from '../../model/pagePresets';
import { getSnapshot, subscribe } from '../../store/wireframeDocumentStore';
import { useWireframeNavigation } from '../WireframeNavigationProvider';
import { NumberSliderField } from './NumberSliderField';
import { SegmentedField } from './SegmentedField';

const PAGE_PRESET_LABELS: Readonly<Record<WireframeNamedPagePreset, string>> = {
  desktop: 'Desktop',
  tablet: 'Tablet',
  phone: 'Phone',
};

const PAGE_PRESET_VALUES: readonly WireframeNamedPagePreset[] = [
  'desktop',
  'tablet',
  'phone',
] as const;

const PAGE_UPDATE_VERB_ID = 'wireframe.page.update';

export function PageControls(): React.ReactElement {
  const { host } = useWireframeNavigation();
  const { document } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { page } = document;
  const matchedPreset = matchPagePreset(page.width, page.height);

  const updatePage = (field: 'preset' | 'width' | 'height', value: string): void => {
    void host.runVerb(PAGE_UPDATE_VERB_ID, 'pointer', { field, value });
  };

  return (
    <VStack
      data-testid="wireframe-page-controls"
      align="stretch"
      gap={5}
      minWidth={0}
      width="full"
    >
      <SegmentedField
        label="Page size"
        value={matchedPreset}
        testId="wireframe-page-presets"
        testIdPrefix="wireframe-page-preset"
        caption={matchedPreset === null ? 'Custom' : undefined}
        captionTestId="wireframe-page-size-custom"
        options={PAGE_PRESET_VALUES.map((preset) => ({
          value: preset,
          label: PAGE_PRESET_LABELS[preset],
          ariaLabel: PAGE_PRESET_LABELS[preset],
        }))}
        onChange={(preset) => updatePage('preset', preset)}
      />

      <NumberSliderField
        label="Page width"
        value={page.width}
        min={MIN_PAGE_SIZE}
        max={MAX_PAGE_SIZE}
        testId="wireframe-page-width"
        sliderName="Page width slider"
        onChange={(width) => updatePage('width', String(width))}
      />

      <NumberSliderField
        label="Page height"
        value={page.height}
        min={MIN_PAGE_SIZE}
        max={MAX_PAGE_SIZE}
        testId="wireframe-page-height"
        sliderName="Page height slider"
        onChange={(height) => updatePage('height', String(height))}
      />

      <Text fontSize="xs" color="fg.muted" data-testid="wireframe-page-clip-caption">
        Content outside the page is hidden and not exported.
      </Text>
    </VStack>
  );
}
