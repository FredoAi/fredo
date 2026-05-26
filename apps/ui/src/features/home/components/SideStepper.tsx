import React, { useState, useEffect, useRef } from 'react';
import { Box, VStack, Text } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { LuCheck, LuClock, LuX, LuRefreshCw, LuCircleX } from 'react-icons/lu';
import { useStream } from '../../../shared/contexts/StreamContext';
import { STEP_STATUSES } from '../../../shared/constants';

interface Step {
  name: string;
  description: string;
  status: typeof STEP_STATUSES[keyof typeof STEP_STATUSES];
  needsPermit: boolean;
  triggerEvent?: string;
}

const STATUS_COLORS: Record<string, string> = {
  [STEP_STATUSES.COMPLETED]: 'var(--status-success)',
  [STEP_STATUSES.RUNNING]: 'var(--accent-primary)',
  [STEP_STATUSES.ERROR]: 'var(--status-error)',
  [STEP_STATUSES.WAITING]: 'var(--text-secondary)',
};

const StepIcon: React.FC<{ status: Step['status'] }> = ({ status }) => {
  const color = STATUS_COLORS[status] ?? 'var(--text-secondary)';
  if (status === STEP_STATUSES.RUNNING) {
    return (
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <LuRefreshCw size={20} color={color} />
      </motion.div>
    );
  }
  if (status === STEP_STATUSES.COMPLETED) return <LuCheck size={20} color={color} />;
  if (status === STEP_STATUSES.ERROR) return <LuX size={20} color={color} />;
  return <LuClock size={20} color={color} />;
};

export const SideStepper: React.FC = () => {
  const [steps, setSteps] = useState<Step[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipTop, setTooltipTop] = useState<number>(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { events } = useStream();
  const processedEventIdsRef = useRef<Set<string>>(new Set());
  const lastUpdateTimeRef = useRef<number>(Date.now());
  const pendingCompletionsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      pendingCompletionsRef.current.forEach(id => clearTimeout(id));
      pendingCompletionsRef.current.clear();
    };
  }, []);

  const handleClose = () => setSteps([]);

  // Process all stream events — stepper Init initializes steps, other tool events drive step statuses
  useEffect(() => {
    if (events.length === 0) return;

    events.forEach((event) => {
      const eventKey = `${event.id || event.timestamp}-${event.toolName}-${event.state}`;
      if (processedEventIdsRef.current.has(eventKey)) return;
      processedEventIdsRef.current.add(eventKey);

      // Fredo_ui_stepper Init → initialize the steps list
      if (event.toolName === 'Fredo_ui_stepper' && event.state === 'Init' && event.payload && typeof event.payload === 'object' && 'steps' in event.payload) {
        let newSteps: Step[] = ((event.payload as any).steps).map((s: any) => ({
          name: typeof s === 'string' ? s : (s.title || s.name || ''),
          description: typeof s === 'string' ? '' : (s.description || s.triggerEvent || ''),
          status: STEP_STATUSES.WAITING,
          needsPermit: typeof s === 'string' ? false : (s.needsPermit || false),
          triggerEvent: typeof s === 'string' ? undefined : s.triggerEvent,
        }));

        // Retroactively apply all tool events already in the stream.
        // This handles the common case where MCP tools fire before the stepper
        // UI is initialized (e.g. when SSE connects mid-session).
        for (const pastEvent of events) {
          if (pastEvent.toolName === 'Fredo_ui_stepper') continue;
          const pastKey = `${pastEvent.id || pastEvent.timestamp}-${pastEvent.toolName}-${pastEvent.state}`;
          processedEventIdsRef.current.add(pastKey); // prevent outer forEach from reprocessing
          newSteps = newSteps.map((step) => {
            if (!step.triggerEvent || step.triggerEvent !== pastEvent.toolName) return step;
            if (pastEvent.state === 'Init' && step.status === STEP_STATUSES.WAITING) {
              return { ...step, status: STEP_STATUSES.RUNNING };
            }
            if (pastEvent.state === 'Response' && (step.status === STEP_STATUSES.WAITING || step.status === STEP_STATUSES.RUNNING)) {
              return { ...step, status: STEP_STATUSES.COMPLETED };
            }
            return step;
          });
        }

        setSteps(newSteps);
        lastUpdateTimeRef.current = Date.now();
        console.log('[TopStepper] Initialized:', newSteps.map(s => `${s.name}:${s.status}`));
        return;
      }

      if (event.toolName === 'Fredo_ui_stepper') return;

      // Init → immediately set step to Running, cancel any pending completion for this tool
      if (event.state === 'Init') {
        const pending = pendingCompletionsRef.current.get(event.toolName);
        if (pending) {
          clearTimeout(pending);
          pendingCompletionsRef.current.delete(event.toolName);
        }
        setSteps((currentSteps) => {
          if (currentSteps.length === 0) return currentSteps;
          let changed = false;
          const updated = currentSteps.map((step) => {
            if (!step.triggerEvent || step.triggerEvent !== event.toolName) return step;
            if (step.status !== STEP_STATUSES.RUNNING) {
              changed = true;
              return { ...step, status: STEP_STATUSES.RUNNING };
            }
            return step;
          });
          if (changed) lastUpdateTimeRef.current = Date.now();
          return changed ? updated : currentSteps;
        });
        return;
      }

      // Response → ensure Running is rendered first, then set Completed after 400ms
      // (guards against React batching Init+Response in the same render cycle)
      if (event.state === 'Response') {
        // First: if step is still Waiting (Init was batched), set it to Running so the spinner shows
        setSteps((currentSteps) => {
          if (currentSteps.length === 0) return currentSteps;
          let changed = false;
          const updated = currentSteps.map((step) => {
            if (!step.triggerEvent || step.triggerEvent !== event.toolName) return step;
            if (step.status === STEP_STATUSES.WAITING) {
              changed = true;
              return { ...step, status: STEP_STATUSES.RUNNING };
            }
            return step;
          });
          if (changed) lastUpdateTimeRef.current = Date.now();
          return changed ? updated : currentSteps;
        });

        // Then: set Completed after 400ms so the Running state is always visibly rendered,
        // then auto-advance the next WAITING step to RUNNING
        const timerId = setTimeout(() => {
          pendingCompletionsRef.current.delete(event.toolName);
          setSteps((currentSteps) => {
            if (currentSteps.length === 0) return currentSteps;
            let changed = false;
            const hasRealTrigger = (s: Step) => !!s.triggerEvent && s.triggerEvent !== 'none';
            let updated = currentSteps.map((step) => {
              if (!step.triggerEvent || step.triggerEvent !== event.toolName) return step;
              if (step.status === STEP_STATUSES.RUNNING) {
                changed = true;
                return { ...step, status: STEP_STATUSES.COMPLETED };
              }
              return step;
            });
            if (changed) {
              lastUpdateTimeRef.current = Date.now();
              console.log('[TopStepper] → Completed:', event.toolName);
              // If all triggered steps are now done, auto-complete any static (no triggerEvent) steps
              const allTriggeredDone = updated
                .filter(hasRealTrigger)
                .every(s => s.status === STEP_STATUSES.COMPLETED);
              if (allTriggeredDone) {
                updated = updated.map(s =>
                  !hasRealTrigger(s) && s.status !== STEP_STATUSES.COMPLETED
                    ? { ...s, status: STEP_STATUSES.COMPLETED }
                    : s
                );
              }
            }
            return changed ? updated : currentSteps;
          });
        }, 400);
        pendingCompletionsRef.current.set(event.toolName, timerId);
        return;
      }

      // Error → cancel pending completion and set Error immediately
      if (event.state === 'Error') {
        const pending = pendingCompletionsRef.current.get(event.toolName);
        if (pending) {
          clearTimeout(pending);
          pendingCompletionsRef.current.delete(event.toolName);
        }
        setSteps((currentSteps) => {
          if (currentSteps.length === 0) return currentSteps;
          let changed = false;
          const updated = currentSteps.map((step) => {
            if (!step.triggerEvent || step.triggerEvent !== event.toolName) return step;
            if (step.status !== STEP_STATUSES.ERROR) {
              changed = true;
              return { ...step, status: STEP_STATUSES.ERROR };
            }
            return step;
          });
          if (changed) lastUpdateTimeRef.current = Date.now();
          return changed ? updated : currentSteps;
        });
      }
    });
  }, [events]);

  return (
    <AnimatePresence>
      {steps.length > 0 && (
        <motion.div
          key="side-stepper"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 56, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          style={{ width: '56px', height: '100%', flexShrink: 0, zIndex: 1000, overflow: 'hidden' }}
        >
          <Box
            background="var(--card-bg)"
            borderRight="1px solid var(--border-color)"
            backdropFilter="blur(10px)"
            boxShadow="4px 0 12px rgba(0, 0, 0, 0.15)"
            width="56px"
            height="100%"
          >
            <VStack gap={0} align="stretch" height="100%">
              {steps.map((step, index) => (
                <Box
                  key={index}
                  ref={(el: HTMLDivElement | null) => { rowRefs.current[index] = el; }}
                  padding={3}
                  borderBottom={index < steps.length - 1 ? '1px solid var(--border-color)' : 'none'}
                  onMouseEnter={() => {
                    const el = rowRefs.current[index];
                    if (el) {
                      const rect = el.getBoundingClientRect();
                      setTooltipTop(rect.top + rect.height / 2);
                    }
                    setHoveredIndex(index);
                  }}
                  onMouseLeave={() => setHoveredIndex(null)}
                  cursor="default"
                >
                  {/* Icon — always visible */}
                  <Box
                    width="24px"
                    height="24px"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <StepIcon status={step.status} />
                  </Box>
                </Box>
              ))}

              {/* Spacer pushes close button to the bottom */}
              <Box flex="1" />

              {/* Close button */}
              <Box
                padding={3}
                borderTop="1px solid var(--border-color)"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                onClick={handleClose}
                color="var(--text-secondary)"
                _hover={{ color: 'var(--status-error)' }}
                style={{ transition: 'color 0.15s' }}
                title="Dismiss"
              >
                <LuCircleX size={18} />
              </Box>
            </VStack>
          </Box>

          {/* Tooltip rendered at motion.div level with position:fixed to escape overflow:hidden parents */}
          <AnimatePresence>
            {hoveredIndex !== null && steps[hoveredIndex] && (
              <motion.div
                key={`tooltip-${hoveredIndex}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.15 }}
                style={{
                  position: 'fixed',
                  left: '64px',
                  top: tooltipTop,
                  transform: 'translateY(-50%)',
                  zIndex: 9999,
                  pointerEvents: 'none',
                }}
              >
                <Box
                  background="var(--card-bg)"
                  border="1px solid var(--border-color)"
                  backdropFilter="blur(10px)"
                  boxShadow="4px 4px 16px rgba(0, 0, 0, 0.25)"
                  borderRadius="md"
                  padding={3}
                  minWidth="180px"
                  maxWidth="260px"
                >
                  <VStack gap={1} align="flex-start">
                    <Text
                      fontSize="sm"
                      fontWeight="600"
                      color="var(--text-primary)"
                      lineHeight="1.3"
                      whiteSpace="nowrap"
                    >
                      {steps[hoveredIndex].name}
                    </Text>
                    {steps[hoveredIndex].description && (
                      <Text
                        fontSize="xs"
                        color="var(--text-secondary)"
                        lineHeight="1.3"
                      >
                        {steps[hoveredIndex].description}
                      </Text>
                    )}
                  </VStack>
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
