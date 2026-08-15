/**
 * NodeFocusContext — provides a focus callback to all custom nodes.
 * Avoids having to wire a custom prop through ReactFlow's NodeTypes system.
 *
 * #2743 ST-6 (AC-7/AC-8): the callback now receives a `DetailOpenTarget`
 * union — `{ kind: 'node'; data }` (the ReactFlow-level double-click path) or
 * `{ kind: 'tool-call'; call; sessionId }` (the ToolsNode accordion-item
 * double-click path). Node containers no longer self-open on double-click
 * (ChatNode / BaseMonitorNode handlers removed) — ReactFlow's
 * `onNodeDoubleClick` is the single node trigger.
 */
import React, { createContext, useContext } from 'react';
import type { DetailOpenTarget } from '../lib/graph';

type FocusHandler = (target: DetailOpenTarget) => void;

const NodeFocusContext = createContext<FocusHandler | null>(null);

export const NodeFocusProvider = NodeFocusContext.Provider;

export function useNodeFocus(): FocusHandler | null {
  return useContext(NodeFocusContext);
}
