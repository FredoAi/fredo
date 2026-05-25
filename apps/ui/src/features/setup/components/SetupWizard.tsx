import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, Code, HStack, Icon, Spinner, Text, VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck, LuCircleX, LuExternalLink, LuLoader, LuSettings2,
} from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { settingsService } from '../../settings';

type Screen = 'detecting' | 'review' | 'executing' | 'done';

interface SetupPlanStep {
  id: string;
  label: string;
  status: 'skipped' | 'needed' | 'blocked';
  command: string | null;
  detail?: string;
}

interface SetupPlan {
  steps: SetupPlanStep[];
  can_proceed: boolean;
  opencode_docs_url: string;
}

interface InstallResult { success: boolean; output: string; error?: string; }

interface SetupWizardProps {
  onClose?: () => void;
}

interface TaskState {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  command: string | null;
  detail?: string;
}

const StatusBadge: React.FC<{ status: SetupPlanStep['status'] }> = ({ status }) => {
  const config = {
    skipped: { color: 'var(--status-success)', icon: LuCircleCheck, label: 'Skipped' },
    needed: { color: 'var(--accent-primary)', icon: LuLoader, label: 'Needed' },
    blocked: { color: 'var(--status-error)', icon: LuCircleX, label: 'Blocked' },
  }[status];

  return (
    <HStack gap={1} flexShrink={0}>
      <Icon as={config.icon} boxSize="14px" color={config.color} />
      <Text fontSize="xs" fontWeight="600" color={config.color}>{config.label}</Text>
    </HStack>
  );
};

const ReviewRow: React.FC<{ step: SetupPlanStep }> = ({ step }) => (
  <HStack gap={3} align="flex-start" py={3} px={3} borderBottom="1px solid var(--border-color)">
    <Box pt="2px" flexShrink={0}>
      <StatusBadge status={step.status} />
    </Box>
    <Box flex={1}>
      <Text fontSize="sm" fontWeight="500" color="var(--text-primary)">{step.label}</Text>
      {step.detail && (
        <Text fontSize="11px" color="var(--text-secondary)" mt="2px">{step.detail}</Text>
      )}
      {step.command && (
        <Code mt={2} p={2} display="block" fontSize="11px" fontFamily="mono"
          bg="var(--bg-secondary)" color="var(--text-secondary)" whiteSpace="pre-wrap">
          {step.command}
        </Code>
      )}
    </Box>
  </HStack>
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
    <HStack gap={3} align="flex-start" py={3} px={3}
      bg={task.status === 'running' ? 'rgba(147,51,234,0.06)' : 'transparent'}>
      <Box pt="1px" flexShrink={0}>{iconEl}</Box>
      <Box flex={1}>
        <Text fontSize="sm" fontWeight={task.status === 'running' ? '600' : '500'} color={labelColor}>
          {task.label}
        </Text>
        {task.command && task.status === 'running' && (
          <Code mt={2} p={2} display="block" fontSize="11px" fontFamily="mono"
            bg="var(--bg-secondary)" color="var(--text-secondary)" whiteSpace="pre-wrap">
            {task.command}
          </Code>
        )}
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
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [tasks, setTasks] = useState<TaskState[]>([]);

  const patchTask = useCallback((id: string, patch: Partial<TaskState>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const setupPlan = await adapterBridge.invoke<SetupPlan>('get_setup_plan', {});
        if (setupPlan) {
          setPlan(setupPlan);
          setScreen('review');
        } else {
          setScreen('detecting');
        }
      } catch {
        setScreen('detecting');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const executeStep = useCallback(async (step: SetupPlanStep) => {
    patchTask(step.id, { status: 'running' });

    try {
      let result: { success: boolean; output?: string; error?: string } | undefined;

      switch (step.id) {
        case 'fredo-path': {
          const pathStatus = await adapterBridge.invoke<{ in_path: boolean; binary_path: string }>('check_fredo_in_path', {});
          if (pathStatus?.in_path) {
            patchTask(step.id, { status: 'skipped', detail: pathStatus.binary_path });
            return;
          }
          result = await adapterBridge.invoke<InstallResult>('add_fredo_to_path', {});
          if (result?.success) {
            patchTask(step.id, { status: 'done', detail: result.output || undefined });
          } else {
            patchTask(step.id, { status: 'error', detail: result?.error ?? result?.output });
          }
          break;
        }
        case 'plugin-install': {
          const installResult = await adapterBridge.invoke<InstallResult>('install_plugin', {});
          if (installResult?.success) {
            await settingsService.set('plugin_installed', 'true');
            patchTask(step.id, { status: 'done', detail: installResult.output || undefined });
          } else {
            patchTask(step.id, { status: 'error', detail: installResult?.error ?? installResult?.output });
          }
          break;
        }
        default:
          patchTask(step.id, { status: 'error', detail: 'Unknown step' });
      }
    } catch (err) {
      patchTask(step.id, { status: 'error', detail: String(err) });
    }
  }, [patchTask]);

  const executePlan = useCallback(async () => {
    if (!plan) return;

    const neededSteps = plan.steps.filter(s => s.status === 'needed');
    setTasks(neededSteps.map(step => ({
      id: step.id,
      label: step.label,
      status: 'pending' as const,
      command: step.command,
    })));

    setScreen('executing');

    for (const step of neededSteps) {
      await executeStep(step);
    }
  }, [plan, executeStep]);

  const handleRunAgain = useCallback(() => {
    setPlan(null);
    setTasks([]);
    setScreen('detecting');
    (async () => {
      try {
        const setupPlan = await adapterBridge.invoke<SetupPlan>('get_setup_plan', {});
        if (setupPlan) {
          setPlan(setupPlan);
          setScreen('review');
        }
      } catch {
        setScreen('detecting');
      }
    })();
  }, []);

  return (
    <Box p={6} display="flex" flexDirection="column" gap={5} minH="0" h="100%">
      <HStack gap={3}>
        <Icon as={LuSettings2} boxSize="22px" color="var(--accent-primary)" />
        <Box>
          <Text fontSize="md" fontWeight="700" color="var(--text-primary)">Fredo Setup</Text>
          <Text fontSize="xs" color="var(--text-secondary)">
            {screen === 'detecting' && 'Detecting environment…'}
            {screen === 'review' && 'Review and confirm changes'}
            {screen === 'executing' && 'Executing setup steps…'}
            {screen === 'done' && 'Setup complete'}
          </Text>
        </Box>
      </HStack>

      {screen === 'detecting' && (
        <VStack gap={3} align="center" py={8}>
          <Spinner size="lg" color="var(--accent-primary)" />
          <Text fontSize="sm" color="var(--text-secondary)">Detecting environment…</Text>
        </VStack>
      )}

      {screen === 'review' && plan && (
        <VStack gap={4} align="stretch" flex={1}>
          {!plan.can_proceed && (
            <Box p={3} borderRadius="md" bg="rgba(239,68,68,0.1)" border="1px solid rgba(239,68,68,0.3)">
              <HStack gap={2}>
                <Icon as={LuCircleX} boxSize="16px" color="var(--status-error)" />
                <Text fontSize="sm" fontWeight="600" color="var(--status-error)">OpenCode not found</Text>
              </HStack>
              <Text fontSize="xs" color="var(--text-secondary)" mt={1}>
                Install OpenCode to continue. See{' '}
                <a href={plan.opencode_docs_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>
                  <HStack gap={1} as="span" display="inline-flex">
                    <Text>installation guide</Text>
                    <Icon as={LuExternalLink} boxSize="12px" />
                  </HStack>
                </a>
              </Text>
            </Box>
          )}
          <Box borderRadius="lg" border="1px solid var(--border-color)" bg="var(--card-bg)" overflow="hidden">
            {plan.steps.map((step, i) => (
              <Box key={step.id} borderTop={i > 0 ? '1px solid var(--border-color)' : undefined}>
                <ReviewRow step={step} />
              </Box>
            ))}
          </Box>
          <HStack justify="flex-end" mt="auto" pt={2} gap={2}>
            <Button size="sm" variant="ghost" color="var(--text-secondary)" onClick={onClose}>Cancel</Button>
            <Button size="sm" background="var(--accent-primary)" color="white" disabled={!plan.can_proceed}
              onClick={executePlan} _hover={{ opacity: plan.can_proceed ? 0.9 : 1 }} _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}>
              Continue
            </Button>
          </HStack>
        </VStack>
      )}

      {screen === 'executing' && (
        <VStack gap={1} align="stretch" flex={1}>
          <Box borderRadius="lg" border="1px solid var(--border-color)" bg="var(--card-bg)" overflow="hidden">
            {tasks.map((task, i) => (
              <Box key={task.id} borderTop={i > 0 ? '1px solid var(--border-color)' : undefined}>
                <TaskRow task={task} />
              </Box>
            ))}
          </Box>
        </VStack>
      )}

      {screen === 'done' && (
        <VStack gap={4} align="stretch" flex={1}>
          <HStack gap={2}>
            <Icon as={LuCircleCheck} boxSize="17px" color="var(--status-success)" />
            <Text fontSize="sm" fontWeight="600" color="var(--status-success)">Setup complete</Text>
          </HStack>
          <Box borderRadius="lg" border="1px solid var(--border-color)" bg="var(--card-bg)" overflow="hidden">
            {tasks.map((task, i) => (
              <Box key={task.id} borderTop={i > 0 ? '1px solid var(--border-color)' : undefined}>
                <TaskRow task={task} />
              </Box>
            ))}
          </Box>
          <HStack justify="flex-end" mt="auto" pt={2} gap={2}>
            <Button size="sm" variant="ghost" color="var(--text-secondary)" onClick={handleRunAgain}>Run again</Button>
            <Button size="sm" background="var(--accent-primary)" color="white" onClick={onClose} _hover={{ opacity: 0.9 }}>Done</Button>
          </HStack>
        </VStack>
      )}
    </Box>
  );
};
