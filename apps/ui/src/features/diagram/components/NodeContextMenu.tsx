import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, HStack, Badge, IconButton, Grid, Tabs, For } from '@chakra-ui/react';
import type { K8sNodeData, TooltipButton, TooltipActionType } from './K8sNode';
import { getActionsForNodeType, type NodeAction } from '../utils/nodeActionRegistry';
import { buildPromptForNode } from '../utils/promptBuilder';
import { LuX } from 'react-icons/lu';

interface NodeContextMenuProps {
  id: string;
  initialTop: number;
  initialLeft: number;
  right?: boolean;
  data: K8sNodeData;
  nodePosition?: { x: number; y: number };
  offsetX?: number;
  offsetY?: number;
  onClose: () => void;
  onAction?: (action: TooltipActionType, node: K8sNodeData) => void;
  viewport?: { x: number; y: number; zoom: number };
}

export const NodeContextMenu: React.FC<NodeContextMenuProps> = ({
  initialTop,
  initialLeft,
  right = false,
  data,
  nodePosition,
  offsetX = 0,
  offsetY = 0,
  viewport,
  onClose,
  onAction,
}) => {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Get dynamic actions for this node type
  const actions = useMemo(() => getActionsForNodeType(data.type ?? ''), [data.type]);

  // Group by section
  const diagnostics = useMemo(() => actions.filter(a => a.section === 'Diagnostics'), [actions]);
  const operations = useMemo(() => actions.filter(a => a.section === 'Operations'), [actions]);
  const logsExec = useMemo(() => actions.filter(a => a.section === 'Logs & Exec'), [actions]);
  const aiAnalysis = useMemo(() => actions.filter(a => a.section === 'AI Analysis'), [actions]);

  // Handle action click - generate prompt and send to Agent
  const handleActionClick = useCallback((action: NodeAction) => {
    const prompt = buildPromptForNode(data, action.tool);
    
    window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
    
    console.log(`[NodeContextMenu] Sent prompt for ${action.tool}:`, prompt);
    onClose();
  }, [data, onClose]);

  const healthColor = 
    data.health === 'error' ? 'red' :
    data.health === 'warning' ? 'yellow' : 'green';

  // Calculate position: start with initial click position
  let finalTop = initialTop;
  let finalLeft = initialLeft;
  
  // If viewport changes, recalculate position relative to node
  if (nodePosition && viewport) {
    // Transform node position to screen coordinates
    const nodeScreenX = nodePosition.x * viewport.zoom + viewport.x;
    const nodeScreenY = nodePosition.y * viewport.zoom + viewport.y;
    
    // Apply the original offset from node to click position
    finalTop = nodeScreenY + offsetY;
    finalLeft = nodeScreenX + offsetX;
  }

  return (
    <Box
      position="absolute"
      top={`${finalTop}px`}
      left={`${finalLeft}px`}
      zIndex={1000}
      bg="var(--node-bg)"
      borderRadius="lg"
      boxShadow="0 4px 12px rgba(0, 0, 0, 0.5)"
      border="2px solid"
      borderColor="var(--border-color)"
      width="500px"
      maxHeight="600px"
      overflow="hidden"
      onClick={handleClick}
      fontFamily="var(--font-family)"
    >
      {/* Compact Header */}
      <HStack 
        p={3} 
        justifyContent="space-between" 
        borderBottom="2px solid" 
        borderColor="var(--border-color)"
        bg="var(--card-bg)"
      >
        <HStack gap={2}>
          <Text fontSize="md" fontWeight="bold" color="var(--text-primary)">
            {data.label}
          </Text>
          <Badge colorPalette={healthColor} variant="solid" fontSize="xs">
            {data.health || 'healthy'}
          </Badge>
        </HStack>
        <HStack gap={2} fontSize="xs" color="var(--text-secondary)">
          {data.namespace && <Text>{data.namespace}</Text>}
          {data.age && <Text>• {data.age}</Text>}
          <IconButton
            size="xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <LuX />
          </IconButton>
        </HStack>
      </HStack>

      {/* Quick Stats Row */}
      {(data.podStatus || data.deploymentStatus || data.serviceType) && (
        <HStack 
          p={2} 
          gap={3} 
          fontSize="xs" 
          bg="var(--card-hover-bg)" 
          borderBottom="1px solid" 
          borderColor="var(--border-color)"
          justifyContent="space-around"
        >
          {data.podStatus && (
            <HStack gap={1}>
              <Text color="var(--text-secondary)">Phase:</Text>
              <Badge 
                colorPalette={
                  data.podStatus.phase === 'Running' ? 'green' :
                  data.podStatus.phase === 'Pending' ? 'yellow' : 'red'
                }
                fontSize="2xs"
              >
                {data.podStatus.phase}
              </Badge>
            </HStack>
          )}
          {data.restartCount !== undefined && data.restartCount > 0 && (
            <HStack gap={1}>
              <Text color="var(--text-secondary)">Restarts:</Text>
              <Text color="var(--status-warning)" fontWeight="600">{data.restartCount}</Text>
            </HStack>
          )}
          {data.deploymentStatus && (
            <HStack gap={1}>
              <Text color="var(--text-secondary)">Replicas:</Text>
              <Text color="var(--text-primary)" fontWeight="600">
                {data.deploymentStatus.availableReplicas || 0}/{data.deploymentStatus.replicas}
              </Text>
            </HStack>
          )}
          {data.serviceType && (
            <HStack gap={1}>
              <Text color="var(--text-secondary)">Type:</Text>
              <Badge colorPalette="blue" fontSize="2xs">{data.serviceType}</Badge>
            </HStack>
          )}
        </HStack>
      )}

      {/* Issues Banner */}
      {data.issues && data.issues.length > 0 && (
        <HStack 
          p={2} 
          bg="rgba(239, 68, 68, 0.15)" 
          borderBottom="1px solid" 
          borderColor="var(--status-error)"
          fontSize="xs"
          color="var(--status-error)"
        >
          <Text fontWeight="600">⚠️</Text>
          <Text flex={1} lineClamp={1}>{data.issues[0]}</Text>
          {data.issues.length > 1 && (
            <Badge colorPalette="red" fontSize="2xs">+{data.issues.length - 1}</Badge>
          )}
        </HStack>
      )}

      {/* Action Grid - Horizontal Layout */}
      <Box p={3} maxHeight="450px" overflowY="auto">
        {/* Diagnostics */}
        {diagnostics.length > 0 && (
          <Box mb={3}>
            <Text fontSize="xs" fontWeight="600" color="var(--text-secondary)" mb={2}>
              🔍 DIAGNOSTICS
            </Text>
            <Grid templateColumns="repeat(2, 1fr)" gap={2}>
              {diagnostics.map((action, idx) => {
                return (
                  <Box
                    key={idx}
                    as="button"
                    p={2}
                    borderRadius="md"
                    border="1px solid"
                    borderColor="var(--border-color)"
                    bg="var(--card-bg)"
                    _hover={{ bg: 'rgba(147, 51, 234, 0.2)', borderColor: 'var(--accent-primary)' }}
                    cursor="pointer"
                    onClick={() => handleActionClick(action)}
                    textAlign="left"
                  >
                    <HStack gap={2} mb={1}>
                      <Box color="var(--accent-primary)" fontSize="sm" lineHeight="1">
                        {action.icon}
                      </Box>
                      <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
                        {action.label}
                      </Text>
                    </HStack>
                    <Text fontSize="2xs" color="var(--text-secondary)" lineClamp={1}>
                      {action.description}
                    </Text>
                  </Box>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* Logs & Exec */}
        {logsExec.length > 0 && (
          <Box mb={3}>
            <Text fontSize="xs" fontWeight="600" color="var(--text-secondary)" mb={2}>
              📝 LOGS & EXEC
            </Text>
            <Grid templateColumns="repeat(2, 1fr)" gap={2}>
              {logsExec.map((action, idx) => {
                return (
                  <Box
                    key={idx}
                    as="button"
                    p={2}
                    borderRadius="md"
                    border="1px solid"
                    borderColor="var(--border-color)"
                    bg="var(--card-bg)"
                    _hover={{ bg: 'rgba(147, 51, 234, 0.2)', borderColor: 'var(--accent-primary)' }}
                    cursor="pointer"
                    onClick={() => handleActionClick(action)}
                    textAlign="left"
                  >
                    <HStack gap={2} mb={1}>
                      <Box color="var(--accent-primary)" fontSize="sm" lineHeight="1">
                        {action.icon}
                      </Box>
                      <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
                        {action.label}
                      </Text>
                    </HStack>
                    <Text fontSize="2xs" color="var(--text-secondary)" lineClamp={1}>
                      {action.description}
                    </Text>
                  </Box>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* Operations */}
        {operations.length > 0 && (
          <Box mb={3}>
            <Text fontSize="xs" fontWeight="600" color="var(--text-secondary)" mb={2}>
              ⚙️ OPERATIONS
            </Text>
            <Grid templateColumns="repeat(2, 1fr)" gap={2}>
              {operations.map((action, idx) => {
                return (
                  <Box
                    key={idx}
                    as="button"
                    p={2}
                    borderRadius="md"
                    border="1px solid"
                    borderColor="var(--status-warning)"
                    bg="rgba(245, 158, 11, 0.1)"
                    _hover={{ bg: 'rgba(245, 158, 11, 0.2)', borderColor: 'var(--status-warning)' }}
                    cursor="pointer"
                    onClick={() => handleActionClick(action)}
                    textAlign="left"
                  >
                    <HStack gap={2} mb={1}>
                      <Box color="var(--status-warning)" fontSize="sm" lineHeight="1">
                        {action.icon}
                      </Box>
                      <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
                        {action.label}
                      </Text>
                    </HStack>
                    <Text fontSize="2xs" color="var(--text-secondary)" lineClamp={1}>
                      {action.description}
                    </Text>
                  </Box>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* AI Analysis */}
        {aiAnalysis.length > 0 && (
          <Box>
            <Text fontSize="xs" fontWeight="600" color="var(--text-secondary)" mb={2}>
              🤖 AI ANALYSIS
            </Text>
            <Grid templateColumns="repeat(2, 1fr)" gap={2}>
              {aiAnalysis.map((action, idx) => {
                return (
                  <Box
                    key={idx}
                    as="button"
                    p={2}
                    borderRadius="md"
                    border="1px solid"
                    borderColor="var(--status-info)"
                    bg="rgba(59, 130, 246, 0.1)"
                    _hover={{ bg: 'rgba(59, 130, 246, 0.2)', borderColor: 'var(--status-info)' }}
                    cursor="pointer"
                    onClick={() => handleActionClick(action)}
                    textAlign="left"
                  >
                    <HStack gap={2} mb={1}>
                      <Box color="var(--status-info)" fontSize="sm" lineHeight="1">
                        {action.icon}
                      </Box>
                      <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
                        {action.label}
                      </Text>
                    </HStack>
                    <Text fontSize="2xs" color="var(--text-secondary)" lineClamp={1}>
                      {action.description}
                    </Text>
                  </Box>
                );
              })}
            </Grid>
          </Box>
        )}
      </Box>
    </Box>
  );
};
