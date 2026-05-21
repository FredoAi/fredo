/**
 * Stepper Tool - Redis Streams Event-Driven Version
 * 
 * Publishes step execution events to Redis Streams for consumption by browser extension
 * Events flow: StepperTool → Redis Streams → StreamConsumer → SSE → Browser
 */

import { BaseTool } from '../../../../core/BaseTool.js';
import { FredoUiService } from '../../service.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';

export interface StepperStep {
  title: string;
  description?: string;
  status: 'Waiting' | 'Running' | 'Completed' | 'Error';
  needsPermit?: boolean;
  /**
   * Tool name whose stream events automatically drive this step's status.
   * Init → Running, Response → Completed, Error → Error.
   * If omitted the step stays at its initial status (static display).
   */
  triggerEvent?: string;
}

export interface StepperToolInput {
  steps: StepperStep[];
}

export class FredoUiStepperTool extends BaseTool {
  readonly name = 'fredo_ui_stepper';
  readonly description = 'Call this ONCE when starting a SOP execution — immediately after kb_sops returns a match, before executing any step. Declare ALL steps upfront. Set triggerEvent on each step to the name of the tool that executes that step; the browser extension automatically advances step status as those tools run (tool called → Running, tool responded → Completed, tool errored → Error). Never call this tool again after the initial call — status is driven automatically. Steps without triggerEvent remain static.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'All workflow steps declared upfront',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Step display name (required)' },
            description: { type: 'string', description: 'Step detail text' },
            status: {
              type: 'string',
              enum: ['Waiting', 'Running', 'Completed', 'Error'],
              description: 'Initial status (Waiting for most steps)'
            },
            needsPermit: { type: 'boolean', description: 'Whether this step requires user approval' },
            triggerEvent: {
              type: 'string',
              description: 'Tool name whose events auto-drive this step\'s status (Init→Running, Response→Completed, Error→Error)'
            }
          },
          required: ['title', 'status']
        }
      }
    },
    required: ['steps'],
    additionalProperties: false
  } as const;

  readonly inputExamples = [
    {
      title: 'Event-driven workflow',
      description: 'Steps auto-update as matching tools execute',
      input: {
        steps: [
          { title: 'Query pod logs', status: 'Waiting', triggerEvent: 'kubectl_logs' },
          { title: 'Analyze errors', status: 'Waiting', triggerEvent: 'code_execute' },
          { title: 'Create incident ticket', status: 'Waiting', triggerEvent: 'jira_create_issue' }
        ]
      },
      output: {
        description: 'Stepper displayed; steps auto-advance as tools run',
        example: { success: true, stepsCount: 3 }
      }
    },
    {
      title: 'Static workflow (no triggerEvent)',
      description: 'Steps displayed statically — update manually if needed',
      input: {
        steps: [
          { title: 'Analyze codebase', status: 'Waiting' },
          { title: 'Generate report', status: 'Waiting' },
          { title: 'Send notification', status: 'Waiting' }
        ]
      },
      output: {
        description: 'Stepper displayed with static steps',
        example: { success: true, stepsCount: 3 }
      }
    }
  ];

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = false;
  readonly allowProgrammaticCalling = false;

  constructor(_service: FredoUiService) {
    super();
  }

  async execute(input: StepperToolInput, context?: any): Promise<any> {
    const sseConnectionId = context?.sseConnectionId;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 [STEPPER TOOL] Execute called');
    console.log('   🔗 Connection ID:', sseConnectionId);
    console.log('   📊 Steps:', input.steps?.length || 0);

    if (!sseConnectionId) {
      console.log('   ⚠️  No connectionId - cannot publish events');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      return { success: false, error: 'No session ID provided' };
    }

    try {
      const publisher = StreamPublisher.getInstance();
      const correlationId = `stepper_${Date.now()}`;

      await publisher.publishInit(
        'fredo_ui_stepper',
        sseConnectionId,
        input,
        correlationId
      );
      console.log('   ✅ Init event published to Redis');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      return {
        success: true,
        stepsCount: input.steps?.length,
      };

    } catch (error) {
      console.error('   ❌ Failed to publish event:', error);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      throw error;
    }
  }
}

