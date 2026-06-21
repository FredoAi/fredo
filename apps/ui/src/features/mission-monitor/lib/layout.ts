/**
 * layout.ts — Dagre auto-layout for Mission Monitor graph.
 *
 * REQ-10: Computes hierarchical positions for ChatNodes (vertical chain) and
 * subagentNodes (branched to the right of their parent) using dagre.
 *
 * REQ-11: Returns updated node positions; ReactFlow handles smooth CSS transitions.
 */

import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';
import type { MonitorNodeData } from '../types';

/** Default node dimensions used when node.height/width is unavailable. */
const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 200;
/** Horizontal offset for subagent nodes placed to the right of their parent. */
const SUBAGENT_X_OFFSET = 320;
/** Vertical padding between nodes in the main chain. */
const CHAIN_Y_PADDING = 250;

/**
 * Identify node type from `data.eventType` or `type` field.
 * Subagent nodes have type 'subagentNode'.
 */
function isSubagentNode(node: Node<MonitorNodeData>): boolean {
  return node.type === 'subagentNode' || node.data?.eventType === 'subagentNode';
}

/**
 * Compute dagre-based layout for a set of nodes and edges.
 *
 * Strategy:
 * 1. Build two groups: ChatNodes (main chain) and subagentNodes (branches).
 * 2. Run dagre layout on the full graph with TB direction to establish Y-positions.
 * 3. Post-process: shift subagent nodes horizontally to the right of their parent
 *    ChatNode, maintaining the Y-position from dagre layout.
 *
 * @param nodes - All ReactFlow nodes (ChatNodes + subagentNodes)
 * @param edges - All ReactFlow edges
 * @param direction - Layout direction (default 'TB' for top-to-bottom main chain)
 * @returns Re-positioned nodes and edges (edges unchanged)
 */
export function getLayoutedElements(
  nodes: Node<MonitorNodeData>[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): { nodes: Node<MonitorNodeData>[]; edges: Edge[] } {
  if (nodes.length === 0) {
    return { nodes, edges };
  }

  // ── Step 1: Build dagre graph with all nodes ──────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 80,
    ranksep: 120,
    marginx: 20,
    marginy: 20,
  });

  for (const node of nodes) {
    const width = node.width ?? DEFAULT_NODE_WIDTH;
    const height = node.height ?? DEFAULT_NODE_HEIGHT;
    g.setNode(node.id, { width, height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  // ── Step 2: Run dagre layout ─────────────────────────────────────────────
  dagre.layout(g);

  // ── Step 3: Build positioned nodes ──────────────────────────────────────────
  // First pass: get dagre positions for all nodes
  const dagrePositions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const dagreNode = g.node(node.id);
    if (dagreNode) {
      const width = node.width ?? DEFAULT_NODE_WIDTH;
      const height = node.height ?? DEFAULT_NODE_HEIGHT;
      dagrePositions.set(node.id, {
        x: dagreNode.x - width / 2,
        y: dagreNode.y - height / 2,
      });
    }
  }

  // ── Step 4: Post-process — position subagent nodes to the right of parent ──
  // Build parent map from edges
  const parentMap = new Map<string, string>();
  for (const edge of edges) {
    // Edge from ChatNode → subagentNode: subagent's parent is the ChatNode
    if (!parentMap.has(edge.target)) {
      parentMap.set(edge.target, edge.source);
    }
  }

  // Find parent ChatNode Y for each subagent node
  // ChatNodes keep their dagre Y positions
  // Subagent nodes: X = parent's right edge + offset, Y = parent's Y (dagre)
  const laidOutNodes = nodes.map((node) => {
    const dagrePos = dagrePositions.get(node.id);
    if (!dagrePos) return node;

    if (isSubagentNode(node)) {
      const parentId = parentMap.get(node.id);
      if (parentId) {
        const parentPos = dagrePositions.get(parentId);
        const parentNode = nodes.find((n) => n.id === parentId);
        if (parentPos && parentNode) {
          const parentWidth = parentNode.width ?? DEFAULT_NODE_WIDTH;
          return {
            ...node,
            position: {
              x: parentPos.x + parentWidth + SUBAGENT_X_OFFSET,
              y: parentPos.y,
            },
          };
        }
      }
      // Fallback: keep dagre Y but nudge X to the right
      return {
        ...node,
        position: {
          x: dagrePos.x + SUBAGENT_X_OFFSET,
          y: dagrePos.y,
        },
      };
    }

    // ChatNode: keep dagre position
    return {
      ...node,
      position: dagrePos,
    };
  });

  // ── Step 5: Ensure vertical chain spacing for ChatNodes ────────────────────
  // After dagre layout and subagent repositioning, enforce minimum spacing
  // between consecutive ChatNodes in the vertical chain.
  const chatNodes = laidOutNodes.filter((n) => !isSubagentNode(n));
  const subagentNodes = laidOutNodes.filter((n) => isSubagentNode(n));

  // Re-space ChatNodes vertically with consistent padding
  let accY = 0;
  const chatNodeYMap = new Map<string, number>();
  for (const node of chatNodes) {
    const height = node.height ?? DEFAULT_NODE_HEIGHT;
    chatNodeYMap.set(node.id, accY);
    accY += height + CHAIN_Y_PADDING;
  }

  // Apply new Y to ChatNodes; shift subagent nodes by the same delta
  const chatNodeOldY = new Map<string, number>();
  for (const node of chatNodes) {
    const dagrePos = dagrePositions.get(node.id);
    chatNodeOldY.set(node.id, dagrePos?.y ?? 0);
  }

  const finalNodes: Node<MonitorNodeData>[] = [];

  // Add repositioned ChatNodes
  for (const node of chatNodes) {
    const newY = chatNodeYMap.get(node.id);
    if (newY !== undefined) {
      finalNodes.push({
        ...node,
        position: { ...node.position, y: newY },
      });
    } else {
      finalNodes.push(node);
    }
  }

  // Add subagent nodes — adjust Y by the same delta as their parent
  for (const node of subagentNodes) {
    const parentId = parentMap.get(node.id);
    if (parentId) {
      const newParentY = chatNodeYMap.get(parentId);
      const oldParentY = chatNodeOldY.get(parentId);
      if (newParentY !== undefined && oldParentY !== undefined) {
        const delta = newParentY - oldParentY;
        finalNodes.push({
          ...node,
          position: {
            x: node.position.x,
            y: node.position.y + delta,
          },
        });
      } else {
        finalNodes.push(node);
      }
    } else {
      finalNodes.push(node);
    }
  }

  return { nodes: finalNodes, edges };
}
