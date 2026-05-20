import { K8sResource } from './model.js';

/**
 * Canonical resource store - in-memory state of all Kubernetes objects
 */
export class InfrastructureDiagramRepository {
  private resources: Map<string, K8sResource> = new Map();
  private resourcesByKind: Map<string, Map<string, K8sResource>> = new Map();

  async init(): Promise<void> {
    console.log('[InfrastructureDiagramRepository] Initialized');
  }

  /**
   * Store or update a Kubernetes resource
   */
  upsertResource(resource: K8sResource): void {
    this.resources.set(resource.uid, resource);

    // Index by kind
    if (!this.resourcesByKind.has(resource.kind)) {
      this.resourcesByKind.set(resource.kind, new Map());
    }
    this.resourcesByKind.get(resource.kind)!.set(resource.uid, resource);
  }

  /**
   * Remove a resource by UID
   */
  deleteResource(uid: string): boolean {
    const resource = this.resources.get(uid);
    if (!resource) return false;

    this.resources.delete(uid);

    // Remove from kind index
    const kindMap = this.resourcesByKind.get(resource.kind);
    if (kindMap) {
      kindMap.delete(uid);
    }

    return true;
  }

  /**
   * Get resource by UID
   */
  getResource(uid: string): K8sResource | undefined {
    return this.resources.get(uid);
  }

  /**
   * Get all resources of a specific kind
   */
  getResourcesByKind(kind: string): K8sResource[] {
    const kindMap = this.resourcesByKind.get(kind);
    return kindMap ? Array.from(kindMap.values()) : [];
  }

  /**
   * Get all resources
   */
  getAllResources(): K8sResource[] {
    return Array.from(this.resources.values());
  }

  /**
   * Clear all resources (for resync)
   */
  clear(): void {
    this.resources.clear();
    this.resourcesByKind.clear();
  }

  /**
   * Get resource count
   */
  getResourceCount(): number {
    return this.resources.size;
  }

  /**
   * Get resource counts by kind
   */
  getResourceCountsByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [kind, kindMap] of this.resourcesByKind) {
      counts[kind] = kindMap.size;
    }
    return counts;
  }
}
