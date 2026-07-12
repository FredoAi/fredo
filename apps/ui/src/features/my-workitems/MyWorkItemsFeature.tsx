/**
 * MyWorkItemsFeature — unified Azure DevOps + Jira work items panel
 *
 * Listens to MCP events from both azdo_start_workitem and jira_get_my_issues /
 * jira_get_issue_details, then renders a single fused panel.
 */

import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { LuClipboardList } from 'react-icons/lu';
import { MyWorkItemsContainer } from './components/MyWorkItemsContainer';
import { WorkItemsSettings } from './components/WorkItemsSettings';
import type { DetailTarget } from './types';

const WORKITEM_TOOL_NAMES = [
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
];

export class MyWorkItemsFeature extends FredoFeatureClass {
  readonly id = 'my-workitems';
  readonly name = 'My Work Items';
  readonly icon = LuClipboardList;
  readonly showable = false;

  // @deprecated — kept for base class compatibility; all event processing via eventContracts
  readonly eventFilters: EventFilter[] = [];

  readonly gridConfig = { closable: true, maximizable: true };

  /** If Agent asks for a specific item, store the target here so the container
   *  can open straight into the detail view. */
  private initialDetail: DetailTarget | undefined = undefined;

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery
  }

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    if (delivery.lifecycle !== 'init') return;

    const dp = delivery.payload;
    const toolName = dp.toolName as string | undefined;
    const eventPayload = dp.payload as Record<string, unknown> | null;
    if (!toolName || !eventPayload) return;

    if (toolName === 'azdo_start_workitem') {
      if (eventPayload.workItemId && typeof eventPayload.workItemId === 'number') {
        console.log('[MyWorkItemsFeature] AzDo direct-to-detail:', eventPayload.workItemId);
        this.initialDetail = { source: 'azdo', id: String(eventPayload.workItemId) };
      } else {
        console.log('[MyWorkItemsFeature] AzDo list view');
        this.initialDetail = undefined;
      }
    }

    // ADO MCP: get a specific work item by id
    if (toolName === 'ado-wit_get_work_item' && eventPayload.id) {
      console.log('[MyWorkItemsFeature] ADO MCP direct-to-detail:', eventPayload.id);
      this.initialDetail = { source: 'azdo', id: String(eventPayload.id) };
    }

    // ADO MCP: search or list — show list view
    if (
      toolName === 'ado-search_workitem' ||
      toolName === 'ado-work_get_iterations' ||
      toolName === 'ado-work_get_team_capacity' ||
      toolName === 'ado-core_get_projects' ||
      toolName === 'ado-core_get_teams'
    ) {
      console.log('[MyWorkItemsFeature] ADO MCP list view:', toolName);
      this.initialDetail = undefined;
    }

    // ADO MCP: update/comment — navigate to the item being modified
    if (
      (toolName === 'ado-wit_update_work_item' || toolName === 'ado-wit_add_comment' || toolName === 'ado-wit_link_work_items') &&
      eventPayload.id
    ) {
      console.log('[MyWorkItemsFeature] ADO MCP update item:', eventPayload.id);
      this.initialDetail = { source: 'azdo', id: String(eventPayload.id) };
    }

    if (toolName === 'jira_get_issue_details' && eventPayload.issueKey) {
      console.log('[MyWorkItemsFeature] Jira direct-to-detail:', eventPayload.issueKey);
      this.initialDetail = { source: 'jira', id: String(eventPayload.issueKey) };
    }

    if (toolName === 'jira_get_my_issues') {
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
