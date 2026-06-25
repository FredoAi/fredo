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

  readonly eventContracts = [
    {
      contractName: 'browser-preview',
      streamFields: ['toolName', 'state'],
      deferredFields: ['payload'],
      key: ['sessionId', 'correlationId', 'toolName'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      providers: ['opencode'],
    },
  ];

  private state: BrowserPreviewState = {
    toolName: null,
    currentUrl: null,
    screenshotUrl: null,
    networkRequests: [],
    consoleLogs: [],
    timestamp: null,
  };

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    const dp = delivery.payload;
    const toolName = dp.toolName as string | null;
    const state = dp.state as string | null;
    const eventPayload = dp.payload as Record<string, unknown> | null;

    if (delivery.lifecycle === 'init') {
      this.state = { ...this.state, toolName: toolName ?? null, timestamp: delivery.timestamp };
    }

    if (delivery.lifecycle === 'end' && eventPayload) {
      // Capture URL from navigation tools (merged from Init payload fields)
      const url = (eventPayload?.url ?? eventPayload?.page) as string | null;
      if (url) this.state = { ...this.state, currentUrl: url };

      // Screenshot — response may contain a base64 data URL or path
      if (toolName === 'take_screenshot' || toolName === 'playwright_screenshot') {
        const src = (eventPayload as any)?.dataUrl ?? (eventPayload as any)?.path ?? (eventPayload as any)?.data ?? null;
        if (src) this.state = { ...this.state, screenshotUrl: src as string, timestamp: delivery.timestamp };
      }

      // Network requests list
      if (toolName === 'list_network_requests') {
        const reqs = Array.isArray(eventPayload) ? eventPayload : ((eventPayload as any)?.requests ?? []) as any[];
        this.state = { ...this.state, networkRequests: reqs, timestamp: delivery.timestamp };
      }

      // Console messages
      if (toolName === 'list_console_messages') {
        const logs = Array.isArray(eventPayload) ? eventPayload : ((eventPayload as any)?.messages ?? []) as any[];
        this.state = { ...this.state, consoleLogs: logs, timestamp: delivery.timestamp };
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
