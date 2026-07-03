/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer
 * and settled (complete/error) nodes are frozen in place.
 *
 * REQ-1: No forceCenter — replaced by per-depth forceY vertical layering
 * REQ-2: forceLink distance increased to 400px for wider nodes (280-360px)
 * REQ-3: forceManyBody strength increased to -800 for small graph repulsion
 * REQ-4: Per-depth forceY for vertical layering (agent depth 0 at y=0, children at y+400)
 * REQ-7: Convergence within maxIterations (300) or alpha below threshold
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

/** Input node for layout computation. */
export interface LayoutNode {
  id: string;
  status: string;
  /** Depth in the graph hierarchy (0=agent, 1=subagent/tool, 2=file) */
  depth?: number;
  /** Node type identifier ('agent' | 'subagent' | 'tool' | 'file') */
  type?: string;
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
  depth?: number;
  type?: string;
}

/**
 * Run force-directed layout on a set of nodes and edges using d3-force.
 *
 * - Connected nodes attract each other via forceLink (distance 400).
 * - All nodes repel via forceManyBody (strength -800).
 * - Per-depth forceY: agent nodes (depth 0) at y≈0, children (depth 1) at y≈400.
 * - No forceCenter — nodes distribute naturally via link + charge + forceY.
 * - Nodes with status 'complete' or 'error' are settled: their positions are
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
  // - Existing positions preserved for layout stability (AC-6 / REQ-6)
  // - Settled (complete/error) nodes frozen so they don't move
  // - New nodes get positions offset across wider spread (±600)
  const simNodes: SimNode[] = nodes.map((n) => {
    const isSettled = n.status === 'complete' || n.status === 'error';
    // Use existing position if available, otherwise random spread from center
    const existing = existingPositions?.get(n.id);
    const x = existing?.x ?? (Math.random() * 1200 - 600);
    const y = existing?.y ?? (Math.random() * 1200 - 600);
    return {
      id: n.id,
      status: n.status,
      depth: n.depth,
      type: n.type,
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

  // Create simulation with per-depth vertical layering
  // - forceLink: connected nodes attract at 400px distance (sufficient for 280-360px-wide nodes)
  // - charge: all nodes repel at -800 (stronger repulsion for small graphs)
  // - y: each depth layer has its own Y target (depth*400), with 0.1 strength
  //   to allow horizontal spread while maintaining vertical hierarchy
  const simulation = forceSimulation(simNodes)
    .alphaDecay(alphaDecay)
    .alphaMin(alphaMin)
    .force('link', forceLink(simLinks).distance(400))
    .force('charge', forceManyBody().strength(-800))
    .force('y', forceY<SimNode>().y((d) => (d.depth ?? 0) * 400).strength(0.1));

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
