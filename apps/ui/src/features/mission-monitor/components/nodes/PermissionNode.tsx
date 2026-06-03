import React from 'react';
import type { NodeProps } from 'reactflow';
import { LuLock } from 'react-icons/lu';
import type { MonitorNodeData } from '../../types';
import { BaseMonitorNode } from './BaseMonitorNode';
import { useNodeFocus } from '../NodeFocusContext';

export const PermissionNode: React.FC<NodeProps<MonitorNodeData>> = ({ data, selected }) => {
  const onFocus = useNodeFocus();
  return (
    <BaseMonitorNode
      data={data}
      selected={selected}
      icon={<LuLock size={13} />}
      minWidth={180}
      onFocus={onFocus ?? undefined}
    />
  );
};
