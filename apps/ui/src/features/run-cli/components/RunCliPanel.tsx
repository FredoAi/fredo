import React, { useState, useCallback, useEffect } from 'react';
import { Box, VStack, HStack, Text, Button } from '@chakra-ui/react';
import { LuSquare, LuTerminal } from 'react-icons/lu';
import { useWindowActions } from '@maomaolabs/core';
import { adapterBridge } from '../../../shared/utils/adapterBridge';

// Module-level flag: survives StrictMode unmount/remount, resets on HMR
let _launchInFlight = false;

// ── Status panel — owns the full launch lifecycle ────────────────────────────
export const RunCliPanel: React.FC = () => {
  const [provider, setProvider] = useState<string>('copilot');
  const [status, setStatus] = useState<'launching' | 'running' | 'exited' | 'error'>('launching');
  const [error, setError] = useState<string | null>(null);
  const { closeWindow } = useWindowActions();

  // Launch on mount — guarded against StrictMode double-invoke
  useEffect(() => {
    if (_launchInFlight) {
      console.log('[RunCliPanel] mount — skipping duplicate (StrictMode)');
      return;
    }
    _launchInFlight = true;
    console.log('[RunCliPanel] mount — launching');
    let cancelled = false;

    async function launch() {
      try {
        const savedProvider = await adapterBridge.invoke<string | null>('get_setting', { key: 'run_cli_provider' });
        const savedWorkDir  = await adapterBridge.invoke<string | null>('get_setting', { key: 'run_cli_work_dir' });
        const p = savedProvider ?? 'copilot';
        if (!cancelled) setProvider(p);
        console.log('[RunCliPanel] calling open_run_cli', { p, savedWorkDir });
        await adapterBridge.invoke('open_run_cli', { provider: p, workDir: savedWorkDir || undefined });
        console.log('[RunCliPanel] open_run_cli OK');
        if (!cancelled) setStatus('running');
      } catch (err) {
        console.error('[RunCliPanel] open_run_cli failed:', err);
        if (!cancelled) { setError(String(err)); setStatus('error'); }
      } finally {
        _launchInFlight = false;
      }
    }

    launch();
    return () => { cancelled = true; };
  }, []);

  // Close this window the moment the terminal process exits — they're bound together
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('run-cli-exited', () => closeWindow('run-cli')).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [closeWindow]);

  // Stop button: kill the terminal — the run-cli-exited event will close both windows
  const handleStop = useCallback(async () => {
    await adapterBridge.invoke('close_run_cli').catch(() => {});
  }, []);

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <VStack h="100%" gap={0} align="stretch" background="var(--card-bg)" overflow="hidden" justify="center">
      <VStack gap={3} align="center" px={6}>
        <Box color={status === 'error' ? 'var(--status-error)' : 'var(--accent-primary)'} opacity={status === 'exited' ? 0.35 : 1}>
          <LuTerminal size={28} />
        </Box>
        <VStack gap={1} align="center">
          <Text fontSize="sm" fontWeight="semibold" color="var(--text-primary)">
            {providerLabel} CLI
          </Text>
          {status === 'launching' && <Text fontSize="xs" color="var(--text-secondary)">Launching…</Text>}
          {status === 'running'   && <Text fontSize="xs" color="var(--status-success)">Terminal is running</Text>}
          {status === 'exited'    && <Text fontSize="xs" color="var(--status-error)">Terminal closed</Text>}
          {status === 'error'     && <Text fontSize="xs" color="var(--status-error)" textAlign="center" maxW="200px">{error}</Text>}
        </VStack>
        {status === 'running' && (
          <Button size="xs" variant="ghost" color="var(--text-secondary)"
            _hover={{ color: 'var(--status-error)', background: 'var(--status-error)15' }}
            onClick={handleStop}
          >
            <HStack gap={1}>
              <LuSquare size={11} />
              <Text fontSize="10px">Stop</Text>
            </HStack>
          </Button>
        )}
      </VStack>
    </VStack>
  );
};
