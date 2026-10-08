/**
 * LayoutSettings — Settings → Layout (Spec #2980 ST-2; EARS R-1.1, R-1.2 UI,
 * R-1.3 UI, R-2.2 list, R-2.3 assign; plan UI/UX §1 LayoutSettings).
 *
 * The ONE discoverable place to configure the zone model. Wired into the LIVE
 * shell (`SettingsSurface`) as a STATIC platform section (the Hotkeys
 * precedent) — NOT through feature `hasSettings` discovery. Every control is
 * IMMEDIATE WRITE-THROUGH to the ST-1 module-scoped store (`useZoneLayout()` +
 * the store actions): there is no Save footer and no second config store. The
 * store's own debounced persistence carries the value to `Fredo_layout_zones`.
 *
 * The editor (`ZoneLayoutEditor`, ST-3) opens IN PLACE as a bordered card, so
 * the settings sidebar stays reachable and no focus is trapped. Text status is
 * announced by a section-local `role="status"` line (the Hotkeys pattern); the
 * "Active" state is never colour-only (a text pill + `aria-current`).
 *
 * Chord labels are a LOCAL presentational map (no new shared hook/export): the
 * `primary` token is resolved through the hotkey engine's existing
 * `resolvePrimaryModifier()`, and each option's accessible name is spelled out
 * ("Control plus Alt"). Presentation is token-first — semantic tokens + CSS
 * vars + the shared `tint()` helper; no hex/rgba literal and never an
 * alpha-append onto a `var()`.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  chakra,
  HStack,
  Icon,
  Input,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuLayoutGrid,
  LuPencil,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { announce } from '../../../shared/hotkeys/announcer';
import { resolvePrimaryModifier } from '../../../shared/hotkeys/keys';
import {
  MAX_ZONE_GAP,
  MIN_ZONE_GAP,
  ZONE_ACTIVATION_CHORDS,
  type ZoneActivationChord,
  type ZoneLayout,
} from '../../../shared/window-system/zoneLayout';
import {
  deleteZoneLayout,
  getZoneLayoutSnapshot,
  setActiveZoneLayout,
  setZoneChord,
  setZoneGap,
  setZoneLayoutEnabled,
  useZoneLayout,
} from '../../../shared/window-system/zoneLayoutStore';

import { ZoneLayoutEditor } from './ZoneLayoutEditor';

/** The static Settings sidebar id for the Layout section. */
export const LAYOUT_NAV_ID = 'layout';

/** The select chrome (CSS vars so it follows the user theme — never NativeSelect). */
const selectStyles = {
  width: 'auto',
  minW: '160px',
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
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
} as const;

/** The visible label + spelled accessible name for one activation chord. */
interface ChordPresentation {
  readonly label: string;
  readonly spelled: string;
}

/**
 * The local presentational chord map — built from the engine's ONE platform
 * rule (`resolvePrimaryModifier`), so "primary" reads as Ctrl on win32/linux
 * and ⌘ on darwin with no second implementation. Iterated in the canonical
 * `ZONE_ACTIVATION_CHORDS` order by the render.
 */
function buildChordPresentation(): Record<ZoneActivationChord, ChordPresentation> {
  const isMeta = resolvePrimaryModifier() === 'meta';
  const primaryLabel = isMeta ? '⌘' : 'Ctrl';
  const primarySpelled = isMeta ? 'Command' : 'Control';
  return {
    alt: { label: 'Alt', spelled: 'Alt' },
    primary: { label: primaryLabel, spelled: primarySpelled },
    'primary+alt': {
      label: `${primaryLabel}+Alt`,
      spelled: `${primarySpelled} plus Alt`,
    },
    'primary+shift': {
      label: `${primaryLabel}+Shift`,
      spelled: `${primarySpelled} plus Shift`,
    },
    'alt+shift': { label: 'Alt+Shift', spelled: 'Alt plus Shift' },
  };
}

interface EditorState {
  readonly layout: ZoneLayout | null;
  readonly untitledIndex: number;
}

export const LayoutSettings: React.FC = () => {
  // Stable `useSyncExternalStore` snapshot — re-renders only on a real mutation.
  const layout = useZoneLayout();

  const [status, setStatus] = useState<string | null>(null);
  /** Non-null while the gap field holds an uncommitted draft; null = show store. */
  const [gapDraft, setGapDraft] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ZoneLayout | null>(null);

  const chordPresentation = useMemo(buildChordPresentation, []);

  const applyStatus = useCallback((message: string | null) => {
    setStatus(message);
    if (message) announce(message);
  }, []);

  // ── Write-through handlers ──────────────────────────────────────────────────

  const handleEnabled = useCallback(
    (checked: boolean) => {
      setZoneLayoutEnabled(checked);
      applyStatus(checked ? 'Layout management enabled.' : 'Layout management disabled.');
    },
    [applyStatus],
  );

  const handleActive = useCallback(
    (value: string) => {
      const id = value === '' ? null : value;
      setActiveZoneLayout(id);
      const name =
        id === null
          ? null
          : (getZoneLayoutSnapshot().layouts.find((entry) => entry.id === id)?.name ?? null);
      applyStatus(name ? `Active layout: ${name}.` : 'No active layout.');
    },
    [applyStatus],
  );

  const handleGapChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setGapDraft(raw);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) setZoneGap(parsed);
  }, []);

  const handleGapBlur = useCallback(() => {
    if (gapDraft === null) return;
    const parsed = Number.parseInt(gapDraft, 10);
    const next = Number.isFinite(parsed) ? parsed : getZoneLayoutSnapshot().gap;
    setZoneGap(next);
    setGapDraft(null);
    applyStatus(`Zone gap: ${getZoneLayoutSnapshot().gap} px.`);
  }, [gapDraft, applyStatus]);

  const handleChord = useCallback(
    (value: string) => {
      setZoneChord(value as ZoneActivationChord);
      const presentation = chordPresentation[value as ZoneActivationChord];
      applyStatus(presentation ? `Activation chord: ${presentation.label}.` : null);
    },
    [chordPresentation, applyStatus],
  );

  const handleAssign = useCallback(
    (target: ZoneLayout) => {
      setActiveZoneLayout(target.id);
      applyStatus(`Active layout: ${target.name}.`);
    },
    [applyStatus],
  );

  const openNew = useCallback(() => {
    setEditor({ layout: null, untitledIndex: getZoneLayoutSnapshot().layouts.length + 1 });
    applyStatus(null);
  }, [applyStatus]);

  const openEdit = useCallback(
    (target: ZoneLayout) => {
      setEditor({ layout: target, untitledIndex: 1 });
      applyStatus(null);
    },
    [applyStatus],
  );

  const closeEditor = useCallback(
    (saved: ZoneLayout | null) => {
      setEditor(null);
      if (saved) applyStatus(`Saved layout ${saved.name}.`);
    },
    [applyStatus],
  );

  const confirmDelete = useCallback(() => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    deleteZoneLayout(target.id);
    applyStatus(`Deleted layout ${target.name}.`);
  }, [pendingDelete, applyStatus]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const gapValue = gapDraft ?? String(layout.gap);
  const controlsDisabled = !layout.enabled;

  return (
    <Box data-testid="layout-settings" p={5}>
      <Text as="h3" fontSize="lg" fontWeight="600" color="fg.default">
        Layout
      </Text>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        Arrange windows into zones by dragging them with an activation chord.
      </Text>

      {/* ── Enable ── */}
      <HStack justify="space-between" align="center" gap={4} mb={4} maxW="440px">
        <VStack align="start" gap={0}>
          <Text fontSize="sm" fontWeight="500" color="fg.default">
            Enable layout management
          </Text>
          <Text fontSize="xs" color="fg.muted">
            Turn on zone layouts and chord-drag snapping.
          </Text>
        </VStack>
        <Switch.Root
          checked={layout.enabled}
          onCheckedChange={(details) => handleEnabled(details.checked)}
          size="md"
          flexShrink={0}
        >
          <Switch.HiddenInput
            data-testid="layout-enabled-toggle"
            aria-label="Enable layout management"
          />
          <Switch.Control />
        </Switch.Root>
      </HStack>

      {/* ── Active layout ── */}
      <VStack align="stretch" gap={1} mb={4} maxW="440px">
        <Text fontSize="sm" fontWeight="500" color="fg.default">
          Active layout
        </Text>
        <chakra.select
          {...selectStyles}
          data-testid="layout-active-select"
          aria-label="Active layout"
          value={layout.activeLayoutId ?? ''}
          disabled={controlsDisabled || layout.layouts.length === 0}
          onChange={(event) => handleActive(event.target.value)}
        >
          <option value="">None</option>
          {layout.layouts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </chakra.select>
        {layout.layouts.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">
            Define a layout first
          </Text>
        ) : null}
      </VStack>

      {/* ── Zone gap ── */}
      <VStack align="stretch" gap={1} mb={4} maxW="440px">
        <Text fontSize="sm" fontWeight="500" color="fg.default">
          Zone gap
        </Text>
        <Input
          data-testid="layout-gap-input"
          aria-label="Zone gap"
          type="number"
          inputMode="numeric"
          min={MIN_ZONE_GAP}
          max={MAX_ZONE_GAP}
          step={1}
          size="sm"
          maxW="160px"
          value={gapValue}
          disabled={controlsDisabled}
          onChange={handleGapChange}
          onBlur={handleGapBlur}
        />
        <Text fontSize="xs" color="fg.muted">
          0–32 px
        </Text>
      </VStack>

      {/* ── Activation chord ── */}
      <VStack align="stretch" gap={1} mb={4} maxW="440px">
        <Text fontSize="sm" fontWeight="500" color="fg.default">
          Activation chord
        </Text>
        <chakra.select
          {...selectStyles}
          data-testid="layout-chord-select"
          aria-label="Activation chord"
          value={layout.chord}
          disabled={controlsDisabled}
          onChange={(event) => handleChord(event.target.value)}
        >
          {ZONE_ACTIVATION_CHORDS.map((value) => {
            const presentation = chordPresentation[value];
            return (
              <option key={value} value={value} aria-label={presentation.spelled}>
                {presentation.label}
              </option>
            );
          })}
        </chakra.select>
      </VStack>

      {/* ── Section-local feedback (role=status; not a shared live region) ── */}
      {status ? (
        <HStack
          data-testid="layout-save-status"
          role="status"
          aria-live="polite"
          gap={1}
          color="fg.default"
          mb={4}
        >
          <Icon as={LuCircleCheck} boxSize="12px" />
          <Text fontSize="xs">{status}</Text>
        </HStack>
      ) : null}

      {/* ── Defined layouts ── */}
      <HStack justify="space-between" align="center" gap={3} mb={2} maxW="640px">
        <Text fontSize="sm" fontWeight="600" color="fg.default">
          Layouts
        </Text>
        <Button
          data-testid="layout-new-button"
          size="xs"
          variant="outline"
          onClick={openNew}
        >
          <LuPlus />
          New layout
        </Button>
      </HStack>

      {layout.layouts.length === 0 ? (
        <Text data-testid="layout-list-empty" fontSize="sm" color="fg.muted" mb={4}>
          No layouts yet — create one to get started.
        </Text>
      ) : (
        <VStack align="stretch" gap={2} mb={4} maxW="640px">
          {layout.layouts.map((entry) => {
            const isActive = layout.activeLayoutId === entry.id;
            const zeroZones = entry.zones.length === 0;
            return (
              <HStack
                key={entry.id}
                data-testid={`layout-list-item-${entry.id}`}
                aria-current={isActive ? 'true' : undefined}
                gap={3}
                px={3}
                py={2}
                borderWidth="1px"
                borderColor={isActive ? 'accent.default' : 'border.default'}
                borderLeftWidth="3px"
                borderLeftColor={isActive ? 'var(--accent-strong)' : 'transparent'}
                borderRadius="md"
                bg={isActive ? tint('var(--accent-primary)', 8) : 'bg.surface'}
              >
                <Icon as={LuLayoutGrid} boxSize="14px" color="fg.muted" flexShrink={0} />
                <Text fontSize="sm" color="fg.default" flex={1} minW={0} truncate>
                  {entry.name}
                </Text>
                <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                  {entry.zones.length} zones · {entry.template}
                </Text>
                {isActive ? (
                  <chakra.span
                    data-testid={`layout-active-pill-${entry.id}`}
                    fontSize="xs"
                    bg="accent.default"
                    color="fg.onAccent"
                    px={2}
                    py={0.5}
                    borderRadius="full"
                    whiteSpace="nowrap"
                  >
                    Active
                  </chakra.span>
                ) : null}
                <Button
                  data-testid={`layout-assign-${entry.id}`}
                  size="xs"
                  variant={isActive ? 'ghost' : 'outline'}
                  disabled={zeroZones}
                  aria-disabled={isActive || zeroZones}
                  onClick={() => handleAssign(entry)}
                >
                  Use
                </Button>
                <Button
                  data-testid={`layout-edit-${entry.id}`}
                  size="xs"
                  variant="ghost"
                  aria-label={`Edit ${entry.name}`}
                  onClick={() => openEdit(entry)}
                >
                  <LuPencil />
                </Button>
                <Button
                  data-testid={`layout-delete-${entry.id}`}
                  size="xs"
                  variant="ghost"
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => setPendingDelete(entry)}
                >
                  <LuTrash2 />
                </Button>
              </HStack>
            );
          })}
        </VStack>
      )}

      {/* ── In-place editor (never a modal; no focus trap) ── */}
      {editor ? (
        <Box data-testid="layout-editor-host" mb={4}>
          <ZoneLayoutEditor
            layout={editor.layout}
            untitledIndex={editor.untitledIndex}
            onClose={closeEditor}
          />
        </Box>
      ) : null}

      {/* ── Destructive-confirm (inline alertdialog; Hotkeys reset precedent) ── */}
      {pendingDelete ? (
        <Box
          data-testid="layout-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label={`Delete ${pendingDelete.name}`}
          mb={4}
          p={4}
          borderWidth="1px"
          borderColor="status.error"
          borderRadius="md"
          bg="bg.surface"
        >
          <Text fontSize="sm" color="fg.default" fontWeight="600">
            Delete {pendingDelete.name}? Windows assigned to it return to free float.
          </Text>
          <HStack gap={2} mt={3}>
            <Button
              data-testid="layout-delete-confirm"
              size="xs"
              variant="solid"
              bg="status.error"
              color="fg.onAccent"
              onClick={confirmDelete}
            >
              Delete
            </Button>
            <Button
              data-testid="layout-delete-cancel"
              size="xs"
              variant="ghost"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
          </HStack>
        </Box>
      ) : null}
    </Box>
  );
};
