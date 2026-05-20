import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import { StepperTool } from './tools/atlas_ui_stepper/AtlasUiStepperTool.js';
import { CollectResponsesTool } from './tools/atlas_ui_collect_responses/AtlasUiCollectResponsesTool.js';
import * as atlasUiRoutes from './routes.js';
import { EventEmitter } from 'events';

interface Step {
  name: string;
  description?: string;
  status: 'Waiting' | 'Running' | 'Completed' | 'Error';
  needsPermit?: boolean;
}

interface StepsPayload {
  steps: Step[];
}

interface UpdatePayload {
  update: Step[];
}

type StepperInput = StepsPayload | UpdatePayload;

interface StepperEvent {
  type: 'steps' | 'update';
  data: Step[];
  connectionId?: string;
  timestamp: string;
}

export class AtlasUiService extends BaseService {
  readonly name = 'atlas-ui';
  readonly description = 'Atlas UI integration service for frontend communication';
  readonly routes = atlasUiRoutes;
  
  // Required by BaseService but not used for this simple service
  readonly model = null;
  readonly repository = null;
  readonly controller = null;

  // Event emitter for broadcasting step updates to SSE clients
  private eventEmitter: EventEmitter;
  
  // Track current steps per connection
  private connectionSteps: Map<string, Step[]> = new Map();
  private currentStepIndex: Map<string, number> = new Map();

  constructor() {
    super();
    this.eventEmitter = new EventEmitter();
    this.eventEmitter.setMaxListeners(100); // Support many concurrent connections
  }

  async init(): Promise<void> {
    console.log('[AtlasUiService] Initialized');
  }

  /**
   * Subscribe to step updates for a specific connection
   */
  subscribe(connectionId: string, callback: (event: StepperEvent) => void): () => void {
    const eventName = `stepper:${connectionId}`;
    this.eventEmitter.on(eventName, callback);
    
    console.log(`[AtlasUiService] Client subscribed to connection: ${connectionId}`);
    
    // Return unsubscribe function
    return () => {
      this.eventEmitter.off(eventName, callback);
      console.log(`[AtlasUiService] Client unsubscribed from connection: ${connectionId}`);
    };
  }

  /**
   * Broadcast step event to all subscribers of a connection
   */
  private broadcast(connectionId: string, event: StepperEvent): void {
    const eventName = `stepper:${connectionId}`;
    const listenerCount = this.eventEmitter.listenerCount(eventName);
    
    if (listenerCount > 0) {
      console.log(`[AtlasUiService] Broadcasting to ${listenerCount} client(s) on connection: ${connectionId}`);
      this.eventEmitter.emit(eventName, event);
    } else {
      console.log(`[AtlasUiService] No subscribers for connection: ${connectionId}`);
    }
  }

  /**
   * Broadcast to connection (public method for tools)
   */
  broadcastToConnection(connectionId: string, event: { type: string; data: any }): void {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('   [SERVICE] broadcastToConnection called');
    console.log('   [SERVICE]   Connection ID:', connectionId);
    console.log('   [SERVICE]   Event type:', event.type);
    console.log('   [SERVICE]   Data length:', event.data?.length || 0);
    console.log('╚══════════════════════════════════════════════════════╝\n');
    
    const stepperEvent: StepperEvent = {
      type: event.type as 'steps' | 'update',
      data: event.data,
      connectionId,
      timestamp: new Date().toISOString()
    };
    
    // Broadcast to local subscribers (MCP server's own EventEmitter)
    this.broadcast(connectionId, stepperEvent);
    
    // Store steps for this connection if this is initial steps
    if (event.type === 'steps') {
      console.log('   [SERVICE]   Storing', event.data.length, 'steps in memory');
      this.connectionSteps.set(connectionId, event.data);
      this.currentStepIndex.set(connectionId, 0);
      console.log('   [SERVICE]   Steps stored, current index: 0');
    }
    
    // Send to API server if we're in MCP server (cross-process communication)
    console.log('   [SERVICE] SERVER_TYPE:', process.env.SERVER_TYPE);
    console.log('   [SERVICE] Should broadcast to API server:', process.env.SERVER_TYPE === 'mcp');
    
    if (process.env.SERVER_TYPE === 'mcp') {
      console.log('   [SERVICE] 📡 Broadcasting to API server via HTTP...');
      fetch('http://api-server:3000/api/v1/atlas-ui/internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, event: stepperEvent })
      }).then(response => {
        console.log('   [SERVICE] ✅ Broadcast sent to API server, status:', response.status);
      }).catch(error => {
        console.error('   [SERVICE] ❌ Failed to broadcast to API server:', error);
      });
    } else {
      console.log('   [SERVICE] ⚠️  Not broadcasting to API server (SERVER_TYPE is not "mcp")');
    }
  }

  /**
   * Advance to next step
   */
  advanceStep(connectionId: string): void {
    console.log('   [SERVICE] advanceStep called');
    const steps = this.connectionSteps.get(connectionId);
    const currentIndex = this.currentStepIndex.get(connectionId) ?? 0;
    
    console.log('   [SERVICE]   Current index:', currentIndex);
    console.log('   [SERVICE]   Total steps:', steps?.length || 0);
    
    if (!steps || steps.length === 0) {
      console.log('   [SERVICE]   ⚠️  No steps found in memory - cannot advance');
      return;
    }
    
    // Mark current step as completed
    if (currentIndex < steps.length) {
      console.log('   [SERVICE]   Marking step', currentIndex, 'as Completed:', steps[currentIndex].name);
      steps[currentIndex].status = 'Completed';
    }
    
    // Move to next step
    const nextIndex = currentIndex + 1;
    if (nextIndex < steps.length) {
      console.log('   [SERVICE]   Marking step', nextIndex, 'as Running:', steps[nextIndex].name);
      steps[nextIndex].status = 'Running';
      this.currentStepIndex.set(connectionId, nextIndex);
    } else {
      console.log('   [SERVICE]   ✅ All steps completed!');
    }
    
    // Broadcast update
    console.log('   [SERVICE]   Broadcasting update to SSE stream...');
    this.broadcastToConnection(connectionId, {
      type: 'update',
      data: steps
    });
    
    console.log(`   [SERVICE]   ✅ Advanced to step ${nextIndex + 1}/${steps.length}`);
  }

  /**
   * Get current steps for a connection (for late subscribers)
   */
  getCurrentSteps(connectionId: string): Step[] | undefined {
    return this.connectionSteps.get(connectionId);
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }

  getTools(): BaseTool[] {
    return [
      new StepperTool(this),
      new CollectResponsesTool(this)
    ];
  }

  /**
   * Initialize handshake with client
   * Returns SSE connection ID if available
   */
  async handshake(sseConnectionId?: string): Promise<{ 
    connectionId?: string; 
    message: string;
    timestamp: string;
  }> {
    if (!sseConnectionId) {
      return {
        message: 'No SSE Id on API calls use MCP',
        timestamp: new Date().toISOString()
      };
    }

    return {
      connectionId: sseConnectionId,
      message: 'Handshake successful',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Process stepper data (steps initialization or updates)
   */
  async processStepper(input: StepperInput, sseConnectionId?: string): Promise<{
    success: boolean;
    message: string;
    count: number;
    type: 'steps' | 'update';
    connectionId?: string;
    timestamp: string;
  }> {
    const isSteps = 'steps' in input;
    const dataArray = isSteps ? input.steps : input.update;
    const type = isSteps ? 'steps' : 'update';

    console.log(`[AtlasUiService] Processing ${type} with ${dataArray.length} items`);
    
    // Broadcast to subscribed clients if we have a connection ID
    if (sseConnectionId) {
      const event: StepperEvent = {
        type,
        data: dataArray,
        connectionId: sseConnectionId,
        timestamp: new Date().toISOString()
      };
      
      this.broadcast(sseConnectionId, event);
      
      // Also send to API server if we're in MCP server (cross-process communication)
      console.log('[SERVICE] SERVER_TYPE:', process.env.SERVER_TYPE);
      console.log('[SERVICE] Should broadcast to API server:', process.env.SERVER_TYPE === 'mcp');
      
      if (process.env.SERVER_TYPE === 'mcp') {
        console.log('[SERVICE] 📡 Broadcasting to API server via HTTP...');
        try {
          const response = await fetch('http://api-server:3000/api/v1/atlas-ui/internal/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId: sseConnectionId, event })
          });
          console.log('[SERVICE] ✅ Broadcast sent to API server, status:', response.status);
        } catch (error) {
          console.error('[AtlasUiService] ❌ Failed to broadcast to API server:', error);
        }
      } else {
        console.log('[SERVICE] ⚠️  Not broadcasting to API server (SERVER_TYPE is not "mcp")');
      }
    }

    return {
      success: true,
      message: isSteps ? 'Steps initialized' : 'Steps updated',
      count: dataArray.length,
      type,
      connectionId: sseConnectionId,
      timestamp: new Date().toISOString()
    };
  }
}
