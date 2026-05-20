import type { ToolDocRequest, ToolDocResponse } from './model.js';
import { ToolsDocumentationRepository } from './repository.js';

/**
 * Tools Documentation Controller
 * Business logic layer for tool documentation operations
 */
export class ToolsDocumentationController {
  constructor(private repository: ToolsDocumentationRepository) {}

  async getDocumentation(request: ToolDocRequest): Promise<ToolDocResponse> {
    return await this.repository.getDocumentation(request);
  }
}
