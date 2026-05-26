import React from 'react';
import { LuMonitor } from 'react-icons/lu';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { BrowserPreviewPanel } from './components/BrowserPreviewPanel';

export interface BrowserPreviewState {
  toolName: string | null;
  currentUrl: string | null;
  screenshotUrl: string | null;
  networkRequests: any[];
  consoleLogs: any[];
  timestamp: string | null;
}

const BROWSER_TOOL_NAMES = [
  // Playwright
  'playwright_navigate',
  'playwright_screenshot',
  'playwright_click',
  'playwright_fill',
  'playwright_select',
  'playwright_hover',
  'playwright_evaluate',
  'playwright_get_visible_text',
  'playwright_get_visible_html',
  'playwright_go_back',
  'playwright_go_forward',
  // Chrome DevTools
  'take_screenshot',
  'take_snapshot',
  'navigate_page',
  'list_network_requests',
  'get_network_request',
  'list_console_messages',
  'list_pages',
];

export class BrowserPreviewFeature extends FredoFeatureClass {
  readonly id = 'browser-preview';
  readonly name = 'Browser';
  readonly icon = LuMonitor;
  readonly showable = true;

  readonly eventFilters: EventFilter[] = [
    { toolNames: BROWSER_TOOL_NAMES },
  ];

  private state: BrowserPreviewState = {
    toolName: null,
    currentUrl: null,
    screenshotUrl: null,
    networkRequests: [],
    consoleLogs: [],
    timestamp: null,
  };

  processEvent(event: FredoEvent): void {
    const { toolName, timestamp } = event;
    const input = event.payload as Record<string, unknown> | null;
    const response = event.payload as Record<string, unknown> | null;

    if (event.state === 'Init') {
      this.state = { ...this.state, toolName: toolName ?? null, timestamp };

      // Extract URL from navigation tools
      const url = (input?.url ?? input?.page) as string | null;
      if (url) this.state = { ...this.state, currentUrl: url };
    }

    if (event.state === 'Response' && response) {
      // Screenshot — response may contain a base64 data URL or path
      if (toolName === 'take_screenshot' || toolName === 'playwright_screenshot') {
        const src = (response as any)?.dataUrl ?? (response as any)?.path ?? (response as any)?.data ?? null;
        if (src) this.state = { ...this.state, screenshotUrl: src as string, timestamp };
      }

      // Network requests list
      if (toolName === 'list_network_requests') {
        const reqs = Array.isArray(response) ? response : ((response as any)?.requests ?? []) as any[];
        this.state = { ...this.state, networkRequests: reqs, timestamp };
      }

      // Console messages
      if (toolName === 'list_console_messages') {
        const logs = Array.isArray(response) ? response : ((response as any)?.messages ?? []) as any[];
        this.state = { ...this.state, consoleLogs: logs, timestamp };
      }
    }

    this.forceRerender?.();
  }

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
