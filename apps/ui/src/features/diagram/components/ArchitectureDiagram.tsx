import React, { useCallback, useMemo, useState, useEffect, MouseEvent as ReactMouseEvent } from 'react';
import { Box, Spinner, Text, VStack, Button, HStack, Input, IconButton, Collapsible, Checkbox } from '@chakra-ui/react';
import { LuFilter } from 'react-icons/lu';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  MiniMap,
  NodeTypes,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';

// Fallback type for onNodeContextMenu since it's not exported from this version of reactflow
type OnNodeContextMenu = (event: React.MouseEvent, node: Node) => void;
import { useExtension } from '../../../app/providers/ExtensionProvider';
import { useDiagram } from '../hooks/useDiagram';
import { K8sNode, K8sNodeData } from './K8sNode';
import { NodeContextMenu } from './NodeContextMenu';
import { resolveCollisions } from '../utils/resolveCollisions';

interface ArchitectureDiagramProps {
  onFocusComplete?: () => void;
}

export const ArchitectureDiagram: React.FC<ArchitectureDiagramProps> = ({ onFocusComplete }) => {
  const { setShowDiagram } = useExtension();
  const { nodes: diagramNodes, edges: diagramEdges, loading, error } = useDiagram();
  const [nodes, setNodes, onNodesChange] = useNodesState(diagramNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(diagramEdges);
  const { project, getViewport } = useReactFlow();
  
  // Context menu state
  const [menu, setMenu] = useState<{
    id: string;
    initialTop: number;
    initialLeft: number;
    right?: boolean;
    data: K8sNodeData;
    nodePosition: { x: number; y: number };
    initialViewport: { x: number; y: number; zoom: number };
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // Track viewport for context menu positioning
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [matchedNodeIds, setMatchedNodeIds] = useState<string[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const { fitView } = useReactFlow();
  
  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [resourceTypeFilters, setResourceTypeFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [namespaceFilters, setNamespaceFilters] = useState<Set<string>>(new Set());
  const filterPanelRef = React.useRef<HTMLDivElement>(null);
  const filterButtonRef = React.useRef<HTMLButtonElement>(null);
  const isFirstLoadRef = React.useRef(true);
  const previousFilterStateRef = React.useRef({ types: 0, status: 0, namespaces: 0 });
  const focusInProgressRef = React.useRef(false);
  
  // Close filter panel when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!showFilters) return;
      
      const target = event.target as Element;
      const clickedInsidePanel = filterPanelRef.current?.contains(target);
      const clickedOnButton = filterButtonRef.current?.contains(target);
      
      if (!clickedInsidePanel && !clickedOnButton) {
        setShowFilters(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showFilters]);
  
  // Define custom node types
  const nodeTypes: NodeTypes = useMemo(() => ({
    k8sNode: K8sNode,
  }), []);
  
  // Memoize fitViewOptions to prevent unnecessary re-renders
  const fitViewOptions = useMemo(() => ({
    padding: 0.3,
    minZoom: 0.5,
    maxZoom: 1.5
  }), []);
  
  // Pro options to hide attribution (performance boost)
  const proOptions = useMemo(() => ({ hideAttribution: true }), []);
  
  // Extract available namespaces from nodes
  const availableNamespaces = useMemo(() => {
    const namespaces = new Set<string>();
    diagramNodes.forEach(node => {
      const data = node.data as K8sNodeData;
      // Add namespace nodes
      if (data.type === 'namespace') {
        namespaces.add(data.label);
      }
      // Also add namespaces from other resources (skip empty/null/undefined)
      if (data.namespace && data.namespace.trim() !== '') {
        namespaces.add(data.namespace);
      }
    });
    return Array.from(namespaces).sort();
  }, [diagramNodes]);

  // Calculate counts for filters
  const filterCounts = useMemo(() => {
    const counts = {
      resourceTypes: {} as Record<string, number>,
      statuses: {} as Record<string, number>,
      namespaces: {} as Record<string, number>,
    };

    diagramNodes.forEach(node => {
      const data = node.data as K8sNodeData;
      
      // Count resource types
      counts.resourceTypes[data.type ?? 'unknown'] = (counts.resourceTypes[data.type ?? 'unknown'] || 0) + 1;
      
      // Count statuses (treat undefined as 'unknown')
      const status = (data as any).status || 'unknown';
      counts.statuses[status] = (counts.statuses[status] || 0) + 1;
      
      // Count namespaces (skip empty/null/undefined)
      if (data.namespace && data.namespace.trim() !== '') {
        counts.namespaces[data.namespace] = (counts.namespaces[data.namespace] || 0) + 1;
      }
    });

    return counts;
  }, [diagramNodes]);

  // Initialize namespace filters when namespaces are loaded
  React.useEffect(() => {
    if (availableNamespaces.length > 0 && namespaceFilters.size === 0) {
      setNamespaceFilters(new Set(availableNamespaces));
    }
  }, [availableNamespaces]);

  React.useEffect(() => {
    if (diagramNodes && diagramEdges) {
      console.log('Filter state - Types:', resourceTypeFilters.size, 'Status:', statusFilters.size, 'Namespaces:', namespaceFilters.size);
      
      // Apply filters to nodes
      const filteredNodes = diagramNodes.map(node => {
        const data = node.data as K8sNodeData;
        // If filter set is empty, show all for that category
        const typeMatch = resourceTypeFilters.size === 0 || resourceTypeFilters.has(data.type ?? '');
        // Treat undefined/null status as 'unknown'
        const nodeStatus = (data as any).status || 'unknown';
        const statusMatch = statusFilters.size === 0 || statusFilters.has(nodeStatus);
        const namespaceMatch = data.type === 'namespace' || data.type === 'node' || !data.namespace || namespaceFilters.size === 0 || namespaceFilters.has(data.namespace);
        const visible = typeMatch && statusMatch && namespaceMatch;
        
        return {
          ...node,
          hidden: !visible,
        };
      });
      
      const visibleNodeCount = filteredNodes.filter(n => !n.hidden).length;
      // Reposition visible nodes in a compact layout
      const visibleNodes = filteredNodes.filter(n => !n.hidden);
      const HORIZONTAL_SPACING = 320;
      const VERTICAL_SPACING = 250;
      const NODES_PER_ROW = 8;
      
      // Group visible nodes by type
      const nodesByType = new Map<string, Node[]>();
      const typeOrder = ['namespace', 'ingress', 'service', 'deployment', 'statefulset', 'daemonset', 'pod', 'node'];
      
      visibleNodes.forEach(node => {
        const data = node.data as K8sNodeData;
        const type = data.type ?? 'unknown';
        if (!nodesByType.has(type)) {
          nodesByType.set(type, []);
        }
        nodesByType.get(type)!.push(node);
      });
      // Reposition nodes in compact layout
      let currentY = 0;
      const repositionedNodes = new Map<string, { x: number, y: number }>();
      
      typeOrder.forEach(type => {
        const nodesOfType = nodesByType.get(type) || [];
        if (nodesOfType.length === 0) return;
        
        nodesOfType.forEach((node, index) => {
          const row = Math.floor(index / NODES_PER_ROW);
          const col = index % NODES_PER_ROW;
          
          const rowWidth = Math.min(nodesOfType.length - row * NODES_PER_ROW, NODES_PER_ROW) * HORIZONTAL_SPACING;
          const startX = -rowWidth / 2;
          
          repositionedNodes.set(node.id, {
            x: startX + col * HORIZONTAL_SPACING + HORIZONTAL_SPACING / 2,
            y: currentY + row * VERTICAL_SPACING
          });
        });
        
        const maxRows = Math.ceil(nodesOfType.length / NODES_PER_ROW);
        currentY += maxRows * VERTICAL_SPACING + VERTICAL_SPACING * 0.5;
      });
      
      // Apply new positions to filtered nodes
      const layoutedNodes = filteredNodes.map(node => {
        if (node.hidden) return node;
        const newPos = repositionedNodes.get(node.id);
        if (newPos) {
          return {
            ...node,
            position: newPos
          };
        }
        return node;
      });
      
      // Apply collision resolution to prevent overlaps
      const collisionFreeNodes = resolveCollisions(layoutedNodes, {
        nodeWidth: 250,
        nodeHeight: 100,
        margin: 40,
        maxIterations: 200,
        overlapThreshold: 0.8,
      });
      
      setNodes(collisionFreeNodes);
      setEdges(diagramEdges);
      
      // Only fit view on first load or when filters actually change
      const currentFilterState = { 
        types: resourceTypeFilters.size, 
        status: statusFilters.size, 
        namespaces: namespaceFilters.size 
      };
      
      const filtersChanged = 
        currentFilterState.types !== previousFilterStateRef.current.types ||
        currentFilterState.status !== previousFilterStateRef.current.status ||
        currentFilterState.namespaces !== previousFilterStateRef.current.namespaces;
      
      if (isFirstLoadRef.current || filtersChanged) {
        requestAnimationFrame(() => {
          fitView({ duration: 400, padding: 0.1 });
        });
        isFirstLoadRef.current = false;
        previousFilterStateRef.current = currentFilterState;
      }
    }
  }, [diagramNodes, diagramEdges, resourceTypeFilters, statusFilters, namespaceFilters, setNodes, setEdges, fitView]);
  
  // Re-fit view when container size changes (e.g., grid layout changes)
  React.useEffect(() => {
    const handleResize = () => {
      requestAnimationFrame(() => {
        fitView({ duration: 200, padding: 0.1 });
      });
    };
    
    // Use ResizeObserver to detect container size changes
    const container = document.querySelector('.react-flow');
    if (!container) {
      const timeoutId = setTimeout(handleResize, 300);
      return () => clearTimeout(timeoutId);
    }
    
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    
    resizeObserver.observe(container);
    
    // Also trigger on mount
    const timeoutId = setTimeout(handleResize, 100);
    
    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeoutId);
    };
  }, [fitView]);
  
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );
  
  const handleClose = () => {
    setShowDiagram(false);
  };

  // Filter handlers
  const toggleResourceType = (type: string) => {
    setResourceTypeFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        newSet.delete(type);
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  };

  const toggleStatus = (status: string) => {
    setStatusFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(status)) {
        newSet.delete(status);
      } else {
        newSet.add(status);
      }
      return newSet;
    });
  };

  const toggleNamespace = (ns: string) => {
    setNamespaceFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(ns)) {
        newSet.delete(ns);
      } else {
        newSet.add(ns);
      }
      return newSet;
    });
  };

  // Handle right-click on nodes
  const onNodeContextMenu: OnNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: Node) => {
      event.preventDefault();
      
      // Calculate if menu should appear on right or left
      const shouldBeRight = event.clientX > window.innerWidth / 2;
      
      // Get current viewport
      const currentViewport = getViewport();
      
      // Calculate node screen position
      const nodeScreenX = node.position.x * currentViewport.zoom + currentViewport.x;
      const nodeScreenY = node.position.y * currentViewport.zoom + currentViewport.y;
      
      // Calculate offset from node to click position
      const offsetX = event.clientX - nodeScreenX;
      const offsetY = event.clientY - nodeScreenY;
      
      setMenu({
        id: node.id,
        initialTop: event.clientY,
        initialLeft: event.clientX,
        right: shouldBeRight,
        data: node.data as K8sNodeData,
        nodePosition: node.position,
        initialViewport: currentViewport,
        offsetX,
        offsetY,
      });
      
      setViewport(currentViewport);
    },
    [setMenu, getViewport]
  );

  // Close context menu on click anywhere
  const onPaneClick = useCallback(() => {
    setMenu(null);
  }, [setMenu]);

  // Track viewport changes for context menu positioning
  const handleMove = useCallback(() => {
    if (menu) {
      setViewport(getViewport());
    }
  }, [menu, getViewport]);

  // Handle search
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    
    if (!query.trim()) {
      // Reset all nodes to default style and return to default view
      setMatchedNodeIds([]);
      setCurrentMatchIndex(0);
      setNodes((nds) =>
        nds.map((node) => ({
          ...node,
          style: { ...node.style, opacity: 1 },
        }))
      );
      // Return to default view showing all nodes
      requestAnimationFrame(() => {
        fitView({ duration: 500 });
      });
      return;
    }

    const searchLower = query.toLowerCase();
    const matchedIds: string[] = [];

    setNodes((nds) => {
      const updatedNodes = nds.map((node) => {
        const data = node.data as K8sNodeData;
        const matches = 
          data.label?.toLowerCase().includes(searchLower) ||
          data.namespace?.toLowerCase().includes(searchLower) ||
          data.type?.toLowerCase().includes(searchLower);

        if (matches) {
          matchedIds.push(node.id);
        }

        return {
          ...node,
          style: {
            ...node.style,
            opacity: matches ? 1 : 0.3,
          },
        };
      });

      // Update matched nodes and reset to first match
      setMatchedNodeIds(matchedIds);
      setCurrentMatchIndex(0);

      // Trigger fitView for first match
      if (matchedIds.length > 0) {
        const firstMatchNode = updatedNodes.find(n => n.id === matchedIds[0]);
        if (firstMatchNode) {
          requestAnimationFrame(() => {
            fitView({
              nodes: [firstMatchNode],
              duration: 500,
              padding: 0.8,
              maxZoom: 1.2,
            });
          });
        }
      }

      return updatedNodes;
    });
  }, [fitView, setNodes]);

  // Cycle to next match on Enter key
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && matchedNodeIds.length > 1) {
      e.preventDefault();
      
      // Cycle to next match
      const nextIndex = (currentMatchIndex + 1) % matchedNodeIds.length;
      setCurrentMatchIndex(nextIndex);
      
      // Find and focus the next matched node
      const nextNodeId = matchedNodeIds[nextIndex];
      const nextNode = nodes.find(n => n.id === nextNodeId);
      
      if (nextNode) {
        fitView({
          nodes: [nextNode],
          duration: 500,
          padding: 0.8,
          maxZoom: 1.2,
        });
      }
    }
  }, [matchedNodeIds, currentMatchIndex, nodes, fitView]);

  // Auto-focus on kubectl operation target - listen for custom events
  useEffect(() => {
    console.log('[ArchitectureDiagram] 🎧 Event listener attached for diagram-focus-node');
    
    const handleFocusEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ namespace: string; name: string; toolName?: string }>;
      const focusTarget = customEvent.detail;
      
      console.log('[ArchitectureDiagram] 📡 Received diagram-focus-node event:', focusTarget);
      
      if (!focusTarget) {
        onFocusComplete?.();
        return;
      }

      const focusKey = `${focusTarget.namespace}/${focusTarget.name}`;

      // Skip if focus animation is still in progress (safety — DiagramFeature
      // already gates this, but guard defensively).
      if (focusInProgressRef.current) {
        console.log(`[ArchitectureDiagram] Focus in progress, skipping ${focusKey}`);
        // Don't call onFocusComplete here — let the current focus finish naturally
        return;
      }

      console.log(`[ArchitectureDiagram] Auto-focusing on ${focusKey}`);
      focusInProgressRef.current = true;

      // Schedule the focus operation (small delay for layout)
      setTimeout(() => {
        setNodes((currentNodes) => {
          console.log(`[ArchitectureDiagram] Searching for node: namespace="${focusTarget.namespace}", name="${focusTarget.name}"`);
          console.log(`[ArchitectureDiagram] Available nodes:`, currentNodes.filter(n => !n.hidden).map(n => ({
            label: (n.data as K8sNodeData).label,
            namespace: (n.data as K8sNodeData).namespace,
            type: (n.data as K8sNodeData).type
          })));
          
          // Exact match only - no fuzzy matching
          const targetNode = currentNodes.find(node => {
            const data = node.data as K8sNodeData;
            return !node.hidden && data.namespace === focusTarget.namespace && data.label === focusTarget.name;
          });

          if (!targetNode) {
            console.log(`[ArchitectureDiagram] ❌ No exact match found for "${focusTarget.name}" in namespace "${focusTarget.namespace}" — skipping focus`);
            focusInProgressRef.current = false;
            onFocusComplete?.();
            return currentNodes;
          }

          console.log(`[ArchitectureDiagram] ✅ Zooming to node:`, targetNode.id);

          // Zoom to node
          fitView({
            nodes: [targetNode],
            duration: 400,
            padding: 0.3,
            maxZoom: 1.5,
          });

          // Clear focus class after dwell time (0.5s) and signal completion
          const matchedId = targetNode.id;
          setTimeout(() => {
            setNodes((nds) => nds.map((n) => ({ ...n, className: '' })));
            focusInProgressRef.current = false;
            onFocusComplete?.();
          }, 500);

          // Add focus class to targeted node
          return currentNodes.map((node) => ({
            ...node,
            className: node.id === matchedId ? 'focused-node' : '',
          }));
        });
      }, 150);
    };

    // Listen for custom focus events
    window.addEventListener('diagram-focus-node', handleFocusEvent);
    
    return () => {
      console.log('[ArchitectureDiagram] 🔇 Event listener removed for diagram-focus-node');
      window.removeEventListener('diagram-focus-node', handleFocusEvent);
    };
  }, [fitView, setNodes, onFocusComplete]); // No focusTarget dependency!

  // Handle action buttons from context menu
  const handleAction = useCallback((action: string, nodeData: K8sNodeData) => {
    // Generate prompt based on action and node data
    let prompt = '';
    
    switch (action) {
      case 'check-logs':
        prompt = `Check logs for ${nodeData.type} ${nodeData.label} in namespace ${nodeData.namespace}`;
        break;
      case 'improvement-analysis':
        prompt = `Analyze improvement opportunities for ${nodeData.type} ${nodeData.label} in namespace ${nodeData.namespace}`;
        break;
      case 'run-hotfix':
        prompt = `Suggest hotfix for ${nodeData.type} ${nodeData.label} in namespace ${nodeData.namespace}`;
        if (nodeData.issues && nodeData.issues.length > 0) {
          prompt += `. Current issues: ${nodeData.issues.join(', ')}`;
        }
        break;
    }
    
    // Send message to chat
    if (prompt) {
      window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
    }
    
    setMenu(null);
  }, []);
  
  if (loading && nodes.length === 0) {
    return (
      <Box 
        display="flex" 
        alignItems="center" 
        justifyContent="center" 
        height="100vh"
        background="var(--body-bg)"
      >
        <VStack gap={4}>
          <Text color="var(--text-primary)" fontSize="lg" fontFamily="var(--font-base)">Loading K8s infrastructure...</Text>
        </VStack>
      </Box>
    );
  }
  
  if (error && nodes.length === 0) {
    return (
      <Box 
        display="flex" 
        alignItems="center" 
        justifyContent="center" 
        height="100vh"
        background="var(--body-bg)"
      >
        <VStack gap={4} p={8} background="var(--card-bg)" borderRadius="lg" backdropFilter="blur(10px)" border="2px solid" borderColor="var(--border-color)">
          <Text color="red.300" fontSize="lg" fontWeight="600" fontFamily="var(--font-secondary)">⚠️ Failed to Load Diagram</Text>
          <Text color="var(--text-primary)" textAlign="center" fontFamily="var(--font-base)">{error}</Text>
          <Button onClick={handleClose} variant="outline" color="white">
            Back
          </Button>
        </VStack>
      </Box>
    );
  }
  
  return (
    <Box height="100%" width="100%" position="relative" background="var(--body-bg)" fontFamily="var(--font-family)">
      {/* Header Controls */}
      <HStack 
        position="absolute" 
        top={4} 
        left={4} 
        right={4} 
        zIndex={10} 
        gap={3}
        justifyContent="space-between"
      >
        {/* Left side - Live Indicator & Search */}
        <HStack gap={3}>
          {/* Live Indicator */}
          <HStack 
            px={4} 
            py={2} 
            background="var(--card-bg)" 
            border="1px solid"
            borderColor="var(--border-color)"
            borderRadius="md"
            backdropFilter="blur(10px)"
          >
            <Box
              width="8px"
              height="8px"
              borderRadius="full"
              background="var(--accent-primary)"
              animation="pulse 2s infinite"
            />
            <Text fontSize="xs" color="var(--text-primary)" fontWeight="500" fontFamily="var(--font-base)">
              Live
            </Text>
          </HStack>

          {/* Search Input with Counter */}
          <HStack gap={0} position="relative">
            <Input
              placeholder="Search nodes..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              size="sm"
              width="240px"
              background="var(--card-bg)"
              border="1px solid"
              borderColor="var(--border-color)"
              color="var(--text-primary)"
              fontSize="xs"
              _placeholder={{ color: 'var(--text-secondary)' }}
              _focus={{
                borderColor: 'var(--accent-primary)',
                outline: 'none'
              }}
              paddingRight={matchedNodeIds.length > 0 ? "45px" : "8px"}
            />
            {matchedNodeIds.length > 0 && (
              <Box
                position="absolute"
                right="8px"
                top="50%"
                transform="translateY(-50%)"
                pointerEvents="none"
              >
                <Text
                  fontSize="xs"
                  color="var(--text-secondary)"
                  fontWeight="500"
                  background="var(--card-bg)"
                  px={2}
                  borderRadius="sm"
                >
                  {currentMatchIndex + 1}/{matchedNodeIds.length}
                </Text>
              </Box>
            )}
          </HStack>

          {/* Filter Icon Button */}
          <IconButton
            ref={filterButtonRef}
            aria-label="Toggle filters"
            onClick={() => setShowFilters(!showFilters)}
            size="sm"
            background={showFilters ? 'var(--accent-primary)' : 'var(--card-bg)'}
            border="1px solid"
            borderColor={showFilters ? 'var(--accent-primary)' : 'var(--border-color)'}
            color={showFilters ? 'var(--card-bg)' : 'var(--text-primary)'}
            borderRadius="full"
            _hover={{
              background: showFilters ? 'var(--accent-secondary)' : 'var(--card-hover-bg)',
              borderColor: 'var(--accent-primary)'
            }}
          >
            <LuFilter size={16} />
          </IconButton>
        </HStack>
      </HStack>

      {/* Filter Panel */}
      <Collapsible.Root open={showFilters}>
        <Collapsible.Content>
          <Box
            ref={filterPanelRef}
            position="absolute"
            top="70px"
            left={4}
            right={4}
            background="var(--card-bg)"
            border="1px solid"
            borderColor="var(--border-color)"
            borderRadius="md"
            backdropFilter="blur(10px)"
            p={4}
            zIndex={9}
            maxHeight="calc(100vh - 150px)"
            overflowY="auto"
          >
            <HStack gap={6} align="flex-start" wrap="wrap">
              {/* Resource Types */}
              <VStack align="flex-start" gap={2} minWidth="180px">
                <Text fontSize="sm" fontWeight="600" color="var(--text-primary)" fontFamily="var(--font-secondary)">
                  Resource Types
                </Text>
                <VStack align="flex-start" gap={1}>
                  {['namespace', 'node', 'deployment', 'statefulset', 'daemonset', 'pod', 'service', 'ingress'].map(type => {
                    const count = filterCounts.resourceTypes[type] || 0;
                    return (
                      <Checkbox.Root
                        key={type}
                        checked={resourceTypeFilters.has(type)}
                        onCheckedChange={() => toggleResourceType(type)}
                        size="sm"
                        colorPalette="purple"
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                        <Checkbox.Label>
                          <Text fontSize="xs" color="var(--text-primary)" textTransform="capitalize">
                            {type} ({count})
                          </Text>
                        </Checkbox.Label>
                      </Checkbox.Root>
                    );
                  })}
                </VStack>
              </VStack>

              {/* Status */}
              <VStack align="flex-start" gap={2} minWidth="140px">
                <Text fontSize="sm" fontWeight="600" color="var(--text-primary)" fontFamily="var(--font-secondary)">
                  Status
                </Text>
                <VStack align="flex-start" gap={1}>
                  {['healthy', 'warning', 'error', 'unknown'].map(status => {
                    const count = filterCounts.statuses[status] || 0;
                    return (
                      <Checkbox.Root
                        key={status}
                        checked={statusFilters.has(status)}
                        onCheckedChange={() => toggleStatus(status)}
                        size="sm"
                        colorPalette="purple"
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                        <Checkbox.Label>
                          <Text fontSize="xs" color="var(--text-primary)" textTransform="capitalize">
                            {status} ({count})
                          </Text>
                        </Checkbox.Label>
                      </Checkbox.Root>
                    );
                  })}
                </VStack>
              </VStack>

              {/* Namespaces */}
              {availableNamespaces.length > 0 && (
                <VStack align="flex-start" gap={2} minWidth="180px">
                  <Text fontSize="sm" fontWeight="600" color="var(--text-primary)" fontFamily="var(--font-secondary)">
                    Namespaces
                  </Text>
                  <VStack align="flex-start" gap={1} maxHeight="200px" overflowY="auto" width="100%">
                    {availableNamespaces
                      .filter(ns => ns && ns.trim() !== '') // Extra safety filter
                      .map(ns => {
                        const count = filterCounts.namespaces[ns] || 0;
                        return (
                          <Checkbox.Root
                            key={ns}
                            checked={namespaceFilters.has(ns)}
                            onCheckedChange={() => toggleNamespace(ns)}
                            size="sm"
                            colorPalette="purple"
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                            <Checkbox.Label>
                              <Text fontSize="xs" color="var(--text-primary)">
                                {ns} ({count})
                              </Text>
                            </Checkbox.Label>
                          </Checkbox.Root>
                        );
                      })}
                  </VStack>
                </VStack>
              )}
            </HStack>
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>
      
      {/* Diagram */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onMove={handleMove}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.3}
        maxZoom={2}
        elevateNodesOnSelect={true}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        // Performance optimizations for large graphs
        onlyRenderVisibleElements={true}
        panOnDrag={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        preventScrolling={true}
        proOptions={proOptions}
        style={{
          background: 'var(--body-bg)',
        }}
      >
        <Controls showInteractive={false} style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }} />
        <MiniMap 
          nodeColor={(node) => {
            const data = node.data as any;
            // Show hidden nodes in gray
            if (node.hidden) return '#444444';
            if (data.health === 'error') return 'var(--status-error)';
            if (data.health === 'warning') return 'var(--status-warning)';
            return 'var(--status-success)';
          }}
          maskColor="rgba(10, 15, 25, 0.7)"
          style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border-color)' }}
          pannable={true}
          zoomable={true}
          nodeStrokeWidth={3}
          ariaLabel="Diagram minimap"
        />
        <Background gap={16} size={1} color="var(--border-color)" />
        
        {/* SVG gradient for edges */}
        <svg style={{ position: 'absolute', width: 0, height: 0 }}>
          <defs>
            <linearGradient id="edge-gradient">
              <stop offset="0%" stopColor="var(--accent-primary)" />
              <stop offset="100%" stopColor="var(--accent-secondary)" />
            </linearGradient>
          </defs>
        </svg>
        
        {/* Context Menu */}
        {menu && (
          <NodeContextMenu
            id={menu.id}
            initialTop={menu.initialTop}
            initialLeft={menu.initialLeft}
            right={menu.right}
            data={menu.data}
            nodePosition={menu.nodePosition}
            offsetX={menu.offsetX}
            offsetY={menu.offsetY}
            viewport={viewport}
            onClose={() => setMenu(null)}
            onAction={handleAction}
          />
        )}
      </ReactFlow>
      
      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.5;
            transform: scale(1.2);
          }
        }
      `}</style>
    </Box>
  );
};
