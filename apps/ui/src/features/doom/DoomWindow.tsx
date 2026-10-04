import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Collapsible,
  Flex,
  HStack,
  Heading,
  Icon,
  Progress,
  Separator,
  Spinner,
  Text,
  VisuallyHidden,
} from '@chakra-ui/react';
import {
  LuGamepad2,
  LuPlay,
  LuRefreshCw,
  LuSquare,
  LuStepForward,
  LuTriangleAlert,
} from 'react-icons/lu';
import { adapterBridge } from '../../shared/utils/adapterBridge';
import { tint } from '../../shared/utils/colorTint';
import {
  DOOM_AUTOPLAY_EVENT,
  DOOM_AUTOPLAY_IDLE_STATUS,
  DOOM_FRAME_POLL_MS,
  DOOM_READY_TIMEOUT_S,
  describeDoomFrame,
  doomAutoplayErrorMessage,
  doomAutoplayStatusLine,
  doomErrorMessage,
  doomPhaseLabel,
  formatAutoplayElapsed,
  formatDoomState,
  truncateAutoplayError,
  type DoomAutoplayResult,
  type DoomAutoplayStatus,
  type DoomErrorCode,
  type DoomFrame,
  type DoomLaunchResult,
  type DoomRuntimePhase,
  type DoomStateView,
  type DoomStatusEvent,
  type DoomStepResult,
} from './types';

/**
 * DoomWindow — the dedicated `doom` webview (Spec #2968 CU-4/ST-6).
 *
 * Rendered by `Router` for the `index.html?view=doom` route, opened by the Rust
 * `open_doom_window` singleton. It is the ONLY place the runtime is started: on
 * mount it registers the `doom-status-changed` listener and the native-window
 * close registration BEFORE the first call, then invokes `launch_doom_runtime`
 * (idempotent). On success it starts the 66 ms `doom_frame` loop and reads the
 * state; on failure it renders the typed `DoomErrorCode` message.
 *
 * Teardown is RUST-owned: the `CloseRequested` handler wired in
 * `open_doom_window` drives the bounded stop. The React layer NEVER calls
 * `stop_doom_runtime` — a StrictMode unmount would double-stop. The native close
 * registration only releases UI resources (the frame loop + listeners).
 */
export const DoomWindow: React.FC = () => {
  const [phase, setPhase] = useState<DoomRuntimePhase>('idle');
  const [port, setPort] = useState<number | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<DoomErrorCode | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [stateRaw, setStateRaw] = useState<unknown>(null);
  const [stepBusy, setStepBusy] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [startElapsed, setStartElapsed] = useState(0);
  // ── Autoplay (Spec #2969, ST-7) ────────────────────────────────────────────
  // The Rust loop outlives the webview, so this status is seeded on mount from
  // `get_doom_autoplay_status` and thereafter driven SOLELY by the
  // `doom-autoplay-changed` event (no polling). Cross-mount state is never held
  // in a ref — the refs below are within-mount guards only.
  const [autoplayStatus, setAutoplayStatus] =
    useState<DoomAutoplayStatus>(DOOM_AUTOPLAY_IDLE_STATUS);
  const [autoplayBusy, setAutoplayBusy] = useState(false);
  const [autoplayNow, setAutoplayNow] = useState(() => Date.now());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameImageRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // AC-UI-9/AC-UI-10: within-mount guards. `autoplayEventSeenRef` is the
  // first-wins hydration guard (an event already seen must not be clobbered by
  // the mount seed); `autoplayBusyRef` is the synchronous re-entry guard (a
  // double-click must not fire two invokes before React re-renders).
  const autoplayEventSeenRef = useRef(false);
  const autoplayBusyRef = useRef(false);

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

  // ── State readout refresh ───────────────────────────────────────────────────
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

  // ── Launch (idempotent; also the start/retry action) ────────────────────────
  const launch = useCallback(async () => {
    setErrorCode(null);
    setLastError(null);
    setPhase('starting');
    try {
      const result = await adapterBridge.invoke<DoomLaunchResult>('launch_doom_runtime');
      if (result?.success) {
        setPhase('ready');
        setPort(result.port ?? null);
        setPid(result.pid ?? null);
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
    setPort(event.port ?? null);
    setPid(event.pid ?? null);
    setLastError(event.lastError ?? null);
    setErrorCode(event.code ?? null);
  }, []);

  const handleStep = useCallback(async () => {
    if (stepBusy) return;
    setStepBusy(true);
    try {
      const result = await adapterBridge.invoke<DoomStepResult>('doom_step');
      if (result && typeof result === 'object' && 'state' in result) {
        setStateRaw((result as DoomStepResult).state);
      }
    } catch (err) {
      setPhase('error');
      setErrorCode('requestFailed');
      setLastError(String(err));
    } finally {
      setStepBusy(false);
    }
  }, [stepBusy]);

  // ── Autoplay controls (Spec #2969, ST-7) ────────────────────────────────────
  // The event, not the start result, is the source of truth for `running`; the
  // result only surfaces an immediate typed failure (NotReady / engine error)
  // that the backend returns WITHOUT emitting an event (F-32).
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

  const handleAutoplayToggle = useCallback(async () => {
    if (autoplayBusyRef.current) return;
    autoplayBusyRef.current = true;
    setAutoplayBusy(true);
    const active =
      autoplayStatus.phase === 'running' || autoplayStatus.phase === 'stopping';
    try {
      if (active) {
        await adapterBridge.invoke('stop_doom_autoplay');
        return;
      }
      const result = await adapterBridge.invoke<DoomAutoplayResult>('start_doom_autoplay');
      if (result && result.success === false) {
        applyAutoplayFailure(result.code, result.error, result.steps);
      }
    } catch (err) {
      applyAutoplayFailure('engineRequestFailed', String(err));
    } finally {
      autoplayBusyRef.current = false;
      setAutoplayBusy(false);
    }
  }, [applyAutoplayFailure, autoplayStatus.phase]);

  const handleAutoplayStop = useCallback(async () => {
    if (autoplayBusyRef.current) return;
    autoplayBusyRef.current = true;
    setAutoplayBusy(true);
    try {
      await adapterBridge.invoke('stop_doom_autoplay');
    } catch {
      // The event / last status remain authoritative; a stop is idempotent.
    } finally {
      autoplayBusyRef.current = false;
      setAutoplayBusy(false);
    }
  }, []);

  // ── Mount: register BEFORE the first call, then launch ──────────────────────
  useEffect(() => {
    mountedRef.current = true;
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
    // event that races the seed wins (first-wins guard, AC-UI-9).
    unlisteners.push(
      adapterBridge.listen<DoomAutoplayStatus>(DOOM_AUTOPLAY_EVENT, (event) => {
        if (cancelled) return;
        if (!event || !event.phase) return;
        autoplayEventSeenRef.current = true;
        setAutoplayStatus(event);
      }),
    );
    // 1b. Native close is intentionally NOT intercepted here. The `terminal`
    // window registers no JS close listener and closes through Tauri's default
    // native path; the `doom` window mirrors that so the OS / `close()` request
    // actually closes it. The engine teardown is Rust-owned (`CloseRequested`
    // in `open_doom_window`); the React layer MUST NOT call
    // `stop_doom_runtime`. UI resources are released by this effect's cleanup.

    // 2. Idempotent launch — only after the listener is registered.
    void Promise.all(unlisteners).then(() => {
      if (cancelled) return;
      void launch();
      // 3. Hydrate the autoplay status: the loop outlives the webview, so a
      // freshly-opened window reflects a run already in flight. First-wins — a
      // `doom-autoplay-changed` event that already arrived is never clobbered.
      void adapterBridge
        .invoke<DoomAutoplayStatus>('get_doom_autoplay_status')
        .then((status) => {
          if (cancelled || autoplayEventSeenRef.current) return;
          if (status && typeof status === 'object' && 'phase' in status) {
            setAutoplayStatus(status);
          }
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
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
    if (phase !== 'starting') {
      setStartElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setStartElapsed(Math.min((Date.now() - startedAt) / 1000, DOOM_READY_TIMEOUT_S));
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // ── Autoplay elapsed ticker (AC-UI-7): 1 s while running, cleared otherwise ─
  useEffect(() => {
    if (autoplayStatus.phase !== 'running') return;
    setAutoplayNow(Date.now());
    const id = window.setInterval(() => setAutoplayNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [autoplayStatus.phase, autoplayStatus.startedAt]);

  const busy = phase === 'starting' || phase === 'stopping';
  const statusLabel = doomPhaseLabel(phase, port);
  const dotColor =
    phase === 'ready'
      ? 'status.success'
      : phase === 'error'
        ? 'status.error'
        : phase === 'idle'
          ? 'fg.muted'
          : 'status.info';

  const formatted = useMemo(() => formatDoomState(stateRaw), [stateRaw]);
  const frameDescription = useMemo(() => describeDoomFrame(phase, stateRaw), [phase, stateRaw]);
  const error = useMemo(() => doomErrorMessage(errorCode), [errorCode]);
  const progressValue = Math.min((startElapsed / DOOM_READY_TIMEOUT_S) * 100, 100);

  // ── Autoplay-derived display state (AC-UI-1..11) ────────────────────────────
  const autoplayActive =
    autoplayStatus.phase === 'running' || autoplayStatus.phase === 'stopping';
  const autoplayStopping = autoplayStatus.phase === 'stopping';
  const autoplayStatusText = doomAutoplayStatusLine(autoplayStatus);
  const autoplayElapsed =
    autoplayStatus.phase === 'running'
      ? formatAutoplayElapsed(autoplayStatus.startedAt, autoplayNow)
      : null;
  const autoplayError = useMemo(
    () => doomAutoplayErrorMessage(autoplayStatus.code),
    [autoplayStatus.code],
  );
  const autoplayErrorDetail = truncateAutoplayError(autoplayStatus.lastError);
  // Start gated on runtime readiness; `stopping` is a bounded loading state.
  const autoplayToggleDisabled =
    autoplayBusy || autoplayStopping || (!autoplayActive && phase !== 'ready');

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
      {/* Header */}
      <Flex
        flexShrink={0}
        align="center"
        justify="space-between"
        gap={3}
        px={4}
        py={2}
        borderBottomWidth="1px"
        borderColor="border.default"
      >
        <HStack gap={2} minW={0}>
          <Icon as={LuGamepad2} boxSize="16px" color="accent.default" aria-hidden />
          <Heading
            as="h1"
            data-testid="doom-window-title"
            size="sm"
            fontFamily="mono"
            fontWeight="semibold"
            lineClamp={1}
          >
            Doom
          </Heading>
        </HStack>
        <HStack gap={2} flexShrink={0}>
          <Box boxSize="8px" borderRadius="full" bg={dotColor} aria-hidden />
          <Text
            data-testid="doom-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-busy={busy}
            fontSize="xs"
            color="fg.muted"
            fontFamily="mono"
            whiteSpace="nowrap"
          >
            {statusLabel}
          </Text>
        </HStack>
      </Flex>

      {/* Frame region — position relative so overlays never reflow it */}
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

        {phase === 'idle' && (
          <Center>
            <Flex direction="column" align="center" gap={3}>
              <Text fontSize="sm" color="fg.muted" fontFamily="mono">
                Runtime not started
              </Text>
              <Button
                data-testid="doom-start-button"
                colorPalette="accent"
                size="sm"
                onClick={() => void launch()}
              >
                Start Doom
              </Button>
            </Flex>
          </Center>
        )}

        {phase === 'starting' && (
          <Center>
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
          <Center>
            <HStack gap={2}>
              <Spinner size="sm" color="fg.muted" />
              <Text fontSize="sm" color="fg.muted" fontFamily="mono">
                Stopping…
              </Text>
            </HStack>
          </Center>
        )}

        {frameError && phase === 'ready' && (
          <Box position="absolute" top={3} right={3} px={2} py={1} borderRadius="sm" bg="bg.surface">
            <Text data-testid="doom-frame-reconnecting" fontSize="xs" color="fg.muted" fontFamily="mono">
              Reconnecting…
            </Text>
          </Box>
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
                <Icon as={LuTriangleAlert} boxSize="16px" color="status.error" mt="2px" flexShrink={0} aria-hidden />
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
      </Box>

      <Separator borderColor="border.default" />

      {/* Footer — state readout + step control */}
      <Flex
        flexShrink={0}
        wrap="wrap"
        align="center"
        justify="space-between"
        gap={3}
        px={4}
        py={2}
      >
        <Box minW={0} flex="1 1 240px">
          <Text
            data-testid="doom-state-readout"
            fontFamily="mono"
            fontSize="xs"
            color="fg.default"
          >
            {stateRaw === null ? (
              <Text as="span" color="fg.muted">
                No state read yet
              </Text>
            ) : (
              <Flex as="span" wrap="wrap" gap={3} align="baseline">
                {formatted.advancedKey && formatted.advancedValue !== null && (
                  <Text as="span" fontWeight="semibold">
                    {formatted.advancedKey} {formatted.advancedValue}
                  </Text>
                )}
                {formatted.pairs.map((pair) => (
                  <Text as="span" key={pair.key} color="fg.muted" title={`${pair.key}=${pair.value}`}>
                    {pair.key}={pair.value}
                  </Text>
                ))}
              </Flex>
            )}
          </Text>
          {stateRaw !== null && (
            <Collapsible.Root>
              <Collapsible.Trigger asChild>
                <Button variant="ghost" size="2xs" mt={1} px={0} color="fg.muted">
                  Raw state
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Box
                  mt={1}
                  maxH="120px"
                  overflowY="auto"
                  p={2}
                  borderRadius="sm"
                  bg="bg.surface"
                  borderWidth="1px"
                  borderColor="border.default"
                >
                  <Text as="pre" fontFamily="mono" fontSize="2xs" color="fg.muted" whiteSpace="pre-wrap">
                    {formatted.rawJson}
                  </Text>
                </Box>
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </Box>
        <HStack gap={2} align="center" minW={0}>
          <Text
            data-testid="doom-autoplay-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            fontFamily="mono"
            fontSize="xs"
            color="fg.muted"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
            minW={0}
            title={autoplayStatusText}
          >
            {autoplayStatusText}
          </Text>
          {autoplayElapsed && (
            <Text
              data-testid="doom-autoplay-elapsed"
              fontFamily="mono"
              fontSize="xs"
              color="fg.muted"
              whiteSpace="nowrap"
              flexShrink={0}
            >
              {autoplayElapsed}
            </Text>
          )}
          <Button
            data-testid="doom-autoplay-toggle"
            colorPalette="accent"
            size="sm"
            aria-pressed={autoplayStatus.running}
            disabled={autoplayToggleDisabled}
            loading={autoplayStopping}
            onClick={() => void handleAutoplayToggle()}
          >
            <Icon as={autoplayActive ? LuSquare : LuPlay} boxSize="14px" mr={1} aria-hidden />
            Autoplay
          </Button>
          {autoplayActive && (
            <Button
              data-testid="doom-autoplay-stop"
              variant="outline"
              size="sm"
              disabled={autoplayBusy || autoplayStopping}
              loading={autoplayStopping}
              onClick={() => void handleAutoplayStop()}
            >
              <Icon as={LuSquare} boxSize="14px" mr={1} aria-hidden />
              Stop
            </Button>
          )}
          <Button
            data-testid="doom-step-button"
            variant="solid"
            colorPalette="accent"
            size="sm"
            disabled={phase !== 'ready' || stepBusy || autoplayActive}
            onClick={() => void handleStep()}
          >
            {stepBusy ? (
              <Spinner size="xs" />
            ) : (
              <>
                <Icon as={LuStepForward} boxSize="14px" mr={1} aria-hidden />
                Step
              </>
            )}
          </Button>
        </HStack>
        {autoplayStatus.phase === 'failed' && (
          <Box
            data-testid="doom-autoplay-error"
            role="alert"
            flexBasis="100%"
            p={3}
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
                  {autoplayError.title}
                </Text>
                <Text fontSize="xs" color="fg.default" mt={1} lineHeight="1.4">
                  {autoplayError.message}
                </Text>
                {autoplayErrorDetail && (
                  <Text
                    fontSize="xs"
                    color="fg.muted"
                    fontFamily="mono"
                    mt={2}
                    title={autoplayStatus.lastError ?? undefined}
                    truncate
                  >
                    {autoplayErrorDetail}
                  </Text>
                )}
              </Box>
            </HStack>
          </Box>
        )}
      </Flex>
    </Flex>
  );
};

/** A centered absolute overlay that never reflows the frame region. */
const Center: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Flex position="absolute" inset={0} align="center" justify="center" pointerEvents="auto">
    {children}
  </Flex>
);

/**
 * The `doom` window deliberately registers NO JS `onCloseRequested` handler.
 *
 * `@tauri-apps/api`'s `onCloseRequested` wrapper auto-invokes
 * `getCurrentWindow().destroy()` when the handler does not `preventDefault()`;
 * `destroy` requires `core:window:allow-destroy`, which the `doom` window's
 * capability does not grant, so the invoke is ACL-denied and the window never
 * closes. The working `terminal` window registers no JS close listener and
 * closes through Tauri's default native path — `doom` mirrors that. Engine
 * teardown stays Rust-owned via the `CloseRequested` handler wired in
 * `open_doom_window` (`features/doom/commands.rs`), so the React layer MUST NOT
 * intercept the close or call `stop_doom_runtime`.
 */

export default DoomWindow;
