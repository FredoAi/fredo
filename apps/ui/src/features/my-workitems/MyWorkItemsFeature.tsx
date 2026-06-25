/**
 * MyWorkItemsFeature — unified Azure DevOps + Jira work items panel
 *
 * Listens to MCP events from both azdo_start_workitem and jira_get_my_issues /
 * jira_get_issue_details, then renders a single fused panel.
 */

import React from 'react';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { LuClipboardList } from 'react-icons/lu';
import { MyWorkItemsContainer } from './components/MyWorkItemsContainer';
import { WorkItemsSettings } from './components/WorkItemsSettings';
import type { DetailTarget } from './types';

const WORKITEM_TOOL_NAMES = [
  'azdo_start_workitem',
  'jira_get_my_issues',
  'jira_get_issue_details',
  'ado-wit_get_work_item',
  'ado-wit_update_work_item',
  'ado-wit_add_comment',
  'ado-wit_link_work_items',
  'ado-search_workitem',
  'ado-work_get_iterations',
  'ado-work_get_team_capacity',
  'ado-core_get_projects',
  'ado-core_get_teams',
];

export class MyWorkItemsFeature extends FredoFeatureClass {
  readonly id = 'my-workitems';
  readonly name = 'My Work Items';
  readonly icon = LuClipboardList;
  readonly showable = true;

  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'my-workitems',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
        { name: 'payload', path: 'payload', hint: 'deferred' },
      ],
      filter: { toolNames: WORKITEM_TOOL_NAMES },
    },
  ];

  readonly gridConfig = { closable: true, maximizable: true };

  /** If Agent asks for a specific item, store the target here so the container
   *  can open straight into the detail view. */
  private initialDetail: DetailTarget | undefined = undefined;

  /** Programmatically open a specific AzDo work item detail (used after creating a work item) */
  public openAzdoItem(workItemId: number) {
    console.log('[MyWorkItemsFeature] Programmatic AzDo detail:', workItemId);
    this.initialDetail = { source: 'azdo', id: String(workItemId) };
  }

  render() {
    return (
      <MyWorkItemsContainer
        initialDetail={this.initialDetail}
        onClose={() => this.onCloseRequested?.()}
      />
    );
  }

  readonly hasSettings = true;

  renderSettings() {
    return <WorkItemsSettings />;
  }

  onMount() {
    console.log('[MyWorkItemsFeature] Mounted');
  }

  onUnmount() {
    console.log('[MyWorkItemsFeature] Unmounted — resetting state');
    this.initialDetail = undefined;
  }
}

export const myWorkItemsFeature = new MyWorkItemsFeature();
