import { BaseTool, ToolInputSchema, ToolExample } from '../../../../core/BaseTool.js';

// ---------------------------------------------------------------------------
// Lightweight weighted search engine — lives inline here, single consumer
// ---------------------------------------------------------------------------

function scoreCandidate(tool: BaseTool, queryTokens: string[]): number {
  let score = 0;
  const name = tool.name.toLowerCase();
  const desc = (tool.description || '').toLowerCase();
  const related = (tool.relatedTools || []).join(' ').toLowerCase();

  for (const token of queryTokens) {
    // Name match — highest weight
    if (name.includes(token)) score += 3;
    if (name === token) score += 5; // exact match bonus
    // Description word match
    if (desc.includes(token)) score += 1;
    // Related tools hint
    if (related.includes(token)) score += 0.5;
  }
  return score;
}

// ---------------------------------------------------------------------------
// ToolSearchTool
// ---------------------------------------------------------------------------
/**
 * tool_search — discovers deferred tools by keyword query.
 *
 * Returns full tool metadata (schema + inputExamples + httpEndpoint) so the
 * AI agent has everything it needs to use the tool immediately.  Each returned
 * tool is also *unlocked* in the current MCP session so it will appear in
 * subsequent ListTools responses.
 */
export class ToolSearchTool extends BaseTool {
  readonly name = 'tool_search';
  readonly description =
    'Search for available tools by keyword or intent. ' +
    'Returns full schemas and input examples for matching tools. ' +
    'Tools returned are automatically available for immediate use in this session. ' +
    'Use this FIRST when you need a capability that is not in your current tool list. ' +
    'IMPORTANT: combine ALL needed capabilities in a single query with top_k: 20 — ' +
    'the query is scored per-token, so "kubectl logs metrics traces jira azdo" returns everything at once. ' +
    'Never call this tool more than once per session.';

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keyword(s) or short description of the capability you need. ' +
          'E.g. "kubectl pods", "jira ticket", "logs error", "infrastructure diagram".',
        example: 'kubectl pods'
      },
      top_k: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5, max: 20)',
        minimum: 1,
        maximum: 20,
        default: 5
      }
    },
    required: ['query'],
    additionalProperties: false
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Find all tools in one call (preferred)',
      description: 'Discover all available tools across every domain in a single query',
      input: { query: 'kubectl logs metrics traces jira azdo code diagram', top_k: 20 }
    },
    {
      title: 'Find Kubernetes tools',
      description: 'Discover all kubectl-related tools',
      input: { query: 'kubectl pods' }
    },
    {
      title: 'Find observability tools',
      description: 'Discover logs, metrics, and traces query tools',
      input: { query: 'logs metrics traces', top_k: 10 }
    },
    {
      title: 'Find Jira tools',
      description: 'Discover Jira issue management tools',
      input: { query: 'jira issue' }
    }
  ];

  readonly deferLoading = false; // Always visible — it IS the discovery mechanism
  readonly allowProgrammaticCalling = false; // meta tool, not for sandbox use
  readonly exposedAs = 'mcp' as const;

  readonly notes = [
    'BEST PRACTICE: combine all needed capabilities in one query with top_k: 20 — e.g. "kubectl logs metrics traces jira azdo". The query is scored per-token so all domains are returned in a single call.',
    'Never call this tool more than once per session — all tools unlocked in the first call remain available.',
    'Run this tool first when you cannot find the capability you need in the current tool list.',
    'Results include full inputSchema and inputExamples so you can call the tool immediately.',
    'Each result is automatically unlocked in the session — no extra step needed.',
    'Searches tool name (weight ×3), description (weight ×1), relatedTools (weight ×0.5).'
  ];

  readonly relatedTools = ['tools_documentation'];

  /** All registered tools — injected by ServiceLoader after all services are loaded */
  private allTools: BaseTool[] = [];

  setTools(tools: BaseTool[]): void {
    this.allTools = tools;
    console.log(`[ToolSearchTool] Loaded ${tools.length} tools into search index`);
  }

  async execute(
    input: { query: string; top_k?: number },
    context?: { unlockTool?: (name: string) => void; sseConnectionId?: string }
  ): Promise<any> {
    const { query, top_k = 5 } = input;

    if (!query || query.trim().length === 0) {
      throw new Error('query is required');
    }

    const limit = Math.min(Math.max(1, top_k), 20);
    const queryTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 1);

    if (queryTokens.length === 0) {
      return { results: [], total: 0, query };
    }

    // Score all tools
    const scored = this.allTools
      .map(tool => ({ tool, score: scoreCandidate(tool, queryTokens) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Unlock each matched tool in the current session
    if (context?.unlockTool) {
      for (const { tool } of scored) {
        context.unlockTool(tool.name);
      }
    }

    const results = scored.map(({ tool, score }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      inputExamples: tool.inputExamples,
      httpEndpoint: tool.httpEndpoint,
      relatedTools: tool.relatedTools,
      notes: tool.notes,
      deferLoading: tool.deferLoading ?? false,
      allowProgrammaticCalling: tool.allowProgrammaticCalling ?? false,
      _score: score
    }));

    console.log(
      `[ToolSearchTool] query="${query}" → ${results.length} results` +
        (results.length ? ` (top: ${results[0].name})` : '')
    );

    return {
      results,
      total: results.length,
      query
    };
  }
}

export default ToolSearchTool;
