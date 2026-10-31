/**
 * The generic application-side intent hook (Spec #3099, ST-6).
 *
 * Pins:
 *  - listener FIRST, then the take-on-mount drain (an intent queued before the
 *    mount still executes);
 *  - exactly-once per `requestId` across a remount (module-scoped ledger, never
 *    a React ref);
 *  - intents addressed to another `appId` are ignored (no cross-app drain);
 *  - the executor outcome mapping (`performed`/`noop`/`rejected`/`failed` ->
 *    `Performed`/`Noop`/`Invalid`/`Failed`) and the `performed` list rule;
 *  - EVERY intent is answered with `app_command_intent_result` (never a silent
 *    drop), including a thrown `run`.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import type { FredoApplicationClass } from '@/shared/classes';
import type { DispatchResult, Intent, Surface } from '@/shared/navigation';
import {
  registerNavigationHost,
  type NavigationHost,
} from '@/shared/navigation/ui/hostRegistry';
import {
  APP_COMMAND_INTENT_EVENT,
  APP_COMMAND_INTENT_RESULT_COMMAND,
  APP_COMMAND_INTENT_TAKE_COMMAND,
  drainAppCommandIntents,
  handleAppCommandIntent,
  resetAppCommandIntentLedgerForTests,
  useAppCommandIntent,
  type AppCommandIntentPayload,
} from '../useAppCommandIntent';

type Handler = (payload: unknown) => void;

const APP_ID = 'demo';

function registerDemo(overrides: {
  add?: () => void | boolean | Promise<void | boolean>;
  needs?: () => void | boolean | Promise<void | boolean>;
} = {}): { add: ReturnType<typeof vi.fn> } {
  const add = vi.fn(overrides.add ?? (() => true));
  registerApplication({
    id: APP_ID,
    name: 'Demo',
    showable: true,
    commandSurface: {
      modes: [],
      commands: [
        { id: 'demo.add', title: 'Add', description: 'Add a widget', args: [], run: add },
        {
          id: 'demo.needs',
          title: 'Needs',
          description: 'Needs a name',
          args: [{ name: 'name', required: true }],
          run: vi.fn(overrides.needs ?? (() => true)),
        },
      ],
    },
  } as unknown as FredoApplicationClass);
  return { add };
}

function intent(overrides: Partial<AppCommandIntentPayload> = {}): AppCommandIntentPayload {
  return {
    requestId: 'req-1',
    appId: APP_ID,
    action: 'demo.add',
    arguments: {},
    ...overrides,
  };
}

function resultCalls(): Array<[string, Record<string, unknown>]> {
  return invokeMock.mock.calls.filter(
    ([command]) => command === APP_COMMAND_INTENT_RESULT_COMMAND,
  ) as Array<[string, Record<string, unknown>]>;
}

function takeCalls(): number {
  return invokeMock.mock.calls.filter(
    ([command]) => command === APP_COMMAND_INTENT_TAKE_COMMAND,
  ).length;
}

let handlers: Record<string, Handler[]>;
let callOrder: string[];
let addSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers = {};
  callOrder = [];
  resetApplicationRegistryForTests();
  resetAppCommandIntentLedgerForTests();
  addSpy = registerDemo().add;
  invokeMock.mockReset();
  listenMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    callOrder.push(`listen:${event}`);
    (handlers[event] ??= []).push(handler);
    return vi.fn();
  });
  invokeMock.mockImplementation(async (command: string) => {
    callOrder.push(`invoke:${command}`);
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  resetApplicationRegistryForTests();
  resetAppCommandIntentLedgerForTests();
});

async function mount(appId: string = APP_ID): Promise<void> {
  renderHook(() => useAppCommandIntent(appId));
  await waitFor(() =>
    expect((handlers[APP_COMMAND_INTENT_EVENT] ?? []).length).toBeGreaterThan(0),
  );
}

describe('mount ordering + drain (R-2a)', () => {
  it('registers the listener BEFORE taking the queue', async () => {
    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));

    expect(callOrder.indexOf(`listen:${APP_COMMAND_INTENT_EVENT}`)).toBeLessThan(
      callOrder.indexOf(`invoke:${APP_COMMAND_INTENT_TAKE_COMMAND}`),
    );
  });

  it('executes and answers an intent that was queued before the mount', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) return [intent({ requestId: 'queued' })];
      return undefined;
    });

    await mount();

    await waitFor(() => expect(resultCalls()).toHaveLength(1));
    expect(resultCalls()[0][1]).toEqual({
      requestId: 'queued',
      appId: APP_ID,
      outcome: 'Performed',
      performed: ['demo.add'],
      detail: null,
    });
  });

  it('drains only intents addressed to this appId', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) {
        return [intent({ requestId: 'foreign', appId: 'other' })];
      }
      return undefined;
    });

    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resultCalls()).toHaveLength(0);
  });
});

describe('exactly once (module-scoped ledger)', () => {
  it('does not re-execute the same requestId after a remount', async () => {
    await mount();

    await act(async () => {
      (handlers[APP_COMMAND_INTENT_EVENT] ?? []).forEach((handler) =>
        handler(intent({ requestId: 'once' })),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(resultCalls()).toHaveLength(1));
    expect(addSpy).toHaveBeenCalledTimes(1);

    cleanup();
    // The unmounted hook's listeners are gone; only the remount's remain.
    handlers = {};
    invokeMock.mockClear();

    // The host queue still holds the request (the handler ran from the event).
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) return [intent({ requestId: 'once' })];
      return undefined;
    });
    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // One execution, one report — the ledger carried across the remount.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(resultCalls()).toHaveLength(0);
  });

  it('ignores an event addressed to another appId', async () => {
    await mount();

    await act(async () => {
      (handlers[APP_COMMAND_INTENT_EVENT] ?? []).forEach((handler) =>
        handler(intent({ requestId: 'foreign', appId: 'other' })),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resultCalls()).toHaveLength(0);
  });

  it('ignores a malformed intent (blank requestId) without reporting', async () => {
    await handleAppCommandIntent(intent({ requestId: '   ' }));
    expect(resultCalls()).toHaveLength(0);

    await handleAppCommandIntent(null);
    await handleAppCommandIntent(undefined);
    expect(resultCalls()).toHaveLength(0);
  });
});

describe('outcome mapping (R-2/R-3/R-3c/R-3d)', () => {
  it('performed -> Performed with the executed id', async () => {
    await handleAppCommandIntent(intent({ requestId: 'p' }));
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Performed',
      performed: ['demo.add'],
    });
  });

  it('run returning false -> Noop with an empty performed list', async () => {
    resetApplicationRegistryForTests();
    registerDemo({ add: () => false });

    await handleAppCommandIntent(intent({ requestId: 'n' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Noop', performed: [] });
  });

  it('a thrown run -> Failed (never a silent drop)', async () => {
    resetApplicationRegistryForTests();
    registerDemo({
      add: () => {
        throw new Error('boom');
      },
    });

    await handleAppCommandIntent(intent({ requestId: 'f' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Failed', performed: [] });
  });

  it('an unknown command id -> Invalid', async () => {
    await handleAppCommandIntent(intent({ requestId: 'i', action: 'demo.missing' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Invalid', performed: [] });
  });

  it('a contract-failing argument is rejected BEFORE run (R-3d)', async () => {
    await handleAppCommandIntent(
      intent({ requestId: 'args', action: 'demo.needs', arguments: { bogus: 'x' } }),
    );
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Invalid', performed: [] });
  });

  it('a missing arguments value is the no-argument shape, never a prompt', async () => {
    await handleAppCommandIntent(intent({ requestId: 'bare', arguments: undefined }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Performed', performed: ['demo.add'] });
  });
});

describe('drain helper', () => {
  it('is a no-op for a blank appId', async () => {
    await drainAppCommandIntents('   ');
    expect(takeCalls()).toBe(0);
  });
});

/* ───────────────────── navigation-host relay (Spec #3120, ST-4) ───────────────────── */

const EMPTY_SURFACE: Surface = {
  tree: { appId: APP_ID, root: 'root', places: [], directAliases: {} },
  verbs: [],
  companion: null,
};

/** Register a stub NavigationHost for this app; the disposer unregisters it. */
function registerHost(
  runIntent: (intent: Intent) => Promise<DispatchResult>,
): { runIntent: ReturnType<typeof vi.fn>; unregister: () => void } {
  const spy = vi.fn(runIntent);
  const unregister = registerNavigationHost({
    appId: APP_ID,
    surface: EMPTY_SURFACE,
    host: { runIntent: spy } as unknown as NavigationHost,
  });
  return { runIntent: spy, unregister };
}

describe('navigation-host relay (R-4.1 / R-4.2)', () => {
  it('executes through host.runIntent with channel agent and actor companion', async () => {
    const { runIntent, unregister } = registerHost(async () => ({
      status: 'performed',
      entry: {},
    }) as unknown as DispatchResult);
    try {
      await handleAppCommandIntent(intent({ requestId: 'relay', action: 'wireframe.element.delete' }));
    } finally {
      unregister();
    }

    expect(runIntent).toHaveBeenCalledTimes(1);
    expect(runIntent).toHaveBeenCalledWith({
      verbId: 'wireframe.element.delete',
      args: {},
      channel: 'agent',
      actor: 'companion',
    });
    // The shipped command-surface executor is NOT consulted when a host is registered.
    expect(addSpy).not.toHaveBeenCalled();
    expect(resultCalls()[0][1]).toEqual({
      requestId: 'relay',
      appId: APP_ID,
      outcome: 'Performed',
      performed: ['wireframe.element.delete'],
      detail: null,
    });
  });

  it('passes a present non-object argument through (the funnel types the rejection)', async () => {
    const { runIntent, unregister } = registerHost(async () => ({
      status: 'rejected',
      code: 'invalid-args',
    }) as DispatchResult);
    try {
      await handleAppCommandIntent(intent({ requestId: 'bad-args', arguments: 'not-an-object' }));
    } finally {
      unregister();
    }

    expect(runIntent).toHaveBeenCalledWith({
      verbId: 'demo.add',
      args: 'not-an-object',
      channel: 'agent',
      actor: 'companion',
    });
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Invalid',
      performed: [],
      detail: 'invalid-args',
    });
  });

  it('maps noop to Noop with an empty performed list', async () => {
    const { unregister } = registerHost(async () => ({
      status: 'noop',
      code: 'did-nothing',
      message: null,
    }) as DispatchResult);
    try {
      await handleAppCommandIntent(intent({ requestId: 'noop' }));
    } finally {
      unregister();
    }

    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Noop', performed: [], detail: null });
  });

  it('maps a typed rejection to Invalid with the code as detail (R-4.2)', async () => {
    const { unregister } = registerHost(async () => ({
      status: 'rejected',
      code: 'unavailable',
    }) as DispatchResult);
    try {
      await handleAppCommandIntent(intent({ requestId: 'rejected' }));
    } finally {
      unregister();
    }

    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Invalid',
      performed: [],
      detail: 'unavailable',
    });
  });

  it('maps failed to Failed (never a silent drop)', async () => {
    const { unregister } = registerHost(async () => ({
      status: 'failed',
      code: 'failed-run',
    }) as DispatchResult);
    try {
      await handleAppCommandIntent(intent({ requestId: 'failed' }));
    } finally {
      unregister();
    }

    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Failed', performed: [] });
  });

  it('keeps the shipped executeCommand path when no host is registered', async () => {
    // No registerHost here — the application registry's command surface answers instead.
    await handleAppCommandIntent(intent({ requestId: 'legacy' }));
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Performed',
      performed: ['demo.add'],
    });
  });
});
