import React from 'react';
import { LuGitPullRequest } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes';
import { GithubViewerPanel } from './components/GithubViewerPanel';

export interface GithubViewerState {
  lastEvent: {
    toolName: string;
    payload: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    timestamp: string;
  } | null;
}

export class GithubViewerFeature extends FredoApplicationClass {
  readonly id = 'github-viewer';
  readonly name = 'GitHub';
  readonly icon = LuGitPullRequest;
  readonly showable = false;

  private state: GithubViewerState = { lastEvent: null };

  render() {
    return <GithubViewerPanel state={this.state} />;
  }

  onUnmount() {
    this.state = { lastEvent: null };
  }
}

export const githubViewerFeature = new GithubViewerFeature();
