/**
 * MacroEditor — the Settings → Hotkeys "Macros" subsection (Spec #2946 ST-8;
 * EARS R-3.7, R-3.8, R-3.9; plan UI/UX §2 Macros).
 *
 * Owns BOTH macro kinds inside the ST-6 mount point (`hotkeys-macros-section`):
 *
 *  - NAMED ACTION SEQUENCE — `hotkeys-macro-create` opens a step builder with a
 *    searchable action picker (`hotkeys-macro-action-picker`), reorderable step
 *    rows (`hotkeys-macro-step`), a trigger assigned through the SAME
 *    classifyBinding/conflict flow as a normal rebind, and a saved list
 *    (`hotkeys-macro-list`) with run/edit/delete.
 *
 *  - RAW RECORD/REPLAY — starting requires explicit confirmation
 *    (`hotkeys-macro-record-start` → `hotkeys-macro-record-confirm`); while
 *    recording a PERSISTENT, non-colour-only indicator
 *    (`hotkeys-macro-recording-indicator`) plus an app-wide fixed banner
 *    (`hotkeys-recording-banner`) name the stop chord
 *    (`hotkeys-macro-record-stop`); the privacy bound is stated at
 *    `hotkeys-macro-privacy-note`; persistence is explicit
 *    (`hotkeys-macro-save`) and a discarded recording is announced; replay is
 *    confirmed (`hotkeys-macro-replay-confirm`).
 *
 * Presentation is token-only: semantic tokens + CSS vars + the shared `tint()`
 * helper — never a hex/rgba literal and never an alpha-append onto a `var()`.
 * All announcements route through the shared ST-3 `announce` channel (no live
 * regions here). No telemetry of any kind is emitted.
 */

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, HStack, Icon, Input, Portal, Text, VStack } from '@chakra-ui/react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCircle,
  LuCircleCheck,
  LuKeyboard,
  LuPlay,
  LuPencil,
  LuPlus,
  LuSearch,
  LuSquare,
  LuTrash2,
  LuTriangleAlert,
  LuX,
} from 'react-icons/lu';

import { Keycap } from '../../../shared/components/hotkeys/Keycap';
import { tint } from '../../../shared/utils/colorTint';
import { announce } from '../../../shared/hotkeys/announcer';
import { classifyBinding } from '../../../shared/hotkeys/conflicts';
import { describeSequence } from '../../../shared/hotkeys/describe';
import { normalizeKeyStroke, serializeSequence } from '../../../shared/hotkeys/keys';
import {
  cancelMacroConfirm,
  commitRecording,
  confirmRecordStart,
  confirmReplay,
  createDraftMacro,
  deleteMacro,
  discardRecording,
  getMacroTrigger,
  getMacroUiSnapshot,
  installMacroRecordToggleHandler,
  listMacroStepActions,
  macroActionId,
  matchesStepQuery,
  recordStopChord,
  requestRecordStart,
  requestReplay,
  runNamedMacro,
  saveMacro,
  setMacroTrigger,
  stopRecording,
  subscribeMacroUi,
  syncMacroRegistrations,
  withStep,
  withStepMoved,
  withStepRemoved,
  type MacroStepOption,
} from '../../../shared/hotkeys/macros';
import { getHotkeyAction, listHotkeyActions } from '../../../shared/hotkeys/registry';
import {
  clearBinding,
  getKeymap,
  useHotkeyRevision,
} from '../../../shared/hotkeys/store';
import type { ConflictReport, PersistedMacro } from '../../../shared/hotkeys/types';
import {
  HotkeyConflictDialog,
  type HotkeyConflictResolution,
} from './HotkeyConflictDialog';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindingLabel(serialized: string | null): string | null {
  if (!serialized) return null;
  const described = describeSequence(serialized);
  return described.valid ? described.display : serialized;
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="fg.muted"
    letterSpacing="wider"
    textTransform="uppercase"
  >
    {children as React.ReactNode}
  </Text>
);

interface BuilderState {
  readonly draft: PersistedMacro;
  readonly isNew: boolean;
}

interface TriggerConflictState {
  readonly macroId: string;
  readonly serialized: string;
  readonly report: ConflictReport;
}

export const MacroEditor: React.FC = () => {
  const revision = useHotkeyRevision();
  const ui = useSyncExternalStore(subscribeMacroUi, getMacroUiSnapshot, getMacroUiSnapshot);

  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [recordingName, setRecordingName] = useState('');
  const [capturingTriggerId, setCapturingTriggerId] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TriggerConflictState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The stop chord must work app-wide from the moment a recording exists; the
  // registration is idempotent and re-runs whenever the keymap changes.
  useEffect(() => {
    installMacroRecordToggleHandler();
    syncMacroRegistrations();
  }, [revision]);

  // Source lists (re-derived on every real keymap mutation via `revision`).
  const keymap = getKeymap();
  const namedMacros = keymap.macros;
  const rawMacros = keymap.rawMacros;

  const stepOptions = useMemo<readonly MacroStepOption[]>(
    () => listMacroStepActions(),
    [revision],
  );
  const visibleStepOptions = useMemo(
    () => stepOptions.filter((entry) => matchesStepQuery(entry, pickerQuery)).slice(0, 40),
    [stepOptions, pickerQuery],
  );

  // ── Named-macro builder ─────────────────────────────────────────────────────

  const startCreate = useCallback(() => {
    setPickerQuery('');
    setStatus(null);
    setError(null);
    setBuilder({ draft: createDraftMacro(), isNew: true });
  }, []);

  const startEdit = useCallback((macro: PersistedMacro) => {
    setPickerQuery('');
    setStatus(null);
    setError(null);
    setBuilder({ draft: { ...macro, steps: [...macro.steps] }, isNew: false });
  }, []);

  const saveBuilder = useCallback(async () => {
    const current = builder;
    if (!current) return;
    try {
      await saveMacro(current.draft);
      setBuilder(null);
      setError(null);
      setStatus(`Saved macro "${current.draft.name}".`);
    } catch (caught) {
      setStatus(null);
      setError(`Couldn't save — ${messageOf(caught)}. Change reverted.`);
    }
  }, [builder]);

  const runMacro = useCallback(async (macroId: string) => {
    const result = await runNamedMacro(macroId, 'macro');
    if (result.status === 'empty') setStatus('This macro has no steps to run.');
    else setStatus(`Macro finished: ${result.status}.`);
  }, []);

  const removeMacro = useCallback(async (macroId: string) => {
    try {
      await deleteMacro(macroId);
      setStatus('Macro deleted.');
    } catch (caught) {
      setError(`Couldn't delete — ${messageOf(caught)}.`);
    }
  }, []);

  // ── Trigger capture (the SAME rebind/conflict flow) ─────────────────────────

  const applyTrigger = useCallback(async (macroId: string, serialized: string | null) => {
    try {
      await setMacroTrigger(macroId, serialized);
      setTriggerError(null);
      setError(null);
      setStatus(
        serialized === null
          ? 'Trigger cleared.'
          : `Trigger set — ${bindingLabel(serialized) ?? serialized}.`,
      );
    } catch (caught) {
      setStatus(null);
      setError(`Couldn't save the trigger — ${messageOf(caught)}. Change reverted.`);
    } finally {
      setCapturingTriggerId(null);
    }
  }, []);

  const startTriggerCapture = useCallback((macroId: string) => {
    setTriggerError(null);
    setStatus(null);
    setConflict(null);
    setCapturingTriggerId(macroId);
  }, []);

  useEffect(() => {
    if (capturingTriggerId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Esc') {
        setCapturingTriggerId(null);
        announce('Trigger capture cancelled.');
        return;
      }
      const stroke = normalizeKeyStroke(event);
      if (!stroke) return; // bare modifier / IME / AltGraph / dead key — wait

      const macroId = capturingTriggerId;
      const serialized = serializeSequence([stroke]);
      const report = classifyBinding({
        candidate: serialized,
        targetActionId: macroActionId(macroId),
        targetTier: 'fredo',
        keymap: getKeymap(),
        actions: listHotkeyActions(),
      });
      if (report.kind === 'reserved' || report.kind === 'invalid') {
        const reason = report.reason ?? 'Unavailable combination';
        setTriggerError(`${bindingLabel(serialized) ?? serialized} — ${reason}`);
        announce(`Rejected: ${reason}`);
        return;
      }
      if (report.kind === 'same-tier') {
        setConflict({ macroId, serialized, report });
        setCapturingTriggerId(null);
        announce('That key is already in use. Resolve the conflict before saving the trigger.');
        return;
      }
      void applyTrigger(macroId, serialized);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [capturingTriggerId, applyTrigger]);

  const resolveTriggerConflict = useCallback(
    async (resolution: HotkeyConflictResolution) => {
      const pending = conflict;
      if (!pending) return;
      setConflict(null);
      if (resolution === 'cancel') {
        announce('Conflict dismissed — neither binding was changed.');
        return;
      }
      if (resolution === 'rebind-other') {
        for (const entry of pending.report.colliding.filter((c) => c.tier === 'fredo')) {
          await clearBinding(entry.actionId);
        }
      }
      await applyTrigger(pending.macroId, pending.serialized);
    },
    [conflict, applyTrigger],
  );

  // ── Recording ───────────────────────────────────────────────────────────────

  const beginRecord = useCallback(() => {
    setStatus(null);
    setError(null);
    requestRecordStart(null);
  }, []);

  const acceptRecordStart = useCallback(async () => {
    await confirmRecordStart();
  }, []);

  const stopRecord = useCallback(() => {
    stopRecording();
  }, []);

  const saveRecording = useCallback(async () => {
    try {
      const saved = await commitRecording(recordingName);
      setRecordingName('');
      setStatus(saved ? `Saved macro "${saved.name}".` : null);
    } catch (caught) {
      setError(`Couldn't save the recording — ${messageOf(caught)}.`);
    }
  }, [recordingName]);

  const discardCurrentRecording = useCallback(() => {
    discardRecording();
    setRecordingName('');
    setStatus('Recording discarded.');
  }, []);

  const replayMacro = useCallback((macroId: string) => {
    requestReplay(macroId);
  }, []);

  const acceptReplay = useCallback(async () => {
    await confirmReplay();
  }, []);

  const dismissConfirm = useCallback(() => {
    cancelMacroConfirm();
  }, []);

  const stopChordLabel = bindingLabel(recordStopChord()) ?? 'the stop chord';
  const hasMacros = namedMacros.length > 0 || rawMacros.length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Box>
      <HStack justify="space-between" align="center" gap={3} mb={2}>
        <SectionLabel>Macros</SectionLabel>
        <HStack gap={1}>
          <Button data-testid="hotkeys-macro-create" size="xs" variant="outline" onClick={startCreate}>
            <LuPlus />
            New macro
          </Button>
          <Button
            data-testid="hotkeys-macro-record-start"
            size="xs"
            variant="outline"
            disabled={ui.recording}
            onClick={beginRecord}
          >
            <LuCircle />
            Record keystrokes
          </Button>
        </HStack>
      </HStack>

      {/* Privacy bound — always stated, never tooltip-only (R-3.9). */}
      <HStack data-testid="hotkeys-macro-privacy-note" gap={1} color="fg.muted" mb={2}>
        <Icon as={LuKeyboard} boxSize="12px" />
        <Text fontSize="xs">
          Text you type into text-entry fields is never captured; terminal keys belong to the
          terminal.
        </Text>
      </HStack>

      {/* ── Persistent recording indicator (pane + app-wide banner) ── */}
      {ui.recording ? (
        <>
          <HStack
            data-testid="hotkeys-macro-recording-indicator"
            role="status"
            gap={2}
            px={3}
            py={2}
            borderRadius="sm"
            bg={tint('var(--status-error)', 14)}
            borderWidth="1px"
            borderColor="status.error"
            mb={2}
          >
            <Icon as={LuCircle} boxSize="8px" color="status.error" aria-hidden="true" />
            <Text fontSize="xs" color="fg.default">
              Recording keystrokes — press {stopChordLabel} to stop
            </Text>
            <Button
              data-testid="hotkeys-macro-record-stop"
              size="xs"
              variant="solid"
              bg="status.error"
              color="white"
              onClick={stopRecord}
            >
              <LuSquare />
              Stop recording
            </Button>
          </HStack>
          <Portal>
            <HStack
              data-testid="hotkeys-recording-banner"
              role="status"
              aria-label="Macro recording in progress"
              position="fixed"
              top={4}
              left="50%"
              transform="translateX(-50%)"
              zIndex="toast"
              gap={2}
              px={3}
              py={2}
              borderRadius="sm"
              bg="bg.surface"
              borderWidth="1px"
              borderColor="status.error"
              boxShadow="var(--shadow-dialog)"
            >
              <Icon as={LuCircle} boxSize="8px" color="status.error" aria-hidden="true" />
              <Text fontSize="xs" color="fg.default">
                Recording keystrokes — press {stopChordLabel} to stop
              </Text>
            </HStack>
          </Portal>
        </>
      ) : null}

      {/* ── Stopped recording awaiting explicit save/discard ── */}
      {!ui.recording && ui.recordedStrokes.length > 0 ? (
        <Box
          data-testid="hotkeys-macro-recording-result"
          p={3}
          mb={2}
          borderWidth="1px"
          borderColor="border.subtle"
          borderRadius="sm"
          bg="bg.subtle"
        >
          <Text fontSize="sm" color="fg.default" mb={2}>
            {ui.recordedStrokes.length} keystroke
            {ui.recordedStrokes.length === 1 ? '' : 's'} captured — save or discard the recording.
          </Text>
          <Input
            data-testid="hotkeys-macro-recording-name"
            aria-label="Recorded macro name"
            placeholder="Recorded macro name"
            size="sm"
            mb={2}
            value={recordingName}
            onChange={(event) => setRecordingName(event.target.value)}
          />
          <HStack gap={2}>
            <Button
              data-testid="hotkeys-macro-save"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={() => void saveRecording()}
            >
              <LuCircleCheck />
              Save macro
            </Button>
            <Button
              data-testid="hotkeys-macro-discard"
              size="xs"
              variant="ghost"
              onClick={discardCurrentRecording}
            >
              <LuX />
              Discard
            </Button>
          </HStack>
        </Box>
      ) : null}

      {/* ── Saved macros (named + recorded) ── */}
      <VStack data-testid="hotkeys-macro-list" align="stretch" gap={2} mt={1}>
        {!hasMacros && builder === null ? (
          <Text data-testid="hotkeys-macros-empty" role="status" fontSize="sm" color="fg.muted">
            No macros yet.
          </Text>
        ) : null}
        {namedMacros.map((macro) => {
            const trigger = getMacroTrigger(macro.id);
            const isCapturing = capturingTriggerId === macro.id;
            return (
              <Box
                key={macro.id}
                data-testid="hotkeys-macro-item"
                data-macro-id={macro.id}
                data-macro-kind="named"
                p={3}
                borderWidth="1px"
                borderColor="border.subtle"
                borderRadius="sm"
                bg="bg.subtle"
              >
                <HStack justify="space-between" align="flex-start" gap={2}>
                  <VStack align="stretch" gap={1}>
                    <Text fontSize="sm" color="fg.default">
                      {macro.name}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      {macro.steps.length} step{macro.steps.length === 1 ? '' : 's'} ·{' '}
                      {macro.onStepError === 'abort' ? 'stop on first error' : 'continue on error'}
                    </Text>
                    <HStack data-testid="hotkeys-macro-trigger-display" gap={2} wrap="wrap">
                      {isCapturing ? (
                        <Box
                          data-testid="hotkeys-macro-trigger-field"
                          px={2}
                          py={1}
                          bg="bg.surface"
                          borderWidth="1px"
                          borderStyle="dashed"
                          borderColor="accent.default"
                          borderRadius="sm"
                          fontFamily="mono"
                          fontSize="xs"
                          color="fg.default"
                        >
                          Press the new trigger… (Esc to cancel)
                        </Box>
                      ) : trigger !== null ? (
                        <>
                          <Keycap sequence={trigger} />
                          <Button
                            data-testid="hotkeys-macro-trigger-clear"
                            size="xs"
                            variant="ghost"
                            onClick={() => void applyTrigger(macro.id, null)}
                          >
                            Clear trigger
                          </Button>
                        </>
                      ) : (
                        <Text fontSize="xs" color="fg.muted">
                          Unbound
                        </Text>
                      )}
                    </HStack>
                    {isCapturing && triggerError ? (
                      <HStack data-testid="hotkeys-macro-trigger-error" gap={1} color="status.error">
                        <Icon as={LuTriangleAlert} boxSize="12px" />
                        <Text fontSize="xs">{triggerError}</Text>
                      </HStack>
                    ) : null}
                  </VStack>

                  <HStack gap={1} flexShrink={0}>
                    <Button
                      data-testid="hotkeys-macro-run"
                      size="xs"
                      variant="outline"
                      onClick={() => void runMacro(macro.id)}
                    >
                      <LuPlay />
                      Run
                    </Button>
                    <Button
                      data-testid="hotkeys-macro-edit"
                      size="xs"
                      variant="ghost"
                      onClick={() => startEdit(macro)}
                    >
                      <LuPencil />
                      Edit
                    </Button>
                    <Button
                      data-testid="hotkeys-macro-trigger"
                      size="xs"
                      variant="ghost"
                      disabled={isCapturing}
                      onClick={() => startTriggerCapture(macro.id)}
                    >
                      <LuKeyboard />
                      {trigger === null ? 'Assign trigger' : 'Change trigger'}
                    </Button>
                    <Button
                      data-testid="hotkeys-macro-delete"
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete macro ${macro.name}`}
                      onClick={() => void removeMacro(macro.id)}
                    >
                      <LuTrash2 />
                    </Button>
                  </HStack>
                </HStack>
              </Box>
            );
          })}

          {rawMacros.map((raw) => (
            <Box
              key={raw.id}
              data-testid="hotkeys-macro-item"
              data-macro-id={raw.id}
              data-macro-kind="recorded"
              p={3}
              borderWidth="1px"
              borderColor="border.subtle"
              borderRadius="sm"
              bg="bg.subtle"
            >
              <HStack justify="space-between" align="center" gap={2}>
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" color="fg.default">
                    {raw.name}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Recorded · {raw.strokes.length} keystroke
                    {raw.strokes.length === 1 ? '' : 's'}
                  </Text>
                </VStack>
                <HStack gap={1} flexShrink={0}>
                  <Button
                    data-testid="hotkeys-macro-replay"
                    size="xs"
                    variant="outline"
                    onClick={() => replayMacro(raw.id)}
                  >
                    <LuPlay />
                    Replay
                  </Button>
                  <Button
                    data-testid="hotkeys-macro-delete"
                    size="xs"
                    variant="ghost"
                    aria-label={`Delete macro ${raw.name}`}
                    onClick={() => void removeMacro(raw.id)}
                  >
                    <LuTrash2 />
                  </Button>
                </HStack>
              </HStack>
            </Box>
          ))}
        </VStack>

      {/* ── Named-macro step builder ── */}
      {builder ? (
        <Box
          data-testid="hotkeys-macro-builder"
          mt={3}
          p={3}
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          bg="bg.surface"
        >
          <HStack justify="space-between" align="center" gap={2} mb={2}>
            <Text fontSize="sm" color="fg.default">
              {builder.isNew ? 'New macro' : `Edit "${builder.draft.name}"`}
            </Text>
            <Button
              data-testid="hotkeys-macro-builder-cancel"
              size="xs"
              variant="ghost"
              aria-label="Cancel macro editing"
              onClick={() => setBuilder(null)}
            >
              <LuX />
            </Button>
          </HStack>

          <Input
            data-testid="hotkeys-macro-name"
            aria-label="Macro name"
            placeholder="Macro name"
            size="sm"
            mb={2}
            value={builder.draft.name}
            onChange={(event) =>
              setBuilder((current) =>
                current ? { ...current, draft: { ...current.draft, name: event.target.value } } : current,
              )
            }
          />

          {/* Step list (reorderable) */}
          <VStack data-testid="hotkeys-macro-steps" align="stretch" gap={1} mb={2}>
            {builder.draft.steps.length === 0 ? (
              <Text data-testid="hotkeys-macro-steps-empty" fontSize="xs" color="fg.muted">
                No steps yet — pick actions below.
              </Text>
            ) : (
              builder.draft.steps.map((stepId, index) => {
                const action = getHotkeyAction(stepId);
                return (
                  <HStack
                    key={`${stepId}:${index}`}
                    data-testid="hotkeys-macro-step"
                    data-step-index={index}
                    data-hotkey-action={stepId}
                    gap={2}
                    px={2}
                    py={1}
                    borderWidth="1px"
                    borderColor="border.subtle"
                    borderRadius="sm"
                    bg="bg.subtle"
                  >
                    <Text fontSize="xs" color="fg.muted" minW="18px">
                      {index + 1}.
                    </Text>
                    <Text fontSize="xs" color={action ? 'fg.default' : 'status.error'} flex={1}>
                      {action ? action.title : `${stepId} (unavailable)`}
                    </Text>
                    <Button
                      data-testid="hotkeys-macro-step-up"
                      size="xs"
                      variant="ghost"
                      aria-label={`Move step ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() =>
                        setBuilder((current) =>
                          current
                            ? { ...current, draft: withStepMoved(current.draft, index, -1) }
                            : current,
                        )
                      }
                    >
                      <LuArrowUp />
                    </Button>
                    <Button
                      data-testid="hotkeys-macro-step-down"
                      size="xs"
                      variant="ghost"
                      aria-label={`Move step ${index + 1} down`}
                      disabled={index === builder.draft.steps.length - 1}
                      onClick={() =>
                        setBuilder((current) =>
                          current
                            ? { ...current, draft: withStepMoved(current.draft, index, 1) }
                            : current,
                        )
                      }
                    >
                      <LuArrowDown />
                    </Button>
                    <Button
                      data-testid="hotkeys-macro-step-remove"
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove step ${index + 1}`}
                      onClick={() =>
                        setBuilder((current) =>
                          current
                            ? { ...current, draft: withStepRemoved(current.draft, index) }
                            : current,
                        )
                      }
                    >
                      <LuX />
                    </Button>
                  </HStack>
                );
              })
            )}
          </VStack>

          {/* onStepError policy */}
          <HStack data-testid="hotkeys-macro-on-step-error" role="radiogroup" aria-label="On step error" gap={1} mb={2}>
            {(
              [
                ['abort', 'Stop on first error'],
                ['continue', 'Continue on error'],
              ] as const
            ).map(([policy, label]) => (
              <Button
                key={policy}
                data-testid="hotkeys-macro-on-step-error-option"
                data-policy={policy}
                role="radio"
                aria-checked={builder.draft.onStepError === policy}
                size="xs"
                variant={builder.draft.onStepError === policy ? 'solid' : 'ghost'}
                onClick={() =>
                  setBuilder((current) =>
                    current ? { ...current, draft: { ...current.draft, onStepError: policy } } : current,
                  )
                }
              >
                {label}
              </Button>
            ))}
          </HStack>

          {/* Searchable action picker */}
          <HStack gap={1} mb={2}>
            <Icon as={LuSearch} boxSize="14px" color="fg.muted" />
            <Input
              data-testid="hotkeys-macro-action-picker"
              aria-label="Search actions to add"
              placeholder="Search actions"
              size="sm"
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
            />
          </HStack>
          <VStack align="stretch" gap={1} mb={3} maxH="200px" overflowY="auto">
            {visibleStepOptions.length === 0 ? (
              <Text data-testid="hotkeys-macro-action-picker-empty" fontSize="xs" color="fg.muted">
                No actions match "{pickerQuery}".
              </Text>
            ) : (
              visibleStepOptions.map((entry) => (
                <Button
                  key={entry.actionId}
                  data-testid="hotkeys-macro-action-option"
                  data-hotkey-action={entry.actionId}
                  size="xs"
                  variant="ghost"
                  justifyContent="flex-start"
                  onClick={() =>
                    setBuilder((current) =>
                      current ? { ...current, draft: withStep(current.draft, entry.actionId) } : current,
                    )
                  }
                >
                  <LuPlus />
                  <Text fontSize="xs" color="fg.default">
                    {entry.title}
                  </Text>
                  {entry.binding ? <Keycap sequence={entry.binding} /> : null}
                </Button>
              ))
            )}
          </VStack>

          <HStack gap={2}>
            <Button
              data-testid="hotkeys-macro-builder-save"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={() => void saveBuilder()}
            >
              <LuCircleCheck />
              Save macro
            </Button>
            <Text fontSize="xs" color="fg.muted">
              Assign a trigger from the saved list.
            </Text>
          </HStack>
        </Box>
      ) : null}

      {/* ── Explicit confirmations (R-3.8) ── */}
      {ui.confirm?.kind === 'record-start' ? (
        <Box
          data-testid="hotkeys-macro-record-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm keystroke recording"
          mt={3}
          p={4}
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          bg="bg.surface"
        >
          <Text fontSize="sm" color="fg.default" fontWeight="600">
            Record keystrokes for this macro?
          </Text>
          <Text fontSize="xs" color="fg.muted" mt={1}>
            Fredo will record your keystrokes for this macro. Text you type into text-entry fields
            will NOT be captured. Continue?
          </Text>
          <HStack gap={2} mt={3}>
            <Button
              data-testid="hotkeys-macro-record-confirm-accept"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={() => void acceptRecordStart()}
            >
              Continue
            </Button>
            <Button
              data-testid="hotkeys-macro-record-confirm-cancel"
              size="xs"
              variant="ghost"
              onClick={dismissConfirm}
            >
              Cancel
            </Button>
          </HStack>
        </Box>
      ) : null}

      {ui.confirm?.kind === 'replay' ? (
        <Box
          data-testid="hotkeys-macro-replay-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm macro replay"
          mt={3}
          p={4}
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          bg="bg.surface"
        >
          <Text fontSize="sm" color="fg.default" fontWeight="600">
            Replay "{ui.confirm.name ?? 'recorded macro'}"?
          </Text>
          <Text fontSize="xs" color="fg.muted" mt={1}>
            The recorded keystrokes will be replayed into the focused surface. Continue?
          </Text>
          <HStack gap={2} mt={3}>
            <Button
              data-testid="hotkeys-macro-replay-confirm-accept"
              size="xs"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={() => void acceptReplay()}
            >
              Replay
            </Button>
            <Button
              data-testid="hotkeys-macro-replay-confirm-cancel"
              size="xs"
              variant="ghost"
              onClick={dismissConfirm}
            >
              Cancel
            </Button>
          </HStack>
        </Box>
      ) : null}

      {/* ── Persistence feedback ── */}
      {status ? (
        <HStack data-testid="hotkeys-macro-save-status" role="status" gap={1} color="fg.default" mt={2}>
          <Icon as={LuCircleCheck} boxSize="12px" />
          <Text fontSize="xs">{status}</Text>
        </HStack>
      ) : null}
      {error ? (
        <HStack data-testid="hotkeys-macro-save-error" role="alert" gap={1} color="status.error" mt={2}>
          <Icon as={LuTriangleAlert} boxSize="12px" />
          <Text fontSize="xs">{error}</Text>
        </HStack>
      ) : null}

      {/* ── Same conflict flow as a normal rebind (ST-7 dialog) ── */}
      {conflict ? (
        <HotkeyConflictDialog
          candidate={conflict.serialized}
          targetAction={getHotkeyAction(macroActionId(conflict.macroId))}
          report={conflict.report}
          onResolve={(resolution) => void resolveTriggerConflict(resolution)}
        />
      ) : null}
    </Box>
  );
};
