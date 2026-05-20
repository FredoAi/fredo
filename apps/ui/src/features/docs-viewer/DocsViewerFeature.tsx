import React from 'react';
import { LuBookOpen } from 'react-icons/lu';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { DocsViewerPanel } from './components/DocsViewerPanel';

export interface DocsViewerState {
  query: string | null;
  results: any[];
  source: 'angular' | 'microsoft-learn' | null;
  timestamp: string | null;
}

const DOCS_TOOL_NAMES = [
  'search_documentation',      // Angular CLI MCP
  'microsoft_learn_search',    // Microsoft Learn MCP
  'microsoft_learn_get',       // Microsoft Learn MCP
];

export class DocsViewerFeature extends FredoFeatureClass {
  readonly id = 'docs-viewer';
  readonly name = 'Docs';
  readonly icon = LuBookOpen;
  readonly showable = true;

  readonly eventFilters: EventFilter[] = [
    { toolNames: DOCS_TOOL_NAMES },
  ];

  private state: DocsViewerState = {
    query: null,
    results: [],
    source: null,
    timestamp: null,
  };

  processEvent(event: StreamEvent): void {
    const { toolName, input, response, timestamp } = event;

    if (event.state === 'Init') {
      const source: DocsViewerState['source'] = toolName === 'search_documentation'
        ? 'angular'
        : 'microsoft-learn';

      this.state = {
        query: input?.query ?? input?.keyword ?? input?.search ?? null,
        results: [],
        source,
        timestamp,
      };
    }

    if (event.state === 'Response' && response) {
      // Normalise various response shapes into a flat results array
      const raw = response?.results ?? response?.items ?? response?.value ?? response;
      const results = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      this.state = { ...this.state, results, timestamp };
    }

    this.forceRerender?.();
  }

  render() {
    return <DocsViewerPanel state={this.state} />;
  }

  onUnmount() {
    this.state = { query: null, results: [], source: null, timestamp: null };
  }
}

export const docsViewerFeature = new DocsViewerFeature();
