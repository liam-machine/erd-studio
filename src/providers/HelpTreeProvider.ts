/**
 * HelpTreeProvider — the sidebar's Help & Feedback view.
 *
 * Getting help, setting up the AI helper and sending feedback, as labelled
 * rows rather than unlabelled title-bar icons. The reports the user filed
 * from ERD Studio (`ReportTrackingService`) show under "My Reports" once
 * there is one; its rows are {@link MyReportsTreeProvider}'s.
 */

import * as vscode from 'vscode';

import type { ReportTrackingService } from '../services/reportTrackingService';
import { MyReportsTreeProvider, type MyReportNode } from './MyReportsTreeProvider';

export interface HelpActionNode {
  readonly type: 'action';
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly command: string;
  readonly tooltip: string;
}

export interface HelpReportsNode {
  readonly type: 'reports';
}

export type HelpNode = HelpActionNode | HelpReportsNode | MyReportNode;

/** The rows, in order. Each runs a contributed command; none takes an argument. */
export const HELP_ACTIONS: readonly HelpActionNode[] = [
  {
    type: 'action', id: 'aiHelper', label: 'Set Up My AI Helper', icon: 'sparkle', command: 'erdStudio.setupAiHelper',
    tooltip: 'Teach your AI assistant (Claude Code, GitHub Copilot, Codex, Gemini CLI or Cursor) to read and write your diagrams.',
  },
  {
    type: 'action', id: 'gettingStarted', label: 'Watch Getting Started Video', icon: 'play-circle', command: 'erdStudio.showGettingStarted',
    tooltip: 'A one-minute video and the first steps, for a project with or without dbt.',
  },
  {
    type: 'action', id: 'feedback', label: 'Send Feedback', icon: 'comment-discussion', command: 'erdStudio.reportBug',
    tooltip: 'Report a bug or suggest an idea. It opens as a GitHub issue you can read before sending.',
  },
  {
    type: 'action', id: 'logs', label: 'Show Logs', icon: 'output', command: 'erdStudio.showLogs',
    tooltip: 'What ERD Studio did and how long it took, in the Output panel.',
  },
];

export class HelpTreeProvider implements vscode.TreeDataProvider<HelpNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HelpNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly reports: MyReportsTreeProvider;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tracking: ReportTrackingService) {
    this.reports = new MyReportsTreeProvider(tracking);
    this.subscription = tracking.onDidChangeReports(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(element?: HelpNode): HelpNode[] {
    if (!element) {
      const rows: HelpNode[] = [...HELP_ACTIONS];
      // After Send Feedback: the reports it filed, once there is one.
      if (this.tracking.getReports().length > 0) rows.splice(3, 0, { type: 'reports' });
      return rows;
    }
    if (element.type === 'reports') return this.reports.getChildren() ?? [];
    return [];
  }

  getTreeItem(element: HelpNode): vscode.TreeItem {
    if (element.type === 'report') return this.reports.getTreeItem(element);
    if (element.type === 'reports') {
      const reports = this.tracking.getReports();
      const item = new vscode.TreeItem('My Reports', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'erdStudio.help.reports';
      const open = reports.filter((r) => r.state === 'open').length;
      item.description = open > 0 ? `${open} open` : `${reports.length}`;
      item.iconPath = new vscode.ThemeIcon('issues');
      item.tooltip = 'The issues you filed from ERD Studio, and where each one is up to.';
      item.contextValue = 'myReports';
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.id = `erdStudio.help.${element.id}`;
    item.iconPath = new vscode.ThemeIcon(element.icon);
    item.tooltip = element.tooltip;
    item.contextValue = 'helpAction';
    item.command = { command: element.command, title: element.label };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.reports.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
