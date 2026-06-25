import React from 'react';
import { LuGitPullRequest } from 'react-icons/lu';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { GithubViewerPanel } from './components/GithubViewerPanel';

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

  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'github-viewer',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
        { name: 'payload', path: 'payload', hint: 'deferred' },
      ],
      filter: { toolNames: GITHUB_TOOL_NAMES },
    },
  ];

  render() {
    return <GithubViewerPanel />;
  }
}

export const githubViewerFeature = new GithubViewerFeature();
