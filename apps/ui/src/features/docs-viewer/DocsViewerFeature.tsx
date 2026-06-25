import React from 'react';
import { LuBookOpen } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
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

  readonly eventContracts = [
    {
      contractName: 'docs-viewer',
      streamFields: ['toolName', 'state'],
      deferredFields: ['payload'],
      key: ['sessionId', 'correlationId', 'toolName'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      providers: ['opencode'],
    },
  ];

  private state: DocsViewerState = {
    query: null,
    results: [],
    source: null,
    timestamp: null,
  };

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    const dp = delivery.payload;
    const toolName = dp.toolName as string | undefined;
    const state = dp.state as string | undefined;
    const eventPayload = dp.payload as Record<string, unknown> | null;

    if (delivery.lifecycle === 'init') {
      const source: DocsViewerState['source'] = toolName === 'search_documentation'
        ? 'angular'
        : 'microsoft-learn';

      this.state = {
        query: (eventPayload?.query ?? eventPayload?.keyword ?? eventPayload?.search) as string | null,
        results: [],
        source,
        timestamp: delivery.timestamp,
      };
    }

    if (delivery.lifecycle === 'end' && eventPayload) {
      // Normalise various response shapes into a flat results array
      const raw = (eventPayload as any)?.results ?? (eventPayload as any)?.items ?? (eventPayload as any)?.value ?? eventPayload;
      const results = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      this.state = { ...this.state, results, timestamp: delivery.timestamp };
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
