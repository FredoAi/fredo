/**
 * useCompanionReadiness — probes the backend `check_companion_readiness`
 * command, exposes each prerequisite's honest state, and runs a step's action
 * (`install_llama_cpp`) followed by an in-session re-probe (AC-3) with NO
 * app reload.
 *
 * Fail closed: a dev/absent host (`adapterBridge.invoke` → `undefined`) maps
 * every prerequisite to `error` and `ready:false` — `installed` is never
 * fabricated. The backend is the single source of truth; there is no cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../../utils/adapterBridge';
import { COMPANION_SETUP_STEPS } from './companionSetupSteps';
import type {
  CompanionReadiness,
  LlamaCppInstallResult,
  PrerequisiteId,
} from './companionReadiness';

export interface UseCompanionReadinessResult {
  /** null only while the very first probe is in flight. */
  readiness: CompanionReadiness | null;
  checking: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  runAction: (id: PrerequisiteId) => Promise<void>;
  runningActionId: PrerequisiteId | null;
  actionError: Partial<Record<PrerequisiteId, string>>;
}

const FAIL_CLOSED_DETAIL =
  'Could not determine readiness — the Fredo backend is unavailable.';

/** Fail-closed shape: every prerequisite unknown, `ready` never true. */
function failClosedReadiness(detail: string): CompanionReadiness {
  return {
    ready: false,
    prerequisites: COMPANION_SETUP_STEPS.map((step) => ({
      id: step.id,
      state: 'error' as const,
      detail,
      resolvedPath: null,
    })),
  };
}

export function useCompanionReadiness(): UseCompanionReadinessResult {
  const [readiness, setReadiness] = useState<CompanionReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningActionId, setRunningActionId] = useState<PrerequisiteId | null>(null);
  const [actionError, setActionError] = useState<Partial<Record<PrerequisiteId, string>>>(
    {},
  );

  // Synchronous re-entrancy guard: a second activation before React re-renders
  // must NOT start a second install (REQ-7).
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshInternal = useCallback(async (showChecking: boolean) => {
    if (showChecking) {
      if (mountedRef.current) setChecking(true);
      // A fresh probe supersedes any stale action error (Re-check is recovery).
      if (mountedRef.current) setActionError({});
    }
    try {
      const result = await adapterBridge.invoke<CompanionReadiness>(
        'check_companion_readiness',
      );
      if (!mountedRef.current) return;
      if (result && Array.isArray(result.prerequisites) && result.prerequisites.length > 0) {
        setReadiness(result);
        setError(null);
      } else {
        setReadiness(failClosedReadiness(FAIL_CLOSED_DETAIL));
        setError(FAIL_CLOSED_DETAIL);
      }
    } catch (err) {
      if (mountedRef.current) {
        setReadiness(failClosedReadiness(FAIL_CLOSED_DETAIL));
        setError(String(err));
      }
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  const refresh = useCallback(() => refreshInternal(true), [refreshInternal]);

  useEffect(() => {
    void refreshInternal(true);
  }, [refreshInternal]);

  const runAction = useCallback(
    async (id: PrerequisiteId) => {
      if (runningRef.current) return;
      const step = COMPANION_SETUP_STEPS.find((s) => s.id === id);
      if (!step?.action) return;

      runningRef.current = true;
      setRunningActionId(id);
      setActionError((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });

      try {
        if (step.action.command === 'install_llama_cpp') {
          const result = await adapterBridge.invoke<LlamaCppInstallResult>(
            'install_llama_cpp',
          );
          if (!result || result.success !== true) {
            if (mountedRef.current) {
              setActionError((prev) => ({
                ...prev,
                [id]:
                  result?.error ??
                  'The install did not complete. Choose Retry or Re-check.',
              }));
            }
          }
        } else {
          // Reserved metadata (#2856/#2857) — no action is wired this slice.
          if (mountedRef.current) {
            setActionError((prev) => ({
              ...prev,
              [id]: `${step.action?.label ?? 'This action'} is not available yet.`,
            }));
          }
        }
      } catch (err) {
        if (mountedRef.current) {
          setActionError((prev) => ({ ...prev, [id]: String(err) }));
        }
      } finally {
        // Re-probe in place (AC-3) while the row keeps its running state, so a
        // successful install flips to `installed` with no reload.
        await refreshInternal(false);
        runningRef.current = false;
        if (mountedRef.current) setRunningActionId(null);
      }
    },
    [refreshInternal],
  );

  return useMemo(
    () => ({
      readiness,
      checking,
      error,
      refresh,
      runAction,
      runningActionId,
      actionError,
    }),
    [readiness, checking, error, refresh, runAction, runningActionId, actionError],
  );
}
