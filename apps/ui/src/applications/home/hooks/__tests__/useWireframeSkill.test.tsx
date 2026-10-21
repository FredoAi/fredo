/**
 * useWireframeSkill — Home's `wireframe` dispatcher (Spec #3070, ST-7, C5 /
 * R-6.1–R-6.5 / F-43, F-47).
 *
 * Pins the observable contract:
 *  - `listActions` answers from the static catalog with the app CLOSED (no open,
 *    no intent);
 *  - an unknown id opens nothing and says it does not know the action;
 *  - a closed app is opened exactly once through the shipped opener; an open app
 *    is not opened again;
 *  - the result is matched by `requestId` (a foreign id resolves nothing);
 *  - a bounded timeout produces the honest failure reply.
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
import { WIREFRAME_ACTIONS } from '../../../wireframe/actions/wireframeActions';
import {
  WIREFRAME_INTENT_RESULT_EVENT,
  WIREFRAME_INTENT_TIMEOUT_MS,
  useWireframeSkill,
} from '../useWireframeSkill';
import type { FredoApplicationClass } from '../../../../shared/classes/FredoApplicationClass';

type Handler = (payload: unknown) => void;

const WIREFRAME_FEATURE = {
  id: 'wireframe',
  name: 'Wireframe',
  showable: true,
} as unknown as FredoApplicationClass;

let handlers: Record<string, Handler[]>;
let pusher: ReturnType<typeof vi.fn>;
let unregister: (() => void) | null = null;

const emit = async (event: string, payload: unknown) => {
  await act(async () => {
    (handlers[event] ?? []).forEach((handler) => handler(payload));
  });
};

function lastIntentCall(): {
  requestId: string;
  action: string;
  arguments: Record<string, unknown>;
} {
  const call = invokeMock.mock.calls
    .filter(([command]) => command === 'wireframe_intent')
    .pop();
  expect(call, 'wireframe_intent must have been invoked').toBeDefined();
  return call?.[1] as {
    requestId: string;
    action: string;
    arguments: Record<string, unknown>;
  };
}

async function mount(): Promise<void> {
  renderHook(() =>
    useWireframeSkill({
      openFeatureWindow: vi.fn(),
      features: [WIREFRAME_FEATURE],
    }),
  );
  await waitFor(() => {
    expect(handlers['llm-skill-call']).toHaveLength(1);
    expect(handlers[WIREFRAME_INTENT_RESULT_EVENT]).toHaveLength(1);
  });
}

/** Mount with a spy opener so the open count is directly observable. */
async function mountWithOpener(): Promise<ReturnType<typeof vi.fn>> {
  const openFeatureWindow = vi.fn();
  renderHook(() =>
    useWireframeSkill({
      openFeatureWindow,
      features: [WIREFRAME_FEATURE],
    }),
  );
  await waitFor(() => {
    expect(handlers['llm-skill-call']).toHaveLength(1);
    expect(handlers[WIREFRAME_INTENT_RESULT_EVENT]).toHaveLength(1);
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
  invokeMock.mockResolvedValue(undefined);
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

describe('listActions works with the app closed (R-6.1 / F-43)', () => {
  it('answers from the static catalog without opening or sending an intent', async () => {
    const openFeatureWindow = await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.companion.listActions' },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    const reply = pusher.mock.calls[0][0] as { kind: string; text: string };
    expect(reply.kind).toBe('success');
    for (const action of WIREFRAME_ACTIONS) {
      expect(reply.text).toContain(action.id);
      expect(reply.text).toContain(action.description);
    }
    expect(reply.text.startsWith('Wireframe actions: ')).toBe(true);
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('wireframe_intent', expect.anything());
  });
});

describe('unknown and unsupported requests change nothing (R-6.4)', () => {
  it('answers an unknown id without opening or sending an intent', async () => {
    const openFeatureWindow = await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.add.teapot' },
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'unknown',
      text: 'I don\'t know the Wireframe action "wireframe.add.teapot". Nothing changed.',
    });
    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('wireframe_intent', expect.anything());
  });

  it('a blank action is the nothing-changed reply', async () => {
    await mount();

    await emit('llm-skill-call', { skill: 'wireframe', arguments: { action: '   ' } });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Wireframe. Nothing changed.",
    });
  });

  it('ignores every other skill', async () => {
    await mount();

    await emit('llm-skill-call', { skill: 'open_app', arguments: { app: 'Settings' } });

    expect(pusher).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('wireframe_intent', expect.anything());
  });
});

describe('opening and relaying an action (R-6.2 / R-6.3)', () => {
  it('opens a closed app once, relays the intent and reports the performed action', async () => {
    const openFeatureWindow = await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.add.card' },
    });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('wireframe_intent', expect.anything()),
    );
    expect(openFeatureWindow).toHaveBeenCalledTimes(1);
    expect(openFeatureWindow).toHaveBeenCalledWith('wireframe', WIREFRAME_FEATURE);

    const call = lastIntentCall();
    expect(call.action).toBe('wireframe.add.card');

    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      performed: ['wireframe.add.card'],
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'success',
      text: 'Started a new wireframe for Wireframe: Add a card/container element.',
    });
  });

  it('does not open an already-open app', async () => {
    windowSnapshotMock.mockReturnValue([{ id: 'wireframe' }]);
    const openFeatureWindow = await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.add.text' },
    });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('wireframe_intent', expect.anything()),
    );
    expect(openFeatureWindow).not.toHaveBeenCalled();

    const call = lastIntentCall();
    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      performed: ['wireframe.add.text'],
    });
    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
  });

  it('matches the result by requestId, never by arrival order', async () => {
    await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.add.card' },
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('wireframe_intent', expect.anything()),
    );
    const call = lastIntentCall();

    // A foreign request id resolves nothing.
    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: 'someone-else',
      performed: ['wireframe.add.card'],
    });
    expect(pusher).not.toHaveBeenCalled();

    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      performed: ['wireframe.add.card'],
    });
    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
  });

  it('names only the performed subset in the draft reply', async () => {
    await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: {
        action: 'wireframe.companion.draftApp',
        app_name: 'Reporter',
        summary: 'visualize reports',
      },
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('wireframe_intent', expect.anything()),
    );
    const call = lastIntentCall();
    expect(call.arguments.app_name).toBe('Reporter');

    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      performed: ['wireframe.document.new', 'wireframe.add.section', 'wireframe.add.text'],
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    const reply = pusher.mock.calls[0][0] as { kind: string; text: string };
    expect(reply.kind).toBe('success');
    expect(reply.text).toBe(
      'Started a new wireframe for Reporter: Start a new empty wireframe, Add a site frame section (header, nav bar, sidebar, footer), Add a text element (body or heading style).',
    );
    expect(reply.text).not.toContain('wireframe.add.card');
  });

  it('a performed: [] result is the honest nothing-changed reply', async () => {
    await mountWithOpener();

    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.element.delete' },
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('wireframe_intent', expect.anything()),
    );
    const call = lastIntentCall();

    await emit(WIREFRAME_INTENT_RESULT_EVENT, {
      requestId: call.requestId,
      performed: [],
    });
    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Wireframe. Nothing changed.",
    });
  });
});

describe('bounded timeout (never a stuck bubble)', () => {
  it('replies with the failure copy when no result arrives in time', async () => {
    await mountWithOpener();

    vi.useFakeTimers();
    await emit('llm-skill-call', {
      skill: 'wireframe',
      arguments: { action: 'wireframe.add.card' },
    });
    expect(pusher).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(WIREFRAME_INTENT_TIMEOUT_MS);
    });

    expect(pusher).toHaveBeenCalledTimes(1);
    expect(pusher).toHaveBeenCalledWith({
      kind: 'failed',
      text: "I couldn't do that in Wireframe. Nothing changed.",
    });
  });
});
