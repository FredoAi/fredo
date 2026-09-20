/**
 * #2883 ST-6 (AC4) — the ONE hide gate for Fredo's reply.
 *
 * Contract (Architect, `## API Contracts & Data Models` — `CompanionEntity.tsx`
 * + `replyProtection.ts`):
 *
 *   `REPLY_LEAVE_GRACE_MS = 2000`; `useReplyProtection(graceMs = REPLY_LEAVE_GRACE_MS)`
 *   returns `{ protectedRef, protected, enter, leave, clearOrDefer }`.
 *
 * Semantics (binding — the four AC4 EARS clauses):
 *
 *   - R-4.1 (pointer over ⇒ no dismiss, even mid-countdown): `enter()` marks the
 *     reply protected. Any clear that comes DUE while protected is not run — it is
 *     stashed by `clearOrDefer` and run when protection ends. A countdown that had
 *     already started can therefore never complete while the pointer is over the
 *     reply.
 *   - R-4.2 (dismiss only after the leave): `leave()` arms a FRESH full
 *     `REPLY_LEAVE_GRACE_MS` window — never a resume of the suspended countdown
 *     (no remaining-time arithmetic exists). On expiry protection ends and the
 *     stashed clear runs, i.e. the reply dismisses exactly as it would have.
 *   - R-4.3 (keyboard focus protects independently): the pointer and the keyboard
 *     are tracked as SEPARATE sources; the grace is armed only when the last live
 *     source leaves, so focus inside the surface keeps the reply up even if the
 *     pointer leaves.
 *   - R-4.4 (cannot be unmounted mid-read): `protected` is a render-visible flag the
 *     entity joins into its EXISTING single `isInUse` predicate — the entity stays
 *     the only writer of `isInUse` (the context's idle auto-return gate then
 *     suppresses the 60 s auto-return).
 *
 * The decision logic is pure where it can be (`protectionSurvivesLeave`,
 * `shouldAnnounceProtection`); the hook only owns the refs/timer around it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

/**
 * The bound leave-grace (Architect-bound number; QA REQ-9 scores against it).
 * A due clear is RE-ARMED with this full window on leave, never resumed.
 */
export const REPLY_LEAVE_GRACE_MS = 2000;

/**
 * The ONE polite announcement made on the FIRST entry to protection in a
 * generation (UI/UX `Dismissal protection`). Never per token, never on re-entry.
 */
export const REPLY_PROTECTION_ANNOUNCEMENT = "Fredo's reply will stay open while you read it.";

/** The two independent protection sources (R-4.3: focus protects on its own). */
export type ReplyProtectionSource = 'pointer' | 'focus';

export interface ReplyProtection {
  /** Synchronous mirror of `protected` — read by the timer callbacks. */
  protectedRef: MutableRefObject<boolean>;
  /** Render-visible flag: the one-shot announcement + the `isInUse` join. */
  protected: boolean;
  /** Cancel the pending dismissal and hold the reply; also re-arms within grace. */
  enter: (source?: ReplyProtectionSource) => void;
  /** Start a FRESH leave-grace once the last live source has left. */
  leave: (source?: ReplyProtectionSource) => void;
  /** Run the clear now, or defer it until protection ends (R-4.1). */
  clearOrDefer: (clear: () => void) => void;
  /**
   * Per-generation reset: a NEW reply/error/stream generation owns the bubble, so
   * protection does not carry over and a stashed clear is dropped (it must never
   * wipe the new generation).
   */
  reset: () => void;
}

/**
 * Pure decision (R-4.3): after `leaving` stops protecting, does another source
 * still hold the reply? `sources` is the CURRENT set (the leaver included).
 */
export function protectionSurvivesLeave(
  sources: ReadonlySet<ReplyProtectionSource>,
  leaving: ReplyProtectionSource,
): boolean {
  for (const source of sources) {
    if (source !== leaving) return true;
  }
  return false;
}

/**
 * Pure decision: announce the protection copy only on the FIRST entry per
 * generation (never per token, never on a re-entry inside the same generation).
 */
export function shouldAnnounceProtection(
  announcedGeneration: number,
  currentGeneration: number,
): boolean {
  return announcedGeneration !== currentGeneration;
}

/**
 * The single protection decision for the seat reply. One instance per entity;
 * the entity owns the reply's clear timers and routes their message clear through
 * `clearOrDefer`.
 *
 * `graceMs` (REQ-10 / AC9) is the configurable leave grace. It defaults to the
 * shipped `REPLY_LEAVE_GRACE_MS`; a NEW `leave()` arms exactly the value current
 * at that moment (see `graceMsRef`).
 */
export function useReplyProtection(graceMs: number = REPLY_LEAVE_GRACE_MS): ReplyProtection {
  const [isProtected, setIsProtected] = useState(false);
  const protectedRef = useRef(false);
  const sourcesRef = useRef<Set<ReplyProtectionSource>>(new Set());
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredClearRef = useRef<(() => void) | null>(null);
  // REQ-10 — read the grace through a ref so the STABLE `leave` callback always
  // arms a NEW window with the latest value. An already-armed timer keeps the
  // delay it was scheduled with: a mid-grace setting change can never re-time or
  // resurrect a stale window (a fresh `leave()` is the only thing that arms).
  const graceMsRef = useRef(graceMs);
  useEffect(() => {
    graceMsRef.current = graceMs;
  }, [graceMs]);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  /** End protection: drop every source, then run the clear it suspended. */
  const release = useCallback(() => {
    protectedRef.current = false;
    sourcesRef.current.clear();
    setIsProtected(false);
    const deferred = deferredClearRef.current;
    deferredClearRef.current = null;
    if (deferred) deferred();
  }, []);

  const enter = useCallback((source: ReplyProtectionSource = 'pointer') => {
    sourcesRef.current.add(source);
    // Re-entry — including a pointer that returns inside the leave grace — is a
    // FULL restart of protection (R-4.2: never a resume).
    clearGraceTimer();
    if (protectedRef.current) return;
    protectedRef.current = true;
    setIsProtected(true);
  }, [clearGraceTimer]);

  const leave = useCallback((source: ReplyProtectionSource = 'pointer') => {
    const survives = protectionSurvivesLeave(sourcesRef.current, source);
    sourcesRef.current.delete(source);
    if (!protectedRef.current) return;
    // R-4.3 — keyboard focus (or the pointer) still holds the reply: no grace yet.
    if (survives) return;
    // FRESH re-arm: the suspended countdown is never resumed, and any clear that
    // already came due waits for this full window.
    clearGraceTimer();
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      release();
    }, graceMsRef.current);
  }, [clearGraceTimer, release]);

  const clearOrDefer = useCallback((clear: () => void) => {
    if (protectedRef.current) {
      // R-4.1 — a countdown that came due while the reply is being read must not
      // complete; it is run when protection ends (R-4.2).
      deferredClearRef.current = clear;
      return;
    }
    clear();
  }, []);

  const reset = useCallback(() => {
    clearGraceTimer();
    sourcesRef.current.clear();
    deferredClearRef.current = null;
    if (!protectedRef.current) return;
    protectedRef.current = false;
    setIsProtected(false);
  }, [clearGraceTimer]);

  // Never leave a timer or a stashed clear behind on unmount.
  useEffect(() => () => {
    clearGraceTimer();
    sourcesRef.current.clear();
    deferredClearRef.current = null;
    protectedRef.current = false;
  }, [clearGraceTimer]);

  return useMemo<ReplyProtection>(() => ({
    protectedRef,
    protected: isProtected,
    enter,
    leave,
    clearOrDefer,
    reset,
  }), [isProtected, enter, leave, clearOrDefer, reset]);
}
