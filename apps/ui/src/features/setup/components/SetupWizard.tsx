import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, HStack, Icon, Progress, Spinner, Text, VStack,
} from '@chakra-ui/react';
import {
  LuBrain, LuCircleCheck, LuCircleX, LuDownload, LuFileWarning,
  LuLoader, LuSettings2, LuTerminal, LuWrench,
} from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';

// ── Types ──────────────────────────────────────────────────────────────────────

type StepStatus = 'checking' | 'idle' | 'running' | 'done' | 'error' | 'skipped';

interface StepState {
  status: StepStatus;
  detail?: string;
}

interface SetupWizardProps {
  onClose?: () => void;
}

// ── Step Definitions ───────────────────────────────────────────────────────────

interface StepDef {
  id: string;
  label: string;
  description: string;
  icon: typeof LuTerminal;
  actionLabel: string;
  actionLabelRunning: string;
}

const STEPS: StepDef[] = [
  {
    id: 'fredo-path',
    label: 'Fredo Path',
    description: 'Add fredo to system PATH',
    icon: LuTerminal,
    actionLabel: 'Add to PATH',
    actionLabelRunning: 'Adding…',
  },
  {
    id: 'opencode-cli',
    label: 'OpenCode CLI',
    description: 'Install OpenCode CLI',
    icon: LuTerminal,
    actionLabel: 'Install',
    actionLabelRunning: 'Installing…',
  },
  {
    id: 'plugin-build',
    label: 'Plugin Build',
    description: 'Build required plugin',
    icon: LuWrench,
    actionLabel: 'Build',
    actionLabelRunning: 'Building…',
  },
  {
    id: 'plugin-install',
    label: 'Plugin Install',
    description: 'Install the plugin',
    icon: LuWrench,
    actionLabel: 'Install',
    actionLabelRunning: 'Installing…',
  },
  {
    id: 'model',
    label: 'Model Download',
    description: 'Download AI model',
    icon: LuBrain,
    actionLabel: 'Download',
    actionLabelRunning: 'Downloading…',
  },
  {
    id: 'otel-config',
    label: 'OTel Config',
    description: 'Configure OpenTelemetry',
    icon: LuSettings2,
    actionLabel: 'Configure',
    actionLabelRunning: 'Configuring…',
  },
];

// ── Status Icon ────────────────────────────────────────────────────────────────

const StatusIcon: React.FC<{ status: StepStatus }> = ({ status }) => {
  switch (status) {
    case 'done':
      return <Icon as={LuCircleCheck} boxSize="18px" color="var(--status-success)" />;
    case 'error':
      return <Icon as={LuCircleX} boxSize="18px" color="var(--status-error)" />;
    case 'skipped':
      return <Icon as={LuCircleCheck} boxSize="18px" color="var(--text-muted)" />;
    case 'running':
      return <Spinner size="sm" color="var(--accent-primary)" />;
    case 'checking':
      return <Spinner size="sm" color="var(--text-secondary)" />;
    default:
      return null;
  }
};

// ── Per-step check logic ───────────────────────────────────────────────────────

async function checkStep(id: string): Promise<StepState> {
  switch (id) {
    case 'fredo-path': {
      const res = await adapterBridge.invoke<{ in_path: boolean; binary_path: string }>('check_fredo_in_path');
      if (res?.in_path) return { status: 'done', detail: res.binary_path };
      return { status: 'idle' };
    }
    case 'opencode-cli': {
      const res = await adapterBridge.invoke<{ installed: boolean }>('check_opencode_cli');
      if (res?.installed) return { status: 'done' };
      return { status: 'idle' };
    }
    case 'plugin-build': {
      const res = await adapterBridge.invoke<{ built: boolean }>('check_plugin_built');
      if (res?.built) return { status: 'done' };
      return { status: 'idle' };
    }
    case 'plugin-install': {
      const res = await adapterBridge.invoke<{ installed: boolean }>('check_plugin_installed');
      if (res?.installed) return { status: 'done' };
      return { status: 'idle' };
    }
    case 'model': {
      const res = await adapterBridge.invoke<{ exists: boolean }>('check_model_files');
      if (res?.exists) return { status: 'done' };
      return { status: 'idle' };
    }
    case 'otel-config': {
      const res = await adapterBridge.invoke<{ configured: boolean }>('check_otel_config');
      if (res?.configured) return { status: 'done' };
      return { status: 'idle' };
    }
    default:
      return { status: 'idle' };
  }
}

// ── StepCard ───────────────────────────────────────────────────────────────────

const StepCard: React.FC<{ step: StepDef }> = ({ step }) => {
  const [state, setState] = useState<StepState>({ status: 'checking' });
  const [progress, setProgress] = useState(0);
  const mountedRef = useRef(true);
  const progressListenerRef = useRef<(() => void) | undefined>();

  // Mark unmounted
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      progressListenerRef.current?.();
    };
  }, []);

  // Check status on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await checkStep(step.id);
        if (!cancelled && mountedRef.current) {
          setState(result);
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setState({ status: 'idle' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [step.id]);

  // Set up Tauri event listener for model download progress
  const startProgressListener = useCallback(async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<number>('setup:download-progress', (event) => {
        if (mountedRef.current) {
          setProgress(event.payload);
        }
      });
      progressListenerRef.current = unlisten;
    } catch {
      // Non-Tauri environment — no progress available
    }
  }, []);

  const stopProgressListener = useCallback(() => {
    progressListenerRef.current?.();
    progressListenerRef.current = undefined;
  }, []);

  const handleAction = useCallback(async () => {
    setState({ status: 'running' });
    setProgress(0);

    // For model step, listen for download progress
    if (step.id === 'model') {
      await startProgressListener();
    }

    try {
      let result: StepState;

      switch (step.id) {
        case 'fredo-path': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('add_fredo_to_path');
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        case 'opencode-cli': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('install_opencode_cli');
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        case 'plugin-build': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('build_plugin');
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        case 'plugin-install': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('install_plugin');
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        case 'model': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('download_model');
          stopProgressListener();
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        case 'otel-config': {
          const exec = await adapterBridge.invoke<{ success: boolean; output?: string; error?: string }>('configure_otel');
          result = exec?.success
            ? { status: 'done', detail: exec.output }
            : { status: 'error', detail: exec?.error ?? exec?.output };
          break;
        }
        default:
          result = { status: 'error', detail: 'Unknown step' };
      }

      if (mountedRef.current) {
        setState(result);
      }
    } catch (err) {
      stopProgressListener();
      if (mountedRef.current) {
        setState({ status: 'error', detail: String(err) });
      }
    }
  }, [step.id, startProgressListener, stopProgressListener]);

  // ── Derived UI state ─────────────────────────────────────────────────────────

  const isRunning = state.status === 'running';
  const isChecking = state.status === 'checking';
  const isIdle = state.status === 'idle';
  const isDone = state.status === 'done';
  const isError = state.status === 'error';

  return (
    <Box
      borderRadius="lg"
      border="1px solid var(--border-color)"
      bg="var(--card-bg)"
      p={4}
      opacity={isChecking ? 0.6 : 1}
      transition="opacity 0.2s"
    >
      <HStack gap={4} align="flex-start">
        {/* Step icon */}
        <Box pt="1px" flexShrink={0}>
          <Icon as={step.icon} boxSize="20px" color="var(--text-primary)" />
        </Box>

        {/* Step content */}
        <Box flex={1} minW="0">
          <HStack gap={3} align="center" mb={1}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              {step.label}
            </Text>
            {!isChecking && !isIdle && (
              <StatusIcon status={state.status} />
            )}
            {isDone && (
              <Text fontSize="xs" fontWeight="600" color="var(--status-success)">Done</Text>
            )}
            {isError && (
              <Text fontSize="xs" fontWeight="600" color="var(--status-error)">Error</Text>
            )}
          </HStack>

          <Text fontSize="xs" color="var(--text-secondary)" mb={3}>
            {step.description}
          </Text>

          {/* Model download progress bar */}
          {step.id === 'model' && isRunning && (
            <Box mb={3}>
              <Progress.Root value={progress} size="sm">
                <Progress.Track>
                  <Progress.Range />
                </Progress.Track>
              </Progress.Root>
              <Text fontSize="11px" color="var(--text-secondary)" mt={1}>
                {progress}%
              </Text>
            </Box>
          )}

          {/* Detail text */}
          {state.detail && !isRunning && (
            <Text
              fontSize="11px"
              color={isError ? 'var(--status-error)' : 'var(--text-secondary)'}
              fontFamily="mono"
              wordBreak="break-all"
              mb={3}
            >
              {state.detail}
            </Text>
          )}

          {/* Action button or status */}
          <HStack gap={2}>
            {isChecking && (
              <HStack gap={1}>
                <Spinner size="xs" color="var(--text-secondary)" />
                <Text fontSize="xs" color="var(--text-secondary)">Checking…</Text>
              </HStack>
            )}

            {isIdle && (
              <Button
                size="sm"
                background="var(--accent-primary)"
                color="white"
                onClick={handleAction}
                _hover={{ opacity: 0.9 }}
              >
                <Icon as={step.id === 'model' ? LuDownload : LuLoader} boxSize="14px" mr={1} />
                {step.actionLabel}
              </Button>
            )}

            {isRunning && (
              <Button size="sm" variant="outline" disabled>
                <Spinner size="xs" mr={1} />
                {step.actionLabelRunning}
              </Button>
            )}

            {isError && (
              <Button
                size="sm"
                variant="outline"
                borderColor="var(--status-error)"
                color="var(--status-error)"
                onClick={handleAction}
                _hover={{ bg: 'var(--hover-bg)' }}
              >
                Retry
              </Button>
            )}
          </HStack>
        </Box>
      </HStack>
    </Box>
  );
};

// ── SetupWizard ────────────────────────────────────────────────────────────────

export const SetupWizard: React.FC<SetupWizardProps> = ({ onClose }) => {
  return (
    <Box p={6} display="flex" flexDirection="column" gap={5} minH="0" h="100%">
      {/* Header */}
      <HStack gap={3}>
        <Icon as={LuSettings2} boxSize="22px" color="var(--accent-primary)" />
        <Text fontSize="md" fontWeight="700" color="var(--text-primary)">Fredo Setup</Text>
      </HStack>

      {/* Step cards */}
      <VStack gap={4} align="stretch" flex={1}>
        {STEPS.map(step => (
          <StepCard key={step.id} step={step} />
        ))}
      </VStack>
    </Box>
  );
};
