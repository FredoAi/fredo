import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolDocRequest, ToolDocResponse } from './model.js';

/**
 * Tools Documentation Repository
 * Handles file system operations for tool documentation
 */
export class ToolsDocumentationRepository {
  private toolMetadata: Map<string, { serviceName: string; folderPath: string }> = new Map(); // From ServiceLoader

  constructor() {}

  async init(): Promise<void> {
    // Repository initialized
  }

  /**
   * Set the tool metadata from ServiceLoader
   * Includes service name and nested folder path for each tool
   */
  setToolMetadata(metadata: Map<string, { serviceName: string; folderPath: string }>): void {
    this.toolMetadata = metadata;
    console.log(`[ToolsDocRepository] Loaded ${metadata.size} tool metadata entries`);
  }

  async getDocumentation(request: ToolDocRequest): Promise<ToolDocResponse> {
    const { tool_name } = request;

    try {
      const docPath = this.resolveDocPath(tool_name);
      const content = await fs.readFile(docPath, 'utf-8');

      return {
        success: true,
        tool_name,
        documentation: content
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Documentation not found for tool: ${tool_name}`
      };
    }
  }

  private resolveDocPath(toolName: string): string {
    // Use dynamic metadata from ServiceLoader
    const metadata = this.toolMetadata.get(toolName);
    
    if (!metadata) {
      throw new Error(
        `Unknown tool: ${toolName}. Tool not found in ServiceLoader metadata. ` +
        `Ensure tool has proper nested structure: tools/{tool_name}/{Tool}Tool.ts + doc.md`
      );
    }

    // Return path to doc.md in nested folder
    return path.join(metadata.folderPath, 'doc.md');
  }
}
