import React from 'react';
import type { NodeProps } from 'reactflow';
import { LuPlay } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { BaseMonitorNode } from './BaseMonitorNode';
import { useNodeFocus } from '../NodeFocusContext';

export const SessionNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  // Shorten session ID label to first 8 chars
  const shortLabel = data.label.length > 8 ? data.label.slice(0, 8) : data.label;
  const sessionData: MonitorNodeData = { ...data, label: shortLabel };

  return (
    <BaseMonitorNode
      data={sessionData}
      selected={selected}
      icon={<LuPlay size={12} />}
      minWidth={120}
      onFocus={onFocus ?? undefined}
    />
  );
};
