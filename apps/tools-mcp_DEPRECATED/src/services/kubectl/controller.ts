import { KubectlRepository } from './repository.js';
import type {
  GetPodsRequest,
  GetPodsResponse,
  DescribePodRequest,
  DescribePodResponse,
  DeletePodRequest,
  DeletePodResponse,
  GetLogsRequest,
  GetLogsResponse,
  GetDeploymentsRequest,
  GetDeploymentsResponse,
  ScaleDeploymentRequest,
  ScaleDeploymentResponse,
  RestartDeploymentRequest,
  RestartDeploymentResponse,
  RolloutStatusRequest,
  RolloutStatusResponse,
  GetServicesRequest,
  GetServicesResponse,
  GetEventsRequest,
  GetEventsResponse,
  TopPodsRequest,
  TopPodsResponse,
  ExecRequest,
  ExecResponse,
} from './model.js';

/**
 * Kubectl Controller
 * Business logic layer for kubectl operations
 */
export class KubectlController {
  constructor(private repository: KubectlRepository) {}

  // ============================================================================
  // Pod Operations
  // ============================================================================

  async getPods(request: GetPodsRequest): Promise<GetPodsResponse> {
    return await this.repository.getPods(request);
  }

  async describePod(request: DescribePodRequest): Promise<DescribePodResponse> {
    return await this.repository.describePod(request);
  }

  async deletePod(request: DeletePodRequest): Promise<DeletePodResponse> {
    return await this.repository.deletePod(request);
  }

  async getLogs(request: GetLogsRequest): Promise<GetLogsResponse> {
    return await this.repository.getLogs(request);
  }

  // ============================================================================
  // Deployment Operations
  // ============================================================================

  async getDeployments(request: GetDeploymentsRequest): Promise<GetDeploymentsResponse> {
    return await this.repository.getDeployments(request);
  }

  async scaleDeployment(request: ScaleDeploymentRequest): Promise<ScaleDeploymentResponse> {
    return await this.repository.scaleDeployment(request);
  }

  async restartDeployment(request: RestartDeploymentRequest): Promise<RestartDeploymentResponse> {
    return await this.repository.restartDeployment(request);
  }

  async getRolloutStatus(request: RolloutStatusRequest): Promise<RolloutStatusResponse> {
    return await this.repository.getRolloutStatus(request);
  }

  // ============================================================================
  // Service Operations
  // ============================================================================

  async getServices(request: GetServicesRequest): Promise<GetServicesResponse> {
    return await this.repository.getServices(request);
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  async getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
    return await this.repository.getEvents(request);
  }

  // ============================================================================
  // Resource Metrics Operations
  // ============================================================================

  async getTopPods(request: TopPodsRequest): Promise<TopPodsResponse> {
    return await this.repository.getTopPods(request);
  }

  // ============================================================================
  // Exec Operations
  // ============================================================================

  async execCommand(request: ExecRequest): Promise<ExecResponse> {
    return await this.repository.execCommand(request);
  }
}
