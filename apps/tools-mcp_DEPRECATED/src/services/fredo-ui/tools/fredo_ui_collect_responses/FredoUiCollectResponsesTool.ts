import { BaseTool } from '../../../../core/BaseTool.js';
import type { FredoUiService } from '../../service.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';

export interface CollectResponsesToolInput {
  // No input parameters needed - uses session context
}

export interface CollectResponsesToolOutput {
  success: boolean;
  connectionId: string;
  responses: Array<{
    featureId: string;
    payload: any;
    metadata?: any;
  }>;
  count: number;
  collectedAt: string;
}

export class FredoUiCollectResponsesTool extends BaseTool {
  readonly name = 'fredo_ui_collect_responses';
  readonly description = 'Use to explicitly retrieve pending user responses when needed immediately (normally auto-included in pendingUIResponses). No parameters. Does NOT: wait for responses, block execution. Responses auto-deleted after collection (5min TTL). Use when: explicitly checking for alert confirmations, work item creation results, form submissions. Returns: array of response payloads. Responses also appear in pendingUIResponses of subsequent tool calls.';

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = false;
  readonly allowProgrammaticCalling = false;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {},
    additionalProperties: false
  };

  readonly inputExamples = [
    {
      title: 'Collect Pending Responses',
      description: 'Retrieve all pending UI responses and clear them',
      input: {},
      output: {
        description: 'Returns all pending responses with metadata',
        example: {
          success: true,
          connectionId: 'a3245ba6-3cfb-420d-bc74-9151603d2e7c',
          responses: [
            {
              featureId: 'azdo-create-workitem',
              payload: {
                workItemId: 12345,
                url: 'https://dev.azure.com/...'
              },
              metadata: {
                timestamp: '2026-02-18T10:30:00.000Z'
              }
            }
          ],
          count: 1,
          collectedAt: '2026-02-18T10:30:05.000Z'
        }
      }
    },
    {
      title: 'No Pending Responses',
      description: 'When no responses are pending',
      input: {},
      output: {
        description: 'Returns empty array with zero count',
        example: {
          success: true,
          connectionId: 'a3245ba6-3cfb-420d-bc74-9151603d2e7c',
          responses: [],
          count: 0,
          collectedAt: '2026-02-18T10:30:05.000Z'
        }
      }
    }
  ];

  constructor(_service: FredoUiService) {
    super();
  }

  async execute(
    _input: CollectResponsesToolInput,
    context?: { sseConnectionId?: string }
  ): Promise<CollectResponsesToolOutput> {
    const connectionId = context?.sseConnectionId;
    
    if (!connectionId) {
      // Session is always set before tool execution by mcpServer, but guard gracefully
      console.warn('[COLLECT RESPONSES TOOL] No sseConnectionId in context — returning empty.');
      return {
        success: true,
        connectionId: '',
        responses: [],
        count: 0,
        collectedAt: new Date().toISOString()
      };
    }
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📬 [COLLECT RESPONSES TOOL] Execute called');
    console.log('   🆔 Connection ID:', connectionId);
    
    try {
      // Get Redis client from StreamPublisher singleton
      const publisher = StreamPublisher.getInstance();
      const redis = publisher.getClient();
      
      // Search for all response keys matching the connection
      const pattern = `ui:response:${connectionId}:*`;
      console.log('   🔍 Searching for keys:', pattern);
      
      const keys = await redis.keys(pattern);
      console.log(`   📊 Found ${keys.length} pending response(s)`);
      
      if (keys.length === 0) {
        const response: CollectResponsesToolOutput = {
          success: true,
          connectionId,
          responses: [],
          count: 0,
          collectedAt: new Date().toISOString()
        };
        
        console.log('   ✅ No pending responses to collect');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        
        return response;
      }
      
      // Collect and delete responses atomically using pipeline
      const responses: Array<{ featureId: string; payload: any; metadata?: any }> = [];
      const pipeline = redis.pipeline();
      
      // Queue GET operations for all keys
      for (const key of keys) {
        pipeline.get(key);
      }
      
      // Execute GET operations
      const getResults = await pipeline.exec();
      
      if (!getResults) {
        throw new Error('Pipeline execution returned null');
      }
      
      // Parse responses and queue DELETE operations
      const deletePipeline = redis.pipeline();
      let successCount = 0;
      
      for (let i = 0; i < getResults.length; i++) {
        const [error, data] = getResults[i];
        const key = keys[i];
        
        if (error) {
          console.warn(`   ⚠️  Error retrieving key ${key}:`, error);
          continue;
        }
        
        if (data) {
          try {
            const parsed = JSON.parse(data as string);
            responses.push(parsed);
            successCount++;
            console.log(`   ✅ Retrieved response from feature: ${parsed.featureId}`);
          } catch (parseError) {
            console.warn(`   ⚠️  Failed to parse JSON for key ${key}:`, parseError);
          }
        }
        
        // Queue deletion regardless of parse success
        deletePipeline.del(key);
      }
      
      // Execute DELETE operations
      await deletePipeline.exec();
      console.log(`   🗑️  Deleted ${keys.length} response key(s) from Redis`);
      
      const response: CollectResponsesToolOutput = {
        success: true,
        connectionId,
        responses,
        count: successCount,
        collectedAt: new Date().toISOString()
      };
      
      console.log(`   🎯 Collected ${successCount} response(s) successfully`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      return response;
      
    } catch (error) {
      console.error('   ❌ Error collecting responses:', error);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      throw new Error(
        `Failed to collect UI responses: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
