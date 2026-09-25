/**
 * Spec #2946 ST-8 — macros model + recorder + privacy + latch (EARS R-3.7,
 * R-3.8, R-3.9).
 *
 * Unit layer for the shared module: named-macro ordered execution with the
 * `onStepError` policy, the explicit-confirmation gates, the cross-webview
 * recording latch, the no-text-entry/no-terminal privacy bound, dispatch
 * suspension while recording (through the real ST-4 engine), the trigger binding
 * through the standard classifier, raw replay, and the PO#13 no-telemetry audit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resetHotkeyEngineForTests, installHotkeyEngine } from '../engine';
import {
  acquireRecordingLatch,
  readRecordingLatch,
} from '../persistence';
import { getHotkeyAction, registerFredoAction, resetRegistryForTests } from '../registry';
import { resetKeymapStoreForTests, setMacros, setRawMacros } from '../store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';

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
  getRecordedStrokes,
  isRecordStopStroke,
  isRecordingActive,
  isTextEntryTarget,
  macroActionId,
  recordStopChord,
  requestRecordStart,
  requestReplay,
  replayRawMacro,
  resetMacrosForTests,
  runNamedMacro,
  saveMacro,
  saveRawMacro,
  setMacroTrigger,
  shouldCaptureStroke,
  startRecording,
  stopRecording,
  syncMacroRegistrations,
  withStep,
  withStepMoved,
  withStepRemoved,
} from '../macros';
import { normalizeKeyStroke, parseSequence } from '../keys';
import type { PersistedMacro } from '../types';

// ── Harness helpers ──────────────────────────────────────────────────────────

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mountNeutral(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function mountInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

function mountContentEditable(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function mountTerminal(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-terminal-root', 'true');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  root.appendChild(inner);
  document.body.appendChild(root);
  inner.focus();
  return inner;
}

function fredo(actionId: string, run: ReturnType<typeof vi.fn>, defaultSequence: string | null = null) {
  registerFredoAction({ actionId, title: `Action ${actionId}`, defaultSequence, run });
}

function named(overrides: Partial<PersistedMacro> = {}): PersistedMacro {
  return {
    id: 'm1',
    name: 'Macro one',
    steps: [],
    trigger: null,
    onStepError: 'abort',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetMacrosForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetMacrosForTests();
  resetHotkeyEngineForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── 1. Named-macro model ─────────────────────────────────────────────────────

describe('named-macro model (pure transforms)', () => {
  it('appends, reorders and removes steps without mutating the input', () => {
    const base = createDraftMacro('M');
    const withTwo = withStep(withStep(base, 'fredo.a'), 'fredo.b');
    expect(base.steps).toEqual([]);
    expect(withTwo.steps).toEqual(['fredo.a', 'fredo.b']);

    const moved = withStepMoved(withTwo, 0, 1);
    expect(moved.steps).toEqual(['fredo.b', 'fredo.a']);
    expect(withTwo.steps).toEqual(['fredo.a', 'fredo.b']);

    expect(withStepRemoved(moved, 0).steps).toEqual(['fredo.a']);
    // Out-of-range moves/removals are no-ops (empty macro handling).
    expect(withStepMoved(moved, 0, -1).steps).toEqual(['fredo.b', 'fredo.a']);
    expect(withStepRemoved(moved, 9).steps).toEqual(['fredo.b', 'fredo.a']);
  });
});

// ── 2. Named-macro execution (R-3.7) ─────────────────────────────────────────

describe('named macro runs its ordered action sequence exactly once (R-3.7)', () => {
  it('runs every step in order, once each', async () => {
    const a = vi.fn();
    const b = vi.fn();
    fredo('fredo.test.a', a, null);
    fredo('fredo.test.b', b, null);
    await setMacros([named({ steps: ['fredo.test.a', 'fredo.test.b'] })]);

    const result = await runNamedMacro('m1');

    expect(result.status).toBe('ran');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.invocationCallOrder[0]).toBeLessThan(b.mock.invocationCallOrder[0]);
  });

  it('surfaces an unavailable step and aborts when onStepError is "abort"', async () => {
    const b = vi.fn();
    fredo('fredo.test.b', b, null);
    await setMacros([
      named({ id: 'm2', steps: ['fredo.test.missing', 'fredo.test.b'], onStepError: 'abort' }),
    ]);

    const result = await runNamedMacro('m2');

    expect(result.status).toBe('aborted');
    expect(result.failingStepId).toBe('fredo.test.missing');
    expect(b).not.toHaveBeenCalled();
  });

  it('continues past a failing step when onStepError is "continue"', async () => {
    const b = vi.fn();
    fredo('fredo.test.b', b, null);
    await setMacros([
      named({ id: 'm3', steps: ['fredo.test.missing', 'fredo.test.b'], onStepError: 'continue' }),
    ]);

    const result = await runNamedMacro('m3');

    expect(result.status).toBe('completed-with-errors');
    expect(b).toHaveBeenCalledTimes(1);
    expect(result.results[0].status).toBe('unavailable');
  });

  it('treats a disabled step as unavailable and a thrown step as failed', async () => {
    const disabled = vi.fn();
    registerFredoAction({
      actionId: 'fredo.test.disabled',
      title: 'Disabled',
      defaultSequence: null,
      run: disabled,
      enabled: () => false,
    });
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    fredo('fredo.test.boom', boom, null);
    await setMacros([
      named({ id: 'm4', steps: ['fredo.test.disabled'], onStepError: 'abort' }),
    ]);
    expect((await runNamedMacro('m4')).results[0].status).toBe('unavailable');
    expect(disabled).not.toHaveBeenCalled();

    await setMacros([named({ id: 'm5', steps: ['fredo.test.boom'], onStepError: 'abort' })]);
    const failed = await runNamedMacro('m5');
    expect(failed.status).toBe('aborted');
    expect(failed.results[0].status).toBe('failed');
  });

  it('handles an empty macro without throwing', async () => {
    await setMacros([named({ id: 'm6', steps: [] })]);
    const result = await runNamedMacro('m6');
    expect(result.status).toBe('empty');
    expect(result.results).toEqual([]);
  });

  it('refuses a re-entrant invocation of the same macro', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    registerFredoAction({
      actionId: 'fredo.test.slow',
      title: 'Slow',
      defaultSequence: null,
      run: () => gate,
    });
    await setMacros([named({ id: 'm7', steps: ['fredo.test.slow'] })]);
    const first = runNamedMacro('m7');
    const second = await runNamedMacro('m7');
    expect(second.status).toBe('reentrant');
    release();
    expect((await first).status).toBe('ran');
  });
});

// ── 3. Trigger registration + setMacroTrigger (same rebind flow source) ──────

describe('macro trigger binding', () => {
  it('registers a dispatch action and fires the ordered steps from its trigger', async () => {
    const a = vi.fn();
    fredo('fredo.test.a', a, null);
    await saveMacro(named({ id: 'm8', steps: ['fredo.test.a'] }));
    syncMacroRegistrations();
    expect(getHotkeyAction(macroActionId('m8'))).not.toBeNull();

    await setMacroTrigger('m8', 'primary+alt+m');
    expect(getMacroTrigger('m8')).toBe('primary+alt+m');

    installHotkeyEngine();
    const el = mountNeutral();
    keydown(el, { key: 'm', ctrlKey: true, altKey: true });

    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
  });

  it('clears the trigger and unbinds it on delete', async () => {
    await saveMacro(named({ id: 'm9', steps: [] }));
    await setMacroTrigger('m9', 'primary+alt+9');
    expect(getMacroTrigger('m9')).toBe('primary+alt+9');

    await setMacroTrigger('m9', null);
    expect(getMacroTrigger('m9')).toBeNull();

    await setMacroTrigger('m9', 'primary+alt+8');
    await deleteMacro('m9');
    expect(getMacroTrigger('m9')).toBeNull();
  });
});

// ── 4. Explicit confirmation gates (R-3.8) ───────────────────────────────────

describe('explicit confirmation before recording and replay (R-3.8)', () => {
  it('does NOT start recording on a bare request — only on confirm', async () => {
    requestRecordStart();
    expect(getMacroUiSnapshot().confirm?.kind).toBe('record-start');
    expect(isRecordingActive()).toBe(false);
    expect(await readRecordingLatch()).toBeNull();

    await confirmRecordStart();
    expect(isRecordingActive()).toBe(true);
    stopRecording();
    discardRecording();
  });

  it('cancel dismisses the request and captures nothing', async () => {
    requestRecordStart();
    cancelMacroConfirm();
    expect(getMacroUiSnapshot().confirm).toBeNull();
    expect(isRecordingActive()).toBe(false);
    expect(getRecordedStrokes()).toEqual([]);
  });

  it('does NOT replay on a bare request — only on confirm', async () => {
    const a = vi.fn();
    fredo('fredo.test.a', a, 'g');
    installHotkeyEngine();
    await setRawMacros([{ id: 'r1', name: 'Rec', strokes: ['g'], trigger: null }]);

    requestReplay('r1');
    expect(getMacroUiSnapshot().confirm?.kind).toBe('replay');
    expect(a).not.toHaveBeenCalled();

    await confirmReplay();
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
  });
});

// ── 5. Cross-webview recording latch (G-124) ─────────────────────────────────

describe('exactly-one-recording latch (G-124)', () => {
  it('sets the latch on start and clears it on stop', async () => {
    const started = await startRecording();
    expect(started.ok).toBe(true);
    expect(await readRecordingLatch()).not.toBeNull();

    stopRecording();
    await vi.waitFor(async () => expect(await readRecordingLatch()).toBeNull());
    discardRecording();
  });

  it('refuses a second recording while one is active', async () => {
    await startRecording();
    const second = await startRecording();
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already-recording');
    stopRecording();
    discardRecording();
  });

  it('refuses to start when another webview already holds the latch', async () => {
    await acquireRecordingLatch('other-webview-macro', 1);
    const result = await startRecording();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('another-webview');
  });
});

// ── 6. Privacy bound (R-3.9) ─────────────────────────────────────────────────

describe('privacy bound — no text-entry / terminal stroke is retained (R-3.9)', () => {
  it('classifies text-entry and terminal targets as exempt', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const neutral = document.createElement('div');
    const terminalRoot = document.createElement('div');
    terminalRoot.setAttribute('data-fredo-terminal-root', 'true');
    const terminalInner = document.createElement('div');
    terminalRoot.appendChild(terminalInner);
    document.body.append(input, textarea, editable, neutral, terminalRoot);

    for (const exempt of [input, textarea, editable, terminalInner]) {
      expect(shouldCaptureStroke(exempt)).toBe(false);
    }
    expect(shouldCaptureStroke(neutral)).toBe(true);
    expect(shouldCaptureStroke(null)).toBe(true);
    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(terminalInner)).toBe(false);
  });

  it('skips a text-entry stroke while the field still receives it (no preventDefault)', async () => {
    fredo('fredo.test.x', vi.fn(), 'g');
    installHotkeyEngine();
    await startRecording();
    const input = mountInput();

    const event = keydown(input, { key: 'g' });

    expect(getRecordedStrokes()).toEqual([]);
    // The recorder keeps the native default: the typed character reaches the field.
    expect(event.defaultPrevented).toBe(false);

    stopRecording();
    discardRecording();
  });

  it('skips a terminal stroke', async () => {
    installHotkeyEngine();
    await startRecording();
    const inner = mountTerminal();

    keydown(inner, { key: 'a' });

    expect(getRecordedStrokes()).toEqual([]);
    stopRecording();
    discardRecording();
  });

  it('retains non-text strokes', async () => {
    await startRecording();
    const el = mountNeutral();
    keydown(el, { key: 'g' });
    keydown(el, { key: 'ArrowUp' });
    expect(getRecordedStrokes()).toEqual(['g', 'arrowup']);
    stopRecording();
    discardRecording();
  });

  it('never retains the stop chord or Escape', async () => {
    installHotkeyEngine();
    await startRecording();
    const el = mountNeutral();
    keydown(el, { key: 'F9', ctrlKey: true, shiftKey: true });
    expect(getRecordedStrokes()).toEqual([]);
    expect(isRecordingActive()).toBe(false);
    discardRecording();
  });
});

// ── 7. Dispatch suspension while recording (R-3.9, via the real engine) ──────

describe('dispatch is suspended except the stop chord and Escape (R-3.9)', () => {
  it('suppresses a normal binding, consumes Escape, and stops on the stop chord', async () => {
    const run = vi.fn();
    fredo('fredo.test.x', run, 'x');
    installHotkeyEngine();
    await startRecording();
    const el = mountNeutral();

    const bound = keydown(el, { key: 'x' });
    expect(run).not.toHaveBeenCalled();
    expect(bound.defaultPrevented).toBe(true);

    const escape = keydown(el, { key: 'Escape' });
    expect(run).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(true);
    expect(isRecordingActive()).toBe(true);

    keydown(el, { key: 'F9', ctrlKey: true, shiftKey: true });
    expect(isRecordingActive()).toBe(false);
  });

  it('recognizes the shipped stop chord and reports it for the indicator copy', () => {
    const stroke = normalizeKeyStroke({
      key: 'F9',
      ctrlKey: true,
      shiftKey: true,
      getModifierState: () => false,
    } as unknown as KeyboardEvent);
    expect(stroke).not.toBeNull();
    expect(isRecordStopStroke(stroke!)).toBe(true);
    expect(recordStopChord()).toBe('ctrl+shift+f9');
    expect(parseSequence(recordStopChord()!)).toHaveLength(1);
  });
});

// ── 8. Recording persistence (R-3.7/R-3.8) ───────────────────────────────────

describe('recording persistence is explicit', () => {
  it('stops, exposes the captured strokes, and saves a raw macro only on save', async () => {
    await startRecording();
    const el = mountNeutral();
    keydown(el, { key: 'g' });
    stopRecording();

    expect(getMacroUiSnapshot().recordedStrokes).toEqual(['g']);

    const saved = await commitRecording('My recording');
    expect(saved?.name).toBe('My recording');
    expect(saved?.strokes).toEqual(['g']);
    expect(getMacroUiSnapshot().recordedStrokes).toEqual([]);
  });

  it('announces a discarded recording and drops the captured strokes', async () => {
    await startRecording();
    keydown(mountNeutral(), { key: 'h' });
    stopRecording();
    discardRecording();
    expect(getRecordedStrokes()).toEqual([]);
    expect(isRecordingActive()).toBe(false);
  });
});

// ── 9. Raw replay (R-3.8) ────────────────────────────────────────────────────

describe('raw replay', () => {
  it('replays every recorded stroke through a synthetic keydown', async () => {
    await saveRawMacro({ id: 'r2', name: 'Two keys', strokes: ['g', 'arrowup'], trigger: null });
    const seen: string[] = [];
    document.addEventListener('keydown', (event) => {
      seen.push((event as KeyboardEvent).key);
    });

    const result = await replayRawMacro('r2');

    expect(result.status).toBe('replayed');
    expect(result.played).toBe(2);
    expect(seen).toEqual(['g', 'ArrowUp']);
  });

  it('handles a missing/empty recording without throwing', async () => {
    expect((await replayRawMacro('nope')).status).toBe('missing');

    await saveRawMacro({ id: 'r3', name: 'Empty', strokes: [], trigger: null });
    expect((await replayRawMacro('r3')).status).toBe('empty');
  });
});

// ── 10. PO#13 — no shortcut-usage telemetry ──────────────────────────────────

describe('PO#13 — zero shortcut-usage telemetry', () => {
  const TELEMETRY_PATTERN =
    /\b(?:emit_span|start_span|tracing::|otel|opentelemetry|telemetry|track\(|analytics|posthog|sentry|datadog|metrics)\b/i;

  it('macros.ts and MacroEditor.tsx contain no telemetry emission path', () => {
    for (const relative of [
      'src/shared/hotkeys/macros.ts',
      'src/features/settings-app/components/MacroEditor.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), relative), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(TELEMETRY_PATTERN);
    }
  });
});

// ── 11. Source token hygiene (theme discipline) ──────────────────────────────

describe('MacroEditor source token hygiene', () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), 'src/features/settings-app/components/MacroEditor.tsx'),
    'utf8',
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('contains no hex / rgb() / hsl() colour literal', () => {
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
  });

  it('contains no var(--x)NN alpha-append', () => {
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
  });
});
