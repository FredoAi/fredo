import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuFilePlus } from 'react-icons/lu';
import { UnifiedCreateWorkItemView } from './components/UnifiedCreateWorkItemView';
import type { WorkItemPlatform } from './types';
import type { CreateWorkItemData } from './types';
import type { CreateIssueData, JiraIssueCreated } from './types';

export class CreateWorkItemFeature extends FredoFeatureClass {
  readonly id = 'create-workitem';
  readonly name = 'Create Work Item';
  readonly icon = LuFilePlus;
  readonly showable = true;

  readonly eventFilters: EventFilter[] = [
    { toolNames: ['azdo_create_workitem'], states: ['Init', 'Update'] },
    { toolNames: ['jira_create_issue'], states: ['Init', 'Update'] },
  ];

  readonly gridConfig = { closable: true, maximizable: true };

  // Active platform tab
  private platform: WorkItemPlatform = 'azdo';

  // Shared mode
  private mode: 'form' | 'success' = 'form';

  // Azure DevOps state
  private azdoFormData: Partial<CreateWorkItemData> = {};
  private azdoUpdateCounter = 0;
  private azdoSuccessData: { workItemId: number; workItemUrl: string } | undefined;

  // Jira state
  private jiraFormData: Partial<CreateIssueData> = {};
  private jiraUpdateCounter = 0;
  private jiraSuccessData: JiraIssueCreated | undefined;

  // Transition callback for navigating to work item details after AzDo creation
  private onTransitionToWorkItem?: (workItemId: number) => void;

  public registerTransitionCallback(callback: (workItemId: number) => void) {
    this.onTransitionToWorkItem = callback;
  }

  processEvent(event: StreamEvent): void {
    if (event.toolName === 'azdo_create_workitem') {
      this.platform = 'azdo';
      if (this.mode === 'success') return;

      const incoming = event.input || {};
      const { merge, assignedTo, ...fields } = incoming;
      const nonEmpty = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '')
      );
      if (Object.keys(nonEmpty).length === 0) return;

      this.azdoFormData = { ...this.azdoFormData, ...nonEmpty };
      this.azdoUpdateCounter++;
      console.log('[CreateWorkItemFeature] AzDo form updated:', Object.keys(this.azdoFormData));

    } else if (event.toolName === 'jira_create_issue') {
      this.platform = 'jira';
      if (this.mode === 'success') return;

      const incoming = event.input || {};
      const nonEmpty = Object.fromEntries(
        Object.entries(incoming).filter(([, v]) => v !== null && v !== undefined && v !== '')
      );
      if (Object.keys(nonEmpty).length === 0) return;

      this.jiraFormData = { ...this.jiraFormData, ...nonEmpty };
      this.jiraUpdateCounter++;
      console.log('[CreateWorkItemFeature] Jira form updated:', Object.keys(this.jiraFormData));
    }
  }

  render() {
    return (
      <UnifiedCreateWorkItemView
        platform={this.platform}
        mode={this.mode}
        azdoFormData={this.azdoFormData}
        azdoUpdateCounter={this.azdoUpdateCounter}
        azdoSuccessData={this.azdoSuccessData}
        jiraFormData={this.jiraFormData}
        jiraUpdateCounter={this.jiraUpdateCounter}
        jiraSuccessData={this.jiraSuccessData}
        onPlatformChange={this.handlePlatformChange.bind(this)}
        onAzdoSuccess={this.handleAzdoSuccess.bind(this)}
        onJiraSuccess={this.handleJiraSuccess.bind(this)}
        onCreateAnother={this.handleCreateAnother.bind(this)}
        onViewWorkItem={this.handleViewWorkItem.bind(this)}
        onClose={this.handleClose.bind(this)}
      />
    );
  }

  onMount() {
    console.log('[CreateWorkItemFeature] Mounted');
  }

  onUnmount() {
    console.log('[CreateWorkItemFeature] Unmounted — resetting state');
    this.mode = 'form';
    this.platform = 'azdo';
    this.azdoFormData = {};
    this.azdoUpdateCounter = 0;
    this.azdoSuccessData = undefined;
    this.jiraFormData = {};
    this.jiraUpdateCounter = 0;
    this.jiraSuccessData = undefined;
  }

  private handlePlatformChange(p: WorkItemPlatform) {
    this.platform = p;
    this.forceRerender?.();
  }

  private handleAzdoSuccess(workItemId: number, workItemUrl: string) {
    this.mode = 'success';
    this.platform = 'azdo';
    this.azdoSuccessData = { workItemId, workItemUrl };
    this.azdoFormData = {};
    this.azdoUpdateCounter = 0;
    this.forceRerender?.();
  }

  private handleJiraSuccess(created: JiraIssueCreated) {
    this.mode = 'success';
    this.platform = 'jira';
    this.jiraSuccessData = created;
    this.jiraFormData = {};
    this.jiraUpdateCounter = 0;
    this.forceRerender?.();
  }

  private handleCreateAnother() {
    this.mode = 'form';
    this.azdoSuccessData = undefined;
    this.jiraSuccessData = undefined;
    this.forceRerender?.();
  }

  private handleViewWorkItem() {
    if (this.azdoSuccessData && this.onTransitionToWorkItem) {
      this.onTransitionToWorkItem(this.azdoSuccessData.workItemId);
    }
  }

  private handleClose() {
    this.onCloseRequested?.();
  }
}

export const createWorkItemFeature = new CreateWorkItemFeature();
