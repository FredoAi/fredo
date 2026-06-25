import React from 'react';
import { LuMonitor } from 'react-icons/lu';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { BrowserPreviewPanel } from './components/BrowserPreviewPanel';

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

  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'browser-preview',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
        { name: 'payload', path: 'payload', hint: 'deferred' },
      ],
      filter: { toolNames: BROWSER_TOOL_NAMES },
    },
  ];

  render() {
    return <BrowserPreviewPanel />;
  }
}

export const browserPreviewFeature = new BrowserPreviewFeature();
