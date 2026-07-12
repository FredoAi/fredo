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
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { ArchitectureDiagram } from './components/ArchitectureDiagram';
import { DiagramSettings } from './components/DiagramSettings';
import { LuNetwork } from 'react-icons/lu';
import { isListOperation } from './utils/nodeActionRegistry';
import { adapterBridge } from '../../shared/utils/adapterBridge';

export class DiagramFeature extends FredoFeatureClass {
  readonly id = 'diagram';
  readonly name = 'Infrastructure Diagram';
  readonly icon = LuNetwork;
  readonly showable = false;
  readonly hasSettings = true;

  // @deprecated — kept for base class compatibility; all event processing via eventContracts
  readonly eventFilters: EventFilter[] = [];

  private focusTarget: { namespace: string; name: string } | null = null;
  private lastFocusTime = 0;
  private focusDebounceMs = 500; // Minimum dwell time per node (ms)
  private safetyTimeoutMs = 4000; // Max wait before force-advancing queue
  private processedEventIds = new Set<string>(); // Track ALL processed events to avoid re-queuing
  private focusTargetVersion = 0;
  private focusQueue: Array<{ namespace: string; name: string; eventId: string; toolName: string }> = [];
  private isProcessingFocus = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery
  }

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    const dp = delivery.payload;
    const toolName = dp.toolName as string | undefined;
    const state = dp.state as string | undefined;
    const eventPayload = dp.payload as Record<string, unknown> | null;

    // Only process kubectl Init events for auto-focus
    if (!toolName?.startsWith('kubectl_') || state !== 'Init') {
      return;
    }

    // Skip list operations (they don't target specific resources)
    if (isListOperation(toolName)) {
      return;
    }

    // Extract namespace and name from event input
    const target = this.extractFocusTarget(eventPayload);
    if (!target) {
      return;
    }

    // Build a stable unique key for this event.
    const eventId = `${toolName}-${target.namespace}-${target.name}-${delivery.timestamp || Date.now()}`;

    if (this.processedEventIds.has(eventId)) {
      return;
    }
    this.processedEventIds.add(eventId);

    // Add to queue
    this.focusQueue.push({
      namespace: target.namespace,
      name: target.name,
      eventId,
      toolName,
    });

    this.processNextFocus();
  }

  /**
   * Called by ArchitectureDiagram when a focus animation completes (or node not found).
   * Advances the queue to the next item.
   */
  public onFocusComplete = (): void => {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.isProcessingFocus = false;
    this.focusTarget = null;
    this.lastFocusTime = Date.now();
    this.processNextFocus();
  };

  private processNextFocus(): void {
    // Already processing or queue is empty
    if (this.isProcessingFocus || this.focusQueue.length === 0) {
      return;
    }

    // Check debounce - must wait 0.5s from last focus
    const now = Date.now();
    const timeSinceLastFocus = now - this.lastFocusTime;

    if (timeSinceLastFocus < this.focusDebounceMs) {
      const waitTime = this.focusDebounceMs - timeSinceLastFocus;
      setTimeout(() => this.processNextFocus(), waitTime);
      return;
    }

    // Get next item from queue
    const nextTarget = this.focusQueue.shift();
    if (!nextTarget) return;

    this.isProcessingFocus = true;
    this.lastFocusTime = now;

    this.focusTarget = { namespace: nextTarget.namespace, name: nextTarget.name };
    this.focusTargetVersion++;

    setTimeout(() => {
      const focusEvent = new CustomEvent('diagram-focus-node', {
        detail: {
          namespace: nextTarget.namespace,
          name: nextTarget.name,
          toolName: nextTarget.toolName,
        },
      });
      window.dispatchEvent(focusEvent);
      console.log(`[DiagramFeature] 📡 Emitted diagram-focus-node event for ${nextTarget.namespace}/${nextTarget.name}`);
    }, 200); // Small delay for component mount

    // Safety timeout: if onFocusComplete hasn't fired within safetyTimeoutMs, force-advance
    this.safetyTimer = setTimeout(() => {
      if (this.isProcessingFocus) {
        console.log('[DiagramFeature] ⚠️ Safety timeout — forcing focus queue advance');
        this.onFocusComplete();
      }
    }, this.safetyTimeoutMs);
  }

  /**
   * Extract namespace and resource name from kubectl event input
   */
  private extractFocusTarget(eventPayload: Record<string, unknown> | null): { namespace: string; name: string } | null {
    if (!eventPayload) return null;

    // Common pattern: namespace + name
    if (eventPayload.namespace && eventPayload.name) {
      return { namespace: String(eventPayload.namespace), name: String(eventPayload.name) };
    }

    // kubectl_exec uses 'pod' instead of 'name'
    if (eventPayload.namespace && eventPayload.pod) {
      return { namespace: String(eventPayload.namespace), name: String(eventPayload.pod) };
    }

    return null;
  }

  /**
   * @deprecated Use onFocusComplete instead
   */
  public clearFocusTarget() {
    this.focusTarget = null;
  }

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
      // Pass saved path, or empty string to let Rust auto-detect the default kubeconfig
      const path = kubeconfigPath ?? '';
      adapterBridge.invoke('start_k8s_diagram', { kubeconfigPath: path }).catch(console.error);
    } catch {
      // bridge not ready yet
    }
  }

  async onUnmount() {
    this.focusTarget = null;
    this.focusQueue = [];
    this.isProcessingFocus = false;
    this.processedEventIds.clear();
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }
}

// Export singleton instance
export const diagramFeature = new DiagramFeature();
