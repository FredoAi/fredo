import { BaseTool, type ToolInputSchema, type ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';

export class AzdoCreateWorkitemTool extends BaseTool {
  readonly name = 'azdo_create_workitem';
  readonly description = 'Use to populate work item form in browser for user review before creation. Call multiple times to iterate on draft. PRIORITY REVERSED: 1=Critical, 2=High, 3=Medium, 4=Low (NOT standard scale). Requires: title, type (Bug/Task/User Story/Feature/Epic), description. Optional: priority, assignedTo, tags, acceptanceCriteria. Does NOT: create work item directly, bypass user review. User creates via form UI. Result arrives in pendingUIResponses with workItemId and URL.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;
  
  readonly inputSchema: ToolInputSchema = {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'Work item title - clear, specific, and actionable',
        example: 'Fix authentication timeout on iOS mobile app login'
      },
      type: {
        type: 'string',
        description: 'Work item type - choose based on work nature',
        enum: ['Bug', 'Task', 'User Story', 'Feature', 'Epic'],
        example: 'Bug'
      },
      description: {
        type: 'string',
        description: 'Detailed description with context, steps, impact (HTML supported)',
        example: 'Users on iOS 16+ experience 30-second timeout during OAuth flow when network switches between WiFi and cellular. Affects 15% of mobile users.'
      },
      priority: {
        type: 'number',
        description: 'Priority level: 1=Critical, 2=High, 3=Medium, 4=Low',
        minimum: 1,
        maximum: 4,
        example: 1
      },
      assignedTo: {
        type: 'string',
        description: 'Email or display name of person to assign',
        example: 'jane.doe@company.com'
      },
      tags: {
        type: 'string',
        description: 'Comma-separated tags for categorization',
        example: 'mobile, authentication, ios, urgent'
      },
      acceptanceCriteria: {
        type: 'string',
        description: 'Clear criteria for completion and testing (HTML supported)',
        example: 'Login completes in <5 seconds on iOS 16+ with network transitions. No timeout errors in logs for 48 hours after deployment.'
      },
      areaPath: {
        type: 'string',
        description: 'Team or area path (optional, defaults to project root)',
        example: 'MyProject\\Mobile\\iOS'
      },
      iterationPath: {
        type: 'string',
        description: 'Sprint or iteration path (optional)',
        example: 'MyProject\\Sprint 23'
      }
    },
    additionalProperties: false
  };
  
  readonly inputExamples: ToolExample[] = [
    {
      title: 'Initial Draft from User Request',
      description: 'User requested help creating work item, send populated draft',
      input: {
        title: 'Fix login authentication timeout on mobile',
        type: 'Bug',
        description: 'Users experiencing timeout issues during login process',
        priority: 1
      },
      output: {
        description: 'Opens form in Fredo UI with populated fields for review',
        example: {
          message: 'Work item draft sent to Fredo UI',
          fieldsProvided: ['title', 'type', 'description', 'priority'],
          timestamp: '2026-02-18T10:00:00.000Z'
        }
      }
    },
    {
      title: 'Iterative Refinement After Review',
      description: 'User asked for review of their draft, send improved version',
      input: {
        title: 'Fix authentication timeout on iOS 16+ devices during network transitions',
        description: '<p>Users on iOS 16 and later experience 30-second timeout during OAuth flow when device switches between WiFi and cellular networks.</p><p><strong>Impact:</strong> Affects 15% of mobile users, causing login failures.</p><p><strong>Root Cause:</strong> OAuth token refresh not handling network state changes properly.</p>',
        priority: 1,
        tags: 'mobile, authentication, ios, network-transition',
        acceptanceCriteria: '<ul><li>Login completes in <5 seconds on all iOS versions</li><li>Network transitions handled gracefully</li><li>Zero timeout errors in production logs for 48 hours post-deployment</li></ul>'
      },
      output: {
        description: 'Updates existing form with refined data, highlights changed fields',
        example: {
          message: 'Work item draft updated in Fredo UI',
          fieldsProvided: ['title', 'description', 'priority', 'tags', 'acceptanceCriteria'],
          timestamp: '2026-02-18T10:05:00.000Z'
        }
      }
    }
  ];
  
  readonly notes = [
    'This tool sends draft data to UI - it does NOT create the work item in Azure DevOps',
    'User must review and click "Create Work Item" button in UI to finalize',
    'Can be called multiple times to iteratively refine the draft',
    'All fields are optional - provide only fields you want to populate/update',
    'Form merges incoming data with existing user input (preserves user edits)'
  ];
  
  readonly relatedTools = ['azdo_start_workitem'];
  
  async execute(input: any, context?: { sseConnectionId?: string }): Promise<any> {
    const sseConnectionId = context?.sseConnectionId;
    
    if (!sseConnectionId) {
      throw new Error('Browser extension session required. Ensure extension is connected.');
    }
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 [AZDO CREATE WORKITEM] Sending draft to UI');
    console.log('   Connection ID:', sseConnectionId);
    console.log('   Fields provided:', Object.keys(input).join(', '));
    
    try {
      const publisher = StreamPublisher.getInstance();
      const correlationId = `azdo-create-${Date.now()}`;
      
      // Publish Init event to open/update form
      await publisher.publishInit(
        'azdo_create_workitem',
        sseConnectionId,
        { ...input, merge: true },
        correlationId
      );

      // Publish Response immediately so the SideStepper can complete the step.
      // The work item form is now open for user review; actual creation happens
      // when the user submits the form (tracked via pendingUIResponses).
      await publisher.publishResponse(
        'azdo_create_workitem',
        sseConnectionId,
        { message: 'Work item draft sent to Fredo UI for user review', fieldsProvided: Object.keys(input) },
        correlationId
      );
      
      console.log('   ✅ Draft sent to browser extension');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      return {
        message: 'Work item draft sent to Fredo UI for user review',
        fieldsProvided: Object.keys(input),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('   ❌ Failed to send draft:', error);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      throw error;
    }
  }
}
