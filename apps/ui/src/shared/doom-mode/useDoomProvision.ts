/**
 * useDoomProvision — the frontend controller for Doom engine first-use
 * provisioning (Spec #3012, ST-4).
 *
 * It drives the sequence the plan mandates:
 *
 *   seed `get_doom_provision_status` → dialog when `needsInstallDir` →
 *   `provision_doom_engine` → subscribe `doom-provision-progress` (registered
 *   BEFORE the invoke) → on `ready` call the EXISTING `enter_doom_mode`
 *   (`onReady`), with the status command as the poll fallback.
 *
 * One hook serves both hosts: the `Home` `iddqd` flow (`mode: 'provision'`) and
 * the post-activation in-window "Engine location" affordance
 * (`mode: 'relocate'`), which persists `doom_install_dir` ONLY — the rebuild
 * happens on the NEXT activation (R-4.4), never in place while a session is
 * active. The presentational `DoomProvisionDialog` consumes the controller this
 * hook returns.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import {
  DOOM_PROVISION_EVENT,
  DOOM_PROVISION_IDLE_STATUS,
  DOOM_PROVISION_INSTALL_DIR_KEY,
  DOOM_PROVISION_READY_FLASH_MS,
  doomProvisionDir,
  type DoomProvisionResult,
  type DoomProvisionStatus,
} from './provision';

/** The dialog surface derived from the phase (+ explicit checking/retry states). */
export type DoomProvisionView = 'checking' | 'form' | 'progress' | 'ready' | 'result';

/**
 * The presentational contract `DoomProvisionDialog` consumes. A host renders the
 * dialog with the controller returned by {@link useDoomProvision}.
 */
export interface DoomProvisionDialogController {
  /** Whether the dialog is mounted/open. */
  open: boolean;
  /** `provision` = first-use build; `relocate` = change the install dir only. */
  mode: 'provision' | 'relocate';
  /** Which sub-surface the dialog shows. */
  view: DoomProvisionView;
  /** The latest provisioning snapshot (the event is truth). */
  status: DoomProvisionStatus;
  /** The editable install-dir draft. */
  installDir: string;
  /** A start/save invoke is in flight. */
  submitting: boolean;
  /** Relocate mode: the install dir was persisted. */
  relocationSaved: boolean;
  /** Relocate mode: persisting the install dir failed. */
  relocationError: string | null;
  onInstallDirChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export interface UseDoomProvisionOptions {
  /** Called once provisioning reaches `ready` (the host enters Doom Mode). */
  onReady?: () => void;
  /** Relocate mode: persist the install dir only; never provision in place. */
  relocate?: boolean;
}

export interface UseDoomProvisionResult extends DoomProvisionDialogController {
  /** The `iddqd` entry point: seed + branch (staged → enter; else → dialog). */
  activate: () => void;
  /** Open the dialog to change the install dir (in-window, post-activation). */
  openRelocate: () => void;
}

const SEED_SPINNER_DELAY_MS = 300;
const POLL_INTERVAL_MS = 1000;

export function useDoomProvision(options: UseDoomProvisionOptions = {}): UseDoomProvisionResult {
  const relocate = options.relocate === true;
  const mode: 'provision' | 'relocate' = relocate ? 'relocate' : 'provision';

  // The `onReady` callback is read through a ref so a re-render never rebuilds
  // the event listener (the shipped #523 loop guard).
  const onReadyRef = useRef<(() => void) | undefined>(options.onReady);
  useEffect(() => {
    onReadyRef.current = options.onReady;
  }, [options.onReady]);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DoomProvisionView>('checking');
  const [status, setStatus] = useState<DoomProvisionStatus>(DOOM_PROVISION_IDLE_STATUS);
  const [installDir, setInstallDir] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [relocationSaved, setRelocationSaved] = useState(false);
  const [relocationError, setRelocationError] = useState<string | null>(null);

  // Whether a real event has arrived for the current run (the poll fallback is
  // only consulted until the first event lands). A ref — never a re-render dep.
  const eventSeenRef = useRef(false);
  const readyTimerRef = useRef<number | null>(null);

  const applyStatus = useCallback((next: DoomProvisionStatus) => {
    setStatus(next);
    setView((current) => {
      if (current === 'checking') return current;
      switch (next.phase) {
        case 'awaitingInstallDir':
          return 'form';
        case 'downloadingToolchain':
        case 'building':
          return 'progress';
        case 'failed':
        case 'cancelled':
          return 'result';
        case 'ready':
          return 'ready';
        default:
          return current;
      }
    });
  }, []);

  // Every broadcast is latest-wins; `ready` closes the dialog after the flash
  // and hands off to the host's EXISTING `enterDoomMode('code')`.
  const applyEvent = useCallback(
    (next: DoomProvisionStatus) => {
      eventSeenRef.current = true;
      applyStatus(next);
      if (next.phase === 'ready') {
        setView('ready');
        if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current);
        readyTimerRef.current = window.setTimeout(() => {
          readyTimerRef.current = null;
          setOpen(false);
          onReadyRef.current?.();
        }, DOOM_PROVISION_READY_FLASH_MS);
      }
    },
    [applyStatus],
  );

  // Listener FIRST (mounted once, before any invoke). Relocate never provisions,
  // so it does not subscribe.
  useEffect(() => {
    if (relocate) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const off = await adapterBridge.listen<DoomProvisionStatus>(
        DOOM_PROVISION_EVENT,
        (payload) => {
          if (disposed || !payload) return;
          applyEvent(payload);
        },
      );
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [relocate, applyEvent]);

  // Mount seed: populate the install-dir draft / status for the relocate flow
  // (the provision flow re-seeds in `activate`).
  useEffect(() => {
    void adapterBridge
      .invoke<DoomProvisionStatus>('get_doom_provision_status')
      .then((seed) => {
        if (seed) applyStatus(seed);
      })
      .catch(() => {});
  }, [applyStatus]);

  // Poll fallback: only while a run is live AND no event has been seen.
  useEffect(() => {
    if (relocate || !open || view !== 'progress' || eventSeenRef.current) return;
    const id = window.setInterval(() => {
      void adapterBridge
        .invoke<DoomProvisionStatus>('get_doom_provision_status')
        .then((seed) => {
          if (seed) applyStatus(seed);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [relocate, open, view, applyStatus]);

  useEffect(
    () => () => {
      if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current);
    },
    [],
  );

  const startProvision = useCallback(async (dir: string) => {
    eventSeenRef.current = false;
    setSubmitting(true);
    setView('progress');
    try {
      const result = await adapterBridge.invoke<DoomProvisionResult>('provision_doom_engine', {
        installDir: dir,
      });
      if (result && result.success === false) {
        setStatus((prev) => ({
          ...prev,
          phase: 'failed',
          running: false,
          needsInstallDir: result.needsInstallDir,
          installDir: dir,
          code: result.code ?? 'installDirInvalid',
          lastError: result.error ?? null,
        }));
        setView('result');
      }
    } catch (error) {
      setStatus((prev) => ({
        ...prev,
        phase: 'failed',
        running: false,
        code: 'buildFailed',
        lastError: String(error),
      }));
      setView('result');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const activate = useCallback(() => {
    setRelocationSaved(false);
    setRelocationError(null);
    eventSeenRef.current = false;
    // The loading surface appears only if the seed is slow (> ~300 ms).
    const showTimer = window.setTimeout(() => {
      setView('checking');
      setOpen(true);
    }, SEED_SPINNER_DELAY_MS);
    void (async () => {
      try {
        const seed = await adapterBridge.invoke<DoomProvisionStatus>('get_doom_provision_status');
        window.clearTimeout(showTimer);
        if (!seed) {
          setView('form');
          setOpen(true);
          return;
        }
        applyStatus(seed);
        // A staged engine (enginePath set) skips provisioning entirely (R-3.1).
        if (seed.enginePath) {
          setOpen(false);
          onReadyRef.current?.();
          return;
        }
        if (seed.needsInstallDir) {
          setInstallDir(doomProvisionDir(seed));
          setView('form');
          setOpen(true);
          return;
        }
        const dir = doomProvisionDir(seed);
        setInstallDir(dir);
        setOpen(true);
        void startProvision(dir);
      } catch {
        window.clearTimeout(showTimer);
        setView('form');
        setOpen(true);
      }
    })();
  }, [applyStatus, startProvision]);

  const openRelocate = useCallback(() => {
    setRelocationSaved(false);
    setRelocationError(null);
    setView('form');
    setOpen(true);
    void (async () => {
      try {
        const seed = await adapterBridge.invoke<DoomProvisionStatus>('get_doom_provision_status');
        if (!seed) return;
        applyStatus(seed);
        setInstallDir(doomProvisionDir(seed));
      } catch {
        /* keep the current draft */
      }
    })();
  }, [applyStatus]);

  const confirm = useCallback(() => {
    const dir = installDir.trim();
    if (!dir || submitting) return;
    if (relocate) {
      setSubmitting(true);
      void adapterBridge
        .invoke('save_control_setting', { key: DOOM_PROVISION_INSTALL_DIR_KEY, value: dir })
        .then(() => {
          setRelocationSaved(true);
          setOpen(false);
        })
        .catch((error) => {
          setRelocationError(String(error));
        })
        .finally(() => {
          setSubmitting(false);
        });
      return;
    }
    void startProvision(dir);
  }, [installDir, relocate, startProvision, submitting]);

  const cancel = useCallback(() => {
    // While a build/download runs, Cancel is the ONLY cancel path (Escape is
    // inert) and it kills the child tree; otherwise Cancel just dismisses.
    if (!relocate && view === 'progress') {
      void adapterBridge.invoke('cancel_doom_engine_provisioning').catch(() => {});
      return;
    }
    setOpen(false);
  }, [relocate, view]);

  const retry = useCallback(() => {
    if (status.code === 'installDirInvalid') {
      setView('form');
      return;
    }
    const dir = installDir.trim() || doomProvisionDir(status);
    if (!dir) {
      setView('form');
      return;
    }
    void startProvision(dir);
  }, [installDir, startProvision, status]);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  return {
    open,
    mode,
    view,
    status,
    installDir,
    submitting,
    relocationSaved,
    relocationError,
    onInstallDirChange: setInstallDir,
    onConfirm: confirm,
    onCancel: cancel,
    onRetry: retry,
    onDismiss: dismiss,
    activate,
    openRelocate,
  };
}
