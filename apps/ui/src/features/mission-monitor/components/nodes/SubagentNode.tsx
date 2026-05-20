import React from 'react';
import type { NodeProps } from 'reactflow';
import { LuBot } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { BaseMonitorNode } from './BaseMonitorNode';
import { useNodeFocus } from '../NodeFocusContext';

export const SubagentNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  return (
    <BaseMonitorNode
      data={data}
      selected={selected}
      icon={<LuBot size={13} />}
      minWidth={170}
      onFocus={onFocus ?? undefined}
    />
  );
};
