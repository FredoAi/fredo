/**
 * MyWorkItemsFeature — unified Azure DevOps + Jira work items panel
 *
 * Listens to MCP events from both azdo_start_workitem and jira_get_my_issues /
 * jira_get_issue_details, then renders a single fused panel.
 */

import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuClipboardList } from 'react-icons/lu';
import { MyWorkItemsContainer } from './components/MyWorkItemsContainer';
import { WorkItemsSettings } from './components/WorkItemsSettings';
import type { DetailTarget } from './types';

export class MyWorkItemsFeature extends FredoFeatureClass {
  readonly id = 'my-workitems';
  readonly name = 'My Work Items';
  readonly icon = LuClipboardList;
  readonly showable = true;

  readonly eventFilters: EventFilter[] = [
    { toolNames: [
      // Legacy internal tool names
      'azdo_start_workitem',
      'jira_get_my_issues',
      'jira_get_issue_details',
      // ADO MCP server tools
      'ado-wit_get_work_item',
      'ado-wit_update_work_item',
      'ado-wit_add_comment',
      'ado-wit_link_work_items',
      'ado-search_workitem',
      'ado-work_get_iterations',
      'ado-work_get_team_capacity',
      'ado-core_get_projects',
      'ado-core_get_teams',
    ] },
  ];

  readonly gridConfig = { closable: true, maximizable: true };

  /** If Agent asks for a specific item, store the target here so the container
   *  can open straight into the detail view. */
  private initialDetail: DetailTarget | undefined = undefined;

  processEvent(event: FredoEvent): void {
    if (event.state !== 'Init') return;

    const input = event.payload as Record<string, unknown> || {};

    if (event.toolName === 'azdo_start_workitem') {
      if (input.workItemId && typeof input.workItemId === 'number') {
        console.log('[MyWorkItemsFeature] AzDo direct-to-detail:', input.workItemId);
        this.initialDetail = { source: 'azdo', id: String(input.workItemId) };
      } else {
        console.log('[MyWorkItemsFeature] AzDo list view');
        this.initialDetail = undefined;
      }
    }

    // ADO MCP: get a specific work item by id
    if (event.toolName === 'ado-wit_get_work_item' && input.id) {
      console.log('[MyWorkItemsFeature] ADO MCP direct-to-detail:', input.id);
      this.initialDetail = { source: 'azdo', id: String(input.id) };
    }

    // ADO MCP: search or list — show list view
    if (
      event.toolName === 'ado-search_workitem' ||
      event.toolName === 'ado-work_get_iterations' ||
      event.toolName === 'ado-work_get_team_capacity' ||
      event.toolName === 'ado-core_get_projects' ||
      event.toolName === 'ado-core_get_teams'
    ) {
      console.log('[MyWorkItemsFeature] ADO MCP list view:', event.toolName);
      this.initialDetail = undefined;
    }

    // ADO MCP: update/comment — navigate to the item being modified
    if (
      (event.toolName === 'ado-wit_update_work_item' || event.toolName === 'ado-wit_add_comment' || event.toolName === 'ado-wit_link_work_items') &&
      input.id
    ) {
      console.log('[MyWorkItemsFeature] ADO MCP update item:', input.id);
      this.initialDetail = { source: 'azdo', id: String(input.id) };
    }

    if (event.toolName === 'jira_get_issue_details' && input.issueKey) {
      console.log('[MyWorkItemsFeature] Jira direct-to-detail:', input.issueKey);
      this.initialDetail = { source: 'jira', id: input.issueKey as string };
    }

    if (event.toolName === 'jira_get_my_issues') {
      console.log('[MyWorkItemsFeature] Jira list view');
      this.initialDetail = undefined;
    }
  }

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
