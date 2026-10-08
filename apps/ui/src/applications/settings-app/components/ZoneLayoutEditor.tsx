/**
 * ZoneLayoutEditor — the in-place layout editor for the Settings → Layout section
 * (Spec #2980 ST-3; EARS R-2.1, R-2.2, R-2.4, R-2.5; plan UI/UX §1 ZoneLayoutEditor).
 *
 * Builds a `ZoneLayout` from the columns / rows / grid / main-side templates and a
 * custom recursive split (`splitZone` on a selected preview zone), paints a live
 * fractional preview of the zones, and confirms with `saveZoneLayout` only. The
 * draft lives in COMPONENT STATE — editing the currently-assigned layout therefore
 * only upserts the store; the renderers re-derive their rects (R-2.5), so there is
 * no imperative reflow and nothing to corrupt the workspace.
 *
 * The confirm is disabled while the draft has zero zones (R-2.4); a submit attempt
 * (Enter / programmatic) still surfaces `layout-editor-error`. The editor is NOT a
 * modal — a bordered card in place, so the settings sidebar stays reachable and no
 * focus is trapped.
 *
 * This file consumes ST-1's pure math (`buildTemplateZones`, `splitZone`) and the
 * ST-1 store (`saveZoneLayout`) verbatim — it never re-implements zone math.
 * Presentation is token-first: semantic tokens + CSS vars + the shared `tint()`
 * helper — never a hex/rgba literal and never an alpha-append onto a `var()`.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Button, HStack, Icon, Input, Text, VStack, chakra } from '@chakra-ui/react';
import { LuCircleCheck, LuTriangleAlert, LuX } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import {
  buildTemplateZones,
  splitZone,
  type TemplateParams,
  type Zone,
  type ZoneLayout,
  type ZoneTemplateId,
} from '../../../shared/window-system/zoneLayout';
import {
  getZoneLayoutSnapshot,
  getZoneLayoutWorkspace,
  saveZoneLayout,
} from '../../../shared/window-system/zoneLayoutStore';

/** A selectable starting template (the `custom` shape is reached only by splitting). */
type PresetTemplate = Exclude<ZoneTemplateId, 'custom'>;

const PRESET_TEMPLATES: ReadonlyArray<{ id: PresetTemplate; label: string }> = [
  { id: 'columns', label: 'Columns' },
  { id: 'rows', label: 'Rows' },
  { id: 'grid', label: 'Grid' },
  { id: 'main-side', label: 'Main + side' },
];

const COLUMN_ROW_COUNTS = [2, 3, 4] as const;
const GRID_COUNTS = [2, 3] as const;

/** Main-pane share bounds (fraction of the workspace width). */
const MIN_MAIN_FRACTION = 0.3;
const MAX_MAIN_FRACTION = 0.7;
const DEFAULT_MAIN_FRACTION = 0.6;

/** The select chrome (CSS vars so it follows the user theme — never NativeSelect). */
const selectStyles = {
  width: 'auto',
  minW: '120px',
  p: 2,
  borderRadius: 'md',
  bg: 'var(--card-bg)',
  border: '1px solid',
  borderColor: 'var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 'sm',
  cursor: 'pointer',
  _hover: { borderColor: 'var(--accent-primary)' },
  _focus: {
    outline: 'none',
    borderColor: 'var(--accent-primary)',
    boxShadow: '0 0 0 1px var(--accent-primary)',
  },
} as const;

export interface ZoneLayoutEditorProps {
  /** The layout being edited; `null`/absent creates a new one. */
  layout?: ZoneLayout | null;
  /** 1-based index for the default "Untitled {n}" name (new layouts only). */
  untitledIndex?: number;
  /** Called after a successful save (with the stored layout) or on cancel (`null`). */
  onClose?: (saved: ZoneLayout | null) => void;
}

/** A stable new layout id (no `uuid` package — `crypto.randomUUID` per AGENTS.md). */
function newLayoutId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `layout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneZone(zone: Zone): Zone {
  return { id: zone.id, rect: { ...zone.rect } };
}

/** The clamped-integer count for a count select value. */
function parseCount(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(4, Math.max(2, parsed));
}

/** The measured workspace aspect ratio, or the 16/10 fallback when unmeasured. */
function previewAspectRatio(): number {
  const workspace = getZoneLayoutWorkspace();
  if (workspace && workspace.width > 0 && workspace.height > 0) {
    return workspace.width / workspace.height;
  }
  return 16 / 10;
}

export const ZoneLayoutEditor: React.FC<ZoneLayoutEditorProps> = ({
  layout = null,
  untitledIndex,
  onClose,
}) => {
  const [draftId] = useState(() => layout?.id ?? newLayoutId());
  const [name, setName] = useState(
    () =>
      layout?.name ??
      `Untitled ${untitledIndex ?? getZoneLayoutSnapshot().layouts.length + 1}`,
  );
  const [template, setTemplate] = useState<ZoneTemplateId>(layout?.template ?? 'custom');
  const [zones, setZones] = useState<Zone[]>(() =>
    layout ? layout.zones.map(cloneZone) : [],
  );
  const [columnCount, setColumnCount] = useState(() =>
    layout?.template === 'columns' ? Math.max(2, layout.zones.length) : 2,
  );
  const [rowCount, setRowCount] = useState(() =>
    layout?.template === 'rows' ? Math.max(2, layout.zones.length) : 2,
  );
  const [gridCount, setGridCount] = useState(() =>
    layout?.template === 'grid'
      ? Math.min(3, Math.max(2, Math.round(Math.sqrt(layout.zones.length))))
      : 2,
  );
  const [mainFraction, setMainFraction] = useState(DEFAULT_MAIN_FRACTION);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aspectRatio = useMemo(previewAspectRatio, []);

  // ── Template + params ───────────────────────────────────────────────────────

  const applyTemplate = useCallback(
    (id: PresetTemplate) => {
      const params: TemplateParams =
        id === 'columns'
          ? { columns: columnCount }
          : id === 'rows'
            ? { rows: rowCount }
            : id === 'grid'
              ? { columns: gridCount, rows: gridCount }
              : { mainFraction };
      setTemplate(id);
      setZones(buildTemplateZones(id, params));
      setSelectedZoneId(null);
      setError(null);
    },
    [columnCount, rowCount, gridCount, mainFraction],
  );

  const handleCountChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const raw = event.target.value;
      if (template === 'grid') {
        const next = parseCount(raw, gridCount);
        setGridCount(next);
        setZones(buildTemplateZones('grid', { columns: next, rows: next }));
      } else if (template === 'columns') {
        const next = parseCount(raw, columnCount);
        setColumnCount(next);
        setZones(buildTemplateZones('columns', { columns: next }));
      } else if (template === 'rows') {
        const next = parseCount(raw, rowCount);
        setRowCount(next);
        setZones(buildTemplateZones('rows', { rows: next }));
      }
      setSelectedZoneId(null);
      setError(null);
    },
    [template, columnCount, rowCount, gridCount],
  );

  const handleMainFractionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = Number.parseFloat(event.target.value);
      if (!Number.isFinite(next)) return;
      const clamped = Math.min(MAX_MAIN_FRACTION, Math.max(MIN_MAIN_FRACTION, next));
      setMainFraction(clamped);
      setZones(buildTemplateZones('main-side', { mainFraction: clamped }));
      setSelectedZoneId(null);
      setError(null);
    },
    [],
  );

  // ── Custom split (ST-1 math, never re-implemented) ──────────────────────────

  const handleSplit = useCallback(
    (axis: 'horizontal' | 'vertical') => {
      if (selectedZoneId === null) return;
      const next = splitZone(zones, selectedZoneId, axis, 0.5);
      if (next === zones) return;
      setZones(next);
      setTemplate('custom');
      setSelectedZoneId(`${selectedZoneId}-a`);
      setError(null);
    },
    [zones, selectedZoneId],
  );

  // ── Confirm / cancel ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setError('Enter a name for the layout.');
        return;
      }
      if (zones.length === 0) {
        setError('Add at least one zone before saving.');
        return;
      }
      const stored = saveZoneLayout({ id: draftId, name: trimmed, template, zones });
      setError(null);
      onClose?.(stored);
    },
    [name, zones, draftId, template, onClose],
  );

  const handleCancel = useCallback(() => {
    onClose?.(null);
  }, [onClose]);

  // ── Derived select state ────────────────────────────────────────────────────

  const countEnabled = template === 'columns' || template === 'rows' || template === 'grid';
  const countValue =
    template === 'grid'
      ? `${gridCount}x${gridCount}`
      : template === 'columns'
        ? String(columnCount)
        : template === 'rows'
          ? String(rowCount)
          : '';

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Box
      data-testid="layout-editor"
      role="group"
      aria-label="Zone layout editor"
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="md"
      p={4}
    >
      <form onSubmit={handleSubmit} noValidate>
        <VStack align="stretch" gap={3}>
          <Text fontSize="sm" fontWeight="600" color="fg.default">
            {layout ? `Edit "${layout.name}"` : 'New layout'}
          </Text>

          <Input
            data-testid="layout-editor-name"
            aria-label="Layout name"
            aria-required="true"
            placeholder="Layout name"
            size="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          {/* Template radiogroup */}
          <HStack data-testid="layout-template" role="radiogroup" aria-label="Zone template" gap={2} wrap="wrap">
            {PRESET_TEMPLATES.map((entry) => {
              const active = template === entry.id;
              return (
                <chakra.button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`layout-template-${entry.id}`}
                  onClick={() => applyTemplate(entry.id)}
                  borderWidth="1px"
                  borderColor={active ? 'accent.default' : 'border.default'}
                  bg={active ? tint('var(--accent-primary)', 12) : 'bg.surface'}
                  color="fg.default"
                  borderRadius="sm"
                  px={3}
                  py={1}
                  fontSize="xs"
                >
                  {entry.label}
                </chakra.button>
              );
            })}
          </HStack>

          {/* Count — columns/rows 2–4, grid 2×2 / 3×3, disabled otherwise */}
          <HStack gap={3} align="center">
            <Text fontSize="xs" color="fg.muted">
              Zones
            </Text>
            <chakra.select
              {...selectStyles}
              data-testid="layout-template-count"
              aria-label="Zone count"
              value={countValue}
              disabled={!countEnabled}
              onChange={handleCountChange}
            >
              {template === 'grid' ? (
                GRID_COUNTS.map((count) => (
                  <option key={count} value={`${count}x${count}`}>
                    {count}×{count}
                  </option>
                ))
              ) : countEnabled ? (
                COLUMN_ROW_COUNTS.map((count) => (
                  <option key={count} value={String(count)}>
                    {count}
                  </option>
                ))
              ) : (
                <option value="">—</option>
              )}
            </chakra.select>
          </HStack>

          {/* Main fraction — main-side only */}
          {template === 'main-side' ? (
            <HStack gap={3} align="center">
              <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                Main pane share
              </Text>
              <chakra.input
                type="range"
                data-testid="layout-template-main-fraction"
                aria-label="Main pane share"
                min={MIN_MAIN_FRACTION}
                max={MAX_MAIN_FRACTION}
                step={0.05}
                value={mainFraction}
                onChange={handleMainFractionChange}
                accentColor="var(--accent-primary)"
              />
              <Text fontSize="xs" color="fg.default" minW="36px">
                {Math.round(mainFraction * 100)}%
              </Text>
            </HStack>
          ) : null}

          {/* Live fractional preview mini-map */}
          <Box
            data-testid="layout-editor-preview"
            position="relative"
            width="100%"
            aspectRatio={aspectRatio}
            maxH="240px"
            bg="bg.subtle"
            borderWidth="1px"
            borderStyle={zones.length === 0 ? 'dashed' : 'solid'}
            borderColor="border.default"
            borderRadius="sm"
            overflow="hidden"
          >
            {zones.length === 0 ? (
              <Box
                position="absolute"
                inset="0"
                display="flex"
                alignItems="center"
                justifyContent="center"
                px={3}
              >
                <Text fontSize="xs" color="fg.muted" textAlign="center">
                  Add a template or split to create zones.
                </Text>
              </Box>
            ) : (
              zones.map((zone, index) => {
                const selected = selectedZoneId === zone.id;
                return (
                  <chakra.button
                    key={zone.id}
                    type="button"
                    data-testid={`layout-editor-zone-${zone.id}`}
                    aria-pressed={selected}
                    aria-label={`Zone ${index + 1} of ${zones.length}`}
                    onClick={() => setSelectedZoneId(zone.id)}
                    position="absolute"
                    left={`${zone.rect.x * 100}%`}
                    top={`${zone.rect.y * 100}%`}
                    width={`${zone.rect.width * 100}%`}
                    height={`${zone.rect.height * 100}%`}
                    borderWidth={selected ? '2px' : '1px'}
                    borderColor={selected ? 'accent.default' : 'border.default'}
                    bg={selected ? tint('var(--accent-primary)', 12) : 'bg.surface'}
                    color={selected ? 'fg.default' : 'fg.muted'}
                    fontSize="xs"
                  >
                    {index + 1}
                  </chakra.button>
                );
              })
            )}
          </Box>

          {/* Split controls */}
          <VStack align="stretch" gap={1}>
            <HStack gap={2}>
              <Button
                data-testid="layout-editor-split-h"
                size="xs"
                variant="outline"
                disabled={selectedZoneId === null}
                onClick={() => handleSplit('horizontal')}
              >
                Split left / right
              </Button>
              <Button
                data-testid="layout-editor-split-v"
                size="xs"
                variant="outline"
                disabled={selectedZoneId === null}
                onClick={() => handleSplit('vertical')}
              >
                Split top / bottom
              </Button>
            </HStack>
            {selectedZoneId === null ? (
              <Text fontSize="xs" color="fg.muted">
                Select a zone in the preview to split it.
              </Text>
            ) : null}
          </VStack>

          {/* Error */}
          {error ? (
            <HStack data-testid="layout-editor-error" role="alert" gap={1} color="status.error">
              <Icon as={LuTriangleAlert} boxSize="12px" />
              <Text fontSize="xs">{error}</Text>
            </HStack>
          ) : null}

          {/* Confirm / cancel */}
          <HStack gap={2}>
            <Button
              data-testid="layout-editor-confirm"
              type="submit"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              disabled={zones.length === 0}
            >
              <LuCircleCheck />
              Save layout
            </Button>
            <Button
              data-testid="layout-editor-cancel"
              type="button"
              size="xs"
              variant="ghost"
              onClick={handleCancel}
            >
              <LuX />
              Cancel
            </Button>
          </HStack>
        </VStack>
      </form>
    </Box>
  );
};
