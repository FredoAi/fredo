/**
 * NodeFocusContext — provides a focus callback to all custom nodes.
 * Avoids having to wire a custom prop through ReactFlow's NodeTypes system.
 */
import React, { createContext, useContext } from 'react';
import type { MonitorNodeData } from '../types';

type FocusHandler = (data: MonitorNodeData) => void;

const NodeFocusContext = createContext<FocusHandler | null>(null);

export const NodeFocusProvider = NodeFocusContext.Provider;

export function useNodeFocus(): FocusHandler | null {
  return useContext(NodeFocusContext);
}
