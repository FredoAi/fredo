import React, { useMemo, useState, useEffect } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import styles from './K8sNode.module.css';
import { useStream } from '../../../shared/contexts/StreamContext';
import { KUBECTL_OPERATION_LABELS } from '../utils/operationLabels';

// Track recently completed operations to show tooltip for 10s after completion
interface CompletedOperation {
  tool: string;
  correlationId: string;
  completedAt: number;
  state: 'Response' | 'Error';
}

export type TooltipActionType = 'check-logs' | 'improvement-analysis' | 'run-hotfix';

export interface TooltipButton {
  label: 'Check Logs' | 'Improvement Analysis' | 'Run Hotfix';
  action: TooltipActionType;
  prompt?: string;
  icon?: string;
}

export interface K8sNodeData {
  label: string;
  namespace?: string;
  type?: string;
  health?: 'healthy' | 'warning' | 'error';
  age?: string;
  tooltipButtons?: TooltipButton[];
  podStatus?: {
    phase: string;
    podIP?: string;
    containers?: any[];
  };
  restartCount?: number;
  serviceType?: string;
  servicePorts?: Array<{ port: number; protocol: string }>;
  clusterIP?: string;
  deploymentStatus?: {
    replicas: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
  issues?: string[];
  resources?: {
    cpu?: string;
    memory?: string;
  };
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const getTypeColor = (type: string): string => {
  const colors: Record<string, string> = {
    service: '#8b5cf6',      // Purple
    pod: '#6366f1',          // Indigo
    database: '#10b981',     // Green
    deployment: '#3b82f6',   // Blue
    firewall: '#ef4444',     // Red
    default: '#6b7280'       // Gray
  };
  return colors[type] || colors.default;
};

const getTypeIcon = (type: string): string => {
  const icons: Record<string, string> = {
    service: 'SVC',
    pod: 'POD',
    database: 'DB',
    deployment: 'DEP',
    firewall: 'FW',
    default: 'SYS'
  };
  return icons[type] || icons.default;
};

const healthIcons = {
  healthy: '●',
  warning: '●',
  error: '●',
};

export const K8sNode: React.FC<NodeProps<K8sNodeData>> = ({ data, selected }) => {
  const healthIcon = healthIcons[data.health || 'healthy'];
  const typeIcon = getTypeIcon(data.type || 'pod');
  const typeColor = getTypeColor(data.type || 'pod');
  
  // Check if turbo theme is active
  const isTurboTheme = document.body.classList.contains('theme-turbo');

  // Subscribe to kubectl events for this node
  const { events } = useStream();
  
  // Track recently completed operations (Response/Error) to keep tooltip visible for 10s
  const [completedOps, setCompletedOps] = useState<CompletedOperation[]>([]);

  // Get active and completed operations targeting this node
  const { activeOps, newCompletedOps } = useMemo(() => {
    if (!data.namespace || !data.label) return { activeOps: [], newCompletedOps: [] };
    
    // STEP 1: Find Init events matching this node (have input.namespace + input.name)
    const initEvents = events.filter(event => {
      if (!event.toolName?.startsWith('kubectl_')) return false;
      if (event.state !== 'Init') return false;
      
      const input = (event.payload as Record<string, any>) || {};
      const targetName = input.name || input.pod;
      
      return input.namespace === data.namespace && targetName === data.label;
    });
    
    // Extract correlationIds from Init events
    const relevantCorrelationIds = new Set(
      initEvents.map(e => e.correlationId).filter(Boolean) as string[]
    );
    
    // DEBUG: Log Response events to verify correlationId
    const responseEvents = events.filter(e => e.state === 'Response' && e.toolName?.startsWith('kubectl_'));
    if (responseEvents.length > 0) {
      console.log(`[K8sNode ${data.label}] Response events:`, responseEvents.map(e => ({
        tool: e.toolName,
        correlationId: e.correlationId,
        hasCorrelationId: !!e.correlationId,
      })));
      console.log(`[K8sNode ${data.label}] Relevant correlationIds:`, Array.from(relevantCorrelationIds));
    }
    
    // STEP 2: Include Response/Error events with matching correlationIds
    // (Response/Error don't have input fields, but share correlationId with their Init)
    const allRelevantEvents = events.filter(event => {
      if (!event.toolName?.startsWith('kubectl_')) return false;
      
      // Include Init events matching this node
      if (event.state === 'Init') {
        const input = (event.payload as Record<string, any>) || {};
        const targetName = input.name || input.pod;
        return input.namespace === data.namespace && targetName === data.label;
      }
      
      // Include Response/Error with matching correlationIds
      if ((event.state === 'Response' || event.state === 'Error') && event.correlationId) {
        return relevantCorrelationIds.has(event.correlationId);
      }
      
      return false;
    });

    // Deduplicate by correlationId, keeping the LATEST state per operation
    const byCorrelation = new Map<string, { tool: string; state: string; timestamp: string; correlationId: string }>();
    
    allRelevantEvents.forEach(event => {
      const key = event.correlationId || `${event.toolName}-${event.timestamp}`;
      const existing = byCorrelation.get(key);
      
      // Keep event with latest timestamp (Response comes after Init/Update)
      if (!existing || (event.timestamp && event.timestamp > existing.timestamp)) {
        byCorrelation.set(key, {
          tool: event.toolName || '',
          state: event.state,
          timestamp: event.timestamp || '',
          correlationId: event.correlationId || '',
        });
      }
    });

    // Separate into active (Init/Update) vs completed (Response/Error)
    const active: Array<{ tool: string; state: string; timestamp: string; correlationId: string }> = [];
    const newCompleted: Array<{ tool: string; state: string; correlationId: string }> = [];

    byCorrelation.forEach(op => {
      if (op.state === 'Init' || op.state === 'Update') {
        active.push(op);
      } else if (op.state === 'Response' || op.state === 'Error') {
        // Only add to newCompleted if not already tracked
        const alreadyTracked = completedOps.some(c => c.correlationId === op.correlationId);
        if (!alreadyTracked && op.correlationId) {
          newCompleted.push({ tool: op.tool, state: op.state, correlationId: op.correlationId });
        }
      }
    });

    return { activeOps: active, newCompletedOps: newCompleted };
  }, [events, data.namespace, data.label, completedOps]);

  // Update completedOps state when new completed operations are detected
  useEffect(() => {
    if (newCompletedOps.length > 0) {
      const now = Date.now();
      setCompletedOps(prev => [
        ...prev,
        ...newCompletedOps.map(op => ({
          tool: op.tool,
          correlationId: op.correlationId,
          completedAt: now,
          state: op.state as 'Response' | 'Error',
        }))
      ]);
    }
  }, [newCompletedOps]);

  // Clean up completed operations after 10 seconds
  useEffect(() => {
    if (completedOps.length === 0) return;

    const now = Date.now();
    const timeout = setTimeout(() => {
      setCompletedOps(prev => prev.filter(op => now - op.completedAt < 10000));
    }, 1000); // Check every second

    return () => clearTimeout(timeout);
  }, [completedOps]);

  // Build tooltip lines for active + recently completed operations
  const operationTooltipLines = useMemo(() => {
    const lines: Array<{ key: string; label: string; isCompleted: boolean; isError: boolean }> = [];

    // Active operations
    activeOps.forEach(op => {
      lines.push({
        key: `${op.tool}-${op.correlationId}`,
        label: KUBECTL_OPERATION_LABELS[op.tool] || op.tool.replace('kubectl_', '').replace(/_/g, ' '),
        isCompleted: false,
        isError: false,
      });
    });

    // Recently completed operations (shown for 10s)
    const now = Date.now();
    completedOps.forEach(op => {
      if (now - op.completedAt < 10000) {
        const baseLabel = KUBECTL_OPERATION_LABELS[op.tool] || op.tool.replace('kubectl_', '').replace(/_/g, ' ');
        lines.push({
          key: `${op.tool}-${op.correlationId}`,
          label: op.state === 'Error' ? `${baseLabel} (Failed)` : `${baseLabel} (Completed)`,
          isCompleted: true,
          isError: op.state === 'Error',
        });
      }
    });

    return lines;
  }, [activeOps, completedOps]);

  return (
    <div className={`${styles.turboNode} ${selected ? styles.selected : ''}`}>
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ opacity: 0 }} 
      />
      
      {/* Active operation tooltip — floats above node while operations run */}
      {operationTooltipLines.length > 0 && (
        <div className={styles.activeOperationBox}>
          <div className={styles.activeOperationHeader}>Active Operations</div>
          <div className={styles.activeOperationList}>
            {operationTooltipLines.map(op => (
              <div key={op.key} className={styles.activeOperationItem}>
                {!op.isCompleted && <span className={styles.activeOperationSpinner} />}
                {op.isCompleted && !op.isError && <span className={styles.completedCheck}>✓</span>}
                {op.isCompleted && op.isError && <span className={styles.errorX}>✗</span>}
                <span className={op.isCompleted ? styles.completedText : ''}>{op.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Cloud badge with health indicator */}
      <div className={`${styles.cloud} ${isTurboTheme ? styles.gradient : ''}`}>
        <div>
          <span className={`${styles.healthIndicator} ${styles[data.health || 'healthy']}`}>
            {healthIcon}
          </span>
        </div>
      </div>

      {/* Main node content with animated gradient border */}
      <div className={`${styles.wrapper} ${isTurboTheme ? styles.gradient : ''}`}>
        <div className={styles.inner}>
          {/* Colored Header Bar */}
          <div className={styles.header} style={{ backgroundColor: typeColor }}>
            <span className={styles.headerText}>{data.label}</span>
          </div>

          {/* Content */}
          <div className={styles.content}>
            {data.namespace && (
              <div className={styles.subtitle}>{data.namespace}</div>
            )}

            {/* Age */}
            {data.age && (
              <div className={styles.statusRow}>
                <span className={styles.subtitle}>{data.age}</span>
              </div>
            )}

            {/* Pod Status */}
            {data.podStatus && (
              <div className={styles.statusRow}>
              <span className={`${styles.badge} ${
                data.podStatus.phase === 'Running' ? styles.badgeGreen :
                data.podStatus.phase === 'Pending' ? styles.badgeYellow : 
                styles.badgeRed
              }`}>
                {data.podStatus.phase}
              </span>
              {data.restartCount !== undefined && data.restartCount > 0 && (
                <span className={`${styles.badge} ${
                  data.restartCount > 5 ? styles.badgeYellow : styles.badgeGray
                }`}>
                  ↻ {data.restartCount}
                </span>
              )}
            </div>
          )}

          {/* Deployment Status */}
          {data.deploymentStatus && (
            <div className={styles.subtitle} style={{ marginTop: '4px' }}>
              📊 {data.deploymentStatus.availableReplicas || 0}/{data.deploymentStatus.replicas} replicas
            </div>
          )}

          {/* Service Info */}
          {data.serviceType && (
            <div className={styles.statusRow}>
              <span className={`${styles.badge} ${styles.badgeBlue}`}>
                {data.serviceType}
              </span>
              {data.servicePorts && data.servicePorts.length > 0 && (
                <span className={styles.subtitle}>
                  :{data.servicePorts[0].port}
                </span>
              )}
            </div>
          )}

          {/* Issues */}
          {data.issues && data.issues.length > 0 && (
            <div className={styles.issuesBox}>
              <div className={styles.issueText}>
                ⚠️ {data.issues[0]}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      <Handle 
        type="source" 
        position={Position.Bottom} 
        style={{ opacity: 0 }} 
      />
    </div>
  );
};

// Memoize node component for better performance with large graphs
export default React.memo(K8sNode);
