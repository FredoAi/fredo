/**
 * Prompt Builder
 * Generates comprehensive AI prompts for Kubernetes resources
 */

export interface K8sNodeData {
  label: string;
  namespace?: string;
  type?: string;
  health?: 'healthy' | 'warning' | 'error';
  age?: string;
  tooltipButtons?: any[];
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
    replicas?: number;
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

/**
 * Get health status emoji and text
 */
function getHealthIndicator(health?: string): string {
  switch (health) {
    case 'healthy':
      return '✅ Healthy';
    case 'warning':
      return '⚠️ Warning';
    case 'error':
      return '❌ Error';
    default:
      return '❔ Unknown';
  }
}

/**
 * Get contextual hints based on node state
 */
function getContextualHints(nodeData: K8sNodeData): string[] {
  const hints: string[] = [];
  
  // High restart count
  if (nodeData.restartCount && nodeData.restartCount > 10) {
    hints.push(`⚠️ Pod has restarted ${nodeData.restartCount} times in ${nodeData.age || 'unknown time'} - investigate crash loop immediately`);
  } else if (nodeData.restartCount && nodeData.restartCount > 5) {
    hints.push(`Pod has ${nodeData.restartCount} restarts - monitor for stability issues`);
  }
  
  // Health-based hints
  if (nodeData.health === 'error') {
    hints.push('Critical issue detected - immediate investigation recommended');
  } else if (nodeData.health === 'warning') {
    hints.push('Warning state - check resource usage and recent events');
  }
  
  // Pod phase hints
  if (nodeData.podStatus?.phase === 'CrashLoopBackOff') {
    hints.push('Container is crash looping - check logs with --previous flag');
  } else if (nodeData.podStatus?.phase === 'Pending') {
    hints.push('Pod is pending - check node resources and scheduling constraints');
  } else if (nodeData.podStatus?.phase === 'Failed') {
    hints.push('Pod failed - review events and container exit codes');
  }
  
  // Deployment replica hints
  if (nodeData.deploymentStatus) {
    const { replicas = 0, availableReplicas = 0 } = nodeData.deploymentStatus;
    if (availableReplicas < replicas) {
      hints.push(`Deployment not fully available: ${availableReplicas}/${replicas} replicas ready`);
    }
  }
  
  return hints;
}

/**
 * Get suggested kubectl tools based on node type and state
 */
function getSuggestedTools(nodeData: K8sNodeData): string[] {
  const suggestions: string[] = [];
  const type = nodeData.type?.toLowerCase();
  
  if (type === 'pod') {
    suggestions.push('kubectl_describe_pod: Full details with events and conditions');
    
    if (nodeData.restartCount && nodeData.restartCount > 0) {
      suggestions.push('kubectl_logs --previous=true: View logs from crashed container');
    } else {
      suggestions.push('kubectl_logs: View current container logs');
    }
    
    suggestions.push('kubectl_top_pods: Check current resource usage');
    
    if (nodeData.health === 'error') {
      suggestions.push('kubectl_delete_pod: Force pod recreation (triggers new pod from deployment)');
    }
    
    suggestions.push('kubectl_exec: Execute diagnostic commands inside container');
  }
  
  if (type === 'deployment') {
    suggestions.push('kubectl_get_deployments: Get deployment configuration and status');
    suggestions.push('kubectl_rollout_status: Check rollout progress');
    suggestions.push('kubectl_restart_deployment: Trigger rolling restart');
    suggestions.push('kubectl_scale_deployment: Adjust replica count');
  }
  
  if (type === 'service') {
    suggestions.push('kubectl_get_services: Get service endpoints and configuration');
  }
  
  // Always suggest events
  suggestions.push('kubectl_get_events: View recent events for this resource');
  
  return suggestions;
}

/**
 * Format labels as readable string
 */
function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return 'None';
  }
  
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

/**
 * Build comprehensive prompt for node
 */
export function buildPromptForNode(nodeData: K8sNodeData, action: string): string {
  const parts: string[] = [];
  
  // Header based on action
  if (action === 'improvement_analysis') {
    parts.push('Please analyze this Kubernetes resource for improvement opportunities:\n');
  } else if (action === 'run_hotfix') {
    parts.push('I need help with this Kubernetes resource that requires immediate attention:\n');
  } else if (action === 'health_check') {
    parts.push('Please perform a comprehensive health check on this Kubernetes resource:\n');
  } else {
    parts.push('I need help with this Kubernetes resource:\n');
  }
  
  // Resource identification
  parts.push(`**Resource**: ${nodeData.type || 'Unknown'}/${nodeData.label}`);
  parts.push(`**Namespace**: ${nodeData.namespace || 'default'}`);
  parts.push(`**Status**: ${getHealthIndicator(nodeData.health)}${nodeData.podStatus?.phase ? ` (${nodeData.podStatus.phase})` : ''}`);
  parts.push(`**Age**: ${nodeData.age || 'Unknown'}${nodeData.restartCount ? ` | **Restarts**: ${nodeData.restartCount}` : ''}`);
  parts.push('');
  
  // Labels
  if (nodeData.labels && Object.keys(nodeData.labels).length > 0) {
    parts.push(`**Labels**: ${formatLabels(nodeData.labels)}`);
  }
  
  // Type-specific details
  if (nodeData.type?.toLowerCase() === 'pod' && nodeData.podStatus) {
    const containers = nodeData.podStatus.containers || [];
    if (containers.length > 0) {
      const containerInfo = containers.map(c => c.name || 'unknown').join(', ');
      parts.push(`**Containers**: ${containerInfo}`);
    }
    if (nodeData.podStatus.podIP) {
      parts.push(`**Pod IP**: ${nodeData.podStatus.podIP}`);
    }
  }
  
  if (nodeData.type?.toLowerCase() === 'deployment' && nodeData.deploymentStatus) {
    const { replicas, readyReplicas, availableReplicas } = nodeData.deploymentStatus;
    parts.push(`**Replicas**: ${availableReplicas || 0}/${replicas || 0} available, ${readyReplicas || 0} ready`);
  }
  
  if (nodeData.type?.toLowerCase() === 'service') {
    if (nodeData.serviceType) {
      parts.push(`**Service Type**: ${nodeData.serviceType}`);
    }
    if (nodeData.clusterIP) {
      parts.push(`**Cluster IP**: ${nodeData.clusterIP}`);
    }
    if (nodeData.servicePorts && nodeData.servicePorts.length > 0) {
      const ports = nodeData.servicePorts
        .map(p => `${p.port}/${p.protocol}`)
        .join(', ');
      parts.push(`**Ports**: ${ports}`);
    }
  }
  
  // Resources
  if (nodeData.resources?.cpu || nodeData.resources?.memory) {
    parts.push(`**Resources**: ${nodeData.resources.cpu ? `CPU ${nodeData.resources.cpu}` : ''}${nodeData.resources.cpu && nodeData.resources.memory ? ', ' : ''}${nodeData.resources.memory ? `Memory ${nodeData.resources.memory}` : ''}`);
  }
  
  parts.push('');
  
  // Issues
  if (nodeData.issues && nodeData.issues.length > 0) {
    parts.push('**Issues**:');
    nodeData.issues.forEach(issue => {
      parts.push(`- ${issue}`);
    });
    parts.push('');
  }
  
  // Contextual hints
  const hints = getContextualHints(nodeData);
  if (hints.length > 0) {
    parts.push('**Context**:');
    hints.forEach(hint => {
      parts.push(hint);
    });
    parts.push('');
  }
  
  // Suggested tools
  const tools = getSuggestedTools(nodeData);
  if (tools.length > 0) {
    parts.push('**Suggested kubectl Actions**:');
    tools.forEach(tool => {
      parts.push(`- ${tool}`);
    });
    parts.push('');
  }
  
  // Closing based on action
  if (action === 'improvement_analysis') {
    parts.push('Please analyze this resource and provide Priority 1, 2, and 3 recommendations for improvements.');
  } else if (action === 'run_hotfix') {
    parts.push('Please analyze this issue and suggest next steps. If needed, execute the Hotfix SOP workflow.');
  } else if (action === 'health_check') {
    parts.push('Please provide a comprehensive health assessment and identify any potential issues.');
  } else {
    parts.push('Please analyze this resource and suggest next steps.');
  }
  
  return parts.join('\n');
}

/**
 * Build prompt for kubectl operation result
 */
export function buildPromptForResult(toolName: string, result: any, nodeData?: K8sNodeData): string {
  const parts: string[] = [];
  
  parts.push(`Here are the results from ${toolName}${nodeData ? ` for ${nodeData.type}/${nodeData.label}` : ''}:\n`);
  parts.push('```json');
  parts.push(JSON.stringify(result, null, 2));
  parts.push('```\n');
  parts.push('Please analyze these results and provide insights or recommendations.');
  
  return parts.join('\n');
}
