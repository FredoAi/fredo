/**
 * MyWorkItemsFeature — unified Azure DevOps + Jira work items panel
 *
 * Listens to MCP events from both azdo_start_workitem and jira_get_my_issues /
 * jira_get_issue_details, then renders a single fused panel.
 */

import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuClipboardList } from 'react-icons/lu';
import { MyWorkItemsContainer } from './components/MyWorkItemsContainer';
import { WorkItemsSettings } from './components/WorkItemsSettings';
import type { DetailTarget } from './types';

export class MyWorkItemsFeature extends FredoFeatureClass {
  readonly id = 'my-workitems';
  readonly name = 'My Work Items';
  readonly icon = LuClipboardList;
  readonly showable = false;

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
