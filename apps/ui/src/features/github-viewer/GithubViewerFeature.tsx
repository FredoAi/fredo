import React from 'react';
import { LuGitPullRequest } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { GithubViewerPanel } from './components/GithubViewerPanel';

export interface GithubViewerState {
  lastEvent: {
    toolName: string;
    payload: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    timestamp: string;
  } | null;
}

const GITHUB_TOOL_NAMES = [
  'pull_request_read',
  'get_pull_request',
  'get_pull_request_files',
  'get_pull_request_diff',
  'get_pull_request_review_comments',
  'search_code',
  'get_file_contents',
  'list_issues',
];

export class GithubViewerFeature extends FredoFeatureClass {
  readonly id = 'github-viewer';
  readonly name = 'GitHub';
  readonly icon = LuGitPullRequest;
  readonly showable = true;

  // @deprecated — kept for base class compatibility; all event processing via eventContracts
  readonly eventFilters: EventFilter[] = [];

  readonly eventContracts = [
    {
      contractName: 'github-viewer',
      streamFields: ['toolName', 'state'],
      deferredFields: ['payload'],
      key: ['sessionId', 'correlationId', 'toolName'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      providers: ['opencode'],
    },
  ];

  private state: GithubViewerState = { lastEvent: null };

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery
  }

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    const dp = delivery.payload;
    const toolName = dp.toolName as string | undefined;
    const state = dp.state as string | undefined;
    const eventPayload = dp.payload as Record<string, unknown> | null;

    if (delivery.lifecycle === 'init') {
      this.state = {
        lastEvent: {
          toolName: toolName ?? 'unknown',
          payload: eventPayload ?? null,
          response: null,
          timestamp: delivery.timestamp,
        },
      };
    } else if ((delivery.lifecycle === 'end') && this.state.lastEvent) {
      this.state = {
        lastEvent: {
          ...this.state.lastEvent,
          response: eventPayload ?? null,
          timestamp: delivery.timestamp,
        },
      };
    }
    this.forceRerender?.();
  }

  render() {
    return <GithubViewerPanel state={this.state} />;
  }

  onUnmount() {
    this.state = { lastEvent: null };
  }
}

export const githubViewerFeature = new GithubViewerFeature();
