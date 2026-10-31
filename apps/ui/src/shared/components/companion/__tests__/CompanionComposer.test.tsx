/**
 * Spec #3120 (rework) ST-2 — the teleport-attached instruction composer (DOM).
 *
 * Work bullet (c): open ⇒ the input is focused within one settle; Esc ⇒ the
 * composer is gone and focus lands on the app root (never `body`); submit ⇒ the
 * existing `ask` is called once with the resolved grounding envelope; an empty
 * submit is a no-op.
 */

import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

// ── framer-motion (SpeechBubble) mock — same shape the shipped companion suites use.
const motionMock = vi.hoisted(() => {
  let react: { createElement: (tag: string, props: unknown, ...children: unknown[]) => unknown } | null = null;
  const cache = new Map<string, (props: Record<string, unknown>) => unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        let comp = cache.get(tag);
        if (!comp) {
          comp = (props: Record<string, unknown>) => {
            if (!react) throw new Error('framer-motion mock: React not set yet');
            const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest } = props ?? {};
            const children = (props as { children?: unknown }).children;
            if (children !== undefined) return react.createElement(tag, { ...rest }, children);
            return react.createElement(tag, { ...rest });
          };
          cache.set(tag, comp);
        }
        return comp;
      },
    },
  );
  return {
    setReact(r: typeof react) { react = r; },
    motion,
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: motionMock.AnimatePresence,
  motion: motionMock.motion,
  useReducedMotion: () => false,
}));

motionMock.setReact(React);

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion } from '@/shared/contexts/CompanionContext';
import { CompanionEntity, FredoCompanion } from '@/shared/components/companion';
import { getActiveCompanionEntity } from '@/shared/components/companion/CompanionEntity';
import {
  COMPANION_COMPOSER_DISMISS_TESTID,
  COMPANION_COMPOSER_INPUT_TESTID,
  COMPANION_COMPOSER_TARGET_TESTID,
  COMPANION_COMPOSER_TESTID,
  COMPANION_COMPOSER_NO_TARGET_COPY,
} from '@/shared/components/companion/CompanionComposer';
import {
  requestCompanionComposerOpen,
  resetCompanionComposerBridgeForTests,
} from '@/shared/companion/composerBridge';
import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import type { FredoApplicationClass } from '@/shared/classes';
import { registerNavigationHost } from '@/shared/navigation/ui/hostRegistry';
import type { NavigationHost } from '@/shared/navigation/ui/host';
import type { ContextEnvelope, Surface } from '@/shared/navigation/types';
import { CAPABILITY_LIMITS } from '@/shared/navigation/types';
import {
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { DevAdapter } from '@/app/adapters/DevAdapter';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { AVATAR_SM } from '@/shared/components/fredo-avatar/fredoAvatarSizes';

// ── environment pins (jsdom has no layout) ───────────────────────────────────

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => AVATAR_SM.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => AVATAR_SM.height,
});
Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });

function envelopeFor(appId: string): ContextEnvelope {
  return {
    version: 1,
    appId,
    placePath: [{ id: 'root', label: 'Canvas', transient: false, sticky: false }],
    selection: { count: 1, kinds: ['card'], label: 'Card', ids: ['el-1'] },
    verbs: [],
    journal: { last: [], undoableCount: 0 },
    dirty: false,
    limits: CAPABILITY_LIMITS,
  };
}

const WIREFRAME_ENVELOPE = envelopeFor('wireframe');
const MISSION_ENVELOPE = envelopeFor('mission-monitor');

function fakeApp(id: string, name: string, showable = true): FredoApplicationClass {
  return {
    id,
    name,
    showable,
    icon: (() => null),
    render: () => null,
  } as unknown as FredoApplicationClass;
}

let disposeHosts: Array<() => void> = [];

function registerHost(appId: string, envelope: ContextEnvelope): void {
  disposeHosts.push(
    registerNavigationHost({
      appId,
      surface: { appId } as unknown as Surface,
      host: { describeContext: () => envelope } as unknown as NavigationHost,
    }),
  );
}

// ── harnesses ────────────────────────────────────────────────────────────────

function AppRoot() {
  return <div data-testid="app-root" data-fredo-app-id="wireframe" tabIndex={-1} />;
}

/** The home seat predicate (mirrors LauncherShell): interactive seat while ON + home. */
function SeatSlot() {
  const { state } = useCompanion();
  if (!state.isVisible || state.isAway) return null;
  return <CompanionEntity surface="seat" />;
}

/** A provider already hosting the away overlay (no teleport choreography). */
function OverlayHarness() {
  const { state, setHosting, teleport } = useCompanion();
  useEffect(() => {
    if (!state.isVisible || state.isAway) return;
    setHosting(true);
    teleport(500, 400);
  }, [state.isVisible, state.isAway, setHosting, teleport]);
  if (!state.isVisible || !state.isAway || !state.isHosting || state.isAutoHidden) return null;
  return <CompanionEntity surface="overlay" />;
}

function VisibilityProbe() {
  const { state } = useCompanion();
  return <div data-testid="visible-probe" data-visible={String(state.isVisible)} />;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  localStorage.clear();
  localStorage.setItem('Fredo_companion_visible', 'true');

  resetApplicationRegistryForTests();
  resetCompanionComposerBridgeForTests();
  resetWindowStoreForTests();
  disposeHosts = [];

  registerApplication(fakeApp('wireframe', 'Wireframe'));
  registerApplication(fakeApp('mission-monitor', 'Mission Monitor'));
  registerApplication(fakeApp('hidden-lab', 'Hidden Lab', false));
  registerHost('wireframe', WIREFRAME_ENVELOPE);
  registerHost('mission-monitor', MISSION_ENVELOPE);
  openWindow({ id: 'wireframe', title: 'Wireframe', icon: null, component: null });

  const devAdapter = new DevAdapter();
  adapterBridge.setInvoke(devAdapter.invoke.bind(devAdapter));
  adapterBridge.setLlmChat(devAdapter.llmChat.bind(devAdapter));
  adapterBridge.setLlmChatWithImage(devAdapter.llmChatWithImage.bind(devAdapter));
  adapterBridge.setLlmChatWithStatus(devAdapter.llmChatWithStatus.bind(devAdapter));
  adapterBridge.setListen(() => Promise.resolve(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApplicationRegistryForTests();
  resetCompanionComposerBridgeForTests();
  resetWindowStoreForTests();
  for (const dispose of disposeHosts) dispose();
  disposeHosts = [];
  localStorage.clear();
});

describe('CompanionComposer — teleport-attached instruction box', () => {
  it('opens from a bridge request and focuses the input (no click)', async () => {
    const { getByTestId, queryAllByTestId, container } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(container.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));

    act(() => {
      requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true });
    });

    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));
    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe('for Wireframe');

    const root = getByTestId(COMPANION_COMPOSER_TESTID);
    expect(['above', 'right', 'left']).toContain(root.getAttribute('data-composer-placement'));
    const clearance = Number(root.getAttribute('data-composer-clearance'));
    expect(Number.isInteger(clearance)).toBe(true);
    expect(clearance).toBeGreaterThanOrEqual(14);
    expect(consoleError).not.toHaveBeenCalled();
  });

  /**
   * #3120 (rework) ST-2-R4 (R-3.1) — REGRESSION PIN for the first same-window
   * seat→overlay teleport. The out and in timers are advanced in SEPARATE `act`
   * flushes so React COMMITS the `TELEPORT` that unmounts the seat (and clears its
   * timer) between them — the live ordering. On the pre-fix tip the seat owned
   * the only settle-open timer, so its unmount killed it and no composer ever
   * appeared; here the surviving overlay owns the settle-open.
   */
  it('the FIRST seat→overlay teleport opens exactly one focused overlay composer (phased flush)', async () => {
    const { container, getByTestId, queryAllByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <SeatSlot />
        <FredoCompanion />
      </CompanionProvider>,
    );
    await waitFor(() => expect(container.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('seat'));
    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(0);

    vi.useFakeTimers();
    // 1) the gesture starts the out motion on the SEAT.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 520, clientY: 420 }),
      );
    });
    // 2) the out settle → the seat plays teleport-in → TELEPORT → the seat unmounts
    //    in THIS commit and the overlay mounts (the surviving settle-open owner).
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(container.querySelectorAll('.fredo-companion-avatar')).toHaveLength(1);
    expect(getActiveCompanionEntity()?.surface).toBe('overlay');
    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(0);
    // 3) the overlay's teleport-in settle → the ONE open.
    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1);
    expect(getByTestId(COMPANION_COMPOSER_TESTID).getAttribute('data-composer-surface')).toBe('overlay');
    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
  });

  /**
   * #3120 (rework) ST-2-R4 — the away→away leg (the overlay survives the whole
   * sequence) still opens exactly one focused composer at the settle, with the
   * same phased flush shape as the seat→overlay pin above.
   */
  it('an away→away teleport opens exactly one focused composer at the settle (phased flush)', async () => {
    const { container, getByTestId, queryAllByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(container.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));
    // The harness's own teleport settles open; close it so the second leg is unambiguous.
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));
    fireEvent.click(getByTestId(COMPANION_COMPOSER_DISMISS_TESTID));
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(0));

    vi.useFakeTimers();
    // Same-window teleport driven through the host's own entity handle (the
    // `FredoCompanion` window listener is not mounted in this harness).
    act(() => {
      getActiveCompanionEntity()?.teleportTo({ x: 480, y: 380 });
    });
    expect(container.querySelector('.fredo-companion-avatar')?.getAttribute('data-state')).toBe('teleport-out');
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(container.querySelector('.fredo-companion-avatar')?.getAttribute('data-state')).toBe('teleport-in');
    // The overlay survives the TELEPORT; this commit only re-arms the settle.
    expect(getActiveCompanionEntity()?.surface).toBe('overlay');
    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1);
    expect(getByTestId(COMPANION_COMPOSER_TESTID).getAttribute('data-composer-surface')).toBe('overlay');
    expect(document.activeElement).toBe(getByTestId(COMPANION_COMPOSER_INPUT_TESTID));
  });

  /**
   * #3120 (rework) ST-2-R4 (R-1.8) — a REPEAT open request while the box is
   * already open must re-focus the input (the old boolean latch produced no
   * state change → no render → no focus), and must never mount a second box.
   */
  it('a repeated open request re-focuses the input and keeps exactly one composer', async () => {
    const { getByTestId, queryAllByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));

    act(() => {
      requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true });
    });
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));
    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe('for Wireframe');

    // Move focus away (as a pointer activation of the command bar does), then ask again.
    act(() => {
      getByTestId('app-root').focus();
    });
    expect(document.activeElement).toBe(getByTestId('app-root'));

    act(() => {
      requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true });
    });

    expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe('for Wireframe');
  });

  it('Escape closes the box and returns focus to the app root, never body', async () => {
    const { getByTestId, queryByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));

    act(() => {
      requestCompanionComposerOpen({ source: 'keyboard', appId: 'wireframe', focus: true });
    });
    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull());

    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID);
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(getByTestId('app-root'));
  });

  it('submit calls ask ONCE with the resolved grounding envelope', async () => {
    const statusSpy = vi
      .spyOn(adapterBridge, 'llmChatWithStatus')
      .mockImplementation(() => Promise.resolve());
    const { getByTestId, queryByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));

    act(() => {
      requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true });
    });
    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull());

    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'change the card label' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    const [messages] = statusSpy.mock.calls[0];
    expect(messages[0]).toEqual({ role: 'system', content: JSON.stringify(WIREFRAME_ENVELOPE) });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'change the card label' });
    // The box stays open for the next turn (no transcript/history surface).
    expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull();
    expect(input.value).toBe('');
  });

  it('an explicitly named showable app overrides the default target', async () => {
    const statusSpy = vi
      .spyOn(adapterBridge, 'llmChatWithStatus')
      .mockImplementation(() => Promise.resolve());
    const { getByTestId, queryByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));

    act(() => { requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true }); });
    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull());

    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'open Mission Monitor' } });
    await waitFor(() =>
      expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe('for Mission Monitor'),
    );
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    const [messages] = statusSpy.mock.calls[0];
    expect(messages[0]).toEqual({ role: 'system', content: JSON.stringify(MISSION_ENVELOPE) });
  });

  it('an empty submit is a no-op and keeps focus in the input', async () => {
    const statusSpy = vi
      .spyOn(adapterBridge, 'llmChatWithStatus')
      .mockImplementation(() => Promise.resolve());
    const { getByTestId, queryByTestId } = renderWithChakra(
      <CompanionProvider>
        <AppRoot />
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));
    act(() => { requestCompanionComposerOpen({ source: 'keyboard', appId: 'wireframe', focus: true }); });
    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull());

    const input = getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(statusSpy).not.toHaveBeenCalled();
    expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('renders the no-target copy when no app is in front of Fredo', async () => {
    resetWindowStoreForTests();
    const { getByTestId, queryByTestId } = renderWithChakra(
      <CompanionProvider>
        <OverlayHarness />
      </CompanionProvider>,
    );
    await waitFor(() => expect(document.querySelector('.fredo-companion-avatar')).not.toBeNull());
    await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));
    act(() => { requestCompanionComposerOpen({ source: 'teleport', focus: true }); });
    await waitFor(() => expect(queryByTestId(COMPANION_COMPOSER_TESTID)).not.toBeNull());
    expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe(COMPANION_COMPOSER_NO_TARGET_COPY);
  });
});
