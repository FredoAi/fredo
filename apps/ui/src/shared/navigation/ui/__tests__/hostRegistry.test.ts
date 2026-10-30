/**
 * Spec #3120 (P6), ST-1 — the host seam pins: registry, fresh `describeContext`, `runIntent`,
 * the async launcher confirmation store, the launcher-open bridge and requester-attributed undo.
 *
 * These are the P6 contracts the launcher (ST-6) and the Wireframe provider (ST-4) consume. They
 * are exercised through the real `createNavigationHost` + the controlled `navTestSurface` fixture
 * — no product declaration, no DOM, no persistence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createJournalStore,
  type ConfirmationRequest,
  type Intent,
  type JournalStore,
} from '../../';
import { resetNavigationAnnouncer } from '../announce';
import {
  getPendingLauncherConfirmation,
  requestLauncherConfirmation,
  resolveLauncherConfirmation,
  subscribeLauncherConfirmation,
  type PendingLauncherConfirmation,
} from '../confirmation';
import { createNavigationHost, type NavigationHost, type NavigationHostOptions } from '../host';
import {
  describeContext,
  getNavigationHost,
  getRegisteredSurface,
  listRegisteredSurfaces,
  registerNavigationHost,
} from '../hostRegistry';
import {
  requestLauncherOpen,
  subscribeLauncherOpenRequests,
  type LauncherOpenRequest,
} from '../launcherBridge';
import { FIXTURE_APP_ID, FIXTURE_PLACES, fixtureSnapshot, navTestSurface } from './fixtures';

/* ───────────────────────────── harness ───────────────────────────── */

const disposers: Array<() => void> = [];

function makeHost(
  options: Partial<NavigationHostOptions> = {},
  journal: JournalStore = createJournalStore(),
): { host: NavigationHost; journal: JournalStore } {
  const host = createNavigationHost({
    surface: navTestSurface(),
    getContext: () => fixtureSnapshot([FIXTURE_PLACES.canvas]),
    journal,
    now: () => '2026-01-01T09:00:00.000Z',
    applyPatch: () => undefined,
    ...options,
  });
  return { host, journal };
}

function intentOf(overrides: Partial<Intent> = {}): Intent {
  return { verbId: 'test.rect', args: {}, channel: 'launcher', actor: 'human', ...overrides };
}

function confirmationRequest(): ConfirmationRequest {
  return {
    verbId: 'test.delete',
    title: 'Delete',
    targetLabels: ['element-1'],
    targetOverflow: 0,
    consequence: 'the selection is removed and is not kept in history.',
    undoAvailability: { undoable: true },
    externalParty: null,
  };
}

beforeEach(() => {
  resetNavigationAnnouncer();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetNavigationAnnouncer();
});

/* ───────────────────────────── registry ───────────────────────────── */

describe('host registry — register / unregister / describeContext', () => {
  it('registers the host + surface and unregisters them', () => {
    const surface = navTestSurface();
    const { host } = makeHost();
    const dispose = registerNavigationHost({ appId: FIXTURE_APP_ID, surface, host });
    disposers.push(dispose);

    expect(getNavigationHost(FIXTURE_APP_ID)).toBe(host);
    expect(getRegisteredSurface(FIXTURE_APP_ID)).toBe(surface);
    expect(listRegisteredSurfaces()).toContain(surface);

    dispose();
    expect(getNavigationHost(FIXTURE_APP_ID)).toBeNull();
    expect(getRegisteredSurface(FIXTURE_APP_ID)).toBeNull();
    expect(listRegisteredSurfaces()).not.toContain(surface);
  });

  it('unregister is idempotent and never removes a newer registration', () => {
    const surface = navTestSurface();
    const first = makeHost();
    const second = makeHost();
    const disposeFirst = registerNavigationHost({ appId: 'dup', surface, host: first.host });
    const disposeSecond = registerNavigationHost({ appId: 'dup', surface, host: second.host });
    disposers.push(disposeSecond);

    expect(getNavigationHost('dup')).toBe(second.host);
    disposeFirst(); // a stale disposer must not remove the newer registration
    disposeFirst(); // idempotent
    expect(getNavigationHost('dup')).toBe(second.host);

    disposeSecond();
    disposeSecond(); // idempotent
    expect(getNavigationHost('dup')).toBeNull();
  });

  it('describeContext is null for an unknown app and FRESH for a registered host', () => {
    expect(describeContext('unknown-app')).toBeNull();

    const surface = navTestSurface();
    const { host } = makeHost();
    const dispose = registerNavigationHost({ appId: 'fresh', surface, host });
    disposers.push(dispose);

    const first = describeContext('fresh');
    const second = describeContext('fresh');
    expect(first).not.toBeNull();
    expect(first).not.toBe(second); // built on demand — never the cached snapshot
    expect(first).toStrictEqual(second);
    expect(first?.appId).toBe(FIXTURE_APP_ID);
    expect(first?.placePath[0]?.id).toBe(FIXTURE_PLACES.canvas);
  });
});

/* ───────────────────────────── runIntent ───────────────────────────── */

describe('runIntent — the full intent through the ONE funnel', () => {
  it('carries the intent actor and channel into the journal entry', async () => {
    const { host, journal } = makeHost();

    const human = await host.runIntent(intentOf({ channel: 'launcher', actor: 'human' }));
    expect(human.status).toBe('performed');
    const humanEntry = journal.entries()[0];
    expect(humanEntry.channel).toBe('launcher');
    expect(humanEntry.actor).toBe('human');

    const companion = await host.runIntent(
      intentOf({ channel: 'agent', actor: 'companion' }),
    );
    expect(companion.status).toBe('performed');
    const companionEntry = journal.entries()[1];
    expect(companionEntry.channel).toBe('agent');
    expect(companionEntry.actor).toBe('companion');
  });

  it('awaits an async confirm: accept runs, cancel rejects before running', async () => {
    const decisions: Array<(accepted: boolean) => void> = [];
    const { host, journal } = makeHost({
      confirm: () => new Promise<boolean>((resolve) => decisions.push(resolve)),
    });

    const accepted = host.runIntent(
      intentOf({ verbId: 'test.delete', channel: 'launcher', actor: 'human' }),
    );
    expect(decisions).toHaveLength(1);
    expect(journal.entries()).toHaveLength(0); // nothing applies before the answer
    decisions[0](true);
    expect((await accepted).status).toBe('performed');
    expect(journal.entries()).toHaveLength(1);

    const canceled = host.runIntent(
      intentOf({ verbId: 'test.delete', channel: 'launcher', actor: 'human' }),
    );
    expect(decisions).toHaveLength(2);
    decisions[1](false);
    expect(await canceled).toStrictEqual({ status: 'rejected', code: 'canceled-confirmation' });
    expect(journal.entries()).toHaveLength(1); // a cancel journals nothing
  });
});

/* ───────────────────── confirmation store ───────────────────── */

describe('launcher confirmation store', () => {
  it('resolves false immediately when no launcher surface is mounted', async () => {
    await expect(requestLauncherConfirmation(confirmationRequest(), intentOf())).resolves.toBe(
      false,
    );
    expect(getPendingLauncherConfirmation()).toBeNull();
  });

  it('notifies the mounted launcher and resolves accept then cancel', async () => {
    const seen: Array<PendingLauncherConfirmation | null> = [];
    disposers.push(subscribeLauncherConfirmation((pending) => seen.push(pending)));

    const request = confirmationRequest();
    const intent = intentOf({ verbId: 'test.delete' });

    const first = requestLauncherConfirmation(request, intent);
    expect(getPendingLauncherConfirmation()).toStrictEqual({ request, intent });
    expect(seen[seen.length - 1]).toStrictEqual({ request, intent });

    resolveLauncherConfirmation(true);
    await expect(first).resolves.toBe(true);
    expect(getPendingLauncherConfirmation()).toBeNull();
    expect(seen[seen.length - 1]).toBeNull();

    const second = requestLauncherConfirmation(request, intent);
    resolveLauncherConfirmation(false);
    await expect(second).resolves.toBe(false);
  });

  it('guards a double resolve and notifies only the real settlement', async () => {
    const seen: Array<PendingLauncherConfirmation | null> = [];
    disposers.push(subscribeLauncherConfirmation((pending) => seen.push(pending)));

    const request = confirmationRequest();
    const intent = intentOf({ verbId: 'test.delete' });
    const decision = requestLauncherConfirmation(request, intent);

    resolveLauncherConfirmation(true);
    resolveLauncherConfirmation(false); // stale second resolve — no-op
    await expect(decision).resolves.toBe(true);

    // replay(null) on subscribe → pending on request → null on settle; the stale resolve adds none.
    expect(seen).toStrictEqual([null, { request, intent }, null]);
  });

  it('a new request supersedes the pending one as a cancel', async () => {
    disposers.push(subscribeLauncherConfirmation(() => undefined));

    const first = requestLauncherConfirmation(confirmationRequest(), intentOf());
    const second = requestLauncherConfirmation(
      confirmationRequest(),
      intentOf({ verbId: 'test.exportPng' }),
    );

    await expect(first).resolves.toBe(false); // superseded = cancel
    resolveLauncherConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it('unmounting the launcher dismisses a pending confirmation as a cancel', async () => {
    const unsubscribe = subscribeLauncherConfirmation(() => undefined);
    const decision = requestLauncherConfirmation(confirmationRequest(), intentOf());
    unsubscribe(); // launcher closed between request and resolve
    await expect(decision).resolves.toBe(false);
    expect(getPendingLauncherConfirmation()).toBeNull();
  });
});

/* ───────────────────────── undo attribution ───────────────────────── */

describe('undo attribution — the reversal belongs to the requester', () => {
  it('a companion-channel undo journals human; a system undo stays system', async () => {
    const { host, journal } = makeHost();

    await host.runIntent(intentOf({ channel: 'agent', actor: 'companion' }));

    const companionUndo = await host.runIntent(
      intentOf({ verbId: 'journal.undo', channel: 'agent', actor: 'companion' }),
    );
    expect(companionUndo.status).toBe('performed');
    const humanEntry = journal.entries()[journal.entries().length - 1];
    expect(humanEntry.actor).toBe('human');
    expect(humanEntry.channel).toBe('agent');

    const systemUndo = await host.runIntent(
      intentOf({ verbId: 'journal.undo', channel: 'system', actor: 'system' }),
    );
    expect(systemUndo.status).toBe('performed');
    const systemEntry = journal.entries()[journal.entries().length - 1];
    expect(systemEntry.actor).toBe('system');
    expect(systemEntry.channel).toBe('system');
  });

  it('the trail-button undoEntry defaults to the human on the pointer channel', async () => {
    const { host, journal } = makeHost();
    const performed = await host.runIntent(intentOf({ channel: 'launcher', actor: 'human' }));
    expect(performed.status).toBe('performed');
    const target = journal.entries()[0];
    expect(target).toBeDefined();
    if (target === undefined) throw new Error('fixture entry missing');

    const undo = await host.undoEntry(target.seq);
    expect(undo.status).toBe('performed');
    if (undo.status !== 'performed') throw new Error(undo.status);
    expect(undo.entry.actor).toBe('human');
    expect(undo.entry.channel).toBe('pointer');
  });
});

/* ───────────────────────── launcher bridge ───────────────────────── */

describe('launcher-open bridge', () => {
  it('delivers requests to subscribers and stops after unsubscribe', () => {
    const seen: LauncherOpenRequest[] = [];
    const unsubscribe = subscribeLauncherOpenRequests((request) => seen.push(request));

    const request: LauncherOpenRequest = { source: 'rail-ask', focus: true };
    requestLauncherOpen(request);
    expect(seen).toStrictEqual([request]);

    unsubscribe();
    unsubscribe(); // idempotent
    requestLauncherOpen({ source: 'ask-verb', prefill: '> lock', focus: true });
    expect(seen).toStrictEqual([request]);
  });
});
