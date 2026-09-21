/**
 * #2918 ST-5 — the Companion entity's continuous held display state:
 * model-declared reply status routing + the bounded settle hold.
 *
 * PRODUCT-UNIT PINS for the entity seam (`CompanionEntity.tsx`):
 *
 *   R-1  — the joke, the typed command-bar `ask`, and dictation ALL route through
 *          the ONE structured transport (`adapterBridge.llmChatWithStatus`), each
 *          with the correct `options` shape (`offerSkills` false for the joke,
 *          true for the skill-aware typed/audio turns; `audioBase64` for a clip).
 *   R-2  — the model-declared status is asserted at the SUCCESS SETTLE through the
 *          resolver's `modelStatus` input, held for the existing `HAPPY_HOLD_MS`,
 *          then released to `idle`. An absent status resolves to the default
 *          `happy` (byte-identical to the shipped settle).
 *   R-9  — the status is NEVER asserted while streaming, nor on the error path; a
 *          non-emittable value (`talk`) heals to the default `happy` (the closed-7
 *          allowlist in `fredoReplyStatus` runs BEFORE the resolver input).
 *
 * The single-in-flight guard, the scripted `thinking` → first-token `joking`
 * window, the a11y live region, the watchdog and `clearReplyOrDefer` are the
 * shipped behavior this file does NOT re-pin (covered by skillSettle /
 * newStates / dispatch).
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion } from '@/shared/contexts/CompanionContext';
import { CompanionEntity } from '@/shared/components/companion/CompanionEntity';
import type { CompanionEntityHandle } from '@/shared/components/companion/CompanionEntity';
import { FREDO_AVATAR_STATES } from '@/shared/components/fredo-avatar/fredoAvatarStates';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { LlmChatWithStatusOptions, LlmMessage, LlmSkillCall } from '@/app/adapters/HostAdapter';

// ── Module mocks (same shape as FredoCompanion.newStates.test.tsx) ─────────────
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
            const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props ?? {};
            void _i; void _a; void _e; void _t;
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

// ── Harness ────────────────────────────────────────────────────────────────────
type CompanionApi = ReturnType<typeof useCompanion>;
let api: CompanionApi;

function ApiProbe() {
  api = useCompanion();
  return null;
}

/** One captured `llmChatWithStatus` invocation + its channels. */
type StatusGeneration = {
  messages: LlmMessage[];
  options: LlmChatWithStatusOptions;
  onToken: (token: string) => void;
  onDone: () => void;
  onStatus: (status: string) => void;
  onSkillCall: (call: LlmSkillCall) => void;
  onError: (message: string) => void;
};
let generations: StatusGeneration[] = [];
const lastGen = (): StatusGeneration => generations[generations.length - 1];

const avatarEl = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.fredo-companion-avatar');
const avatarState = (container: HTMLElement): string | null =>
  avatarEl(container)?.getAttribute('data-state') ?? null;
const overlayState = (container: HTMLElement): string | null =>
  container.querySelector('#fredo-expression')?.getAttribute('data-state') ?? null;

async function mountEntity() {
  localStorage.clear();
  const ref = createRef<CompanionEntityHandle>();
  const view = renderWithChakra(
    React.createElement(
      CompanionProvider,
      null,
      React.createElement(CompanionEntity, { ref, surface: 'seat' }),
      React.createElement(ApiProbe, null),
    ),
  );
  await waitFor(() => {
    expect(api.idleTimeoutSeconds).toBe(60);
  });
  await act(async () => {});
  return { ref, container: view.container };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  generations = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  adapterBridge.setInvoke(async () => undefined);
  adapterBridge.setListen(() => Promise.resolve(() => {}));
  // #2918 ST-5 — the ONE structured transport. The legacy transports are
  // deliberately NOT registered: if the entity still used one, the generation
  // would never be captured here (the pins below would fail loudly).
  adapterBridge.setLlmChatWithStatus(
    async (messages, options, onToken, onDone, onStatus, onSkillCall, onError) => {
      generations.push({
        messages,
        options,
        onToken,
        onDone,
        onStatus,
        onSkillCall: (c: LlmSkillCall) => onSkillCall?.(c),
        onError: (m: string) => onError?.(m),
      });
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('#2918 ST-5 — reply-status assertion at the success settle', () => {
  it('asserts the model status at the settle, holds HAPPY_HOLD_MS, then releases to idle', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('tell me something'); });
    expect(generations).toHaveLength(1);

    // Streaming: the scripted flow owns the window (`thinking` before the first
    // token, `joking` after it) — the status is captured but NOT asserted.
    act(() => { lastGen().onToken('Hello'); });
    expect(avatarState(container)).toBe('joking');
    act(() => { lastGen().onStatus('thinking'); });
    expect(avatarState(container)).toBe('joking');

    // Success settle → the resolved model status (flow at base `idle`).
    act(() => { lastGen().onDone(); });
    expect(avatarState(container)).toBe('thinking');
    expect(overlayState(container)).toBe('thinking');

    // Held for exactly the existing HAPPY_HOLD_MS (5000)…
    act(() => { vi.advanceTimersByTime(4999); });
    expect(avatarState(container)).toBe('thinking');
    // …then released to idle.
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
    expect(overlayState(container)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders the default `happy` when no llm-status arrived (today\u2019s behaviour)', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('hello'); });
    act(() => { lastGen().onToken('Hello'); });
    act(() => { lastGen().onDone(); });

    expect(avatarState(container)).toBe('happy');
    expect(overlayState(container)).toBe('happy');

    act(() => { vi.advanceTimersByTime(4999); });
    expect(avatarState(container)).toBe('happy');
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does NOT assert the model status while streaming (the scripted flow owns the window)', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('hello'); });
    // A status that would OUTRANK the scripted flow if it were wrongly admitted
    // (`working` is priority 0; the pending flow is `thinking`).
    act(() => { lastGen().onStatus('working'); });
    expect(avatarState(container)).toBe('thinking');

    act(() => { lastGen().onToken('Hi'); });
    expect(avatarState(container)).toBe('joking');
    expect(overlayState(container)).toBe('joking');
  });

  it('does NOT assert the model status on the error path (error holds ERROR_HOLD_MS)', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    act(() => { ref.current?.ask('boom'); });
    act(() => { lastGen().onStatus('joking'); });
    act(() => { lastGen().onError('the companion server returned HTTP 500'); });

    expect(avatarState(container)).toBe('error');
    expect(overlayState(container)).toBe('error');

    act(() => { vi.advanceTimersByTime(7999); });
    expect(avatarState(container)).toBe('error');
    act(() => { vi.advanceTimersByTime(1); });
    expect(avatarState(container)).toBe('idle');
  });

  it.each(['talk', 'dancing', 'teleport-out', 'ERROR', ''])(
    'heals the non-emittable status %j to the default `happy`',
    async (status) => {
      const { ref, container } = await mountEntity();
      vi.useFakeTimers();

      act(() => { ref.current?.ask('hello'); });
      act(() => { lastGen().onStatus(status); });
      act(() => { lastGen().onDone(); });

      expect(avatarState(container)).toBe('happy');
      expect(FREDO_AVATAR_STATES).toContain(avatarState(container) as string);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it('routes the joke, the typed ask, and dictation through llmChatWithStatus', async () => {
    const { ref, container } = await mountEntity();
    vi.useFakeTimers();

    // 1 — the typed command-bar `ask` (skill-aware).
    act(() => { ref.current?.ask('typed message'); });
    expect(generations).toHaveLength(1);
    expect(lastGen().options).toEqual({ offerSkills: true });
    expect(lastGen().messages[lastGen().messages.length - 1].content).toBe('typed message');
    act(() => { lastGen().onDone(); });

    // 2 — the avatar-click joke (plain, no skill offer).
    act(() => { fireEvent.click(avatarEl(container) as HTMLElement); });
    act(() => { vi.advanceTimersByTime(250); });
    expect(generations).toHaveLength(2);
    expect(lastGen().options).toEqual({ offerSkills: false });

    // 3 — dictation (skill-aware + the captured clip).
    act(() => { ref.current?.askWithAudio('QUJD'); });
    expect(generations).toHaveLength(3);
    expect(lastGen().options).toEqual({ offerSkills: true, audioBase64: 'QUJD' });
  });
});
