/**
 * MyWorkItemsFeature — unified Azure DevOps + Jira work items panel
 *
 * Listens to MCP events from both azdo_start_workitem and jira_get_my_issues /
 * jira_get_issue_details, then renders a single fused panel.
 */

import React from 'react';
import { FredoApplicationClass } from '../../shared/classes';
import { LuClipboardList } from 'react-icons/lu';
import { MyWorkItemsContainer } from './components/MyWorkItemsContainer';
import { WorkItemsSettings } from './components/WorkItemsSettings';
import type { ApplicationHotkeyAction } from '../../shared/hotkeys/types';
import {
  dispatchMyWorkItemsAction,
  isMyWorkItemsActionAvailable,
  MY_WORKITEMS_REFRESH_ACTION_ID,
  MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
  MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
  MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
} from './lib/hotkeyBridge';
import type { DetailTarget } from './types';

export class MyWorkItemsFeature extends FredoApplicationClass {
  readonly id = 'my-workitems';
  readonly name = 'My Work Items';
  readonly icon = LuClipboardList;
  readonly showable = false;

  readonly gridConfig = { closable: true, maximizable: true };

  /**
   * Spec #2961 ST-1 (S4): the feature's LOCAL base-context actions, declared
   * through the platform contract. Each `run` dispatches a namespaced event the
   * mounted `MyWorkItemsContainer` maps onto its EXISTING refresh / source-filter
   * operations, so `run` is a safe no-op while the feature is closed. `refresh`
   * is unavailable-with-reason while the list is loading; the container
   * publishes that availability (module-scoped, so it survives unmount).
   */
  readonly hotkeys: readonly ApplicationHotkeyAction[] = [
    {
      actionId: MY_WORKITEMS_REFRESH_ACTION_ID,
      title: 'Refresh work items',
      description: 'Reload Azure DevOps and Jira work items',
      defaultSequence: 'r',
      enabled: () => isMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID),
      unavailableReason: 'Work items are still loading',
      run: () => dispatchMyWorkItemsAction(MY_WORKITEMS_REFRESH_ACTION_ID),
    },
    {
      actionId: MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
      title: 'Show all sources',
      description: 'Show work items from every source',
      defaultSequence: 'a',
      run: () => dispatchMyWorkItemsAction(MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID),
    },
    {
      actionId: MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
      title: 'Show Azure DevOps items',
      description: 'Filter the list to Azure DevOps work items',
      defaultSequence: 'z',
      run: () => dispatchMyWorkItemsAction(MY_WORKITEMS_SHOW_AZDO_ACTION_ID),
    },
    {
      actionId: MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
      title: 'Show Jira items',
      description: 'Filter the list to Jira issues',
      defaultSequence: 'j',
      run: () => dispatchMyWorkItemsAction(MY_WORKITEMS_SHOW_JIRA_ACTION_ID),
    },
  ];

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
