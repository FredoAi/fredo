/**
 * useCompanionReadiness — probes the backend `check_companion_readiness`
 * command, exposes each prerequisite's honest state, and runs a step's action
 * (`install_llama_cpp` / `download_model`) followed by an in-session re-probe
 * (AC-3) with NO app reload.
 *
 * Fail closed: a dev/absent host (`adapterBridge.invoke` → `undefined`) maps
 * every prerequisite to `error` and `ready:false` — `installed`/`present` is
 * never fabricated. The backend is the single source of truth; there is no cache.
 *
 * #2856 model files: `check_model_files` supplies the per-file status; while a
 * `download_model` run is in flight the existing `setup:download-progress`
 * channel is subscribed and its per-file updates merged onto the status by
 * `fileId`. Progress is derived with a monotonic merge (Bug #523 — no effect is
 * keyed on a changing `.length` or a fresh object).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../../utils/adapterBridge';
import { COMPANION_SETUP_STEPS } from './companionSetupSteps';
import {
  deriveServerLaunchState,
  llamaServerEndpoint,
  serverLaunchFailureCopy,
  type CompanionReadiness,
  type CompanionServerLaunchInfo,
  type LlamaCppInstallResult,
  type LlamaServerLaunchCode,
  type LlamaServerLaunchResult,
  type LlamaServerStatus,
  type LlamaServerStatusEvent,
  type ModelDownloadProgress,
  type ModelDownloadResult,
  type ModelFileId,
  type ModelFileState,
  type ModelFilesStatus,
  type PrerequisiteId,
  type PrerequisiteReport,
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
  /** Per-file model status (model/vision/mtp), merged with live progress. */
  modelFiles: ModelFilesStatus | null;
  /**
   * #2857 server launch snapshot — null when the backend status command is
   * unavailable (then the wizard just renders the backend's own prerequisite set).
   */
  serverLaunch: CompanionServerLaunchInfo | null;
}

/**
 * Module-scoped one-shot guard (AGENTS.md: refs reset on mount — use module
 * state for anything that must survive a close/reopen cycle). Once a launch has
 * been auto-attempted, it is NEVER auto-retried; a failure stays `failed` until
 * the user presses Retry (no restart loop).
 */
let autoLaunchAttempted = false;

/** Test seam for the module-scoped one-shot auto-launch guard. */
export function resetCompanionAutoLaunchGuard(): void {
  autoLaunchAttempted = false;
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

const MODEL_FILE_IDS: readonly ModelFileId[] = ['model', 'vision', 'mtp'];

function isModelFileId(value: unknown): value is ModelFileId {
  return typeof value === 'string' && (MODEL_FILE_IDS as readonly string[]).includes(value);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

function clampBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Live progress for one file, merged onto the backend probe by `fileId`. */
interface ModelFileProgress {
  downloadedBytes: number;
  expectedBytes: number;
  percent: number;
  state: ModelFileState;
}

/**
 * Merge live progress onto the backend per-file status (progress wins while the
 * transfer is in flight). `complete` is re-derived from the merged files so a
 * partial/in-flight set can never read complete.
 */
function mergeModelFiles(
  base: ModelFilesStatus | null,
  progress: Partial<Record<ModelFileId, ModelFileProgress>>,
): ModelFilesStatus | null {
  if (!base) return null;
  const files = base.files.map((file) => {
    const live = progress[file.id];
    if (!live) return file;
    switch (live.state) {
      case 'downloading':
        return {
          ...file,
          state: 'downloading' as const,
          downloadedBytes: live.downloadedBytes,
          expectedBytes: live.expectedBytes > 0 ? live.expectedBytes : file.expectedBytes,
        };
      case 'present':
        return {
          ...file,
          state: 'present' as const,
          downloadedBytes: live.expectedBytes > 0 ? live.expectedBytes : file.expectedBytes,
        };
      case 'error':
        return {
          ...file,
          state: 'error' as const,
          detail: file.detail ?? 'Download failed — choose Retry.',
        };
      default:
        // `skipped` — the backend left a verified-present file untouched.
        return { ...file, state: 'present' as const };
    }
  });
  const complete = files.length > 0 && files.every((file) => file.state === 'present');
  return { ...base, complete, files };
}

/** Extract the authoritative final per-file status from a download result. */
function filesFromResult(result: ModelDownloadResult): ModelFilesStatus | null {
  if (!Array.isArray(result.files) || result.files.length === 0) return null;
  return {
    complete: result.files.every((file) => file.state === 'present'),
    files: result.files,
  };
}

export function useCompanionReadiness(): UseCompanionReadinessResult {
  const [backendReadiness, setBackendReadiness] = useState<CompanionReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningActionId, setRunningActionId] = useState<PrerequisiteId | null>(null);
  const [actionError, setActionError] = useState<Partial<Record<PrerequisiteId, string>>>(
    {},
  );
  const [baseModelFiles, setBaseModelFiles] = useState<ModelFilesStatus | null>(null);
  const [progressByFile, setProgressByFile] = useState<
    Partial<Record<ModelFileId, ModelFileProgress>>
  >({});
  // #2857 — server launch composition (the backend readiness command stays 2-prereq).
  const [serverStatus, setServerStatus] = useState<LlamaServerStatus | null>(null);
  const [serverStatusAvailable, setServerStatusAvailable] = useState(false);
  const [serverLaunchError, setServerLaunchError] = useState<{
    code: LlamaServerLaunchCode | null;
    detail: string | null;
  } | null>(null);
  const [serverExited, setServerExited] = useState(false);

  // Synchronous re-entrancy guard: a second activation before React re-renders
  // must NOT start a second install/download (REQ-7).
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const unlistenRef = useRef<(() => void) | undefined>(undefined);
  // The exit event is the authoritative "was healthy, now gone" trigger.
  const wasHealthyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unlistenRef.current?.();
      unlistenRef.current = undefined;
    };
  }, []);

  const probeReadiness = useCallback(async (showChecking: boolean) => {
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
        setBackendReadiness(result);
        setError(null);
      } else {
        setBackendReadiness(failClosedReadiness(FAIL_CLOSED_DETAIL));
        setError(FAIL_CLOSED_DETAIL);
      }
    } catch (err) {
      if (mountedRef.current) {
        setBackendReadiness(failClosedReadiness(FAIL_CLOSED_DETAIL));
        setError(String(err));
      }
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  /**
   * Probe the managed server. A missing/unknown-shaped result (dev host, or a
   * backend without #2857) leaves `serverLaunch` un-composed so the wizard simply
   * renders the backend's own prerequisite set — no fabricated health.
   */
  const probeServerStatus = useCallback(async () => {
    try {
      const status = await adapterBridge.invoke<LlamaServerStatus>(
        'get_llama_server_status',
      );
      if (!mountedRef.current) return;
      if (
        status &&
        typeof status.running === 'boolean' &&
        typeof status.healthy === 'boolean'
      ) {
        setServerStatus(status);
        setServerStatusAvailable(true);
        if (status.healthy) {
          wasHealthyRef.current = true;
          setServerExited(false);
          setServerLaunchError(null);
        } else if (wasHealthyRef.current && !status.running) {
          // A server that was healthy is no longer running → lifecycle `exited`.
          setServerExited(true);
        }
      } else {
        setServerStatus(null);
        setServerStatusAvailable(false);
      }
    } catch {
      if (mountedRef.current) {
        setServerStatus(null);
        setServerStatusAvailable(false);
      }
    }
  }, []);

  const probeModelFiles = useCallback(async () => {
    try {
      const result = await adapterBridge.invoke<ModelFilesStatus>('check_model_files');
      if (!mountedRef.current) return;
      if (result && Array.isArray(result.files) && result.files.length > 0) {
        setBaseModelFiles(result);
      } else {
        // Backend unavailable, or a pre-#2856 shape without per-file status —
        // fail closed: no per-file `present` can be fabricated.
        setBaseModelFiles(null);
      }
    } catch {
      if (mountedRef.current) setBaseModelFiles(null);
    }
  }, []);

  const refreshInternal = useCallback(
    async (showChecking: boolean) => {
      await Promise.all([
        probeReadiness(showChecking),
        probeModelFiles(),
        probeServerStatus(),
      ]);
    },
    [probeReadiness, probeModelFiles, probeServerStatus],
  );

  const refresh = useCallback(() => refreshInternal(true), [refreshInternal]);

  useEffect(() => {
    void refreshInternal(true);
  }, [refreshInternal]);

  // Exit event (ST-3/ST-7): re-probe immediately when the managed child exits.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const un = await adapterBridge.listen<LlamaServerStatusEvent>(
        'llama-server-status',
        () => {
          if (!mountedRef.current) return;
          if (wasHealthyRef.current) setServerExited(true);
          void probeServerStatus();
        },
      );
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [probeServerStatus]);

  const stopProgressListener = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = undefined;
  }, []);

  const startProgressListener = useCallback(async () => {
    stopProgressListener();
    const unlisten = await adapterBridge.listen<ModelDownloadProgress>(
      'setup:download-progress',
      (payload) => {
        if (!mountedRef.current) return;
        const fileId = payload?.fileId;
        if (!isModelFileId(fileId)) return;
        const state: ModelFileState =
          payload.state === 'error'
            ? 'error'
            : payload.state === 'downloading'
              ? 'downloading'
              : 'present';
        setProgressByFile((prev) => ({
          ...prev,
          [fileId]: {
            downloadedBytes: clampBytes(payload.downloaded),
            expectedBytes: clampBytes(payload.total),
            percent: clampPercent(payload.percent),
            state,
          },
        }));
      },
    );
    unlistenRef.current = unlisten;
  }, [stopProgressListener]);

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

      let modelResult: ModelDownloadResult | null = null;

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
        } else if (step.action.command === 'download_model') {
          // Subscribe BEFORE the command so no early chunk is lost (#2856).
          setProgressByFile({});
          await startProgressListener();
          modelResult =
            (await adapterBridge.invoke<ModelDownloadResult>('download_model')) ?? null;
          if (!modelResult || modelResult.success !== true) {
            if (mountedRef.current) {
              setActionError((prev) => ({
                ...prev,
                [id]:
                  modelResult?.error ??
                  'The download did not complete. Choose Retry or Re-check.',
              }));
            }
          }
          stopProgressListener();
        } else if (step.action.command === 'launch_llama_server') {
          const result =
            (await adapterBridge.invoke<LlamaServerLaunchResult>(
              'launch_llama_server',
            )) ?? null;
          if (!result || result.success !== true) {
            const code = result?.code ?? null;
            const port = result?.port ?? null;
            const rawDetail = result?.error ?? result?.detail ?? null;
            const message = serverLaunchFailureCopy(code, llamaServerEndpoint(port));
            if (mountedRef.current) {
              setServerLaunchError({ code, detail: rawDetail ?? message });
              setActionError((prev) => ({ ...prev, [id]: message }));
            }
          } else if (mountedRef.current) {
            // A successful launch clears any prior failure; the follow-up status
            // probe confirms `healthy`.
            setServerLaunchError(null);
            setServerExited(false);
            wasHealthyRef.current = true;
          }
        }
      } catch (err) {
        if (mountedRef.current) {
          setActionError((prev) => ({ ...prev, [id]: String(err) }));
        }
        stopProgressListener();
      } finally {
        if (modelResult) {
          const nextFiles = filesFromResult(modelResult);
          if (nextFiles) {
            // The final per-file status is authoritative (it carries the error
            // detail for a failed file). Only re-probe the coarse readiness gate
            // so a disk-derived `missing` cannot erase the error state (AC5).
            if (mountedRef.current) {
              setBaseModelFiles(nextFiles);
              setProgressByFile({});
            }
            await probeReadiness(false);
          } else {
            await refreshInternal(false);
          }
        } else {
          // Re-probe in place (AC-3) while the row keeps its running state, so a
          // successful action flips state with no reload.
          await refreshInternal(false);
        }
        stopProgressListener();
        runningRef.current = false;
        if (mountedRef.current) setRunningActionId(null);
      }
    },
    [refreshInternal, probeReadiness, startProgressListener, stopProgressListener],
  );

  const modelFiles = useMemo(
    () => mergeModelFiles(baseModelFiles, progressByFile),
    [baseModelFiles, progressByFile],
  );

  // #2857 — compose the third prerequisite from the managed-server status.
  const serverLaunch = useMemo<CompanionServerLaunchInfo | null>(() => {
    if (!serverStatusAvailable) return null;
    const state = deriveServerLaunchState({
      launching: runningActionId === 'serverLaunch',
      error: serverLaunchError !== null || actionError.serverLaunch !== undefined,
      status: serverStatus,
      exited: serverExited,
    });
    return {
      state,
      port: serverStatus?.port ?? null,
      configPath: serverStatus?.configPath ?? null,
      code: serverLaunchError?.code ?? null,
      detail: serverLaunchError?.detail ?? serverStatus?.lastError ?? null,
    };
  }, [
    serverStatusAvailable,
    serverStatus,
    serverLaunchError,
    serverExited,
    runningActionId,
    actionError,
  ]);

  // The overall ready gate: backend readiness AND a healthy managed server.
  // When the status command is unavailable the backend's own set is authoritative
  // (no fabricated server health, no cross-feature import).
  const readiness = useMemo<CompanionReadiness | null>(() => {
    if (!backendReadiness) return null;
    if (!serverLaunch) return backendReadiness;
    const serverState = serverLaunch.state;
    const report: PrerequisiteReport = {
      id: 'serverLaunch',
      state:
        serverState === 'healthy'
          ? 'installed'
          : serverState === 'failed' || serverState === 'exited'
            ? 'error'
            : 'missing',
      detail:
        serverState === 'healthy'
          ? (serverLaunch.configPath ?? serverLaunch.detail ?? '')
          : (serverLaunch.detail ?? ''),
      resolvedPath: serverLaunch.configPath,
    };
    const prerequisites = [
      ...backendReadiness.prerequisites.filter((p) => p.id !== 'serverLaunch'),
      report,
    ];
    return {
      ready: backendReadiness.ready && serverState === 'healthy',
      prerequisites,
    };
  }, [backendReadiness, serverLaunch]);

  // Auto-invoke ONCE when both provisioning steps are installed and the server is
  // not running. The module-scoped guard (survives wizard close/reopen) makes this
  // a true one-shot: a failure stays `failed` until the user presses Retry.
  useEffect(() => {
    if (checking) return;
    if (runningRef.current) return;
    if (autoLaunchAttempted) return;
    if (!backendReadiness?.ready) return;
    if (!serverLaunch || serverLaunch.state !== 'notRunning') return;
    autoLaunchAttempted = true;
    void runAction('serverLaunch');
  }, [checking, backendReadiness, serverLaunch, runAction]);

  return useMemo(
    () => ({
      readiness,
      checking,
      error,
      refresh,
      runAction,
      runningActionId,
      actionError,
      modelFiles,
      serverLaunch,
    }),
    [
      readiness,
      checking,
      error,
      refresh,
      runAction,
      runningActionId,
      actionError,
      modelFiles,
      serverLaunch,
    ],
  );
}
