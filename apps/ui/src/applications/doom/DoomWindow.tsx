import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  Progress,
  Spinner,
  Text,
  VisuallyHidden,
} from '@chakra-ui/react';
import { LuRefreshCw, LuTriangleAlert } from 'react-icons/lu';
import { adapterBridge } from '../../shared/utils/adapterBridge';
import { tint } from '../../shared/utils/colorTint';
import { isDoomModeEngaged, useDoomMode } from '../../shared/doom-mode';
import {
  DOOM_AUTOPLAY_EVENT,
  DOOM_AUTOPLAY_IDLE_STATUS,
  DOOM_FRAME_POLL_MS,
  DOOM_READY_TIMEOUT_S,
  describeDoomFrame,
  doomAutoplayErrorMessage,
  doomErrorMessage,
  truncateAutoplayError,
  type DoomAutoplayResult,
  type DoomAutoplayStatus,
  type DoomErrorCode,
  type DoomFrame,
  type DoomLaunchResult,
  type DoomRuntimePhase,
  type DoomStateView,
  type DoomStatusEvent,
} from './types';

/**
 * DoomWindow — the dedicated `doom` webview (Spec #2968 CU-4/ST-6; game-only
 * surface per Spec #3007 ST-1).
 *
 * Rendered by `Router` for the `index.html?view=doom` route, opened by the Rust
 * `open_doom_window` singleton. It is the ONLY place the runtime is started: on
 * mount it registers the `doom-status-changed` listener and the autoplay
 * listener BEFORE the first call, then invokes `launch_doom_runtime`
 * (idempotent). On success it starts the 66 ms `doom_frame` loop and reads the
 * state; on failure it renders the typed `DoomErrorCode` message.
 *
 * THE SURFACE IS THE GAME AND NOTHING ELSE (Spec #3007 AC1): the header, the
 * footer/data panel, and every in-window control are deleted. Only the frame
 * region (canvas + VisuallyHidden desc) and the minimal transient states
 * (`starting`/`stopping`/reconnecting/typed error) remain, plus a single
 * unobtrusive top-right autoplay-failure note (AC5).
 *
 * AUTO-PLAY (Spec #3007 R-3): once the runtime is `ready` while the mode is
 * engaged, and the autoplay run is neither active nor `completed`, the window
 * invokes the SAME idempotent `start_doom_autoplay` (resume-by-default — never a
 * `freshStart`). `DoomAutoplayState::try_begin` guards a double loop, so this is
 * a repair, never a second control path.
 *
 * Teardown is RUST-owned: the `CloseRequested` handler wired in
 * `open_doom_window` (now `teardown_doom_on_window_close`) drives the bounded
 * stop. The React layer NEVER calls `stop_doom_runtime`; a StrictMode unmount
 * would double-stop. The native close registration only releases UI resources
 * (the frame loop + listeners).
 */
export const DoomWindow: React.FC = () => {
  const [phase, setPhase] = useState<DoomRuntimePhase>('idle');
  const [errorCode, setErrorCode] = useState<DoomErrorCode | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [stateRaw, setStateRaw] = useState<unknown>(null);
  const [frameError, setFrameError] = useState(false);
  const [startElapsed, setStartElapsed] = useState(0);
  // ── Autoplay (Spec #2969 ST-7; entry guarantee Spec #3007 R-3) ──────────────
  // The Rust loop outlives the webview, so this status is seeded on mount from
  // `get_doom_autoplay_status` and thereafter driven SOLELY by the
  // `doom-autoplay-changed` event (no polling). `autoplayHydrated` gates the
  // repair effect until the seed has settled, so a run already in flight is never
  // raced by a redundant start.
  const [autoplayStatus, setAutoplayStatus] =
    useState<DoomAutoplayStatus>(DOOM_AUTOPLAY_IDLE_STATUS);
  const [autoplayHydrated, setAutoplayHydrated] = useState(false);

  // Spec #2970 ST-6 — the Doom Mode lifecycle phase. The R-3 repair only fires
  // while the mode is engaged (a direct `?view=doom` route with no mode must not
  // start a run).
  const { status: doomModeStatus } = useDoomMode();
  const doomPhase = doomModeStatus.phase;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameImageRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  // Within-mount guards: `autoplayEventSeenRef` is the first-wins hydration guard
  // (an event already seen must not be clobbered by the mount seed);
  // `autoplayRepairAttemptedRef` makes the R-3 repair fire at most ONCE per
  // `ready` episode (reset when the phase leaves `ready`, so an explicit Retry
  // resumes play, while a failed run is never auto-retried in a loop).
  const autoplayEventSeenRef = useRef(false);
  const autoplayRepairAttemptedRef = useRef(false);

  // ── Frame drawing (canvas, letterboxed, pixelated) ─────────────────────────
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const image = lastFrameImageRef.current;
    if (!canvas || !image || !image.naturalWidth || !image.naturalHeight) return;
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }, []);

  const schedulePaint = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  const drawFrame = useCallback(
    (pngBase64: string) => {
      const image = new Image();
      image.onload = () => {
        lastFrameImageRef.current = image;
        setFrameError(false);
        schedulePaint();
      };
      image.onerror = () => {
        // Dropped frame: keep the LAST drawn frame and flag a transient note.
        setFrameError(true);
      };
      image.src = `data:image/png;base64,${pngBase64}`;
    },
    [schedulePaint],
  );

  const pollFrame = useCallback(async () => {
    try {
      const frame = await adapterBridge.invoke<DoomFrame>('doom_frame');
      if (!frame || typeof frame.pngBase64 !== 'string' || frame.pngBase64.length === 0) {
        setFrameError(true);
        return;
      }
      drawFrame(frame.pngBase64);
    } catch {
      // Never blank the canvas — degrade to the last frame + reconnecting note.
      // A `frameNotReady` (HTTP 503 "graphics not up yet") is deliberately treated
      // here as transient: the 66 ms interval keeps polling and the window never
      // enters the `error` phase (R-1.4).
      setFrameError(true);
    }
  }, [drawFrame]);

  // ── State read (feeds the VisuallyHidden frame description only) ────────────
  const refreshState = useCallback(async () => {
    try {
      const view = await adapterBridge.invoke<DoomStateView>('doom_read_state');
      if (view && typeof view === 'object' && 'raw' in view) {
        setStateRaw((view as DoomStateView).raw);
      }
    } catch (err) {
      setPhase('error');
      setErrorCode('requestFailed');
      setLastError(String(err));
    }
  }, []);

  // ── Launch (idempotent; also the retry action) ──────────────────────────────
  const launch = useCallback(async () => {
    setErrorCode(null);
    setLastError(null);
    setPhase('starting');
    try {
      const result = await adapterBridge.invoke<DoomLaunchResult>('launch_doom_runtime');
      if (result?.success) {
        setPhase('ready');
        void refreshState();
      } else {
        setPhase('error');
        setErrorCode(result?.code ?? 'spawnFailed');
        setLastError(result?.error ?? null);
      }
    } catch (err) {
      setPhase('error');
      setErrorCode('requestFailed');
      setLastError(String(err));
    }
  }, [refreshState]);

  const applyStatus = useCallback((event: DoomStatusEvent) => {
    if (!event || !event.phase) return;
    setPhase(event.phase);
    setLastError(event.lastError ?? null);
    setErrorCode(event.code ?? null);
  }, []);

  const applyAutoplayFailure = useCallback(
    (code: DoomAutoplayResult['code'], detail: string | null, steps?: number) => {
      setAutoplayStatus((prev) => ({
        ...prev,
        phase: 'failed',
        running: false,
        steps: typeof steps === 'number' ? steps : prev.steps,
        code: code ?? 'notReady',
        lastError: detail,
      }));
    },
    [],
  );

  // ── Mount: register BEFORE the first call, then launch ──────────────────────
  useEffect(() => {
    autoplayEventSeenRef.current = false;
    let cancelled = false;
    const unlisteners: Array<Promise<() => void>> = [];

    // 1. The status listener MUST be live before `launch_doom_runtime` emits.
    unlisteners.push(
      adapterBridge.listen<DoomStatusEvent>('doom-status-changed', (event) => {
        if (cancelled) return;
        applyStatus(event);
      }),
    );
    // 1a. The autoplay listener MUST be live before the hydration seed, so an
    // event that races the seed wins (first-wins guard).
    unlisteners.push(
      adapterBridge.listen<DoomAutoplayStatus>(DOOM_AUTOPLAY_EVENT, (event) => {
        if (cancelled) return;
        if (!event || !event.phase) return;
        autoplayEventSeenRef.current = true;
        setAutoplayStatus(event);
      }),
    );
    // 1b. Native close is intentionally NOT intercepted here. The `doom` window
    // registers no JS close listener and closes through Tauri's default native
    // path; engine/agent teardown is Rust-owned (`CloseRequested` in
    // `open_doom_window` → `teardown_doom_on_window_close`). The React layer MUST
    // NOT call `stop_doom_runtime`. UI resources are released by this effect's
    // cleanup.

    // 2. Idempotent launch — only after the listeners are registered.
    void Promise.all(unlisteners).then(() => {
      if (cancelled) return;
      void launch();
      // 3. Hydrate the autoplay status: the loop outlives the webview, so a
      // freshly-opened window reflects a run already in flight. First-wins — a
      // `doom-autoplay-changed` event that already arrived is never clobbered.
      // `autoplayHydrated` gates the repair effect until this seed settles.
      void adapterBridge
        .invoke<DoomAutoplayStatus>('get_doom_autoplay_status')
        .then((status) => {
          if (cancelled || autoplayEventSeenRef.current) return;
          if (status && typeof status === 'object' && 'phase' in status) {
            setAutoplayStatus(status);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setAutoplayHydrated(true);
        });
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((pending) => pending.then((fn) => fn()).catch(() => {}));
      if (frameTimerRef.current !== null) {
        window.clearInterval(frameTimerRef.current);
        frameTimerRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [applyStatus, launch]);

  // ── Frame loop: only while `ready`; torn down on any phase change/unmount ───
  useEffect(() => {
    if (phase !== 'ready') return;
    void pollFrame();
    const id = window.setInterval(() => {
      void pollFrame();
    }, DOOM_FRAME_POLL_MS);
    frameTimerRef.current = id;
    return () => {
      window.clearInterval(id);
      if (frameTimerRef.current === id) frameTimerRef.current = null;
    };
  }, [phase, pollFrame]);

  // ── Determinate `starting` progress, bounded by DOOM_READY_TIMEOUT_S ────────
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'idle') {
      setStartElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setStartElapsed(Math.min((Date.now() - startedAt) / 1000, DOOM_READY_TIMEOUT_S));
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // ── Auto-play guarantee (Spec #3007 R-3.b/R-3.c) ────────────────────────────
  // Once `ready` while the mode is engaged and the run is neither active nor
  // `completed`, invoke the SAME idempotent `start_doom_autoplay` with NO
  // `freshStart` (resume-by-default). Guarded to one attempt per `ready` episode
  // so a failed run is never auto-retried in a loop; an explicit Retry leaves
  // `ready`, resetting the guard, and the next `ready` resumes play.
  useEffect(() => {
    if (phase !== 'ready') {
      autoplayRepairAttemptedRef.current = false;
      return;
    }
    if (!isDoomModeEngaged(doomPhase)) return;
    const active = autoplayStatus.phase === 'running' || autoplayStatus.phase === 'stopping';
    if (!autoplayHydrated || active || autoplayStatus.phase === 'completed') return;
    if (autoplayRepairAttemptedRef.current) return;
    autoplayRepairAttemptedRef.current = true;
    void (async () => {
      try {
        const result = await adapterBridge.invoke<DoomAutoplayResult>('start_doom_autoplay');
        if (result && result.success === false) {
          applyAutoplayFailure(result.code, result.error, result.steps);
        }
      } catch (err) {
        applyAutoplayFailure('engineRequestFailed', String(err));
      }
    })();
  }, [phase, doomPhase, autoplayHydrated, autoplayStatus.phase, applyAutoplayFailure]);

  const frameDescription = useMemo(() => describeDoomFrame(phase, stateRaw), [phase, stateRaw]);
  const error = useMemo(() => doomErrorMessage(errorCode), [errorCode]);
  const progressValue = Math.min((startElapsed / DOOM_READY_TIMEOUT_S) * 100, 100);
  const autoplayError = useMemo(
    () => doomAutoplayErrorMessage(autoplayStatus.code),
    [autoplayStatus.code],
  );
  const autoplayErrorDetail = truncateAutoplayError(autoplayStatus.lastError);

  return (
    <Flex
      data-testid="doom-root"
      direction="column"
      h="100vh"
      w="100vw"
      bg="bg.canvas"
      color="fg.default"
      overflow="hidden"
    >
      {/* The frame region is the ONLY in-flow child of doom-root (G-273). */}
      <Box position="relative" flex={1} minH={0} bg="bg.canvas" overflow="hidden">
        <canvas
          ref={canvasRef}
          data-testid="doom-frame-canvas"
          role="img"
          aria-label="Doom game view"
          aria-describedby="doom-frame-desc"
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
        <VisuallyHidden>
          <Text id="doom-frame-desc" data-testid="doom-frame-desc">
            {frameDescription}
          </Text>
        </VisuallyHidden>

        {/* Idle collapses into Starting: the window auto-launches on mount, so
            there is never a start control (AC1) nor a black void (R-1.b). */}
        {(phase === 'idle' || phase === 'starting') && (
          <Center role="status" aria-live="polite" aria-atomic="true">
            <Flex direction="column" align="center" gap={3} width="240px">
              <HStack gap={2}>
                <Spinner size="sm" color="accent.default" />
                <Text fontSize="sm" color="fg.muted" fontFamily="mono">
                  Starting…
                </Text>
              </HStack>
              <Progress.Root value={progressValue} size="xs" width="100%">
                <Progress.Track>
                  <Progress.Range />
                </Progress.Track>
              </Progress.Root>
            </Flex>
          </Center>
        )}

        {phase === 'stopping' && (
          <Center role="status" aria-live="polite" aria-atomic="true">
            <HStack gap={2}>
              <Spinner size="sm" color="fg.muted" />
              <Text fontSize="sm" color="fg.muted" fontFamily="mono">
                Stopping…
              </Text>
            </HStack>
          </Center>
        )}

        {phase === 'error' && (
          <Center>
            <Box
              data-testid="doom-error"
              role="alert"
              maxW="420px"
              mx={4}
              p={4}
              borderRadius="md"
              borderWidth="1px"
              borderColor="status.error"
              bg={tint('var(--status-error)', 8)}
            >
              <HStack gap={2} align="flex-start">
                <Icon
                  as={LuTriangleAlert}
                  boxSize="16px"
                  color="status.error"
                  mt="2px"
                  flexShrink={0}
                  aria-hidden
                />
                <Box minW={0}>
                  <Text fontSize="sm" fontWeight="semibold" color="status.error">
                    {error.title}
                  </Text>
                  <Text fontSize="xs" color="fg.default" mt={1} lineHeight="1.4">
                    {error.message}
                  </Text>
                  {lastError && (
                    <Text
                      fontSize="xs"
                      color="fg.muted"
                      fontFamily="mono"
                      mt={2}
                      title={lastError}
                      truncate
                    >
                      {lastError}
                    </Text>
                  )}
                  <Button
                    data-testid="doom-retry-button"
                    mt={3}
                    size="sm"
                    variant="outline"
                    onClick={() => void launch()}
                  >
                    <Icon as={LuRefreshCw} boxSize="14px" mr={1} aria-hidden />
                    Retry
                  </Button>
                </Box>
              </HStack>
            </Box>
          </Center>
        )}

        {/* ONE absolute top-right transient-note column — pointerEvents none, so
            neither note ever reflows the canvas or steals interaction (G-273). */}
        <Flex
          position="absolute"
          top={3}
          right={3}
          direction="column"
          align="flex-end"
          gap={2}
          pointerEvents="none"
        >
          {frameError && phase === 'ready' && (
            <Box
              px={2}
              py={1}
              borderRadius="sm"
              bg="bg.surface"
              borderWidth="1px"
              borderColor="border.default"
            >
              <Text
                data-testid="doom-frame-reconnecting"
                role="status"
                aria-live="polite"
                fontSize="xs"
                color="fg.muted"
                fontFamily="mono"
              >
                Reconnecting…
              </Text>
            </Box>
          )}
          {autoplayStatus.phase === 'failed' && (
            <Box
              data-testid="doom-autoplay-note"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              maxW="280px"
              p="6px 8px"
              borderRadius="sm"
              bg="bg.surface"
              borderWidth="1px"
              borderColor="border.default"
            >
              <Text fontSize="xs" fontWeight="semibold" color="fg.default">
                {autoplayError.title}
              </Text>
              {autoplayErrorDetail && (
                <Text
                  fontSize="xs"
                  color="fg.muted"
                  fontFamily="mono"
                  truncate
                  title={autoplayStatus.lastError ?? undefined}
                >
                  {autoplayErrorDetail}
                </Text>
              )}
            </Box>
          )}
        </Flex>
      </Box>
    </Flex>
  );
};

/** A centered absolute overlay that never reflows the frame region. */
const Center: React.FC<React.ComponentProps<typeof Flex>> = (props) => (
  <Flex position="absolute" inset={0} align="center" justify="center" pointerEvents="auto" {...props} />
);

/**
 * The `doom` window deliberately registers NO JS `onCloseRequested` handler.
 *
 * `@tauri-apps/api`'s `onCloseRequested` wrapper auto-invokes
 * `getCurrentWindow().destroy()` when the handler does not `preventDefault()`;
 * `destroy` requires `core:window:allow-destroy`, which the `doom` window's
 * capability does not grant, so the invoke is ACL-denied and the window never
 * closes. The working `terminal` window registers no JS close listener and
 * closes through Tauri's default native path — `doom` mirrors that. Engine and
 * agent teardown stays Rust-owned via the `CloseRequested` handler wired in
 * `open_doom_window` (`applications/doom/commands.rs`), so the React layer MUST
 * NOT intercept the close or call `stop_doom_runtime`.
 */

export default DoomWindow;
