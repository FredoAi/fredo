/**
 * Tools Documentation Model
 * Defines the structure for tool documentation operations
 */

export interface ToolDocRequest {
  tool_name: string;
}

export interface ToolDocResponse {
  success: boolean;
  tool_name?: string;
  documentation?: string;
  error?: string;
}

export interface ToolMetadata {
  name: string;
  service: string;
  filePath: string;
  exists: boolean;
}

/**
 * Result shape returned by tool_search
 * Matches the fields exposed by BaseTool.getMetadata()
 */
export interface ToolSearchResult {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  inputExamples: Array<{
    title: string;
    description: string;
    input: Record<string, any>;
    output?: { description: string; example: any };
  }>;
  httpEndpoint?: Record<string, any>;
  relatedTools?: string[];
  notes?: string[];
  deferLoading: boolean;
  allowProgrammaticCalling: boolean;
  /** Internal search relevance score — higher is more relevant */
  _score: number;
}

export interface ToolSearchResponse {
  results: ToolSearchResult[];
  total: number;
  query: string;
}

