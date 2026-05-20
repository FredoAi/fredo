/**
 * Node Action Registry
 * Maps Kubernetes node types to available kubectl operations
 */

export interface NodeAction {
  section: 'Diagnostics' | 'Logs & Exec' | 'Operations' | 'AI Analysis';
  label: string;
  tool: string;
  description: string;
  icon: string;
  inputTemplate: (nodeData: any) => any;
  requiresInput?: boolean;
}

/**
 * Pod Actions
 */
const POD_ACTIONS: NodeAction[] = [
  // Diagnostics
  {
    section: 'Diagnostics',
    label: 'Describe Pod',
    tool: 'kubectl_describe_pod',
    description: 'Get detailed pod information including events and conditions',
    icon: '🔍',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label
    })
  },
  {
    section: 'Diagnostics',
    label: 'Get Events',
    tool: 'kubectl_get_events',
    description: 'View recent events for this pod',
    icon: '📋',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      involvedObjectName: node.label,
      involvedObjectKind: 'Pod',
      limit: 10
    })
  },
  {
    section: 'Diagnostics',
    label: 'Resource Usage',
    tool: 'kubectl_top_pods',
    description: 'Check CPU and memory usage',
    icon: '📊',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      labelSelector: node.labels?.app ? `app=${node.labels.app}` : undefined
    })
  },
  // Logs & Exec
  {
    section: 'Logs & Exec',
    label: 'View Current Logs',
    tool: 'kubectl_logs',
    description: 'View logs from running container',
    icon: '📄',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label,
      tailLines: 100,
      timestamps: true
    })
  },
  {
    section: 'Logs & Exec',
    label: 'View Previous Logs',
    tool: 'kubectl_logs',
    description: 'View logs from crashed container',
    icon: '📜',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label,
      previous: true,
      tailLines: 100,
      timestamps: true
    })
  },
  {
    section: 'Logs & Exec',
    label: 'Execute Command',
    tool: 'kubectl_exec',
    description: 'Run a command inside the container',
    icon: '⚡',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      pod: node.label,
      command: ['sh', '-c', 'echo "Ready for command"']
    }),
    requiresInput: true
  },
  // Operations
  {
    section: 'Operations',
    label: 'Delete Pod',
    tool: 'kubectl_delete_pod',
    description: 'Delete pod (triggers recreation if managed by deployment)',
    icon: '🗑️',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label
    })
  },
  // AI Analysis
  {
    section: 'AI Analysis',
    label: 'Improvement Analysis',
    tool: 'improvement_analysis',
    description: 'Analyze improvement opportunities',
    icon: '🟢',
    inputTemplate: (node) => ({ node })
  },
  {
    section: 'AI Analysis',
    label: 'Run Hotfix',
    tool: 'run_hotfix',
    description: 'Suggest and apply hotfix',
    icon: '🟡',
    inputTemplate: (node) => ({ node })
  },
  {
    section: 'AI Analysis',
    label: 'Health Check',
    tool: 'health_check',
    description: 'Comprehensive health analysis',
    icon: '🔵',
    inputTemplate: (node) => ({ node })
  }
];

/**
 * Deployment Actions
 */
const DEPLOYMENT_ACTIONS: NodeAction[] = [
  // Diagnostics
  {
    section: 'Diagnostics',
    label: 'Describe Deployment',
    tool: 'kubectl_get_deployments',
    description: 'Get deployment details and status',
    icon: '🔍',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      labelSelector: `app=${node.label}`
    })
  },
  {
    section: 'Diagnostics',
    label: 'Rollout Status',
    tool: 'kubectl_rollout_status',
    description: 'Check deployment rollout progress',
    icon: '📊',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label
    })
  },
  {
    section: 'Diagnostics',
    label: 'Get Events',
    tool: 'kubectl_get_events',
    description: 'View recent events for this deployment',
    icon: '📋',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      involvedObjectName: node.label,
      involvedObjectKind: 'Deployment',
      limit: 10
    })
  },
  // Operations
  {
    section: 'Operations',
    label: 'Restart Deployment',
    tool: 'kubectl_restart_deployment',
    description: 'Trigger rolling restart',
    icon: '🔄',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label
    })
  },
  {
    section: 'Operations',
    label: 'Scale Deployment',
    tool: 'kubectl_scale_deployment',
    description: 'Scale to specified replica count',
    icon: '📈',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      name: node.label,
      replicas: node.deploymentStatus?.replicas || 1
    }),
    requiresInput: true
  },
  // AI Analysis
  {
    section: 'AI Analysis',
    label: 'Improvement Analysis',
    tool: 'improvement_analysis',
    description: 'Analyze improvement opportunities',
    icon: '🟢',
    inputTemplate: (node) => ({ node })
  },
  {
    section: 'AI Analysis',
    label: 'Run Hotfix',
    tool: 'run_hotfix',
    description: 'Suggest and apply hotfix',
    icon: '🟡',
    inputTemplate: (node) => ({ node })
  }
];

/**
 * Service Actions
 */
const SERVICE_ACTIONS: NodeAction[] = [
  // Diagnostics
  {
    section: 'Diagnostics',
    label: 'Describe Service',
    tool: 'kubectl_get_services',
    description: 'Get service details and endpoints',
    icon: '🔍',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      labelSelector: `app=${node.label}`
    })
  },
  {
    section: 'Diagnostics',
    label: 'Get Events',
    tool: 'kubectl_get_events',
    description: 'View recent events for this service',
    icon: '📋',
    inputTemplate: (node) => ({
      namespace: node.namespace,
      involvedObjectName: node.label,
      involvedObjectKind: 'Service',
      limit: 10
    })
  },
  // AI Analysis
  {
    section: 'AI Analysis',
    label: 'Improvement Analysis',
    tool: 'improvement_analysis',
    description: 'Analyze improvement opportunities',
    icon: '🟢',
    inputTemplate: (node) => ({ node })
  }
];

/**
 * Namespace Actions
 */
const NAMESPACE_ACTIONS: NodeAction[] = [
  // Diagnostics
  {
    section: 'Diagnostics',
    label: 'List Pods',
    tool: 'kubectl_get_pods',
    description: 'List all pods in this namespace',
    icon: '📦',
    inputTemplate: (node) => ({
      namespace: node.label,
      limit: 50
    })
  },
  {
    section: 'Diagnostics',
    label: 'List Deployments',
    tool: 'kubectl_get_deployments',
    description: 'List all deployments in this namespace',
    icon: '🚀',
    inputTemplate: (node) => ({
      namespace: node.label,
      limit: 50
    })
  },
  {
    section: 'Diagnostics',
    label: 'List Services',
    tool: 'kubectl_get_services',
    description: 'List all services in this namespace',
    icon: '🌐',
    inputTemplate: (node) => ({
      namespace: node.label,
      limit: 50
    })
  },
  {
    section: 'Diagnostics',
    label: 'Get Events',
    tool: 'kubectl_get_events',
    description: 'View recent events in this namespace',
    icon: '📋',
    inputTemplate: (node) => ({
      namespace: node.label,
      limit: 20
    })
  },
  // AI Analysis
  {
    section: 'AI Analysis',
    label: 'Health Check',
    tool: 'health_check',
    description: 'Namespace-wide health analysis',
    icon: '🔵',
    inputTemplate: (node) => ({ node })
  }
];

/**
 * Default Actions (for unknown types)
 */
const DEFAULT_ACTIONS: NodeAction[] = [
  {
    section: 'Diagnostics',
    label: 'Get Events',
    tool: 'kubectl_get_events',
    description: 'View recent cluster events',
    icon: '📋',
    inputTemplate: () => ({
      limit: 10
    })
  },
  {
    section: 'AI Analysis',
    label: 'Health Check',
    tool: 'health_check',
    description: 'Comprehensive health analysis',
    icon: '🔵',
    inputTemplate: (node) => ({ node })
  }
];

/**
 * Get actions for a specific node type
 */
export function getActionsForNodeType(type: string): NodeAction[] {
  const normalizedType = type?.toLowerCase();
  
  switch (normalizedType) {
    case 'pod':
      return POD_ACTIONS;
    case 'deployment':
      return DEPLOYMENT_ACTIONS;
    case 'service':
      return SERVICE_ACTIONS;
    case 'namespace':
      return NAMESPACE_ACTIONS;
    default:
      return DEFAULT_ACTIONS;
  }
}

/**
 * Check if a tool is a list operation (shouldn't trigger auto-focus)
 */
export function isListOperation(toolName: string): boolean {
  const listOperations = [
    'kubectl_get_pods',
    'kubectl_get_deployments',
    'kubectl_get_services',
    'kubectl_top_pods',
    'kubectl_get_events'
  ];
  
  return listOperations.includes(toolName);
}

/**
 * Group actions by section
 */
export function groupActionsBySection(actions: NodeAction[]): Record<string, NodeAction[]> {
  return actions.reduce((acc, action) => {
    if (!acc[action.section]) {
      acc[action.section] = [];
    }
    acc[action.section].push(action);
    return acc;
  }, {} as Record<string, NodeAction[]>);
}
