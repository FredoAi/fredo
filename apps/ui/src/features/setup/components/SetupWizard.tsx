import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, HStack, Icon, Spinner, Text, VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck, LuCircleX, LuSettings2, LuTerminal, LuBot, LuLoader, LuCircle,
} from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { settingsService } from '../../settings';

interface CliCheckResult {
  copilot: boolean; claude: boolean;
  copilot_plugin_installed: boolean; claude_plugin_installed: boolean;
}
interface FredoPathStatus { in_path: boolean; binary_path: string; }
interface InstallResult { success: boolean; output: string; error?: string; }
interface OtelStatus { claude_configured: boolean; copilot_configured: boolean; }
type Provider = 'copilot' | 'claude';
type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
interface TaskState { id: string; label: string; detail?: string; status: TaskStatus; }
type Screen = 'detecting' | 'pick' | 'running' | 'done';
interface SetupWizardProps { onClose?: () => void; }

interface ProviderCardProps {
  label: string; description: string; icon: React.ElementType;
  available: boolean; selected: boolean; onSelect: () => void;
}

const ProviderCard: React.FC<ProviderCardProps> = ({
  label, description, icon, available, selected, onSelect,
}) => (
  <Box
    as="button"
    onClick={available ? onSelect : undefined}
    w="100%" p={4} borderRadius="lg" border="2px solid"
    borderColor={selected ? 'var(--accent-primary)' : 'var(--border-color)'}
    bg={selected ? 'rgba(147,51,234,0.1)' : 'var(--card-bg)'}
    opacity={available ? 1 : 0.45}
    cursor={available ? 'pointer' : 'not-allowed'}
    textAlign="left" transition="all 0.15s"
    _hover={available ? { borderColor: 'var(--accent-primary)', bg: 'rgba(147,51,234,0.06)' } : {}}
  >
    <HStack gap={3} align="center">
      <Icon as={icon} boxSize="22px" color={selected ? 'var(--accent-primary)' : 'var(--text-secondary)'} />
      <Box flex={1}>
        <HStack gap={2} align="center">
          <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">{label}</Text>
          {available ? (
            <HStack gap={1}>
              <Icon as={LuCircleCheck} boxSize="11px" color="var(--status-success)" />
              <Text fontSize="10px" color="var(--status-success)">installed</Text>
            </HStack>
          ) : (
            <HStack gap={1}>
              <Icon as={LuCircleX} boxSize="11px" color="var(--text-muted)" />
              <Text fontSize="10px" color="var(--text-muted)">not found</Text>
            </HStack>
          )}
        </HStack>
        <Text fontSize="xs" color="var(--text-secondary)" mt={0.5}>{description}</Text>
      </Box>
      {selected
        ? <Icon as={LuCircleCheck} boxSize="18px" color="var(--accent-primary)" flexShrink={0} />
        : <Icon as={LuCircle} boxSize="18px" color="var(--border-color)" flexShrink={0} />}
    </HStack>
  </Box>
);

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
  const [provider, setProvider] = useState<Provider | null>(null);
  const [cliResults, setCliResults] = useState<CliCheckResult>({
    copilot: false, claude: false,
    copilot_plugin_installed: false, claude_plugin_installed: false,
  });
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const patchTask = useCallback((id: string, patch: Partial<TaskState>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cli = await adapterBridge.invoke<CliCheckResult>('check_cli_installations', {});
        if (cli) setCliResults(cli);
      } catch { /* ignore */ }
      setScreen('pick');
    })();
  }, []);

  const runSetup = useCallback(async (prov: Provider) => {
    setTasks([
      { id: 'Fredo-cli', label: 'Check Fredo CLI in PATH',  status: 'pending' },
      { id: 'telemetry', label: 'Configure OTEL telemetry', status: 'pending' },
      { id: 'plugin',    label: 'Install Fredo plugin',     status: 'pending' },
    ]);
    setRestartNeeded(false);
    setScreen('running');

    // Task 1: Fredo CLI
    patchTask('Fredo-cli', { status: 'running', label: 'Checking Fredo CLI in PATH…' });
    try {
      const pathStatus = await adapterBridge.invoke<FredoPathStatus>('check_Fredo_in_path', {});
      if (pathStatus?.in_path) {
        patchTask('Fredo-cli', { status: 'skipped', label: 'Fredo CLI — already in PATH', detail: pathStatus.binary_path });
      } else {
        patchTask('Fredo-cli', { label: 'Adding Fredo CLI to PATH…' });
        const result = await adapterBridge.invoke<InstallResult>('add_Fredo_to_path', {});
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
      const alreadyOk = prov === 'claude' ? otelStatus?.claude_configured : otelStatus?.copilot_configured;
      if (alreadyOk) {
        patchTask('telemetry', { status: 'skipped', label: 'OTEL telemetry — already configured' });
      } else {
        patchTask('telemetry', { label: `Configuring OTEL for ${prov === 'claude' ? 'Claude Code' : 'Copilot CLI'}…` });
        const result = await adapterBridge.invoke<InstallResult>('configure_otel', { provider: prov });
        if (result?.success) {
          patchTask('telemetry', {
            status: 'done', label: 'OTEL telemetry configured',
            detail: prov === 'copilot'
              ? 'Env vars written to registry — open a new terminal to pick them up'
              : 'Written to ~/.claude/settings.json',
          });
          if (prov === 'copilot') setRestartNeeded(true);
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
      const result = await adapterBridge.invoke<InstallResult>('install_plugin', { provider: prov });
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

  const providerLabel = provider === 'claude' ? 'Claude Code' : 'GitHub Copilot CLI';
  const noneAvailable = !cliResults.copilot && !cliResults.claude;

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

      {screen === 'pick' && (
        <VStack gap={4} align="stretch" flex={1}>
          <Text fontSize="sm" color="var(--text-secondary)">
            Pick your AI CLI. Fredo will check the CLI, configure telemetry, and install the plugin automatically.
          </Text>
          <ProviderCard
            label="GitHub Copilot CLI"
            description="OTLP/HTTP → localhost:4318 · env vars persisted to registry"
            icon={LuTerminal} available={cliResults.copilot}
            selected={provider === 'copilot'} onSelect={() => setProvider('copilot')}
          />
          <ProviderCard
            label="Claude Code"
            description="OTLP/gRPC → localhost:4317 · config via ~/.claude/settings.json"
            icon={LuBot} available={cliResults.claude}
            selected={provider === 'claude'} onSelect={() => setProvider('claude')}
          />
          {noneAvailable && (
            <Box p={3} borderRadius="md" bg="rgba(234,179,8,0.1)" border="1px solid rgba(234,179,8,0.3)">
              <Text fontSize="xs" color="var(--status-warning)">
                No supported CLI found in PATH. Install Copilot CLI or Claude Code first, then reopen this setup.
              </Text>
            </Box>
          )}
          <HStack justify="flex-end" mt="auto" pt={2} gap={2}>
            <Button size="sm" variant="ghost" color="var(--text-secondary)" onClick={onClose}>Skip</Button>
            <Button
              size="sm" background="var(--accent-primary)" color="white"
              disabled={!provider} onClick={() => provider && runSetup(provider)} _hover={{ opacity: 0.9 }}
            >
              {provider ? `Set up ${providerLabel}` : 'Select a provider'}
            </Button>
          </HStack>
        </VStack>
      )}

      {(screen === 'running' || screen === 'done') && (
        <VStack gap={1} align="stretch" flex={1}>
          {screen === 'running' ? (
            <Text fontSize="xs" color="var(--text-secondary)" mb={2}>
              Setting up <Text as="span" fontWeight="600" color="var(--text-primary)">{providerLabel}</Text>…
            </Text>
          ) : (
            <HStack gap={2} mb={2}>
              <Icon as={LuCircleCheck} boxSize="17px" color="var(--status-success)" />
              <Text fontSize="sm" fontWeight="600" color="var(--status-success)">{providerLabel} setup complete</Text>
            </HStack>
          )}
          <Box borderRadius="lg" border="1px solid var(--border-color)" bg="var(--card-bg)" overflow="hidden">
            {tasks.map((task, i) => (
              <Box key={task.id} borderTop={i > 0 ? '1px solid var(--border-color)' : undefined}>
                <TaskRow task={task} />
              </Box>
            ))}
          </Box>
          {restartNeeded && (
            <Box mt={2} p={3} borderRadius="md" bg="rgba(245,158,11,0.08)" border="1px solid rgba(245,158,11,0.3)">
              <Text fontSize="xs" color="#f59e0b" fontWeight="500">
                Open a <Text as="span" fontWeight="700">new terminal</Text> for the Copilot CLI env vars to take effect.
              </Text>
            </Box>
          )}
          {screen === 'done' && (
            <HStack justify="flex-end" mt="auto" pt={2} gap={2}>
              <Button size="sm" variant="ghost" color="var(--text-secondary)"
                onClick={() => { setScreen('pick'); setTasks([]); }}>Set up another</Button>
              <Button size="sm" background="var(--accent-primary)" color="white"
                onClick={onClose} _hover={{ opacity: 0.9 }}>Done</Button>
            </HStack>
          )}
        </VStack>
      )}
    </Box>
  );
};
