/**
 * useAppCommandSkill — Home's generic companion dispatcher (Spec #3099, ST-6).
 *
 * Pins the BINDING host pre-flight (QA Q-10/Q-11/Q-13/Q-14/Q-15 + NFR-3):
 *  - ONE `app_command_surfaces` read per incoming call; the surface comes from
 *    THAT read (never a local rebuild);
 *  - reserved skills are ignored AND cost no registry read;
 *  - `listActions` answers from the published manifest with the app CLOSED (no
 *    open, no relay);
 *  - an unknown id / invalid arguments / unresolved app rejects BEFORE any
 *    window or relay;
 *  - a closed app is opened exactly once, then the intent is relayed and the
 *    outcome decides the reply (Performed -> success, else nothing changed);
 *  - a timeout settles exactly ONE nothing-changed reply;
 *  - exactly one reply per call.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock, windowSnapshotMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  windowSnapshotMock: vi.fn(),
}));

vi.mock('../../../../shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

vi.mock('../../../../shared/window-system/windowStore', () => ({
  getWindowSnapshot: windowSnapshotMock,
}));

import { registerAppOpenReplyPusher } from '../../../../shared/components/companion/skillBridge';
import type { CompanionManifest } from '../../../../shared/companion/manifest';
import type { FredoApplicationClass } from '../../../../shared/classes/FredoApplicationClass';
import {
  APP_COMMAND_INTENT_COMMAND,
  APP_COMMAND_INTENT_RESULT_EVENT,
  APP_COMMAND_INTENT_TIMEOUT_MS,
  APP_COMMAND_SURFACES_COMMAND,
  useAppCommandSkill,
} from '../useAppCommandSkill';

type Handler = (payload: unknown) => void;

const MANIFEST: CompanionManifest = {
  surfaces: [
    {
      appId: 'demo',
      appName: 'Demo',
      skillName: 'demo',
      description: 'Do demo things.',
      commands: [
        { id: 'demo.add', label: 'Add', description: 'Add a widget', args: [] },
        {
          id: 'demo.rename',
          label: 'Rename',
          description: 'Rename the widget',
          args: [{ name: 'name', required: true }],
        },
      ],
    },
  ],
};

const DEMO_FEATURE = {
  id: 'demo',
  name: 'Demo',
  showable: true,
} as unknown as FredoApplicationClass;

let handlers: Record<string, Handler[]>;
let pusher: ReturnType<typeof vi.fn>;
let unregister: (() => void) | null = null;

const emit = async (event: string, payload: unknown): Promise<void> => {
  await act(async () => {
    (handlers[event] ?? []).forEach((handler) => handler(payload));
  });
  await flush();
};

async function flush(): Promise<void> {
  if (vi.isFakeTimers()) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return;
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function surfaceReads(): number {
  return invokeMock.mock.calls.filter(([command]) => command === APP_COMMAND_SURFACES_COMMAND)
    .length;
}

function intentCalls(): Array<[string, Record<string, unknown>]> {
  return invokeMock.mock.calls.filter(
    ([command]) => command === APP_COMMAND_INTENT_COMMAND,
  ) as Array<[string, Record<string, unknown>]>;
}

async function mount(): Promise<ReturnType<typeof vi.fn>> {
  const openFeatureWindow = vi.fn();
  renderHook(() =>
    useAppCommandSkill({
      openFeatureWindow,
      features: [DEMO_FEATURE],
    }),
  );
  await waitFor(() => {
    expect(handlers['llm-skill-call']).toHaveLength(1);
    expect(handlers[APP_COMMAND_INTENT_RESULT_EVENT]).toHaveLength(1);
  });
  return openFeatureWindow;
}

beforeEach(() => {
  handlers = {};
  pusher = vi.fn();
  unregister = registerAppOpenReplyPusher(pusher);
  invokeMock.mockReset();
  listenMock.mockReset();
  windowSnapshotMock.mockReset();
  windowSnapshotMock.mockReturnValue([]);
  invokeMock.mockImplementation(async (command: string) => {
    if (command === APP_COMMAND_SURFACES_COMMAND) return MANIFEST;
    return undefined;
  });
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return vi.fn();
  });
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
  vi.useRealTimers();
});

describe('listActions with the app CLOSED (R-4a)', () => {
  it('answers from the published manifest, opening nothing and relaying nothing', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'listActions' },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'success',
      text: 'Demo actions: demo.add — Add a widget; demo.rename — Rename the widget',
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
    expect(surfaceReads()).toBe(1);
  });

  it('uses the listLabel override read from the registry', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_SURFACES_COMMAND) {
        return { surfaces: [{ ...MANIFEST.surfaces[0], listLabel: 'Demo capabilities' }] };
      }
      return undefined;
    });
    await mount();

    await emit('llm-skill-call', { skill: 'demo', arguments: { action: 'listActions' } });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher.mock.calls[0][0]).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/^Demo capabilities: /),
    });
  });
});

describe('unknown / invalid requests change nothing (R-3/R-3a/R-3b)', () => {
  it('an unknown id replies unknown without opening or relaying', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.teleport', arguments: {} },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'unknown',
      text: 'I don\'t know the Demo action "demo.teleport". Nothing changed.',
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
  });

  it('a blank action is the nothing-changed reply', async () => {
    await mount();

    await emit('llm-skill-call', { skill: 'demo', arguments: { action: '   ' } });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
    expect(intentCalls()).toHaveLength(0);
  });

  it('a missing required argument rejects before any window or relay', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.rename', arguments: {} },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
  });

  it('an undeclared argument key rejects before any window or relay', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: { bogus: 'x' } },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
  });

  it('a non-object arguments value rejects before any window or relay', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: [1, 2] },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
  });

  it('an unresolvable application is the nothing-changed reply', async () => {
    renderHook(() =>
      useAppCommandSkill({ openFeatureWindow: vi.fn(), features: [] }),
    );
    await waitFor(() => expect(handlers['llm-skill-call']).toHaveLength(1));

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: {} },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
    expect(intentCalls()).toHaveLength(0);
  });
});

describe('dispatch to the owning application (R-2 / R-2b)', () => {
  it('opens a closed app once, relays the intent and names the performed command', async () => {
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: {} },
    });

    await waitFor(() => expect(intentCalls()).toHaveLength(1));
    expect(openFeatureWindow).toHaveBeenCalledTimes(1);
    expect(openFeatureWindow).toHaveBeenCalledWith('demo', DEMO_FEATURE);

    const call = intentCalls()[0][1];
    expect(call).toMatchObject({ appId: 'demo', action: 'demo.add', arguments: {} });
    expect(typeof call.requestId).toBe('string');

    await emit(APP_COMMAND_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      appId: 'demo',
      outcome: 'Performed',
      performed: ['demo.add'],
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'success',
      text: 'Performed in Demo: Add a widget.',
    });
  });

  it('does not open an already-open app', async () => {
    windowSnapshotMock.mockReturnValue([{ id: 'demo' }]);
    const openFeatureWindow = await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: {} },
    });

    await waitFor(() => expect(intentCalls()).toHaveLength(1));
    expect(openFeatureWindow).not.toHaveBeenCalled();
  });

  it('passes the declared arguments through unchanged', async () => {
    await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.rename', arguments: { name: 'Reports' } },
    });

    await waitFor(() => expect(intentCalls()).toHaveLength(1));
    expect(intentCalls()[0][1].arguments).toEqual({ name: 'Reports' });
  });

  it.each(['Noop', 'Invalid', 'Failed'] as const)(
    'a %s outcome reports nothing changed (one reply)',
    async (outcome) => {
      await mount();

      await emit('llm-skill-call', {
        skill: 'demo',
        arguments: { action: 'demo.add', arguments: {} },
      });
      await waitFor(() => expect(intentCalls()).toHaveLength(1));
      const call = intentCalls()[0][1];

      await emit(APP_COMMAND_INTENT_RESULT_EVENT, {
        requestId: call.requestId,
        appId: 'demo',
        outcome,
        performed: [],
      });

      await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
      expect(pusher).toHaveBeenCalledWith({
        kind: 'failed',
        text: "I couldn't do that in Demo. Nothing changed.",
      });
    },
  );

  it('a foreign requestId resolves nothing', async () => {
    await mount();

    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: {} },
    });
    await waitFor(() => expect(intentCalls()).toHaveLength(1));

    await emit(APP_COMMAND_INTENT_RESULT_EVENT, {
      requestId: 'someone-else',
      appId: 'demo',
      outcome: 'Performed',
      performed: ['demo.add'],
    });
    expect(pusher).not.toHaveBeenCalled();

    await emit(APP_COMMAND_INTENT_RESULT_EVENT, {
      requestId: intentCalls()[0][1].requestId,
      appId: 'demo',
      outcome: 'Performed',
      performed: ['demo.add'],
    });
    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
  });

  it('times out with exactly ONE nothing-changed reply', async () => {
    await mount();

    vi.useFakeTimers();
    await emit('llm-skill-call', {
      skill: 'demo',
      arguments: { action: 'demo.add', arguments: {} },
    });
    expect(pusher).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(APP_COMMAND_INTENT_TIMEOUT_MS);
    });

    expect(pusher).toHaveBeenCalledTimes(1);
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Demo. Nothing changed.",
    });
  });
});

describe('reserved skills and foreign skills (NFR-3 / NFR-4)', () => {
  it.each(['open_app', 'close_app', 'doom_mode'])(
    'ignores %s without a registry read or a reply',
    async (skill) => {
      await mount();

      await emit('llm-skill-call', { skill, arguments: { app: 'Demo' } });

      expect(pusher).not.toHaveBeenCalled();
      expect(surfaceReads()).toBe(0);
      expect(intentCalls()).toHaveLength(0);
    },
  );

  it('ignores a skill that is not a published surface', async () => {
    await mount();

    await emit('llm-skill-call', {
      skill: 'mission-monitor',
      arguments: { action: 'mission-monitor.qa', arguments: {} },
    });

    expect(pusher).not.toHaveBeenCalled();
    expect(intentCalls()).toHaveLength(0);
    expect(surfaceReads()).toBe(1);
  });
});
