import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Tools Documentation Service Routes
 */
export class ToolsDocumentationRoutes extends BaseRoutes {
  protected serviceName = 'tools-documentation';
  protected serviceInstance: any;

  async register(_fastify: FastifyInstance, options: any): Promise<void> {
    const toolsDocumentationService = options['tools-documentationService'];
    this.serviceInstance = toolsDocumentationService;

    // Manual route removed - tool is MCP-only
    /*
    // Single route that accepts tool name(s) as query parameter
    const getDocRoute = this.createRoute({
      method: 'GET',
      url: '/',
      schema: {
        description: 'Get documentation for one or more MCP tools by name',
        tags: ['tools-documentation'],
        querystring: {
          type: 'object',
          required: ['tool_name'],
          properties: {
            tool_name: { 
              type: 'string',
              description: 'Name(s) of the tool(s) - single string or JSON array string (e.g., "logs_query" or ["logs_query", "metrics_query"])'
            }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              tool_name: { type: 'string' },
              documentation: { type: 'string' },
              error: { type: 'string' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tool_name: { type: 'string' },
                    documentation: { type: 'string' },
                    error: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      handler: async (request: any, reply) => {
        let tool_name = request.query.tool_name;
        
        // Trim whitespace from string input
        if (typeof tool_name === 'string') {
          tool_name = tool_name.trim();
          
          // If tool_name is a string that looks like JSON array, parse it
          if (tool_name.startsWith('[')) {
            try {
              tool_name = JSON.parse(tool_name);
            } catch (e) {
              // JSON parsing failed - return error with details
              return reply.code(400).send({ 
                success: false, 
                error: 'Invalid JSON array format in tool_name parameter',
                details: e instanceof Error ? e.message : 'Unknown parsing error',
                received: tool_name
              });
            }
          }
        }
        
        // Handle array of tool names
        if (Array.isArray(tool_name)) {
          const results = await Promise.all(
            tool_name.map(async (name: string) => {
              try {
                const result = await toolsDocumentationService.controller.getDocumentation({ tool_name: name.trim() });
                
                // Return only the fields that match the schema
                if (result.success) {
                  return {
                    tool_name: name,
                    documentation: result.documentation
                  };
                } else {
                  return {
                    tool_name: name,
                    error: result.error || 'Unknown error'
                  };
                }
              } catch (error) {
                return {
                  tool_name: name,
                  error: error instanceof Error ? error.message : 'Unknown error'
                };
              }
            })
          );
          return reply.send({ success: true, results });
        }
        
        // Handle single tool name
        const result = await toolsDocumentationService.controller.getDocumentation({ tool_name });
        return reply.send(result);
      }
    });

    fastify.route(getDocRoute);
    */
  }
}

export const toolsDocumentationRoutes = new ToolsDocumentationRoutes();
