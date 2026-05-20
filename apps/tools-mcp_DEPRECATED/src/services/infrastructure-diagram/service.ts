import { EventEmitter } from 'events';
import { BaseService } from '../../core/BaseService.js';
import * as InfrastructureDiagramModel from './model.js';
import { InfrastructureDiagramRepository } from './repository.js';
import { InfrastructureDiagramController } from './controller.js';
import { GraphDerivation } from './graph-derivation.js';
import { KubernetesWatcher } from './k8s-watcher.js';
import * as infrastructureDiagramRoutes from './routes.js';

/**
 * Infrastructure Diagram Service
 * Kubernetes Infrastructure Graph API
 */
export class InfrastructureDiagramService extends BaseService {
  readonly name = 'infrastructure-diagram';
  readonly model = InfrastructureDiagramModel;
  readonly repository: InfrastructureDiagramRepository;
  readonly controller: InfrastructureDiagramController;
  readonly routes = infrastructureDiagramRoutes;

  private k8sWatcher: KubernetesWatcher;
  private graphDerivation: GraphDerivation;
  private eventEmitter: EventEmitter;

  constructor() {
    super();
    this.repository = new InfrastructureDiagramRepository();
    this.controller = new InfrastructureDiagramController(this.repository);
    this.graphDerivation = new GraphDerivation(this.repository);
    this.k8sWatcher = new KubernetesWatcher();
    this.eventEmitter = new EventEmitter();
    this.eventEmitter.setMaxListeners(100);
  }

  async init(): Promise<void> {
    console.log('[InfrastructureDiagramService] Initializing...');

    await this.repository.init();

    // Store service instance globally for tools
    (globalThis as any).__infraService = this;

    // Set up Kubernetes watch event handlers
    this.k8sWatcher.on('resource:added', (resource) => {
      this.repository.upsertResource(resource);
      const updates = this.graphDerivation.deriveUpdate(resource, 'added');
      this.emitUpdates(updates);
    });

    this.k8sWatcher.on('resource:updated', (resource) => {
      this.repository.upsertResource(resource);
      const updates = this.graphDerivation.deriveUpdate(resource, 'updated');
      this.emitUpdates(updates);
    });

    this.k8sWatcher.on('resource:deleted', (resource) => {
      this.repository.deleteResource(resource.uid);
      const updates = this.graphDerivation.deriveUpdate(resource, 'deleted');
      this.emitUpdates(updates);
    });

    // Start watching Kubernetes
    await this.k8sWatcher.start();

    console.log('[InfrastructureDiagramService] Initialized successfully');
  }

  /**
   * Emit graph updates to all subscribers
   */
  private emitUpdates(updates: InfrastructureDiagramModel.GraphUpdate[]): void {
    for (const update of updates) {
      this.eventEmitter.emit('graph:update', update);
    }
  }

  /**
   * Subscribe to graph updates
   */
  on(event: string, handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Unsubscribe from graph updates
   */
  removeListener(event: string, handler: (...args: any[]) => void): void {
    this.eventEmitter.removeListener(event, handler);
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    console.log('[InfrastructureDiagramService] Stopping...');
    this.k8sWatcher.stop();
    this.eventEmitter.removeAllListeners();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }
}

export default InfrastructureDiagramService;
