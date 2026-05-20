/**
 * Abstract base class that all services must extend
 * Follows the exact specification from ARCHITECTURE.md
 * 
 * MANDATORY REQUIREMENTS FOR ALL SERVICES:
 * ========================================
 * 
 * 1. MODEL (Required - NO NULL)
 *    - Define TypeScript interfaces for request/response
 *    - Export all types from model.ts
 *    - Document data structures
 * 
 * 2. REPOSITORY (Required - NO NULL)
 *    - Handle all data access operations
 *    - Implement database queries, API calls, or file operations
 *    - Must have init() method
 * 
 * 3. CONTROLLER (Required - NO NULL)
 *    - Implement business logic layer
 *    - Orchestrate between repository and routes/tools
 *    - Handle validation and error handling
 * 
 * 4. ROUTES (Required - NO NULL)
 *    - Must export register() function
 *    - Use BaseRoutes for consistent structure
 *    - Provides REST API endpoints (appears in Swagger)
 *    - Handler calls controller methods
 * 
 * 5. TOOLS (Required - Auto-loaded)
 *    - Create tools/ directory with tool classes
 *    - Each tool extends BaseTool
 *    - Tools call controller methods (same business logic as routes)
 *    - Provides MCP protocol access (for AI agents)
 * 
 * 6. DOCUMENTATION (Required)
 *    - Create tools/doc.md for each tool
 *    - Document parameters, examples, and usage
 *    - Accessible via tools-documentation service
 * 
 * RESULT: Every service is accessible via:
 * - REST API → http://localhost:3000/api/v1/{service-name}/*
 * - Swagger UI → http://localhost:3000/docs
 * - MCP Protocol → stdio/http for AI agents
 * - Documentation → tools-documentation API/tool
 */
export abstract class BaseService {
  // Required Properties - NO NULL VALUES ALLOWED
  abstract readonly name: string;
  abstract readonly model: any;
  abstract readonly repository: any;
  abstract readonly controller: any;
  abstract readonly routes: { register: (fastify: any, options: any) => Promise<void> } | null;

  constructor() {
    // Base constructor
  }

  /**
   * Initialize the service - must be implemented by subclasses
   */
  abstract init(): Promise<void>;

  /**
   * Register routes - must be implemented by subclasses
   * All services MUST register their routes for API access
   */
  abstract registerRoutes(): void;
}