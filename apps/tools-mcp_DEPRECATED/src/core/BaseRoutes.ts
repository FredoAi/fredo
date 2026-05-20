import { FastifyInstance, FastifySchema, RouteOptions } from 'fastify';
import { BaseTool } from './BaseTool.js';

/**
 * Base Route Interface - Enforces consistent route structure
 * All service routes must implement this interface to ensure proper OpenAPI documentation
 * 
 * MANDATORY REQUIREMENTS FOR ALL ROUTES:
 * ======================================
 * 
 * 1. METHOD (Required)
 *    - HTTP method: GET, POST, PUT, DELETE, PATCH
 *    - Choose appropriate method for operation type
 * 
 * 2. URL (Required)
 *    - Relative path (e.g., '/query', '/diagram')
 *    - Will be prefixed with /api/v1/{service-name}
 * 
 * 3. SCHEMA (Required - Complete Documentation)
 *    - description: Clear explanation of endpoint purpose
 *    - tags: Service name for Swagger grouping
 *    - body: Request body schema (for POST/PUT/PATCH)
 *    - params: URL parameters schema (for /:id routes)
 *    - querystring: Query parameters schema (for ?param=value)
 *    - response: Response schemas for ALL status codes
 * 
 * 4. HANDLER (Required)
 *    - Async function handling the request
 *    - Should call controller methods
 *    - Return consistent response format
 * 
 * SWAGGER INTEGRATION:
 * - All routes automatically appear in Swagger UI
 * - Schemas generate interactive API documentation
 * - Test endpoints directly from browser
 * 
 * BEST PRACTICES:
 * - Use BaseRoutes.createRoute() for consistency
 * - Include descriptions for all parameters
 * - Document all possible response codes
 * - Handler delegates to controller (business logic)
 */
export interface BaseRouteConfig {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Route URL path */
  url: string;
  /** OpenAPI schema configuration - REQUIRED for Swagger documentation */
  schema: RequiredRouteSchema;
  /** Route handler function */
  handler: (request: any, reply: any) => Promise<any>;
  /** Optional route options */
  options?: Partial<RouteOptions>;
}

/**
 * Required schema structure for all routes
 * Ensures proper Swagger documentation and validation
 */
export interface RequiredRouteSchema extends FastifySchema {
  /** Route description - REQUIRED */
  description: string;
  /** Swagger tags for grouping - REQUIRED */
  tags: string[];
  /** Request body schema if applicable */
  body?: object;
  /** Query parameters schema if applicable */
  querystring?: object;
  /** URL parameters schema if applicable */
  params?: object;
  /** Response schema - REQUIRED for documentation */
  response: {
    200: object;
    [statusCode: number]: object;
  };
}

/**
 * Standard success response schema
 */
export const StandardSuccessResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: { type: 'object', description: 'Response data' }
  }
} as const;

/**
 * Standard error response schema
 */
export const StandardErrorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: { type: 'string', description: 'Error message' }
  }
} as const;

/**
 * Base Route Class - Provides utilities for consistent route creation
 */
export abstract class BaseRoutes {
  protected abstract serviceName: string;
  protected serviceInstance: any = null;
  
  // Auto-generation support
  protected autoRegisterTools: boolean = false; // Enable auto-route generation from tools
  protected tools: BaseTool[] = []; // Tools for this service

  /**
   * Set tools for auto-route generation
   * Called by Router before route registration
   */
  setTools(tools: BaseTool[]): void {
    this.tools = tools;
  }

  /**
   * Register all routes for this service
   * Must be implemented by each service
   */
  abstract register(fastify: FastifyInstance, options: any): Promise<void>;

  /**
   * Helper method to create a standardized route with enforced schema
   */
  protected createRoute(config: BaseRouteConfig): RouteOptions {
    // Validate required fields
    this.validateRouteConfig(config);

    // Ensure tags include service name
    if (!config.schema.tags.includes(this.serviceName)) {
      config.schema.tags.unshift(this.serviceName);
    }

    // Add standard error responses if not present
    if (!config.schema.response[400]) {
      config.schema.response[400] = StandardErrorResponse;
    }
    if (!config.schema.response[500]) {
      config.schema.response[500] = StandardErrorResponse;
    }

    return {
      method: config.method,
      url: config.url,
      schema: config.schema,
      handler: this.wrapHandler(config.handler),
      ...config.options
    };
  }

  /**
   * Validate route configuration has all required fields
   */
  private validateRouteConfig(config: BaseRouteConfig): void {
    if (!config.schema.description) {
      throw new Error(`Route ${config.method} ${config.url} missing required 'description' in schema`);
    }
    
    if (!config.schema.tags || config.schema.tags.length === 0) {
      throw new Error(`Route ${config.method} ${config.url} missing required 'tags' in schema`);
    }
    
    if (!config.schema.response || !config.schema.response[200]) {
      throw new Error(`Route ${config.method} ${config.url} missing required '200' response schema`);
    }
  }

  /**
   * Wrapper for handlers to provide consistent error handling and logging
   */
  private wrapHandler(originalHandler: (request: any, reply: any) => Promise<any>) {
    return async (request: any, reply: any) => {
      try {
        const startTime = Date.now();
        const result = await originalHandler(request, reply);
        const duration = Date.now() - startTime;
        
        // Log successful requests (can be configured)
        console.log(`${request.method} ${request.url} - ${reply.statusCode} (${duration}ms)`);
        
        return result;
      } catch (error: any) {
        console.error(`Error in ${request.method} ${request.url}:`, error);
        
        return reply.status(500).send({
          success: false,
          error: error.message || 'Internal server error'
        });
      }
    };
  }

  /**
   * Helper to create query endpoint with common patterns
   */
  protected createQueryRoute(config: {
    description: string;
    bodySchema?: object;
    additionalTags?: string[];
  }): BaseRouteConfig {
    return {
      method: 'POST',
      url: '/query',
      schema: {
        description: config.description,
        tags: [this.serviceName, ...(config.additionalTags || [])],
        body: config.bodySchema || {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query parameters' }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'array', items: { type: 'object' } },
              count: { type: 'integer', description: 'Number of results returned' }
            }
          }
        }
      },
      handler: async (request, reply) => {
        const result = await this.serviceInstance.queryData(request.body);
        return reply.send({
          success: true,
          data: result,
          count: Array.isArray(result) ? result.length : 1
        });
      }
    };
  }

  /**
   * Helper to create health check endpoint
   */
  protected createHealthRoute(): BaseRouteConfig {
    return {
      method: 'GET',
      url: '/health',
      schema: {
        description: `Health check for ${this.serviceName} service`,
        tags: [this.serviceName, 'health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'OK' },
              service: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' }
            }
          }
        }
      },
      handler: async (_request, reply) => {
        return reply.send({
          status: 'OK',
          service: this.serviceName,
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  /**
   * Auto-register routes from tools with httpEndpoint defined
   * Only processes tools where exposedAs is 'api' or 'both'
   * Validates configuration and collects errors for batch reporting
   */
  async autoRegisterToolRoutes(fastify: FastifyInstance): Promise<void> {
    console.log(`[BaseRoutes] autoRegisterTools=${this.autoRegisterTools}, tools.length=${this.tools.length}, serviceName=${this.serviceName}`);
    
    if (!this.autoRegisterTools || this.tools.length === 0) {
      console.log(`[BaseRoutes] Skipping auto-registration for ${this.serviceName}: autoRegisterTools=${this.autoRegisterTools}, tools.length=${this.tools.length}`);
      return;
    }

    console.log(`[BaseRoutes] Auto-registering routes for ${this.serviceName} from ${this.tools.length} tools`);

    const errors: string[] = [];

    for (const tool of this.tools) {
      // Skip tools without httpEndpoint
      if (!tool.httpEndpoint) {
        continue;
      }

      // Skip if manual generation requested
      if (tool.httpEndpoint.skipAutoGeneration) {
        console.log(`[BaseRoutes] Skipping auto-generation for ${tool.name} (manual override)`);
        continue;
      }

      // Validate configuration
      const exposedAs = tool.exposedAs || 'both';
      
      // Check: If autoRegisterTools is true, httpEndpoint must exist for API-exposed tools
      if (exposedAs === 'api' || exposedAs === 'both') {
        if (!tool.httpEndpoint) {
          errors.push(`Tool '${tool.name}' has exposedAs='${exposedAs}' but missing httpEndpoint configuration`);
          continue;
        }
      }
      
      // Skip MCP-only tools
      if (exposedAs === 'mcp') {
        console.log(`[BaseRoutes] Skipping ${tool.name} (MCP-only tool)`);
        continue;
      }

      // Generate and register route
      try {
        const route = this.generateRouteFromTool(tool);
        fastify.route(route);
        console.log(`[BaseRoutes] Auto-registered ${tool.httpEndpoint.method} ${tool.httpEndpoint.path} for ${tool.name}`);
      } catch (error: any) {
        errors.push(`Failed to generate route for '${tool.name}': ${error.message}`);
      }
    }
    
    // Throw batch error if any validation failed
    if (errors.length > 0) {
      throw new Error(
        `\n\n[${this.serviceName}] Auto-registration validation FAILED:\n` +
        errors.map(e => `  ❌ ${e}`).join('\n') +
        `\n\n✨ autoRegisterTools=true requires:\n` +
        `   - Tools with exposedAs='api' or 'both' MUST have httpEndpoint configured\n` +
        `   - httpEndpoint must include method, path, and optionally responseSchema\n`
      );
    }
  }

  /**
   * Generate a Fastify route from a tool's metadata
   */
  private generateRouteFromTool(tool: BaseTool): RouteOptions {
    const { httpEndpoint, inputSchema, description, name } = tool;
    
    if (!httpEndpoint) {
      throw new Error(`Tool ${name} missing httpEndpoint`);
    }

    // Build request schema from inputSchema
    const requestSchema: any = {
      description: httpEndpoint.description || description,
      tags: [this.serviceName],
      response: {
        200: httpEndpoint.responseSchema?.successShape || {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object' }
          }
        }
      }
    };

    // Map parameters based on location
    const paramMapping = httpEndpoint.parameterMapping || {};
    const bodyProperties: any = {};
    const queryProperties: any = {};
    const pathProperties: any = {};
    const bodyRequired: string[] = [];
    const queryRequired: string[] = [];
    const pathRequired: string[] = [];

    // Categorize parameters by location
    for (const [key, prop] of Object.entries(inputSchema.properties)) {
      const location = paramMapping[key]?.location || 'body'; // Default to body
      const httpName = paramMapping[key]?.httpName || key;
      
      if (location === 'body') {
        bodyProperties[httpName] = prop;
        if (inputSchema.required?.includes(key)) {
          bodyRequired.push(httpName);
        }
      } else if (location === 'query') {
        queryProperties[httpName] = prop;
        if (inputSchema.required?.includes(key)) {
          queryRequired.push(httpName);
        }
      } else if (location === 'path') {
        pathProperties[httpName] = prop;
        if (inputSchema.required?.includes(key)) {
          pathRequired.push(httpName);
        }
      }
    }

    // Add body schema if has body parameters
    if (Object.keys(bodyProperties).length > 0) {
      requestSchema.body = {
        type: 'object',
        properties: bodyProperties,
        required: bodyRequired.length > 0 ? bodyRequired : undefined,
        additionalProperties: inputSchema.additionalProperties
      };
    }

    // Add query schema if has query parameters
    if (Object.keys(queryProperties).length > 0) {
      requestSchema.querystring = {
        type: 'object',
        properties: queryProperties,
        required: queryRequired.length > 0 ? queryRequired : undefined
      };
    }

    // Add path schema if has path parameters
    if (Object.keys(pathProperties).length > 0) {
      requestSchema.params = {
        type: 'object',
        properties: pathProperties,
        required: pathRequired.length > 0 ? pathRequired : undefined
      };
    }

    // Add standard error responses
    requestSchema.response[400] = httpEndpoint.responseSchema?.errorShape || StandardErrorResponse;
    requestSchema.response[500] = StandardErrorResponse;

    // Create handler that calls tool.execute with API context
    const handler = async (request: any, reply: any) => {
      try {
        // Merge all parameters back into single input object
        const input: any = {};
        
        // Map body parameters
        if (request.body) {
          for (const [httpName, value] of Object.entries(request.body)) {
            const toolKey = this.findToolKeyForHttpName(inputSchema, paramMapping, httpName, 'body');
            input[toolKey] = value;
          }
        }

        // Map query parameters
        if (request.query) {
          for (const [httpName, value] of Object.entries(request.query)) {
            const toolKey = this.findToolKeyForHttpName(inputSchema, paramMapping, httpName, 'query');
            input[toolKey] = value;
          }
        }

        // Map path parameters
        if (request.params) {
          for (const [httpName, value] of Object.entries(request.params)) {
            const toolKey = this.findToolKeyForHttpName(inputSchema, paramMapping, httpName, 'path');
            input[toolKey] = value;
          }
        }

        // Execute tool with API transport context
        const result = await tool.execute(input, { transport: 'api' });
        
        return reply.send(result);
      } catch (error: any) {
        console.error(`[BaseRoutes] Error executing tool ${name}:`, error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Internal server error'
        });
      }
    };

    return {
      method: httpEndpoint.method,
      url: httpEndpoint.path,
      schema: requestSchema,
      handler
    };
  }

  /**
   * Find the tool's input key for a given HTTP parameter name
   */
  private findToolKeyForHttpName(
    _inputSchema: any,
    paramMapping: any,
    httpName: string,
    location: string
  ): string {
    // Check if any mapping points to this httpName
    for (const [toolKey, mapping] of Object.entries(paramMapping)) {
      if ((mapping as any).httpName === httpName && (mapping as any).location === location) {
        return toolKey;
      }
    }
    // If no mapping found, httpName IS the tool key
    return httpName;
  }
}

export default BaseRoutes;