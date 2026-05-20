import React from 'react';
import type { NodeProps } from 'reactflow';
import { LuListTodo } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { BaseMonitorNode } from './BaseMonitorNode';
import { useNodeFocus } from '../NodeFocusContext';

export const TaskNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  return (
    <BaseMonitorNode
      data={data}
      selected={selected}
      icon={<LuListTodo size={13} />}
      onFocus={onFocus ?? undefined}
    />
  );
};
