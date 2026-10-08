import { Node } from 'reactflow';

interface CollisionOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  margin?: number;
  maxIterations?: number;
  overlapThreshold?: number;
}

/**
 * Resolves node collisions by detecting overlaps and adjusting positions
 * Based on ReactFlow's collision detection example
 */
export function resolveCollisions(
  nodes: Node[],
  options: CollisionOptions = {}
): Node[] {
  const {
    nodeWidth = 250,
    nodeHeight = 100,
    margin = 40,
    maxIterations = 200,
    overlapThreshold = 0.8,
  } = options;

  let collisionDetected = true;
  let iterations = 0;
  const adjustedNodes = nodes.map(node => ({ ...node }));

  while (collisionDetected && iterations < maxIterations) {
    collisionDetected = false;
    iterations++;

    for (let i = 0; i < adjustedNodes.length; i++) {
      for (let j = i + 1; j < adjustedNodes.length; j++) {
        const nodeA = adjustedNodes[i];
        const nodeB = adjustedNodes[j];

        // Skip hidden nodes
        if (nodeA.hidden || nodeB.hidden) continue;

        // Calculate bounding boxes with margin
        const boxA = {
          x: nodeA.position.x,
          y: nodeA.position.y,
          width: nodeWidth + margin,
          height: nodeHeight + margin,
        };

        const boxB = {
          x: nodeB.position.x,
          y: nodeB.position.y,
          width: nodeWidth + margin,
          height: nodeHeight + margin,
        };

        // Check for overlap
        const overlapX =
          Math.max(0, Math.min(boxA.x + boxA.width, boxB.x + boxB.width) - Math.max(boxA.x, boxB.x));
        const overlapY =
          Math.max(0, Math.min(boxA.y + boxA.height, boxB.y + boxB.height) - Math.max(boxA.y, boxB.y));

        if (overlapX > 0 && overlapY > 0) {
          collisionDetected = true;

          // Calculate centers
          const centerA = {
            x: boxA.x + boxA.width / 2,
            y: boxA.y + boxA.height / 2,
          };
          const centerB = {
            x: boxB.x + boxB.width / 2,
            y: boxB.y + boxB.height / 2,
          };

          // Calculate direction to move nodes apart
          const dx = centerB.x - centerA.x;
          const dy = centerB.y - centerA.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;

          // Normalize direction
          const dirX = dx / distance;
          const dirY = dy / distance;

          // Calculate push distance based on overlap
          const pushX = (overlapX / 2) * overlapThreshold;
          const pushY = (overlapY / 2) * overlapThreshold;

          // Move nodes apart
          nodeA.position = {
            x: nodeA.position.x - dirX * pushX,
            y: nodeA.position.y - dirY * pushY,
          };

          nodeB.position = {
            x: nodeB.position.x + dirX * pushX,
            y: nodeB.position.y + dirY * pushY,
          };
        }
      }
    }
  }

  return adjustedNodes;
}
