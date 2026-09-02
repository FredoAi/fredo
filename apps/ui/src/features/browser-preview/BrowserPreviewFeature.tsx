import React from 'react';
import { LuMonitor } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import { BrowserPreviewPanel } from './components/BrowserPreviewPanel';

export interface BrowserPreviewState {
  toolName: string | null;
  currentUrl: string | null;
  screenshotUrl: string | null;
  networkRequests: any[];
  consoleLogs: any[];
  timestamp: string | null;
}

export class BrowserPreviewFeature extends FredoFeatureClass {
  readonly id = 'browser-preview';
  readonly name = 'Browser';
  readonly icon = LuMonitor;
  readonly showable = false;

  private state: BrowserPreviewState = {
    toolName: null,
    currentUrl: null,
    screenshotUrl: null,
    networkRequests: [],
    consoleLogs: [],
    timestamp: null,
  };

  render() {
    return <BrowserPreviewPanel state={this.state} />;
  }

  onUnmount() {
    this.state = {
      toolName: null,
      currentUrl: null,
      screenshotUrl: null,
      networkRequests: [],
      consoleLogs: [],
      timestamp: null,
    };
  }
}

export const browserPreviewFeature = new BrowserPreviewFeature();
