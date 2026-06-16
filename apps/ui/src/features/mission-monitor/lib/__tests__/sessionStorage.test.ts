/**
 * Tests for sessionStorage.ts — persistEvent, event cap, and session lifecycle.
 *
 * Covers REQ-14 (Event Cap — Session Storage), AC-E1, AC-E2.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { persistEvent, getSessionEvents, loadSessions, finalizeSession, deleteSession } from '../sessionStorage';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<FredoEvent>): FredoEvent {
  return {
    id: crypto.randomUUID(),
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 'test-session',
    payload: null,
    error: null,
    metadata: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('persistEvent — event cap (REQ-14)', () => {
  it('stores events up to MAX_EVENTS_PER_SESSION cap', () => {
    // Persist 510 events — only 500 should be stored
    const sessionId = 'cap-test';
    for (let i = 0; i < 510; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId, timestamp: new Date(i).toISOString() }));
    }

    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(500);
  });

  it('keeps the most recent events when cap is exceeded', () => {
    const sessionId = 'recent-test';
    // Persist 600 events with sequential timestamps
    for (let i = 0; i < 600; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId, timestamp: new Date(i).toISOString() }));
    }

    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(500);

    // The first stored event should be event-100 (oldest 100 trimmed)
    expect(stored[0].id).toBe('event-100');
    // The last stored event should be event-599
    expect(stored[stored.length - 1].id).toBe('event-599');
  });

  it('does not trim when under the cap', () => {
    const sessionId = 'under-cap';
    for (let i = 0; i < 100; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId }));
    }

    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(100);
    expect(stored[0].id).toBe('event-0');
    expect(stored[99].id).toBe('event-99');
  });

  it('continues incrementing eventCount beyond cap', () => {
    const sessionId = 'count-test';
    // Persist 700 events — stored capped at 500 but eventCount should be 700
    for (let i = 0; i < 700; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId, timestamp: new Date(i).toISOString() }));
    }

    const sessions = loadSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    expect(session).toBeDefined();
    expect(session!.eventCount).toBe(700);

    // Confirm only 500 events actually stored
    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(500);
  });

  it('eventCount for an existing session increments even after cap is reached', () => {
    const sessionId = 'increment-test';
    // Persist 500 events
    for (let i = 0; i < 500; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId, timestamp: new Date(i).toISOString() }));
    }

    let sessions = loadSessions();
    expect(sessions.find((s) => s.sessionId === sessionId)!.eventCount).toBe(500);

    // Persist 300 more events
    for (let i = 500; i < 800; i++) {
      persistEvent(makeEvent({ id: `event-${i}`, sessionId, timestamp: new Date(i).toISOString() }));
    }

    sessions = loadSessions();
    expect(sessions.find((s) => s.sessionId === sessionId)!.eventCount).toBe(800);

    // Stored events still capped at 500
    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(500);
    // Most recent events preserved
    expect(stored[0].id).toBe('event-300');
    expect(stored[499].id).toBe('event-799');
  });

  it('handles multiple sessions independently — only over-cap session is trimmed', () => {
    const sessionA = 'session-a';
    const sessionB = 'session-b';

    // Session A: 600 events (will be trimmed to 500)
    for (let i = 0; i < 600; i++) {
      persistEvent(makeEvent({ id: `a-event-${i}`, sessionId: sessionA, timestamp: new Date(i).toISOString() }));
    }

    // Session B: 10 events (untouched)
    for (let i = 0; i < 10; i++) {
      persistEvent(makeEvent({ id: `b-event-${i}`, sessionId: sessionB, timestamp: new Date(i).toISOString() }));
    }

    expect(getSessionEvents(sessionA).length).toBe(500);
    expect(getSessionEvents(sessionB).length).toBe(10);
    expect(getSessionEvents(sessionA)[0].id).toBe('a-event-100');
    expect(getSessionEvents(sessionB)[0].id).toBe('b-event-0');
  });

  it('deduplication still works — duplicate events are not stored and do not count toward cap', () => {
    const sessionId = 'dedup-cap';
    const ev = makeEvent({ id: 'unique-id', sessionId });

    // Persist same event 10 times
    for (let i = 0; i < 10; i++) {
      persistEvent(ev);
    }

    const stored = getSessionEvents(sessionId);
    expect(stored.length).toBe(1);

    const sessions = loadSessions();
    // eventCount increments every time persistEvent is called (10 times)
    expect(sessions.find((s) => s.sessionId === sessionId)!.eventCount).toBe(10);
  });
});

describe('persistEvent — existing session lifecycle', () => {
  it('creates a new session record for first event', () => {
    persistEvent(makeEvent({ id: 'first', sessionId: 'new-session' }));

    const sessions = loadSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe('new-session');
    expect(sessions[0].eventCount).toBe(1);
  });

  it('upserts existing session record on subsequent events', () => {
    persistEvent(makeEvent({ id: 'e1', sessionId: 'upsert-session' }));
    persistEvent(makeEvent({ id: 'e2', sessionId: 'upsert-session' }));

    const sessions = loadSessions();
    const s = sessions.find((s) => s.sessionId === 'upsert-session');
    expect(s).toBeDefined();
    expect(s!.eventCount).toBe(2);
  });

  it('does not store events without a sessionId', () => {
    persistEvent(makeEvent({ sessionId: '' }));
    const sessions = loadSessions();
    expect(sessions.length).toBe(0);
  });
});

describe('finalizeSession / deleteSession', () => {
  it('finalizeSession sets endTime', () => {
    persistEvent(makeEvent({ id: 'fin', sessionId: 'fin-session' }));
    finalizeSession('fin-session');

    const s = loadSessions().find((s) => s.sessionId === 'fin-session');
    expect(s).toBeDefined();
    expect(s!.endTime).toBeGreaterThan(0);
  });

  it('deleteSession removes events and session record', () => {
    persistEvent(makeEvent({ id: 'del', sessionId: 'del-session' }));
    expect(getSessionEvents('del-session').length).toBe(1);
    expect(loadSessions().length).toBe(1);

    deleteSession('del-session');
    expect(getSessionEvents('del-session').length).toBe(0);
    expect(loadSessions().length).toBe(0);
  });
});
