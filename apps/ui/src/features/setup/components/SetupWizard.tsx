import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, HStack, Icon, Spinner, Text, VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck, LuCircleX, LuSettings2, LuLoader,
} from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { settingsService } from '../../settings';

interface CliCheckResult {
  opencode: boolean;
  opencode_plugin_installed: boolean;
}
interface FredoPathStatus { in_path: boolean; binary_path: string; }
interface InstallResult { success: boolean; output: string; error?: string; }
interface OtelStatus { opencode_configured: boolean; }
type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
interface TaskState { id: string; label: string; detail?: string; status: TaskStatus; }
type Screen = 'detecting' | 'running' | 'done';
interface SetupWizardProps { onClose?: () => void; }

const TaskRow: React.FC<{ task: TaskState }> = ({ task }) => {
  const iconEl = (() => {
    switch (task.status) {
      case 'running': return <Spinner size="xs" color="var(--accent-primary)" />;
      case 'done':    return <Icon as={LuCircleCheck} boxSize="16px" color="var(--status-success)" />;
      case 'error':   return <Icon as={LuCircleX} boxSize="16px" color="var(--status-error)" />;
      case 'skipped': return <Icon as={LuCircleCheck} boxSize="16px" color="var(--text-muted)" />;
      default:        return <Icon as={LuLoader} boxSize="16px" color="var(--border-color)" />;
    }
  })();
  const labelColor =
    task.status === 'error'   ? 'var(--status-error)'   :
    task.status === 'skipped' ? 'var(--text-muted)'     :
    task.status === 'done'    ? 'var(--text-primary)'   :
    task.status === 'running' ? 'var(--accent-primary)' :
    'var(--text-muted)';
  return (
    <HStack gap={3} align="flex-start" py={2} px={3}
      bg={task.status === 'running' ? 'rgba(147,51,234,0.06)' : 'transparent'}>
      <Box pt="1px" flexShrink={0}>{iconEl}</Box>
      <Box flex={1}>
        <Text fontSize="sm" fontWeight={task.status === 'running' ? '600' : '500'} color={labelColor}>
          {task.label}
        </Text>
        {task.detail && (
          <Text fontSize="11px" color="var(--text-secondary)" mt="2px" fontFamily="mono" wordBreak="break-all">
            {task.detail}
          </Text>
        )}
      </Box>
    </HStack>
  );
};

export const SetupWizard: React.FC<SetupWizardProps> = ({ onClose }) => {
  const [screen, setScreen] = useState<Screen>('detecting');
  const [cliResults, setCliResults] = useState<CliCheckResult>({
    opencode: false,
    opencode_plugin_installed: false,
  });
  const [tasks, setTasks] = useState<TaskState[]>([]);

  const patchTask = useCallback((id: string, patch: Partial<TaskState>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cli = await adapterBridge.invoke<CliCheckResult>('check_cli_installations', {});
        if (cli) setCliResults(cli);
      } catch { /* ignore */ }
      setScreen('running');
      runSetup();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSetup = useCallback(async () => {
    setTasks([
      { id: 'Fredo-cli', label: 'Check Fredo CLI in PATH',  status: 'pending' },
      { id: 'telemetry', label: 'Configure OTEL telemetry', status: 'pending' },
      { id: 'plugin',    label: 'Install Fredo plugin',     status: 'pending' },
    ]);
    setScreen('running');

    // Task 1: Fredo CLI
    patchTask('Fredo-cli', { status: 'running', label: 'Checking Fredo CLI in PATH…' });
    try {
      const pathStatus = await adapterBridge.invoke<FredoPathStatus>('check_fredo_in_path', {});
      if (pathStatus?.in_path) {
        patchTask('Fredo-cli', { status: 'skipped', label: 'Fredo CLI — already in PATH', detail: pathStatus.binary_path });
      } else {
        patchTask('Fredo-cli', { label: 'Adding Fredo CLI to PATH…' });
        const result = await adapterBridge.invoke<InstallResult>('add_fredo_to_path', {});
        if (result?.success) {
          patchTask('Fredo-cli', { status: 'done', label: 'Fredo CLI added to PATH', detail: result.output || undefined });
        } else {
          patchTask('Fredo-cli', { status: 'error', label: 'Fredo CLI — could not add to PATH', detail: result?.error ?? result?.output });
        }
      }
    } catch (err) {
      patchTask('Fredo-cli', { status: 'error', label: 'Fredo CLI — check failed', detail: String(err) });
    }

    // Task 2: OTEL
    patchTask('telemetry', { status: 'running', label: 'Checking telemetry configuration…' });
    try {
      const otelStatus = await adapterBridge.invoke<OtelStatus>('check_otel_configured', {});
      if (otelStatus?.opencode_configured) {
        patchTask('telemetry', { status: 'skipped', label: 'OTEL telemetry — already configured' });
      } else {
        patchTask('telemetry', { label: 'Configuring OTEL for OpenCode…' });
        const result = await adapterBridge.invoke<InstallResult>('configure_otel', {});
        if (result?.success) {
          patchTask('telemetry', {
            status: 'done', label: 'OTEL telemetry configured',
            detail: 'Env vars written persistently — open a new terminal to pick them up',
          });
        } else {
          patchTask('telemetry', { status: 'error', label: 'OTEL telemetry — configuration failed', detail: result?.error ?? result?.output });
        }
      }
    } catch (err) {
      patchTask('telemetry', { status: 'error', label: 'OTEL telemetry — check failed', detail: String(err) });
    }

    // Task 3: Plugin
    patchTask('plugin', { status: 'running', label: 'Installing Fredo plugin…' });
    try {
      const result = await adapterBridge.invoke<InstallResult>('install_plugin', {});
      if (result?.success) {
        await settingsService.set('plugin_installed', 'true');
        patchTask('plugin', { status: 'done', label: 'Fredo plugin installed', detail: result.output || undefined });
      } else {
        patchTask('plugin', { status: 'error', label: 'Plugin install failed', detail: result?.error ?? result?.output });
      }
    } catch (err) {
      patchTask('plugin', { status: 'error', label: 'Plugin install failed', detail: String(err) });
    }

    setScreen('done');
  }, [patchTask]);

  return (
    <Box p={6} display="flex" flexDirection="column" gap={5} minH="0" h="100%">
      <HStack gap={3}>
        <Icon as={LuSettings2} boxSize="22px" color="var(--accent-primary)" />
        <Box>
          <Text fontSize="md" fontWeight="700" color="var(--text-primary)">Fredo Setup</Text>
          <Text fontSize="xs" color="var(--text-secondary)">CLI · Telemetry · Plugin — all in one step</Text>
        </Box>
      </HStack>

      {screen === 'detecting' && (
        <VStack gap={3} align="center" py={8}>
          <Spinner size="lg" color="var(--accent-primary)" />
          <Text fontSize="sm" color="var(--text-secondary)">Detecting environment…</Text>
        </VStack>
      )}

      {(screen === 'running' || screen === 'done') && (
        <VStack gap={1} align="stretch" flex={1}>
          {screen === 'running' ? (
            <Text fontSize="xs" color="var(--text-secondary)" mb={2}>
              Setting up <Text as="span" fontWeight="600" color="var(--text-primary)">OpenCode</Text>…
            </Text>
          ) : (
            <HStack gap={2} mb={2}>
              <Icon as={LuCircleCheck} boxSize="17px" color="var(--status-success)" />
              <Text fontSize="sm" fontWeight="600" color="var(--status-success)">OpenCode setup complete</Text>
            </HStack>
          )}
          <Box borderRadius="lg" border="1px solid var(--border-color)" bg="var(--card-bg)" overflow="hidden">
            {tasks.map((task, i) => (
              <Box key={task.id} borderTop={i > 0 ? '1px solid var(--border-color)' : undefined}>
                <TaskRow task={task} />
              </Box>
            ))}
          </Box>
          {!cliResults.opencode && screen === 'running' && (
            <Box mt={2} p={3} borderRadius="md" bg="rgba(234,179,8,0.1)" border="1px solid rgba(234,179,8,0.3)">
              <Text fontSize="xs" color="var(--status-warning)">
                OpenCode not found in PATH. Install it from <Text as="span" fontWeight="700">https://opencode.ai</Text> and reopen this setup.
              </Text>
            </Box>
          )}
          {screen === 'done' && (
            <HStack justify="flex-end" mt="auto" pt={2} gap={2}>
              <Button size="sm" variant="ghost" color="var(--text-secondary)"
                onClick={() => { setScreen('detecting'); setTasks([]); }}>Run again</Button>
              <Button size="sm" background="var(--accent-primary)" color="white"
                onClick={onClose} _hover={{ opacity: 0.9 }}>Done</Button>
            </HStack>
          )}
        </VStack>
      )}
    </Box>
  );
};
