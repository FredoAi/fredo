/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer
 * and settled (complete/error) nodes are frozen in place.
 *
 * REQ-6: Force-directed layout with forceLink + forceManyBody + forceCenter
 * REQ-7: Convergence within maxIterations (300) or alpha below threshold
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

/** Input node for layout computation. */
export interface LayoutNode {
  id: string;
  status: string;
}

/** Input edge for layout computation. */
export interface LayoutEdge {
  source: string;
  target: string;
}

/** Extra options for force layout computation. */
export interface ForceLayoutOptions {
  maxIterations?: number;
  alphaMin?: number;
  alphaDecay?: number;
  /** Existing positions to preserve as initial positions for matching nodes. */
  existingPositions?: Map<string, { x: number; y: number }>;
}

/** Result of a force layout run. */
export interface ForceLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  converged: boolean;
  iterations: number;
}

/** Internal simulation node — extends d3-force SimulationNodeDatum. */
interface SimNode extends SimulationNodeDatum {
  id: string;
  status: string;
}

/**
 * Run force-directed layout on a set of nodes and edges using d3-force.
 *
 * - Connected nodes attract each other via forceLink (distance 150).
 * - All nodes repel via forceManyBody (strength -300).
 * - Centered around origin via forceCenter(0, 0).
 * - Nodes with status 'inactive' or 'error' are settled: their positions are
 *   frozen with fx/fy so they don't move during simulation.
 * - Converges when alpha drops below alphaMin (default 0.01) or after
 *   maxIterations (default 300).
 * - Returns a Map of node id to {x, y} positions.
 */
export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options?: ForceLayoutOptions,
): ForceLayoutResult {
  const maxIterations = options?.maxIterations ?? 300;
  const alphaMin = options?.alphaMin ?? 0.01;
  const alphaDecay = options?.alphaDecay ?? 0.02;
  const existingPositions = options?.existingPositions;

  if (nodes.length === 0) {
    return { positions: new Map(), converged: true, iterations: 0 };
  }

  // Build simulation nodes with stable initial positions
  // - Existing positions preserved for layout stability (AC-7 / REQ-7)
  // - Settled (complete/error) nodes frozen so they don't move
  // - New nodes get positions offset from center
  const simNodes: SimNode[] = nodes.map((n) => {
    const isSettled = n.status === 'complete' || n.status === 'error';
    // Use existing position if available, otherwise calculate offset from center
    const existing = existingPositions?.get(n.id);
    const x = existing?.x ?? (Math.random() * 400 - 200);
    const y = existing?.y ?? (Math.random() * 400 - 200);
    return {
      id: n.id,
      status: n.status,
      x,
      y,
      // Freeze settled nodes at their position so they don't move
      fx: isSettled ? x : undefined,
      fy: isSettled ? y : undefined,
    };
  });

  // Build index map for link resolution
  const nodeIndexMap = new Map<string, number>();
  simNodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

  // Build simulation links — only for edges where both endpoints exist
  const simLinks: SimulationLinkDatum<SimNode>[] = [];
  for (const edge of edges) {
    const sourceIdx = nodeIndexMap.get(edge.source);
    const targetIdx = nodeIndexMap.get(edge.target);
    if (sourceIdx !== undefined && targetIdx !== undefined) {
      simLinks.push({ source: sourceIdx, target: targetIdx });
    }
  }

  // Create simulation
  const simulation = forceSimulation(simNodes)
    .alphaDecay(alphaDecay)
    .alphaMin(alphaMin)
    .force('link', forceLink(simLinks).distance(150))
    .force('charge', forceManyBody().strength(-300))
    .force('center', forceCenter(0, 0));

  // Run simulation with iteration cap (REQ-7)
  let iterations = 0;
  for (let i = 0; i < maxIterations; i++) {
    simulation.tick();
    iterations++;
    if (simulation.alpha() < alphaMin) {
      break;
    }
  }

  simulation.stop();

  const converged = simulation.alpha() < alphaMin;

  // Build result map of node id → {x, y}
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  return { positions, converged, iterations };
}
