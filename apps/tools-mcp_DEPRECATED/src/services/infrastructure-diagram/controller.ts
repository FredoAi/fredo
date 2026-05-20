import { InfrastructureDiagramRepository } from './repository.js';
import { GraphDerivation } from './graph-derivation.js';
import { InfrastructureGraph } from './model.js';

/**
 * Infrastructure Diagram Controller
 */
export class InfrastructureDiagramController {
  private graphDerivation: GraphDerivation;

  constructor(private repository: InfrastructureDiagramRepository) {
    this.graphDerivation = new GraphDerivation(repository);
  }

  /**
   * Get snapshot of complete infrastructure graph
   */
  async getSnapshot(): Promise<InfrastructureGraph> {
    return this.graphDerivation.deriveGraph();
  }

  /**
   * Get resource statistics
   */
  async getStats(): Promise<any> {
    return {
      totalResources: this.repository.getResourceCount(),
      resourcesByKind: this.repository.getResourceCountsByKind(),
      timestamp: new Date().toISOString(),
    };
  }
}
