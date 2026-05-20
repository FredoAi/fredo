/**
 * Query Viewer Feature Class
 * 
 * Manages query result grid items.
 * Supports multiple instances (one per query result).
 */

import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { QueryViewer } from './components/QueryViewer';
import { LuDatabase } from 'react-icons/lu';
import type { IconType } from 'react-icons';

/**
 * Query result data structure
 */
export interface QueryResult {
  id: string;
  toolName: string;
  query: string;
  results: any[];
  executionTime?: number;
  timestamp: string;
}

export class QueryViewerFeature extends FredoFeatureClass {
  readonly id: string;
  readonly name: string;
  readonly icon: IconType;
  readonly eventFilters: EventFilter[] = [];
  readonly isMultiWindow = true;
  readonly showable = true;

  private queryResult: QueryResult | null;

  constructor(queryResult?: QueryResult) {
    super();
    this.queryResult = queryResult ?? null;
    this.id = queryResult ? `query-${queryResult.id}` : 'query-viewer';
    this.name = queryResult ? queryResult.toolName : 'Query Viewer';
    this.icon = LuDatabase;
  }

  processEvent(_event: StreamEvent): void {}

  render() {
    if (!this.queryResult) {
      return (
        <QueryViewer
          query=""
          results={[]}
          toolName="Query Viewer"
        />
      );
    }
    return (
      <QueryViewer
        query={this.queryResult.query}
        results={this.queryResult.results}
        toolName={this.queryResult.toolName}
        executionTime={this.queryResult.executionTime}
      />
    );
  }
  
  /**
   * Get the underlying query result data
   */
  getQueryResult(): QueryResult | null {
    return this.queryResult;
  }
}

/**
 * Singleton used as the persistent toolbar launcher.
 * Dynamic query windows are created via createQueryViewerFeature().
 */
export const queryViewerFeature = new QueryViewerFeature();

/**
 * Factory function for creating per-query instances
 */
export function createQueryViewerFeature(queryResult: QueryResult): QueryViewerFeature {
  return new QueryViewerFeature(queryResult);
}
