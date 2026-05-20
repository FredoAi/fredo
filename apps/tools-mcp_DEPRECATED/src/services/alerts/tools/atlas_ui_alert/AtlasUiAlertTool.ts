import { randomUUID } from 'node:crypto';
import { BaseTool } from '../../../../core/BaseTool.js';
import type { AlertsService } from '../../service.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';

export interface AlertToolInput {
  text: string;
  isAlert?: boolean;
  needsConfirmation?: boolean;
}

export interface AlertToolOutput {
  alertId: string;
  sent: boolean;
  message: string;
  timestamp: string;
}

/**
 * Atlas UI Alert Tool
 * 
 * Sends alerts and messages to the browser extension UI.
 * Uses event-based architecture - publishes to Redis Stream and returns immediately.
 * 
 * User confirmations arrive asynchronously via API endpoint and are auto-attached
 * to subsequent MCP tool responses via pendingUIResponses array.
 */
export class AtlasUiAlertTool extends BaseTool {
  readonly name = 'atlas_ui_alert';
  readonly description = 'Use to notify user of important events or request confirmation. FIRE-AND-FORGET: send alert, continue work, check pendingUIResponses later. Requires: text (string). Optional: isAlert (true=warning/orange, false=info/blue), needsConfirmation (true=shows Confirm button). Does NOT: block execution, guarantee immediate response. User responses arrive in next tool call via pendingUIResponses (5min TTL). Use for: status updates, permission requests, warnings.';

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = false;
  readonly allowProgrammaticCalling = false;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: 'Alert or message text to display to user'
      },
      isAlert: {
        type: 'boolean',
        description: 'If true, shows as warning/alert (orange). If false, shows as info message (blue). Default: false'
      },
      needsConfirmation: {
        type: 'boolean',
        description: 'If true, shows Confirm button and waits for user action. Response arrives in pendingUIResponses. Default: false'
      }
    },
    required: ['text']
  };

  readonly inputExamples = [
    {
      title: 'Simple Info Message',
      description: 'Display informational message without confirmation',
      input: {
        text: 'Pod restarted successfully',
        isAlert: false,
        needsConfirmation: false
      },
      output: {
        description: 'Returns alertId and confirmation that event was sent',
        example: {
          alertId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          sent: true,
          message: 'Message sent to UI',
          timestamp: '2026-02-14T10:30:00.000Z'
        }
      }
    },
    {
      title: 'Alert with Confirmation',
      description: 'Display warning alert requiring user confirmation',
      input: {
        text: 'About to delete pod api-gateway-7d9f8b. Confirm?',
        isAlert: true,
        needsConfirmation: true
      },
      output: {
        description: 'Returns immediately. User confirmation arrives in pendingUIResponses of next tool call',
        example: {
          alertId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
          sent: true,
          message: 'Alert sent to UI - confirmation pending',
          timestamp: '2026-02-14T10:31:00.000Z'
        }
      }
    }
  ];

  constructor(_service: AlertsService) {
    super();
  }

  async execute(
    input: AlertToolInput,
    context?: { sseConnectionId?: string }
  ): Promise<AlertToolOutput> {
    const connectionId = context?.sseConnectionId;

    if (!connectionId) {
      throw new Error(
        '[ALERT TOOL] context.sseConnectionId is undefined. ' +
        'Ensure handshake was called first to establish session.'
      );
    }

    const alertId = randomUUID();
    const timestamp = new Date().toISOString();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔔 [ALERT TOOL] Sending alert to UI');
    console.log('   🆔 Alert ID:', alertId);
    console.log('   🆔 Connection ID:', connectionId);
    console.log('   💬 Text:', input.text);
    console.log('   ⚠️  Is Alert:', input.isAlert ?? false);
    console.log('   ✅ Needs Confirmation:', input.needsConfirmation ?? false);

    try {
      // Publish alert event to Redis Stream → SSE → Browser Extension
      const publisher = StreamPublisher.getInstance();
      const correlationId = `atlas_ui_alert_${Date.now()}`;

      // Single Response event: shows the toast in the UI and completes the stepper step.
      await publisher.publishResponse('atlas_ui_alert', connectionId, {
        alertId,
        text: input.text,
        isAlert: input.isAlert ?? false,
        needsConfirmation: input.needsConfirmation ?? false,
        timestamp
      }, correlationId);

      console.log('   📤 Alert event published to Redis Stream');
      console.log('   🎯 Fire-and-forget: returning immediately');
      
      if (input.needsConfirmation) {
        console.log('   ⏳ User confirmation will arrive in pendingUIResponses');
      }
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      return {
        alertId,
        sent: true,
        message: input.needsConfirmation 
          ? 'Alert sent to UI - confirmation pending' 
          : input.isAlert 
            ? 'Alert sent to UI' 
            : 'Message sent to UI',
        timestamp
      };
    } catch (error) {
      console.error('❌ Failed to send alert:', error);
      throw new Error(`Failed to send alert: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
