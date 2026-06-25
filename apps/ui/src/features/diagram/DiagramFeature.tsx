/**
 * Diagram Feature Class
 * 
 * Manages the infrastructure diagram grid item.
 * Handles event processing and rendering for Kubernetes cluster visualization.
 * Auto-shows and focuses on nodes when kubectl operations are triggered.
 * 
 * Focus queue: multiple Init events are stacked and focused one-by-one,
 * dwelling at least 0.5s on each node before moving to the next.
 */

import React from 'react';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { ArchitectureDiagram } from './components/ArchitectureDiagram';
import { DiagramSettings } from './components/DiagramSettings';
import { LuNetwork } from 'react-icons/lu';
import { isListOperation } from './utils/nodeActionRegistry';
import { adapterBridge } from '../../shared/utils/adapterBridge';

const DIAGRAM_TOOL_NAMES = ['infrastructure_stream'];

export class DiagramFeature extends FredoFeatureClass {
  readonly id = 'diagram';
  readonly name = 'Infrastructure Diagram';
  readonly icon = LuNetwork;
  readonly showable = true;
  readonly hasSettings = true;
  
  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'diagram',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
        { name: 'payload', path: 'payload', hint: 'deferred' },
      ],
      filter: { toolNames: DIAGRAM_TOOL_NAMES },
    },
  ];

  render() {
    return <ArchitectureDiagram onFocusComplete={this.onFocusComplete} />;
  }

  renderSettings() {
    return <DiagramSettings />;
  }
  
  async onMount() {
    try {
      const kubeconfigPath = await adapterBridge.invoke<string | null>('get_setting', {
        key: 'kubeconfig_path',
      });
      const path = kubeconfigPath ?? '';
      adapterBridge.invoke('start_k8s_diagram', { kubeconfigPath: path }).catch(console.error);
    } catch {
      // bridge not ready yet
    }
  }
  
  async onUnmount() {
    // Cleanup handled by contract engine deregistration
  }

  /**
   * Called by ArchitectureDiagram when a focus animation completes (or node not found).
   */
  public onFocusComplete = (): void => {
    // Focus completion handled internally by ArchitectureDiagram
  };
}

// Export singleton instance
export const diagramFeature = new DiagramFeature();
