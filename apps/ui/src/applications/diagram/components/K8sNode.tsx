import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import styles from './K8sNode.module.css';

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

  return (
    <div className={`${styles.turboNode} ${selected ? styles.selected : ''}`}>
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ opacity: 0 }} 
      />
      
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
