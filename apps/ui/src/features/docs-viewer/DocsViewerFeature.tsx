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

export class DocsViewerFeature extends FredoFeatureClass {
  readonly id = 'docs-viewer';
  readonly name = 'Docs';
  readonly icon = LuBookOpen;
  readonly showable = false;

  private state: DocsViewerState = {
    query: null,
    results: [],
    source: null,
    timestamp: null,
  };

  render() {
    return <DocsViewerPanel state={this.state} />;
  }

  onUnmount() {
    this.state = { query: null, results: [], source: null, timestamp: null };
  }
}

export const docsViewerFeature = new DocsViewerFeature();
