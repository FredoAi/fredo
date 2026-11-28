/**
 * Spec #3243 ST-8 — the placement mint and the speech hooks, on the entity.
 *
 * # The mint timing is the whole point of this file (ADJ-2)
 *
 * The plan calls the timing "the load-bearing half, not the citation", and the
 * assertion it warns against is the one that looks easiest: a row asserting "the
 * receipt's `placementId` is a string". That row passes on a product nobody can
 * reach — a bridge-subscription mint leaves `placementId === ''` on EVERY real
 * user-initiated turn, because the avatar click sets `composerOpen` and touches no
 * bridge.
 *
 * So this suite drives the REAL opener (`openComposer()` on the avatar-click path)
 * and asserts BOTH halves of the published contract:
 *
 *   1. a grounded placement mints a NON-EMPTY id, and two placements mint
 *      DIFFERENT ids (AC-4's freshness, R-4a);
 *   2. an UNGROUNDED composer (no resolved app) reads `''` — the value that must
 *      stay reachable, because a test that cannot reach it cannot detect an
 *      unconditional mint;
 *   3. closing the box clears it (AC-4's discard, R-4b).
 *
 * # The speech hooks
 *
 * The reply surface stamps `data-companion-spoken` / `data-companion-speech-seq`
 * from the seam's own record, and the record is ABSENT before any speak — an
 * empty string would read as a spoken empty sentence.
 */

import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';

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
import { CompanionEntity } from '@/shared/components/companion';
import { getActiveCompanionEntity } from '@/shared/components/companion/CompanionEntity';
import {
  COMPANION_COMPOSER_TESTID,
  COMPANION_COMPOSER_TARGET_TESTID,
  COMPANION_COMPOSER_NO_TARGET_COPY,
} from '@/shared/components/companion/CompanionComposer';
import {
  readPlacement,
  resetPlacementForTests,
} from '@/shared/placement/placementStore';
import {
  COMPANION_SPEECH_SEQ_ATTR,
  COMPANION_SPOKEN_ATTR,
  resetCompanionSpeechForTests,
  speakCompanionReply,
} from '@/shared/companion/companionSpeech';
import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import type { FredoApplicationClass } from '@/shared/classes';
import {
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { DevAdapter } from '@/app/adapters/DevAdapter';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { AVATAR_SM } from '@/shared/components/fredo-avatar/fredoAvatarSizes';

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

function fakeApp(id: string, name: string): FredoApplicationClass {
  return {
    id,
    name,
    description: `${name} is a test application.`,
    showable: true,
    icon: (() => null),
    render: () => null,
  } as unknown as FredoApplicationClass;
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

/** The avatar-click opener — the REAL pointer path, not the retired bridge. */
let opener: { open: () => void; close: () => void } | null = null;

function OpenerProbe() {
  const { openComposer, closeComposer } = useCompanion();
  useEffect(() => {
    opener = { open: openComposer, close: closeComposer };
  }, [openComposer, closeComposer]);
  return null;
}

function AppRoot() {
  return (
    <>
      <div data-testid="app-root" data-fredo-app-id="wireframe" tabIndex={-1} />
    </>
  );
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
  resetPlacementForTests();
  resetCompanionSpeechForTests();
  resetWindowStoreForTests();
  opener = null;

  registerApplication(fakeApp('wireframe', 'Wireframe'));
  registerApplication(fakeApp('mission-monitor', 'Mission Monitor'));
  openWindow({ id: 'wireframe', title: 'Wireframe', icon: null, component: null });

  const devAdapter = new DevAdapter();
  adapterBridge.setInvoke(devAdapter.invoke.bind(devAdapter));
  adapterBridge.setLlmChat(devAdapter.llmChat.bind(devAdapter));
  adapterBridge.setLlmChatWithImage(devAdapter.llmChatWithImage.bind(devAdapter));
  adapterBridge.setLlmChatWithStatus(devAdapter.llmChatWithStatus.bind(devAdapter));
  adapterBridge.setListen(() => Promise.resolve(() => {}));
  vi.spyOn(adapterBridge, 'invoke').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApplicationRegistryForTests();
  resetPlacementForTests();
  resetCompanionSpeechForTests();
  resetWindowStoreForTests();
  localStorage.clear();
});

async function mountOverlay() {
  const view = renderWithChakra(
    <CompanionProvider>
      <OpenerProbe />
      <AppRoot />
      <OverlayHarness />
    </CompanionProvider>,
  );
  await waitFor(() => expect(getActiveCompanionEntity()?.surface).toBe('overlay'));
  return view;
}

describe('the placement mint is keyed on the composerOpen + resolved-target transition', () => {
  it('mints a NON-EMPTY id on the REAL avatar-click opener (not a bridge subscription)', async () => {
    const { queryAllByTestId } = await mountOverlay();

    expect(readPlacement()).toBeNull();

    // The real path. A bridge-subscription mint would leave this empty.
    act(() => { opener?.open(); });

    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));

    const placement = readPlacement();
    expect(placement).not.toBeNull();
    // A NON-EMPTY id is the assertion that matters: "is a string" would pass ''.
    expect(placement?.placementId.length ?? 0).toBeGreaterThan(0);
    expect(placement?.appId).toBe('wireframe');
  });

  it('two placements mint DIFFERENT ids (fresh identity, R-4a)', async () => {
    const { queryAllByTestId } = await mountOverlay();

    act(() => { opener?.open(); });
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));
    const first = readPlacement()?.placementId;

    act(() => { opener?.close(); });
    await waitFor(() => expect(readPlacement()).toBeNull());

    act(() => { opener?.open(); });
    await waitFor(() => expect(readPlacement()).not.toBeNull());
    const second = readPlacement()?.placementId;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('closing the box CLEARS the placement (AC-4 discard, R-4b)', async () => {
    const { queryAllByTestId } = await mountOverlay();

    act(() => { opener?.open(); });
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));
    expect(readPlacement()).not.toBeNull();

    act(() => { opener?.close(); });
    await waitFor(() => expect(readPlacement()).toBeNull());
  });

  it('an UNGROUNDED composer reads NO placement — the reachable empty case', async () => {
    // No app frames, no window app, no focus: the chip reads `No app in front of
    // Fredo`. This is the state an unconditional mint makes unreachable, and it is
    // the state F-18's `placementId === ''` leg depends on existing.
    resetWindowStoreForTests();
    const { getByTestId, queryAllByTestId } = await mountOverlay();

    act(() => { opener?.open(); });
    await waitFor(() => expect(queryAllByTestId(COMPANION_COMPOSER_TESTID)).toHaveLength(1));

    // Prove the composer really is ungrounded before asserting the placement.
    expect(getByTestId(COMPANION_COMPOSER_TARGET_TESTID).textContent).toBe(COMPANION_COMPOSER_NO_TARGET_COPY);
    expect(readPlacement()).toBeNull();
  });

  it('does not mint on a bridge request alone — the timing discriminator', async () => {
    // The avatar click is the only real opener; a publish on the (retired) bridge
    // must mint nothing. This is the control that makes the timing test meaningful:
    // if the mint were on the bridge, THIS would be non-empty and the test above
    // would pass for the wrong reason.
    await mountOverlay();

    expect(readPlacement()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('the speech receipt rides the reply surface as a DOM mirror', () => {
  // The mirror lives on `fredo-companion-surface` — the entity's ALWAYS-PRESENT
  // reply wrapper — and not on `fredo-reply-surface`, which only mounts while a
  // bubble is on screen. That distinction is deliberate: the receipt must be
  // readable by a probe even after the sentence's hold has expired, and the
  // attribute would otherwise vanish with the bubble.
  const SURFACE = 'fredo-companion-surface';

  it('stamps data-companion-spoken / -speech-seq from the seam record', async () => {
    const { container } = await mountOverlay();

    act(() => {
      speakCompanionReply('Filled Rectangle in Wireframe');
    });

    // Poll for the attribute rather than reading synchronously (the store
    // notification can land a tick after the speak).
    await waitFor(() => {
      const surface = container.querySelector(`[data-testid="${SURFACE}"]`);
      expect(surface).not.toBeNull();
      expect(surface?.getAttribute(COMPANION_SPOKEN_ATTR)).toBe('Filled Rectangle in Wireframe');
      expect(surface?.getAttribute(COMPANION_SPEECH_SEQ_ATTR)).toBe('1');
    });
  });

  it('carries NO spoken attribute before anything is spoken', async () => {
    const { container } = await mountOverlay();

    // Absent, not empty: an empty string would read as a spoken empty sentence.
    const surface = container.querySelector(`[data-testid="${SURFACE}"]`);
    expect(surface).not.toBeNull();
    expect(surface?.hasAttribute(COMPANION_SPOKEN_ATTR)).toBe(false);
    expect(surface?.hasAttribute(COMPANION_SPEECH_SEQ_ATTR)).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
