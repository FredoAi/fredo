import React from 'react';
import { LuGitPullRequest } from 'react-icons/lu';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
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

  readonly eventFilters: EventFilter[] = [
    { toolNames: GITHUB_TOOL_NAMES },
  ];

  private state: GithubViewerState = { lastEvent: null };

  processEvent(event: FredoEvent): void {
    if (event.state === 'Init') {
      this.state = {
        lastEvent: {
          toolName: event.toolName,
          payload: event.payload ?? null,
          response: null,
          timestamp: event.timestamp,
        },
      };
    } else if ((event.state === 'Response' || event.state === 'Error') && this.state.lastEvent) {
      this.state = {
        lastEvent: {
          ...this.state.lastEvent,
          response: event.payload ?? null,
          timestamp: event.timestamp,
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
