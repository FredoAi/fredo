/**
 * HotkeysSettings — the Settings → Hotkeys surface (Spec #2946 ST-6; AC4 / R-4.1,
 * R-4.2, R-4.4, R-4.7, R-4.8; R-2.1/R-2.2/R-2.4 listing; R-5.3 listing).
 *
 * Wired into the LIVE shell (`SettingsSurface`) as a STATIC platform section
 * (like Appearance / Telemetry), NOT through the feature `hasSettings`
 * discovery. Every change is IMMEDIATE WRITE-THROUGH via the ST-2 keymap store
 * (the `BackgroundSettings`/`DockPositionSettings` precedent) — no Save footer,
 * no registered `saveFn`.
 *
 * The pane renders the ONE merged registry listing (`listHotkeyActions()`): the
 * Fredo tier first, then one section per feature that actually contributes rows.
 * Search filters (hides) — it never reorders. Rebind capture is keyboard-only:
 * a document capture-phase listener records the next chord, bare modifier
 * presses do not commit, and Escape cancels.
 *
 * Validation is delegated to the ONE classifier — `classifyBinding` (ST-1):
 * reserved / invalid → rejected inline with the classifier's reason; same-tier
 * collision → a conflict surface that BLOCKS the save (ST-7 owns the full
 * dialog; `registerHotkeyConflictDialog` is the hand-off hook and a minimal
 * inline surface keeps the flow completable until it lands); cross-tier →
 * applied and labelled with the precedence. The classifier is never bypassed.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  LuBookOpen,
  LuCircleCheck,
  LuKeyboard,
  LuPlus,
  LuRotateCcw,
  LuSearch,
  LuTriangleAlert,
  LuX,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';

import { getFeatures } from '../../featureRegistry';
import { Keycap } from '../../../shared/components/hotkeys/Keycap';
import { announce } from '../../../shared/hotkeys/announcer';
import { classifyBinding } from '../../../shared/hotkeys/conflicts';
import { describeSequence } from '../../../shared/hotkeys/describe';
import { normalizeKeyStroke, parseSequence, sequenceEquals, serializeSequence } from '../../../shared/hotkeys/keys';
import { getDefaultBinding } from '../../../shared/hotkeys/persistence';
import { listHotkeyActions } from '../../../shared/hotkeys/registry';
import { PLATFORM_RESERVED_COMBOS } from '../../../shared/hotkeys/reserved';
import {
  clearBinding,
  getKeymap,
  hydrateKeymap,
  resetAllBindings,
  setBinding,
  useHotkeyRevision,
} from '../../../shared/hotkeys/store';
import {
  applyVimPreset,
  buildVimPresetPreview,
  type VimPresetPreview,
} from '../../../shared/hotkeys/vimPreset';
import type {
  ConflictReport,
  HotkeyActionId,
  HotkeyTier,
  PersistedKeymap,
  RegisteredHotkeyAction,
} from '../../../shared/hotkeys/types';
import { HotkeyConflictDialog, type HotkeyConflictResolution } from './HotkeyConflictDialog';
import { MacroEditor } from './MacroEditor';

// ── Testids (the plan's UI/UX names block — consumed by the tester) ──────────

export const HOTKEYS_NAV_ID = 'hotkeys';

// ── The ST-7 conflict-dialog hand-off hook ───────────────────────────────────

/** Context handed to a registered conflict-dialog renderer (ST-7). */
export interface HotkeyConflictDialogContext {
  readonly candidate: string;
  readonly targetAction: RegisteredHotkeyAction | null;
  readonly report: ConflictReport;
  /**
   * `override` keeps both bindings (the displaced one stays recorded + labelled);
   * `rebind-other` clears the colliding binding(s) then saves this one; `cancel`
   * discards the capture and changes nothing.
   */
  readonly onResolve: (resolution: HotkeyConflictResolution) => void;
}

export type HotkeyConflictDialogRenderer = (ctx: HotkeyConflictDialogContext) => React.ReactNode;

let conflictDialogRenderer: HotkeyConflictDialogRenderer | null = null;

/**
 * Install the ST-7 conflict dialog. Until a renderer is registered the pane
 * shows a minimal inline conflict surface — `classifyBinding` remains the ONE
 * authority either way, so a save is never applied past a same-tier collision.
 */
export function registerHotkeyConflictDialog(
  renderer: HotkeyConflictDialogRenderer | null,
): void {
  conflictDialogRenderer = renderer;
}

/** Test-only: drop a registered conflict-dialog renderer. */
export function resetHotkeyConflictDialogForTests(): void {
  conflictDialogRenderer = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type TierFilter = 'all' | 'fredo' | 'features';
type CaptureMode = 'replace' | 'add';

interface CaptureState {
  readonly actionId: HotkeyActionId;
  readonly mode: CaptureMode;
}

interface ConflictState {
  readonly actionId: HotkeyActionId;
  readonly mode: CaptureMode;
  readonly serialized: string;
  readonly report: ConflictReport;
}

interface PaneRow {
  readonly action: RegisteredHotkeyAction;
  readonly featureId: string | null;
  readonly featureName: string | null;
  readonly bindings: readonly string[];
  readonly defaults: readonly string[];
}

interface PrecedenceTag {
  readonly kind: 'wins' | 'fallback' | 'duplicate';
  readonly featureId: string | null;
  readonly featureName: string | null;
  /** The other action's title for a same-tier duplicate (override kept both). */
  readonly otherTitle?: string;
  /** `displaced` = this row's binding was displaced by an explicit override (R-5.2). */
  readonly duplicateRole?: 'displaced' | 'overriding';
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shipped defaults for an action: the registry declaration for features,
 *  the shipped table for Fredo actions (falling back to a declaration). */
function shippedDefaults(action: RegisteredHotkeyAction): readonly string[] {
  if (action.tier === 'feature') {
    return action.defaultSequence ? [action.defaultSequence] : [];
  }
  const minimal = getDefaultBinding(action.actionId);
  if (minimal.length > 0) return minimal;
  return action.defaultSequence ? [action.defaultSequence] : [];
}

/** The effective bindings: an explicit keymap entry wins, else the declared default. */
function effectiveBindings(
  action: RegisteredHotkeyAction,
  keymap: PersistedKeymap,
): readonly string[] {
  const explicit = keymap.bindings[action.actionId];
  if (explicit !== undefined) return explicit;
  return action.defaultSequence ? [action.defaultSequence] : [];
}

function sequencesEqual(a: string, b: string): boolean {
  return sequenceEquals(parseSequence(a), parseSequence(b));
}

function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((sequence, index) => sequence === b[index]);
}

function rebindButtonId(actionId: HotkeyActionId): string {
  return `hotkeys-rebind-${actionId}`;
}

/**
 * The focused window's first focusable control (R-1.4 fallback): used when the
 * dialog's invoking rebind button is no longer in the DOM.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusFirstFocusable(): void {
  const first = document.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  first?.focus();
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="fg.muted"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {children as React.ReactNode}
  </Text>
);

// ── Component ─────────────────────────────────────────────────────────────────

export interface HotkeysSettingsProps {
  /** Best-effort focused feature id (ST-10 owns live focus). `null` = none. */
  readonly focusedFeatureId?: string | null;
}

export const HotkeysSettings: React.FC<HotkeysSettingsProps> = ({ focusedFeatureId = null }) => {
  const revision = useHotkeyRevision();

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [capturing, setCapturing] = useState<CaptureState | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  /** displacedActionId → overridingActionId, set by an explicit override (R-5.2). */
  const [displacedOverrides, setDisplacedOverrides] = useState<
    Record<HotkeyActionId, HotkeyActionId>
  >({});
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showResetAll, setShowResetAll] = useState(false);
  const [vimPreview, setVimPreview] = useState<VimPresetPreview | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [cheatsheetQuery, setCheatsheetQuery] = useState('');

  const captureFieldRef = useRef<HTMLDivElement | null>(null);

  // ── Load (idempotent hydrate; the pane owns its loading/error surface) ──────
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    (async () => {
      try {
        await hydrateKeymap();
        if (!cancelled) setLoadState('ready');
      } catch (error) {
        if (!cancelled) {
          setSaveError(`Couldn't load hotkeys — ${messageOf(error)}.`);
          setLoadState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadGeneration]);

  const retryLoad = useCallback(() => setLoadGeneration((generation) => generation + 1), []);

  // Install the ST-7 resolve-before-save dialog through the ST-6 hand-off hook.
  // The inline fallback below keeps the flow completable on the very first paint;
  // thereafter the real dialog owns every same-tier resolution.
  useEffect(() => {
    registerHotkeyConflictDialog((ctx) => <HotkeyConflictDialog {...ctx} />);
    return () => registerHotkeyConflictDialog(null);
  }, []);

  useEffect(() => {
    if (capturing) captureFieldRef.current?.focus();
  }, [capturing]);

  // ── Derive rows from the ONE registry listing + the keymap store ────────────
  const actions = useMemo(() => listHotkeyActions(), [revision]);
  const features = useMemo(() => {
    try {
      return getFeatures();
    } catch {
      return [];
    }
  }, []);

  const featureMeta = useMemo(() => {
    const map = new Map<string, { name: string; icon: IconType | undefined }>();
    for (const feature of features) map.set(feature.id, { name: feature.name, icon: feature.icon });
    return map;
  }, [features]);

  const keymap = getKeymap();

  const rows = useMemo<PaneRow[]>(() => {
    const current = getKeymap();
    return actions.map((action) => {
      const featureId = action.featureId ?? null;
      return {
        action,
        featureId,
        featureName: featureId ? featureMeta.get(featureId)?.name ?? featureId : null,
        bindings: effectiveBindings(action, current),
        defaults: shippedDefaults(action),
      };
    });
    // `revision` re-derives the rows on every real keymap mutation.
  }, [actions, featureMeta, revision]);

  // Cross-tier precedence labels (R-2.4) — same-tier collisions never reach a row.
  const precedence = useMemo(() => {
    const map = new Map<HotkeyActionId, PrecedenceTag>();
    for (const row of rows) {
      for (const other of rows) {
        if (row.action.actionId === other.action.actionId) continue;
        if (row.action.tier === other.action.tier) continue;
        const intersects = row.bindings.some((a) =>
          other.bindings.some((b) => sequencesEqual(a, b)),
        );
        if (!intersects) continue;
        if (row.action.tier === 'feature') {
          if (!map.has(row.action.actionId)) {
            map.set(row.action.actionId, {
              kind: 'wins',
              featureId: row.featureId,
              featureName: row.featureName,
            });
          }
        } else if (!map.has(row.action.actionId)) {
          map.set(row.action.actionId, {
            kind: 'fallback',
            featureId: other.featureId,
            featureName: other.featureName,
          });
        }
      }
    }

    // Same-tier duplicates exist ONLY through an explicit override (a normal
    // same-tier save is blocked by the dialog). Label BOTH rows and name the
    // displaced one so it is never silently discarded (R-5.2).
    for (const row of rows) {
      for (const other of rows) {
        if (row.action.actionId === other.action.actionId) continue;
        if (row.action.tier !== other.action.tier) continue;
        if (map.has(row.action.actionId)) continue;
        const intersects = row.bindings.some((a) =>
          other.bindings.some((b) => sequencesEqual(a, b)),
        );
        if (!intersects) continue;
        const displacedByOther =
          displacedOverrides[row.action.actionId] === other.action.actionId;
        const overridesOther =
          displacedOverrides[other.action.actionId] === row.action.actionId;
        map.set(row.action.actionId, {
          kind: 'duplicate',
          featureId: row.featureId,
          featureName: row.featureName,
          otherTitle: other.action.title,
          duplicateRole: displacedByOther
            ? 'displaced'
            : overridesOther
              ? 'overriding'
              : undefined,
        });
      }
    }
    return map;
  }, [rows, displacedOverrides]);

  const precedenceLabel = useCallback(
    (tag: PrecedenceTag): string => {
      if (tag.kind === 'duplicate') {
        const other = tag.otherTitle ?? 'another binding';
        if (tag.duplicateRole === 'displaced') {
          return `Displaced by "${other}" (override kept both)`;
        }
        if (tag.duplicateRole === 'overriding') {
          return `Overrides "${other}" (both kept)`;
        }
        return `Same key as "${other}" (override kept)`;
      }
      if (tag.kind === 'wins') return 'Feature wins here';
      const featureName = tag.featureName ?? 'feature';
      if (tag.featureId !== null && focusedFeatureId === tag.featureId) {
        return `Inactive while ${featureName} focused`;
      }
      return 'Global fallback';
    },
    [focusedFeatureId],
  );

  // ── Search (hide, never reorder; matches title/description/feature/key/token) ─
  const normalizedQuery = query.trim().toLowerCase();

  const matchesQuery = useCallback(
    (row: PaneRow): boolean => {
      if (normalizedQuery.length === 0) return true;
      const haystack = [
        row.action.title,
        row.action.description ?? '',
        row.featureName ?? '',
        ...row.bindings.map((binding) => describeSequence(binding).display),
        ...row.bindings,
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    },
    [normalizedQuery],
  );

  const matchesTier = useCallback(
    (row: PaneRow): boolean => {
      if (tierFilter === 'all') return true;
      return tierFilter === 'fredo' ? row.action.tier === 'fredo' : row.action.tier === 'feature';
    },
    [tierFilter],
  );

  const visibleRows = useMemo(
    () => rows.filter((row) => matchesQuery(row) && matchesTier(row)),
    [rows, matchesQuery, matchesTier],
  );

  const fredoRows = useMemo(
    () => visibleRows.filter((row) => row.action.tier === 'fredo'),
    [visibleRows],
  );

  const featureSections = useMemo(() => {
    const orderedIds: string[] = [];
    for (const feature of features) orderedIds.push(feature.id);
    for (const row of visibleRows) {
      if (row.action.tier !== 'feature' || row.featureId === null) continue;
      if (!orderedIds.includes(row.featureId)) orderedIds.push(row.featureId);
    }
    return orderedIds
      .map((featureId) => ({
        featureId,
        name: featureMeta.get(featureId)?.name ?? featureId,
        icon: featureMeta.get(featureId)?.icon,
        rows: visibleRows.filter((row) => row.featureId === featureId),
      }))
      .filter((section) => section.rows.length > 0); // R-2.2: zero contribution → no section
  }, [features, featureMeta, visibleRows]);

  const cheatsheetRows = useMemo(
    () => rows.filter((row) => matchesQueryFor(row, cheatsheetQuery.trim().toLowerCase())),
    [rows, cheatsheetQuery],
  );

  // ── Capture (keyboard-only) ─────────────────────────────────────────────────
  const applyCaptured = useCallback(
    async (actionId: HotkeyActionId, mode: CaptureMode, serialized: string) => {
      const currentActions = listHotkeyActions();
      const action = currentActions.find((entry) => entry.actionId === actionId) ?? null;
      const currentKeymap = getKeymap();
      const current = action
        ? effectiveBindings(action, currentKeymap)
        : currentKeymap.bindings[actionId] ?? [];
      const next = mode === 'add' ? [...current, serialized] : [serialized];
      try {
        await setBinding(actionId, next);
        setSaveError(null);
        setCaptureError(null);
        setStatus(
          `Saved — ${action?.title ?? actionId} now uses ${describeSequence(serialized).display}`,
        );
        setCapturing(null);
      } catch (error) {
        setStatus(null);
        setSaveError(`Couldn't save — ${messageOf(error)}. Change reverted.`);
        setCapturing(null);
      }
    },
    [],
  );

  const resolveCapture = useCallback(
    async (capture: CaptureState, serialized: string) => {
      const currentKeymap = getKeymap();
      const currentActions = listHotkeyActions();
      const action = currentActions.find((entry) => entry.actionId === capture.actionId) ?? null;
      const tier: HotkeyTier =
        action?.tier ?? (capture.actionId.startsWith('fredo.') ? 'fredo' : 'feature');
      const report = classifyBinding({
        candidate: serialized,
        targetActionId: capture.actionId,
        targetTier: tier,
        keymap: currentKeymap,
        actions: currentActions,
      });
      const display = describeSequence(serialized).display;

      if (report.kind === 'reserved' || report.kind === 'invalid') {
        const reason = report.reason ?? 'Unavailable combination';
        setCaptureError(`${display} — ${reason}`);
        announce(`Rejected: ${display} — ${reason}`);
        return;
      }
      if (report.kind === 'same-tier') {
        setCaptureError(null);
        setConflict({ actionId: capture.actionId, mode: capture.mode, serialized, report });
        setCapturing(null);
        announce('That key is already in use. Resolve the conflict before saving.');
        return;
      }
      await applyCaptured(capture.actionId, capture.mode, serialized);
    },
    [applyCaptured],
  );

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Esc') {
        setCaptureError(null);
        setCapturing(null);
        announce('Rebind cancelled.');
        return;
      }
      const stroke = normalizeKeyStroke(event);
      if (!stroke) return; // bare modifier / IME / AltGraph / dead key — wait
      void resolveCapture(capturing, serializeSequence([stroke]));
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, resolveCapture]);

  const startCapture = useCallback((actionId: HotkeyActionId, mode: CaptureMode) => {
    setCaptureError(null);
    setConflict(null);
    setStatus(null);
    setCapturing({ actionId, mode });
  }, []);

  const cancelCapture = useCallback(() => {
    setCaptureError(null);
    setCapturing(null);
  }, []);

  /** Restore focus to the invoking rebind button (or the first focusable) after close. */
  const focusInvoker = useCallback((actionId: HotkeyActionId) => {
    window.requestAnimationFrame(() => {
      const invoker = document.getElementById(rebindButtonId(actionId));
      if (invoker) {
        invoker.focus();
        return;
      }
      focusFirstFocusable();
    });
  }, []);

  const resolveConflict = useCallback(
    async (resolution: HotkeyConflictResolution) => {
      const pending = conflict;
      if (!pending) return;
      setConflict(null);
      setCaptureError(null);

      if (resolution === 'cancel') {
        announce('Conflict dismissed — neither binding was changed.');
        focusInvoker(pending.actionId);
        return;
      }

      const target =
        listHotkeyActions().find((entry) => entry.actionId === pending.actionId) ?? null;
      const targetTier: HotkeyTier =
        target?.tier ?? (pending.actionId.startsWith('fredo.') ? 'fredo' : 'feature');
      const sameTierCollisions = pending.report.colliding.filter(
        (entry) => entry.tier === targetTier,
      );

      if (resolution === 'rebind-other') {
        // Clear every same-tier binding on the chord, then save this one. The
        // other action becomes unbound (re-bindable) — never silently replaced.
        for (const entry of sameTierCollisions) {
          await clearBinding(entry.actionId);
        }
      }

      // Re-classify the LIVE keymap before committing: the classifier is the ONE
      // authority and no resolution path may bypass it.
      const verdict = classifyBinding({
        candidate: pending.serialized,
        targetActionId: pending.actionId,
        targetTier,
        keymap: getKeymap(),
        actions: listHotkeyActions(),
      });
      if (verdict.kind === 'reserved' || verdict.kind === 'invalid') {
        const reason = verdict.reason ?? 'Unavailable combination';
        setSaveError(`${describeSequence(pending.serialized).display} — ${reason}.`);
        announce(`Rejected: ${reason}`);
        focusInvoker(pending.actionId);
        return;
      }

      if (resolution === 'override' && sameTierCollisions.length > 0) {
        // Record the displaced bindings BEFORE applying so the listing labels
        // them — the displaced binding stays recorded (R-5.2).
        setDisplacedOverrides((previous) => {
          const next = { ...previous };
          for (const entry of sameTierCollisions) next[entry.actionId] = pending.actionId;
          return next;
        });
      }

      await applyCaptured(pending.actionId, pending.mode, pending.serialized);
      focusInvoker(pending.actionId);
    },
    [conflict, applyCaptured, focusInvoker],
  );

  // ── Reset ───────────────────────────────────────────────────────────────────
  const resetOne = useCallback(
    async (action: RegisteredHotkeyAction) => {
      try {
        await setBinding(action.actionId, shippedDefaults(action));
        setSaveError(null);
        setStatus(`Reset — ${action.title} restored to its default.`);
      } catch (error) {
        setStatus(null);
        setSaveError(`Couldn't save — ${messageOf(error)}. Change reverted.`);
      }
    },
    [],
  );

  const confirmResetAll = useCallback(async () => {
    setShowResetAll(false);
    try {
      await resetAllBindings();
      setSaveError(null);
      setStatus('All hotkeys reset to defaults. Macros were kept.');
    } catch (error) {
      setStatus(null);
      setSaveError(`Couldn't save — ${messageOf(error)}. Change reverted.`);
    }
  }, []);

  // ── Vim preset ──────────────────────────────────────────────────────────────
  const handleVimToggle = useCallback(async (enabled: boolean) => {
    try {
      const preview = await buildVimPresetPreview(enabled);
      setVimPreview(preview);
    } catch (error) {
      setSaveError(`Couldn't build the Vim preset preview — ${messageOf(error)}.`);
    }
  }, []);

  const confirmVimPreset = useCallback(async () => {
    const preview = vimPreview;
    if (!preview) return;
    try {
      await applyVimPreset(preview);
      setVimPreview(null);
      setSaveError(null);
      setStatus(preview.enable ? 'Vim preset enabled.' : 'Vim preset disabled — defaults restored.');
    } catch (error) {
      setStatus(null);
      setSaveError(`Couldn't save — ${messageOf(error)}. Change reverted.`);
    }
  }, [vimPreview]);

  // ── Cheat sheet deep-link ───────────────────────────────────────────────────
  const configureFromCheatsheet = useCallback((actionId: HotkeyActionId) => {
    setCheatsheetOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById(rebindButtonId(actionId))?.focus();
    });
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  const renderRow = (row: PaneRow): React.ReactNode => {
    const { action } = row;
    const tag = precedence.get(action.actionId) ?? null;
    const atDefault = sameBindings(row.bindings, row.defaults);
    const isCapturing = capturing?.actionId === action.actionId;

    return (
      <Box
        key={action.actionId}
        data-testid="hotkeys-row"
        data-hotkey-action={action.actionId}
        data-hotkey-tier={
          action.tier === 'fredo' ? 'global' : `feature:${row.featureId ?? ''}`
        }
        data-hotkey-invalid={action.invalid ? 'true' : 'false'}
        data-capture={isCapturing ? 'active' : undefined}
        borderBottom="1px solid"
        borderColor="border.subtle"
        py={3}
      >
        <HStack align="flex-start" gap={3}>
          <VStack align="stretch" gap={1} flex={1} minW={0}>
            <HStack gap={2} wrap="wrap">
              {isCapturing ? (
                <Box
                  ref={captureFieldRef}
                  data-testid="hotkeys-capture-field"
                  data-capture="active"
                  tabIndex={-1}
                  px={2}
                  py={1}
                  bg="bg.subtle"
                  borderWidth="1px"
                  borderStyle="dashed"
                  borderColor="accent.default"
                  borderRadius="sm"
                  fontFamily="mono"
                  fontSize="xs"
                  color="fg.default"
                >
                  Press the new keys…  (Esc to cancel)
                </Box>
              ) : row.bindings.length === 0 ? (
                <Text data-testid="hotkeys-unbound" fontSize="xs" color="fg.muted">
                  Unbound
                </Text>
              ) : (
                row.bindings.map((binding, index) => (
                  <chakra.span key={`${action.actionId}:${index}:${binding}`} data-testid="hotkeys-binding">
                    <Keycap sequence={binding} />
                  </chakra.span>
                ))
              )}
            </HStack>

            <Text data-testid="hotkeys-action-label" fontSize="sm" color="fg.default">
              {action.title}
            </Text>
            {action.description ? (
              <Text data-testid="hotkeys-action-description" fontSize="xs" color="fg.muted">
                {action.description}
              </Text>
            ) : null}

            <HStack gap={2} wrap="wrap">
              <chakra.span
                data-testid="hotkeys-tier-badge"
                fontSize="xs"
                color="fg.muted"
                bg="bg.subtle"
                borderRadius="sm"
                px={1.5}
                py={0.5}
              >
                {action.tier === 'fredo' ? 'Global' : row.featureName ?? action.featureId}
              </chakra.span>
              {tag ? (
                <chakra.span
                  data-testid="hotkeys-precedence-badge"
                  fontSize="xs"
                  color="fg.default"
                  bg="bg.subtle"
                  borderWidth="1px"
                  borderColor="border.subtle"
                  borderRadius="sm"
                  px={1.5}
                  py={0.5}
                >
                  {precedenceLabel(tag)}
                </chakra.span>
              ) : null}
              {action.invalid ? (
                <chakra.span data-testid="hotkeys-invalid-badge" fontSize="xs" color="status.error">
                  {action.invalid}
                </chakra.span>
              ) : null}
            </HStack>

            {isCapturing && captureError ? (
              <HStack data-testid="hotkeys-capture-error" gap={1} color="status.error">
                <Icon as={LuTriangleAlert} boxSize="12px" />
                <Text fontSize="xs">{captureError}</Text>
              </HStack>
            ) : null}
          </VStack>

          <HStack gap={1} flexShrink={0}>
            <Button
              id={rebindButtonId(action.actionId)}
              data-testid="hotkeys-rebind-button"
              size="xs"
              variant="outline"
              disabled={Boolean(action.invalid) || isCapturing}
              onClick={() => startCapture(action.actionId, 'replace')}
            >
              <LuKeyboard />
              Rebind
            </Button>
            <Button
              data-testid="hotkeys-reset-button"
              size="xs"
              variant="ghost"
              aria-disabled={atDefault}
              disabled={atDefault}
              onClick={() => void resetOne(action)}
            >
              <LuRotateCcw />
              Reset
            </Button>
            {atDefault ? (
              <Text data-testid="hotkeys-reset-reason" fontSize="xs" color="fg.muted">
                Already default
              </Text>
            ) : null}
            <Button
              data-testid="hotkeys-add-binding-button"
              size="xs"
              variant="ghost"
              disabled={Boolean(action.invalid) || isCapturing}
              aria-label={`Add a binding for ${action.title}`}
              onClick={() => startCapture(action.actionId, 'add')}
            >
              <LuPlus />
              Add binding
            </Button>
          </HStack>
        </HStack>

        {isCapturing ? (
          <Button data-testid="hotkeys-capture-cancel" size="xs" variant="ghost" mt={1} onClick={cancelCapture}>
            <LuX />
            Cancel capture
          </Button>
        ) : null}
      </Box>
    );
  };

  const renderSection = (
    key: string,
    title: string,
    icon: IconType | undefined,
    sectionRows: PaneRow[],
  ): React.ReactNode => (
    <Box key={key} data-testid="hotkeys-tier-section" data-hotkey-section={key} mt={4}>
      <HStack gap={2}>
        {icon ? <Icon as={icon} boxSize="14px" color="fg.muted" /> : null}
        <SectionLabel>{title}</SectionLabel>
      </HStack>
      {sectionRows.map(renderRow)}
    </Box>
  );

  return (
    <Box p={5}>
      <Text as="h3" fontSize="lg" fontWeight="600" color="fg.default">
        Hotkeys
      </Text>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        Navigate and operate Fredo without a mouse.
      </Text>

      {loadState === 'loading' ? (
        <VStack data-testid="hotkeys-loading" align="stretch" gap={2} role="status" aria-label="Loading hotkeys">
          {[0, 1, 2].map((index) => (
            <Box key={index} height="44px" bg="bg.subtle" borderRadius="sm" opacity={0.6} />
          ))}
        </VStack>
      ) : loadState === 'error' ? (
        <Box
          data-testid="hotkeys-load-error"
          role="alert"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="status.error"
          borderRadius="sm"
          p={3}
        >
          <HStack gap={2} color="status.error">
            <Icon as={LuTriangleAlert} boxSize="14px" />
            <Text fontSize="sm">Hotkeys could not be loaded.</Text>
          </HStack>
          <Button data-testid="hotkeys-load-retry" size="xs" variant="outline" mt={2} onClick={retryLoad}>
            <LuRotateCcw />
            Retry
          </Button>
        </Box>
      ) : (
        <>
          {/* ── Toolbar ── */}
          <HStack gap={3} wrap="wrap" align="center">
            <HStack flex={1} minW="220px" gap={1}>
              <Icon as={LuSearch} boxSize="14px" color="fg.muted" />
              <Input
                data-testid="hotkeys-search-input"
                aria-label="Search hotkeys"
                placeholder="Search actions, keys, or features"
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query.length > 0 ? (
                <Button
                  data-testid="hotkeys-search-clear"
                  size="xs"
                  variant="ghost"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                >
                  <LuX />
                </Button>
              ) : null}
            </HStack>

            <HStack data-testid="hotkeys-tier-filter" role="radiogroup" aria-label="Filter by tier" gap={1}>
              {(
                [
                  ['all', 'All'],
                  ['fredo', 'Fredo'],
                  ['features', 'Features'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  data-testid="hotkeys-tier-filter-option"
                  data-tier={value}
                  role="radio"
                  aria-checked={tierFilter === value}
                  size="xs"
                  variant={tierFilter === value ? 'solid' : 'ghost'}
                  onClick={() => setTierFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </HStack>

            <Button data-testid="hotkeys-cheatsheet-open" size="xs" variant="outline" onClick={() => setCheatsheetOpen(true)}>
              <LuBookOpen />
              Cheat sheet
            </Button>
            <Button data-testid="hotkeys-reset-all-button" size="xs" variant="outline" onClick={() => setShowResetAll(true)}>
              <LuRotateCcw />
              Reset all
            </Button>
          </HStack>

          {/* ── Persistence feedback ── */}
          {saveStatus ? (
            <HStack data-testid="hotkeys-save-status" role="status" gap={1} color="fg.default" mt={3}>
              <Icon as={LuCircleCheck} boxSize="12px" />
              <Text fontSize="xs">{saveStatus}</Text>
            </HStack>
          ) : null}
          {saveError ? (
            <HStack data-testid="hotkeys-save-error" role="alert" gap={1} color="status.error" mt={3}>
              <Icon as={LuTriangleAlert} boxSize="12px" />
              <Text fontSize="xs">{saveError}</Text>
            </HStack>
          ) : null}

          {/* ── Vim preset ── */}
          <Box
            data-testid="hotkeys-vim-preset-row"
            mt={4}
            p={3}
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="sm"
            bg="bg.subtle"
          >
            <HStack justify="space-between" align="center" gap={3}>
              <VStack align="stretch" gap={0}>
                <Text fontSize="sm" color="fg.default">
                  Vim preset
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  Leader = Space; h j k l navigation.
                </Text>
              </VStack>
              <Switch.Root
                checked={keymap.vimPresetEnabled}
                onCheckedChange={(details) => void handleVimToggle(details.checked)}
                size="md"
              >
                <Switch.HiddenInput
                  data-testid="hotkeys-vim-preset-toggle"
                  aria-label="Enable Vim preset"
                />
                <Switch.Control />
              </Switch.Root>
            </HStack>

            {vimPreview ? (
              <Box
                data-testid="hotkeys-vim-preset-preview"
                mt={3}
                p={3}
                borderWidth="1px"
                borderColor="border.subtle"
                borderRadius="sm"
                bg="bg.surface"
              >
                <Text fontSize="sm" color="fg.default" mb={2}>
                  {vimPreview.enable ? 'Enable the Vim preset?' : 'Disable the Vim preset?'}
                </Text>
                <VStack align="stretch" gap={1}>
                  {vimPreview.changes.map((change) => (
                    <HStack key={change.actionId} data-testid="hotkeys-vim-preset-change" gap={2} wrap="wrap">
                      <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                        {change.actionId}
                      </Text>
                      {change.next.length > 0 ? (
                        change.next.map((binding) => <Keycap key={binding} sequence={binding} />)
                      ) : (
                        <Text fontSize="xs" color="fg.muted">
                          Unbound
                        </Text>
                      )}
                    </HStack>
                  ))}
                </VStack>

                {vimPreview.collisions.length > 0 ? (
                  <VStack data-testid="hotkeys-vim-preset-collisions" align="stretch" gap={1} mt={2}>
                    {vimPreview.collisions.map((collision, index) => (
                      <Text
                        key={`${collision.actionId}:${collision.sequence}:${index}`}
                        data-testid="hotkeys-vim-preset-collision"
                        fontSize="xs"
                        color={collision.report.kind === 'same-tier' ? 'status.error' : 'fg.muted'}
                      >
                        {collision.actionId} · {collision.report.kind}
                        {collision.report.colliding.length > 0
                          ? ` with ${collision.report.colliding
                              .map((entry) => entry.actionId)
                              .join(', ')}`
                          : ''}
                      </Text>
                    ))}
                  </VStack>
                ) : null}

                {vimPreview.blocking ? (
                  <Text data-testid="hotkeys-vim-preset-blocked-reason" fontSize="xs" color="status.error" mt={2}>
                    Resolve the listed conflicts before enabling the preset.
                  </Text>
                ) : null}

                <HStack gap={2} mt={3}>
                  <Button
                    data-testid="hotkeys-vim-preset-confirm"
                    size="xs"
                    variant="solid"
                    bg="accent.default"
                    color="accent.contrast"
                    aria-disabled={vimPreview.blocking}
                    disabled={vimPreview.blocking}
                    onClick={() => void confirmVimPreset()}
                  >
                    {vimPreview.enable ? 'Enable preset' : 'Disable preset'}
                  </Button>
                  <Button
                    data-testid="hotkeys-vim-preset-cancel"
                    size="xs"
                    variant="ghost"
                    onClick={() => setVimPreview(null)}
                  >
                    Cancel
                  </Button>
                </HStack>
              </Box>
            ) : null}
          </Box>

          {/* ── Tier sections ── */}
          {visibleRows.length === 0 ? (
            <Text data-testid="hotkeys-list-empty" role="status" fontSize="sm" color="fg.muted" mt={6}>
              {normalizedQuery.length > 0
                ? `No hotkeys match "${query.trim()}".`
                : 'No hotkeys to show.'}
            </Text>
          ) : (
            <>
              {fredoRows.length > 0 && renderSection('fredo', 'Fredo (global)', undefined, fredoRows)}
              {featureSections.map((section) => (
                <React.Fragment key={section.featureId}>
                  {renderSection(section.featureId, section.name, section.icon, section.rows)}
                </React.Fragment>
              ))}
            </>
          )}

          {/* ── Reserved by the platform (R-5.3, reasons adjacent) ── */}
          <Box data-testid="hotkeys-reserved-list" mt={6}>
            <SectionLabel>Reserved by the platform</SectionLabel>
            <VStack align="stretch" gap={1}>
              {PLATFORM_RESERVED_COMBOS.map((combo) => (
                <HStack
                  key={combo.serialized}
                  data-testid="hotkeys-reserved-row"
                  data-reserved-combo={combo.serialized}
                  aria-disabled="true"
                  gap={2}
                  wrap="wrap"
                  opacity={0.75}
                >
                  <Keycap sequence={combo.serialized} />
                  <Text data-testid="hotkeys-reserved-reason" fontSize="xs" color="fg.muted">
                    {combo.reason}
                  </Text>
                </HStack>
              ))}
            </VStack>
          </Box>

          {/* ── Macros (ST-8 owns the editor) ── */}
          <Box data-testid="hotkeys-macros-section" mt={6}>
            <MacroEditor />
          </Box>

          {/* ── Cheat sheet (minimal read-only view) ── */}
          {cheatsheetOpen ? (
            <Box
              data-testid="hotkeys-cheatsheet-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Hotkey cheat sheet"
              mt={4}
              p={4}
              borderWidth="1px"
              borderColor="border.default"
              borderRadius="md"
              bg="bg.surface"
            >
              <HStack justify="space-between" align="center" gap={3}>
                <Text fontSize="sm" color="fg.default">
                  Hotkey cheat sheet
                </Text>
                <Button
                  data-testid="hotkeys-cheatsheet-close"
                  size="xs"
                  variant="ghost"
                  aria-label="Close cheat sheet"
                  onClick={() => setCheatsheetOpen(false)}
                >
                  <LuX />
                </Button>
              </HStack>
              <Input
                data-testid="hotkeys-cheatsheet-search"
                aria-label="Search cheat sheet"
                placeholder="Search bindings"
                size="sm"
                mt={2}
                value={cheatsheetQuery}
                onChange={(event) => setCheatsheetQuery(event.target.value)}
              />
              {cheatsheetRows.length === 0 ? (
                <Text data-testid="hotkeys-cheatsheet-empty" role="status" fontSize="sm" color="fg.muted" mt={3}>
                  No bindings match.
                </Text>
              ) : (
                <VStack align="stretch" gap={1} mt={3}>
                  {cheatsheetRows.map((row) => (
                    <HStack
                      key={row.action.actionId}
                      data-testid="hotkeys-cheatsheet-entry"
                      gap={2}
                      wrap="wrap"
                    >
                      <Text fontSize="xs" color="fg.default">
                        {row.action.title}
                      </Text>
                      {row.bindings.length > 0 ? (
                        row.bindings.map((binding) => <Keycap key={binding} sequence={binding} />)
                      ) : (
                        <Text fontSize="xs" color="fg.muted">
                          Unbound
                        </Text>
                      )}
                      <Button
                        data-testid="hotkeys-cheatsheet-configure"
                        size="xs"
                        variant="ghost"
                        onClick={() => configureFromCheatsheet(row.action.actionId)}
                      >
                        Configure
                      </Button>
                    </HStack>
                  ))}
                </VStack>
              )}
            </Box>
          ) : null}

          {/* ── Conflict surface (ST-7 fills this via registerHotkeyConflictDialog) ── */}
          {conflict
            ? conflictDialogRenderer
              ? conflictDialogRenderer({
                  candidate: conflict.serialized,
                  targetAction:
                    actions.find((entry) => entry.actionId === conflict.actionId) ?? null,
                  report: conflict.report,
                  onResolve: (resolution) => void resolveConflict(resolution),
                })
              : renderInlineConflict(conflict)
            : null}

          {/* ── Reset-all confirmation ── */}
          {showResetAll ? (
            <Box
              data-testid="hotkeys-reset-all-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-label="Reset all hotkeys"
              mt={4}
              p={4}
              borderWidth="1px"
              borderColor="border.default"
              borderRadius="md"
              bg="bg.surface"
            >
              <Text fontSize="sm" color="fg.default">
                Reset all hotkeys to defaults?
              </Text>
              <Text fontSize="xs" color="fg.muted" mt={1}>
                Your rebinds are removed and the shipped defaults restored. Macros are kept; their
                triggers become unbound.
              </Text>
              <HStack gap={2} mt={3}>
                <Button
                  data-testid="hotkeys-reset-all-confirm"
                  size="xs"
                  variant="solid"
                  bg="accent.default"
                  color="accent.contrast"
                  onClick={() => void confirmResetAll()}
                >
                  Reset all
                </Button>
                <Button
                  data-testid="hotkeys-reset-all-cancel"
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowResetAll(false)}
                >
                  Cancel
                </Button>
              </HStack>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );

  function renderInlineConflict(pending: ConflictState): React.ReactNode {
    const target = actions.find((entry) => entry.actionId === pending.actionId) ?? null;
    return (
      <Box
        data-testid="hotkeys-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Key already in use"
        mt={4}
        p={4}
        borderWidth="1px"
        borderColor="status.error"
        borderRadius="md"
        bg="bg.surface"
      >
        <Text fontSize="sm" color="fg.default" fontWeight="600">
          Key already in use
        </Text>
        <HStack data-testid="hotkeys-conflict-chord" gap={2} mt={2}>
          <Keycap sequence={pending.serialized} />
          <Text fontSize="xs" color="fg.muted">
            {target?.title ?? pending.actionId}
          </Text>
        </HStack>
        <VStack align="stretch" gap={1} mt={2}>
          {pending.report.colliding.map((entry) => (
            <HStack key={`${entry.actionId}:${entry.sequence}`} data-testid="hotkeys-conflict-entry" gap={2}>
              <Text fontSize="xs" color="fg.default">
                {entry.actionId}
              </Text>
              <Text data-testid="hotkeys-conflict-tier" fontSize="xs" color="fg.muted">
                {entry.tier}
              </Text>
              <Keycap sequence={entry.sequence} />
            </HStack>
          ))}
        </VStack>
        <Text fontSize="xs" color="fg.muted" mt={2}>
          While a feature is focused, its binding wins; the global binding resumes when the feature
          releases the key.
        </Text>
        <HStack gap={2} mt={3}>
          <Button
            data-testid="hotkeys-conflict-override"
            size="xs"
            variant="solid"
            bg="accent.default"
            color="accent.contrast"
            onClick={() => void resolveConflict('override')}
          >
            Override
          </Button>
          <Button
            data-testid="hotkeys-conflict-cancel"
            size="xs"
            variant="ghost"
            onClick={() => void resolveConflict('cancel')}
          >
            Cancel
          </Button>
        </HStack>
      </Box>
    );
  }

  function setStatus(next: string | null): void {
    setSaveStatus(next);
    if (next) announce(next);
  }
};

/** Cheat-sheet matcher: title / description / feature / displayed key / stored token. */
function matchesQueryFor(row: PaneRow, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [
    row.action.title,
    row.action.description ?? '',
    row.featureName ?? '',
    ...row.bindings.map((binding) => describeSequence(binding).display),
    ...row.bindings,
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}
