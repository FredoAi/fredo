/**
 * Human-readable labels for kubectl operations.
 * Displayed in the floating operation tooltip above diagram nodes.
 */
export const KUBECTL_OPERATION_LABELS: Record<string, string> = {
  kubectl_restart_deployment: 'Restarting Deployment',
  kubectl_logs: 'Fetching Logs',
  kubectl_describe_pod: 'Describing Pod',
  kubectl_delete_pod: 'Deleting Pod',
  kubectl_exec: 'Executing Command',
  kubectl_scale_deployment: 'Scaling Deployment',
  kubectl_rollout_status: 'Checking Rollout',
  kubectl_get_events: 'Fetching Events',
  kubectl_top_pods: 'Fetching Metrics',
};
