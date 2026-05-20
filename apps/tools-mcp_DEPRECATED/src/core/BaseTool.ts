/**
 * JSON Schema property definition
 */
export interface SchemaProperty {
  type?: string;
  description: string;
  example?: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: any;
  items?: {
    type: string;
    description?: string;
  };
  oneOf?: Array<Partial<SchemaProperty>>;
}

/**
 * JSON Schema definition for tool inputs
 */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required?: string[] | readonly string[];
  additionalProperties?: boolean;
}

/**
 * Tool example with detailed metadata
 */
export interface ToolExample {
  title: string;
  description: string;
  input: Record<string, any>;
  output?: {
    description: string;
    example: any;
  };
}

/**
 * Parameter location mapping for HTTP route generation
 */
export interface ParameterMapping {
  [toolInputKey: string]: {
    location: 'body' | 'query' | 'path' | 'header';
    httpName?: string; // If different from tool key
  };
}

/**
 * Response schema definition for HTTP endpoints
 */
export interface ResponseSchema {
  successShape: Record<string, any>; // 200 response structure
  errorShape?: Record<string, any>;  // 400/500 structure
}

/**
 * HTTP endpoint information for REST API access
 */
export interface ToolHTTPEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  baseUrl?: string;
  fullUrl?: string;
  description: string;
  headers?: Record<string, string>;
  example: string; // curl command example
  
  // Auto-generation support
  parameterMapping?: ParameterMapping; // Map tool inputs to HTTP locations
  responseSchema?: ResponseSchema;     // Define response structure
  skipAutoGeneration?: boolean;        // Force manual route definition
}

/**
 * Complete tool metadata for AI agent consumption
 */
export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** @deprecated Use inputExamples instead */
  examples: ToolExample[];
  inputExamples: ToolExample[];
  httpEndpoint?: ToolHTTPEndpoint;
  notes?: string[];
  relatedTools?: string[];
  exposedAs?: 'api' | 'mcp' | 'both'; // Transport exposure control
  /** If true, this tool is hidden from ListTools until unlocked via tool_search */
  deferLoading?: boolean;
  /** If true, a callable stub is generated for this tool in code_execute preambles */
  allowProgrammaticCalling?: boolean;
}

/**
 * Abstract base class that all tools must extend
 * Provides comprehensive metadata for AI agents to understand tool usage
 * 
 * MANDATORY REQUIREMENTS FOR ALL TOOLS:
 * =====================================
 * 
 * 1. NAME (Required)
 *    - Unique identifier for the tool
 *    - Use snake_case convention (e.g., logs_query)
 * 
 * 2. DESCRIPTION (Required)
 *    - Clear, concise explanation of what the tool does
 *    - Should help AI agents understand when to use it
 * 
 * 3. INPUT SCHEMA (Required - NO EMPTY)
 *    - JSON Schema defining all input parameters
 *    - Every property MUST have description
 *    - Include examples, types, constraints
 *    - Mark required fields in required[] array
 * 
 * 4. EXAMPLES (Required - Minimum 2)
 *    - Show real-world usage patterns
 *    - Include title, description, and input
 *    - Cover different use cases
 *    - Help AI agents learn how to use the tool
 * 
 * 5. HTTP ENDPOINT (Optional but Recommended)
 *    - Include if tool has REST API equivalent
 *    - Provide curl example
 *    - Shows API access method
 * 
 * 6. DOCUMENTATION (Required - doc.md file)
 *    - Create tools/doc.md with comprehensive guide
 *    - Include usage examples, schemas, best practices
 *    - Accessible via tools-documentation service
 * 
 * 7. EXECUTE METHOD (Required)
 *    - Implement business logic
 *    - Call service controller methods
 *    - Return consistent response format
 * 
 * BEST PRACTICES:
 * - Tools should call controller methods (same logic as routes)
 * - Keep tools focused on single responsibility
 * - Provide helpful error messages
 * - Document edge cases and limitations
 */
export abstract class BaseTool {
  // Required Properties - must be implemented by subclasses
  abstract readonly name: string;
  abstract readonly description: string;

  /**
   * JSON Schema for tool inputs with detailed descriptions and examples
   * REQUIRED: Every property must have description and example
   */
  abstract readonly inputSchema: ToolInputSchema;

  /**
   * Comprehensive examples showing real-world usage patterns
   * REQUIRED: Minimum 2 examples showing different use cases
   * Use inputExamples (Anthropic convention). The examples field is kept as an alias.
   */
  abstract readonly inputExamples: ToolExample[];

  /**
   * @deprecated Alias for inputExamples — kept for backward compatibility
   */
  get examples(): ToolExample[] {
    return this.inputExamples;
  }

  /**
   * HTTP endpoint information if tool is accessible via REST API
   * OPTIONAL: Only for tools with REST endpoints
   */
  readonly httpEndpoint?: ToolHTTPEndpoint;

  /**
   * Additional notes, warnings, or usage tips for AI agents
   * OPTIONAL: Best practices, common pitfalls, tips
   */
  readonly notes?: string[];

  /**
   * Related tools that might be useful in combination
   * OPTIONAL: Help AI agents discover complementary tools
   */
  readonly relatedTools?: string[];

  /**
   * Control where this tool is exposed: 'api', 'mcp', or 'both'
   * DEFAULT: 'both' - tool is accessible via both REST API and MCP protocol
   */
  readonly exposedAs?: 'api' | 'mcp' | 'both' = 'both';

  /**
   * If true, this tool is hidden from MCP ListTools until unlocked via tool_search.
   * The tool remains callable by name even before unlock.
   * DEFAULT: false
   */
  readonly deferLoading?: boolean = false;

  /**
   * If true, a language-specific callable stub is generated for this tool
   * in code_execute preambles, allowing sandbox code to invoke it via Unix socket.
   * Only set on data/infra tools — NOT on UI or meta tools.
   * DEFAULT: false
   */
  readonly allowProgrammaticCalling?: boolean = false;

  /**
   * Get complete metadata for AI consumption
   */
  getMetadata(): ToolMetadata {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      inputExamples: this.inputExamples,
      examples: this.inputExamples, // backward-compat alias
      httpEndpoint: this.httpEndpoint,
      notes: this.notes,
      relatedTools: this.relatedTools,
      exposedAs: this.exposedAs || 'both',
      deferLoading: this.deferLoading ?? false,
      allowProgrammaticCalling: this.allowProgrammaticCalling ?? false
    };
  }

  /**
   * Execute the tool - must be implemented by subclasses
   * @param input - Tool input parameters
   * @param context - Optional execution context (e.g., SSE session ID)
   */
  abstract execute(input: any, context?: any): Promise<any>;
}