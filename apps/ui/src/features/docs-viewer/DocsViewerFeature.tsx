import React from 'react';
import { LuBookOpen } from 'react-icons/lu';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { DocsViewerPanel } from './components/DocsViewerPanel';

const DOCS_TOOL_NAMES = [
  'search_documentation',
  'microsoft_learn_search',
  'microsoft_learn_get',
];

export class DocsViewerFeature extends FredoFeatureClass {
  readonly id = 'docs-viewer';
  readonly name = 'Docs';
  readonly icon = LuBookOpen;
  readonly showable = true;

  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'docs-viewer',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
        { name: 'payload', path: 'payload', hint: 'deferred' },
      ],
      filter: { toolNames: DOCS_TOOL_NAMES },
    },
  ];

  render() {
    return <DocsViewerPanel />;
  }

  onUnmount() {
    // Cleanup handled by contract engine deregistration
  }
}

export const docsViewerFeature = new DocsViewerFeature();
