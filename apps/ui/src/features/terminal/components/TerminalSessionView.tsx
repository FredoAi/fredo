import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleX,
  LuFolderOpen,
  LuRefreshCw,
  LuSquare,
  LuTerminal,
  LuTriangleAlert,
} from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { tint } from '../../../shared/utils/colorTint';
import { settingsService } from '../../../features/settings';
import { ensureTerminalSettingsMigrated, WORK_DIR_KEY } from '../settings';

// ── Status contract (backend `list_terminal_sessions`) ──────────────────────
export type TerminalSessionStatus = 'starting' | 'running' | 'error' | 'exited';

export interface TerminalSessionInfo {
  status: TerminalSessionStatus;
  /** Set when `status === "error"` (resolve/spawn failure message). */
  error: string | null;
  /** Resolved working directory of the session (toolbar title). */
  workDir: string | null;
}

interface TerminalSessionViewProps {
  /**
   * Render the terminal surface. Called only while the session is `running`;
   * `onFirstOutput` fires on the first PTY output byte (fades the loading
   * overlay) — includes the `get_pty_buffer` replay, not just live events.
   */
  renderTerminal: (handlers: { onFirstOutput: () => void }) => React.ReactNode;
}

const POLL_MS = 500;

// ── Error metadata: map the backend's launch-error message to an icon/title ──
function getErrorMeta(error: string | null): { icon: typeof LuTriangleAlert; title: string } {
  if (error && error.includes('not found in PATH')) {
    return { icon: LuTerminal, title: 'OpenCode not found' };
  }
  if (error && /directory|cwd|working dir/i.test(error)) {
    return { icon: LuFolderOpen, title: 'Working directory not found' };
  }
  return { icon: LuTriangleAlert, title: 'Failed to start terminal' };
}

const STATUS_DOT_COLOR: Record<TerminalSessionStatus, string> = {
  running: 'var(--status-success)',
  starting: 'var(--status-warning)',
  error: 'var(--status-error)',
  exited: 'var(--text-secondary)',
};

const STATUS_LABEL: Record<TerminalSessionStatus, string> = {
  running: 'running',
  starting: 'launching',
  error: 'error',
  exited: 'exited',
};

/**
 * Launch lifecycle UI for the `terminal` window (AC5 error surface + no-linger
 * guard). Calls `list_terminal_sessions` on mount and polls while `starting`;
 * mounts the ghostty terminal only when `running`. `list_terminal_sessions`
 * becomes a per-session list with the multi-session work — this view reads the
 * single (≤1) entry the backend currently reports.
 */
export const TerminalSessionView: React.FC<TerminalSessionViewProps> = ({ renderTerminal }) => {
  const [status, setStatus] = useState<TerminalSessionInfo | null>(null);
  const [hasOutput, setHasOutput] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // ── Poll list_terminal_sessions while starting; stop once settled ────────
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const sessions = await adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions');
        if (cancelled || !sessions) return;
        const info = sessions[0];
        if (!info) return;
        setStatus(info);
        if (info.status === 'starting') {
          timer = window.setTimeout(poll, POLL_MS);
        }
      } catch {
        // Transient invoke failure — keep polling (window is still open).
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [retryKey]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(async () => {
    setHasOutput(false);
    setStatus({ status: 'starting', error: null, workDir: null });
    try {
      // open_terminal_window is idempotent w.r.t. an already-open window — a
      // Retry reuses the current `terminal` window, never a second one.
      await ensureTerminalSettingsMigrated();
      const savedWorkDir = await settingsService.get<string>(WORK_DIR_KEY, '');
      await adapterBridge.invoke('open_terminal_window', { workDir: savedWorkDir || undefined });
      setRetryKey((k) => k + 1); // restart the poll
    } catch (err) {
      setStatus({ status: 'error', error: String(err), workDir: null });
    }
  }, []);

  const handleClose = useCallback(() => {
    adapterBridge.invoke('close_terminal_window').catch(() => {});
  }, []);

  const handleFirstOutput = useCallback(() => setHasOutput(true), []);

  const kind: TerminalSessionStatus = status?.status ?? 'starting';
  // Overlay is mounted while starting OR while the terminal is live but no PTY
  // byte has arrived yet — it fades out (opacity 180ms) on the first output.
  const showLoading = kind === 'starting' || kind === 'running';
  const { icon: errorIcon, title: errorTitle } = getErrorMeta(status?.error ?? null);

  return (
    <Flex direction="column" h="100%" bg="bg.canvas">
      {/* ── Toolbar (32px) ─────────────────────────────────────────────── */}
      <Flex
        h="32px"
        flexShrink={0}
        align="center"
        gap={3}
        px={3}
        bg="bg.subtle"
        borderBottom="1px solid var(--border-color)"
      >
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          flexShrink={0}
          bg={STATUS_DOT_COLOR[kind]}
          aria-label={`Session status: ${STATUS_LABEL[kind]}`}
        />
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" flex={1} truncate>
          {status?.workDir || '~'}
        </Text>
        {kind === 'running' && (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleClose}
            _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 8) }}
          >
            <LuSquare size={14} />
            Stop
          </Button>
        )}
      </Flex>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <Box position="relative" flex={1} minH={0}>
        {/* Terminal mounts only when running (ghostty-web owns its own colors). */}
        {kind === 'running' && renderTerminal({ onFirstOutput: handleFirstOutput })}

        {/* Loading overlay: mounted while starting OR while the terminal is
            live but no PTY byte has arrived yet; fades out on first output. */}
        {showLoading && (
          <Box
            position="absolute"
            inset={0}
            zIndex={2}
            display="flex"
            alignItems="center"
            justifyContent="center"
            bg="bg.canvas"
            transition="opacity 180ms ease"
            opacity={hasOutput ? 0 : 1}
            pointerEvents={hasOutput ? 'none' : 'auto'}
          >
            <VStack gap={3}>
              <Spinner size="md" color="var(--accent-primary)" aria-label="Starting OpenCode session" />
              <Text fontSize="sm" color="fg.muted">Starting OpenCode…</Text>
            </VStack>
          </Box>
        )}

        {/* AC5 in-window error surface — always closable, no hang. */}
        {kind === 'error' && (
          <Flex
            position="absolute"
            inset={0}
            direction="column"
            align="center"
            justify="center"
            gap={4}
            p={8}
            textAlign="center"
          >
            <Icon as={errorIcon} boxSize="48px" color="var(--status-error)" />
            <VStack gap={1}>
              <Text fontSize="lg" fontWeight="600" color="fg.default">{errorTitle}</Text>
              {status?.error && (
                <Text fontSize="sm" color="fg.muted" maxW="520px">{status.error}</Text>
              )}
            </VStack>
            <HStack gap={3}>
              <Button
                variant="solid"
                size="sm"
                bg="var(--accent-primary)"
                color="white"
                onClick={handleRetry}
              >
                <LuRefreshCw size={14} />
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
              >
                <LuCircleX size={14} />
                Close
              </Button>
            </HStack>
          </Flex>
        )}

        {/* Transient exited state — the backend auto-closes the window (AC4). */}
        {kind === 'exited' && (
          <Flex
            position="absolute"
            inset={0}
            direction="column"
            align="center"
            justify="center"
            gap={2}
          >
            <Text fontSize="sm" color="fg.muted">Session ended — closing window…</Text>
          </Flex>
        )}
      </Box>
    </Flex>
  );
};
