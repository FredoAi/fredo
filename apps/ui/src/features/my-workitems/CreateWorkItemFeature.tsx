import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuFilePlus } from 'react-icons/lu';
import { UnifiedCreateWorkItemView } from './components/UnifiedCreateWorkItemView';
import type { WorkItemPlatform } from './types';
import type { CreateWorkItemData } from './types';
import type { CreateIssueData, JiraIssueCreated } from './types';

export class CreateWorkItemFeature extends FredoFeatureClass {
  readonly id = 'create-workitem';
  readonly name = 'Create Work Item';
  readonly icon = LuFilePlus;
  readonly showable = false;

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
