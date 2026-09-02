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
import { ArchitectureDiagram } from './components/ArchitectureDiagram';
import { DiagramSettings } from './components/DiagramSettings';
import { LuNetwork } from 'react-icons/lu';
import { adapterBridge } from '../../shared/utils/adapterBridge';

export class DiagramFeature extends FredoFeatureClass {
  readonly id = 'diagram';
  readonly name = 'Infrastructure Diagram';
  readonly icon = LuNetwork;
  readonly showable = false;
  readonly hasSettings = true;

  private focusTarget: { namespace: string; name: string } | null = null;
  private lastFocusTime = 0;
  private focusDebounceMs = 500; // Minimum dwell time per node (ms)
  private safetyTimeoutMs = 4000; // Max wait before force-advancing queue
  private focusTargetVersion = 0;
  private focusQueue: Array<{ namespace: string; name: string; eventId: string; toolName: string }> = [];
  private isProcessingFocus = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }
}

// Export singleton instance
export const diagramFeature = new DiagramFeature();
