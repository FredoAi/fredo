import { BaseTool } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';

export interface AzdoStartWorkitemInput {
  workItemId?: number; // Optional: if provided, show detail modal; if not, show list
}

export interface AzdoStartWorkitemOutput {
  message: string;
  mode: 'list' | 'detail';
  workItemId?: number;
  timestamp: string;
}

export class AzdoStartWorkitemTool extends BaseTool {
  readonly name = 'azdo_start_workitem';
  readonly description = 'Use to show user their assigned work items or start work on specific item. Optional: workItemId (integer). Without workItemId: shows list of all assigned work items. With workItemId: shows detail view for that work item. Does NOT: create work items (use azdo_create_workitem), modify work items, assign to others. Opens UI for user to review and update status to Active/In Progress. Used to begin work sessions.';

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      workItemId: {
        type: 'number',
        description: 'Optional work item ID. If provided, shows detail view; otherwise shows list of all assigned work items'
      }
    },
    additionalProperties: false
  };

  readonly inputExamples = [
    {
      title: 'Show All Work Items',
      description: 'Display list of all work items assigned to the user',
      input: {},
      output: {
        description: 'Opens work items list in Fredo extension',
        example: {
          message: 'Opening work items list in Fredo extension',
          mode: 'list',
          timestamp: '2026-02-18T10:30:00.000Z'
        }
      }
    },
    {
      title: 'Show Specific Work Item',
      description: 'Display details of a specific work item',
      input: { workItemId: 12345 },
      output: {
        description: 'Opens work item detail modal in Fredo extension',
        example: {
          message: 'Opening work item #12345 in Fredo extension',
          mode: 'detail',
          workItemId: 12345,
          timestamp: '2026-02-18T10:30:00.000Z'
        }
      }
    }
  ];

  async execute(
    input: AzdoStartWorkitemInput,
    context?: { sseConnectionId?: string }
  ): Promise<AzdoStartWorkitemOutput> {
    const sseConnectionId = context?.sseConnectionId;
    
    if (!sseConnectionId) {
      throw new Error(
        '[AZDO START WORKITEM TOOL] context.sseConnectionId is undefined. ' +
        'This tool requires an active browser extension session.'
      );
    }
    
    const mode = input.workItemId ? 'detail' : 'list';
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 [AZDO START WORKITEM TOOL] Execute called');
    console.log('   🆔 Connection ID:', sseConnectionId);
    console.log('   📊 Mode:', mode);
    if (input.workItemId) {
      console.log('   🎯 Work Item ID:', input.workItemId);
    }
    
    try {
      const publisher = StreamPublisher.getInstance();
      const correlationId = `azdo-workitem-${Date.now()}`;
      
      // Publish init event to Redis for browser extension
      await publisher.publishInit(
        'azdo_start_workitem',
        sseConnectionId,
        input,
        correlationId
      );
      
      console.log('   ✅ Event published to Redis');
      
      const response: AzdoStartWorkitemOutput = {
        message: input.workItemId 
          ? `Opening work item #${input.workItemId} in Fredo extension`
          : 'Opening work items list in Fredo extension',
        mode,
        workItemId: input.workItemId,
        timestamp: new Date().toISOString()
      };
      
      console.log('   📤 Returning response to AI agent');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      return response;
    } catch (error) {
      console.error('   ❌ Failed to publish event:', error);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      throw error;
    }
  }
}
