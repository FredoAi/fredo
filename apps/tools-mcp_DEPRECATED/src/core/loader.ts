import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { BaseService } from './BaseService';
import { BaseTool } from './BaseTool';

// Hot reload test #8 - WITH NODEMON + LEGACY WATCH!
// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Auto-loads all services and tools from the services directory
 */
export class ServiceLoader {
  private services: Map<string, BaseService> = new Map();
  private tools: Map<string, BaseTool> = new Map();
  private toolToServiceMap: Map<string, string> = new Map(); // toolName → serviceName
  private serviceTools: Map<string, BaseTool[]> = new Map(); // serviceName → tools[]
  private toolMetadata: Map<string, { serviceName: string; folderPath: string }> = new Map(); // toolName → metadata

  /**
   * Discover and load all services from /services directory
   */
  async loadServices(): Promise<void> {
    const servicesDir = join(__dirname, '../services');
    
    try {
      const serviceDirectories = await fs.readdir(servicesDir, { withFileTypes: true });
      
      for (const dir of serviceDirectories) {
        if (dir.isDirectory()) {
          await this.loadService(dir.name);
        }
      }

      // After all services are loaded, inject tools into tools-list service
      const toolsListService = this.services.get('tools-list');
      if (toolsListService && typeof (toolsListService as any).setTools === 'function') {
        (toolsListService as any).setTools(this.getTools());
      }

      // Inject tool metadata into tools-documentation service
      const toolsDocService = this.services.get('tools-documentation');
      if (toolsDocService && typeof (toolsDocService as any).setToolMetadata === 'function') {
        (toolsDocService as any).setToolMetadata(this.toolMetadata);
      }

      // Inject full ServiceLoader into tools-documentation so ToolSearchTool
      // can access all registered tools
      if (toolsDocService && typeof (toolsDocService as any).setServiceLoader === 'function') {
        (toolsDocService as any).setServiceLoader(this);
      }
    } catch (error) {
      console.error('Failed to enumerate services directory:', error);
      throw error;
    }
  }

  /**
   * Load a specific service by name
   */
  private async loadService(serviceName: string): Promise<void> {
    try {
      const servicePath = join(__dirname, '../services', serviceName, 'service.ts');

      // Skip directories that don't contain a service.ts (e.g. asset/data folders)
      try {
        await fs.access(servicePath);
      } catch {
        console.warn(`[ServiceLoader] Skipping "${serviceName}" — no service.ts found`);
        return;
      }

      // Dynamic import of service - convert path to URL for Windows ESM compatibility
      const serviceUrl = pathToFileURL(servicePath).href;
      const serviceModule = await import(serviceUrl);
      
      // Find the service class (should be the default export or named export)
      const ServiceClass = serviceModule.default || serviceModule[Object.keys(serviceModule).find(key => key.endsWith('Service')) || ''] || Object.values(serviceModule)[0];
      
      if (!ServiceClass || typeof ServiceClass !== 'function') {
        throw new Error(`No valid service class found in ${servicePath}`);
      }

      const service = new ServiceClass() as BaseService;
      
      // Validate service extends BaseService
      if (!(service instanceof BaseService)) {
        throw new Error(`Service ${serviceName} does not extend BaseService`);
      }

      // Initialize service
      await service.init();
      
      // Register service
      this.services.set(service.name, service);
      
      // Load tools for this service
      await this.loadServiceTools(serviceName, service);
      
    } catch (error: any) {
      console.error(`Failed to load service ${serviceName}:`, error);
      // Do not re-throw — a single unavailable service should not crash the whole server
    }
  }

  /**
   * Load tools for a specific service
   * Supports both nested structure (tools/{tool_name}/{Tool}Tool.ts) and flat structure
   * Validates structure and collects errors for batch reporting
   */
  private async loadServiceTools(serviceName: string, service: BaseService): Promise<void> {
    const toolsDir = join(__dirname, '../services', serviceName, 'tools');
    const errors: string[] = [];
    
    try {
      await fs.access(toolsDir);
    } catch {
      // Tools directory doesn't exist - that's okay
      return;
    }

    try {
      const entries = await fs.readdir(toolsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Nested structure: tools/{tool_name}/
          const toolFolderName = entry.name;
          const toolFolderPath = join(toolsDir, toolFolderName);
          
          // Find the Tool file (should end with Tool.ts)
          const folderEntries = await fs.readdir(toolFolderPath);
          const toolFile = folderEntries.find(f => f.endsWith('Tool.ts') && !f.endsWith('.d.ts'));
          
          if (!toolFile) {
            errors.push(`Nested folder '${toolFolderName}' has no *Tool.ts file`);
            continue;
          }
          
          // Load the tool
          const tool = await this.loadTool(serviceName, toolFolderPath, toolFile, service);
          
          if (tool) {
            // Validate folder name matches tool.name (snake_case)
            if (tool.name !== toolFolderName) {
              errors.push(`Folder name '${toolFolderName}' doesn't match tool.name '${tool.name}' (must be exact match)`);
            }
            
            // Check for doc.md
            const docPath = join(toolFolderPath, 'doc.md');
            try {
              await fs.access(docPath);
              // Store metadata for tools-documentation service
              this.toolMetadata.set(tool.name, {
                serviceName,
                folderPath: toolFolderPath
              });
            } catch {
              errors.push(`Tool '${tool.name}' missing doc.md in ${toolFolderPath}`);
            }
          }
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          // Flat structure detected (legacy)
          errors.push(`Flat structure detected: '${entry.name}' must be migrated to nested folder (tools/{tool_name}/{Tool}Tool.ts)`);
        }
      }
      
      // Throw batch error if any validation failed
      if (errors.length > 0) {
        throw new Error(
          `\n\n[${serviceName}] Tool structure validation FAILED:\n` +
          errors.map(e => `  ❌ ${e}`).join('\n') +
          `\n\n✨ Required structure: tools/{tool_name}/{Tool}Tool.ts + doc.md\n` +
          `   Folder name MUST match tool.name exactly (snake_case)\n`
        );
      }
    } catch (error: any) {
      if (error.message.includes('validation FAILED')) {
        throw error; // Re-throw validation errors
      }
      console.error(`Failed to load tools for service ${serviceName}:`, error);
      throw error;
    }
  }

  /**
   * Load a specific tool from nested structure
   */
  private async loadTool(
    serviceName: string,
    folderPath: string,
    fileName: string,
    service: BaseService
  ): Promise<BaseTool | null> {
    try {
      const toolPath = join(folderPath, fileName);
      const toolUrl = pathToFileURL(toolPath).href;
      const toolModule = await import(toolUrl);
      
      // Find the tool class
      const ToolClass = toolModule.default || toolModule[Object.keys(toolModule).find(key => key.endsWith('Tool')) || ''] || Object.values(toolModule)[0];
      
      if (!ToolClass || typeof ToolClass !== 'function') {
        return null; // Skip if no valid tool class
      }

      const tool = new ToolClass(service) as BaseTool;
      
      // Validate tool extends BaseTool
      if (!(tool instanceof BaseTool)) {
        console.warn(`Tool ${fileName} does not extend BaseTool, skipping`);
        return null;
      }

      // Register tool globally
      this.tools.set(tool.name, tool);
      
      // Build tool-to-service mapping
      this.toolToServiceMap.set(tool.name, serviceName);
      
      // Add tool to service's tools collection
      if (!this.serviceTools.has(serviceName)) {
        this.serviceTools.set(serviceName, []);
      }
      this.serviceTools.get(serviceName)!.push(tool);
      
      return tool;
    } catch (error) {
      console.error(`Failed to load tool ${fileName} for service ${serviceName}:`, error);
      return null;
    }
  }

  /**
   * Get all loaded services
   */
  getServices(): BaseService[] {
    return Array.from(this.services.values());
  }

  /**
   * Get a service by name
   */
  getService(name: string): BaseService | undefined {
    return this.services.get(name);
  }

  /**
   * Get all loaded tools
   */
  getTools(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get the service name for a given tool
   */
  getServiceNameForTool(toolName: string): string | undefined {
    return this.toolToServiceMap.get(toolName);
  }

  /**
   * Get all tools for a specific service
   */
  getToolsForService(serviceName: string): BaseTool[] {
    return this.serviceTools.get(serviceName) || [];
  }

  /**
   * Get the complete tool-to-service mapping
   */
  getToolToServiceMap(): Map<string, string> {
    return new Map(this.toolToServiceMap);
  }

  /**
   * Get tool metadata (service name and folder path)
   */
  getToolMetadata(): Map<string, { serviceName: string; folderPath: string }> {
    return new Map(this.toolMetadata);
  }
}