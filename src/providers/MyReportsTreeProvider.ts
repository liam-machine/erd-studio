/**
 * MyReportsTreeProvider — VS Code TreeDataProvider for the "My Reports" sidebar.
 *
 * Shows the GitHub issues the user filed from ERD Studio as a flat list,
 * newest first, with the issue's current state as the row description. The
 * data comes entirely from {@link ReportTrackingService}'s cache; this provider
 * never touches the network.
 *
 * The view is gated on `erdStudio.hasTrackedReports`, which the tracking
 * service sets, so an unauthenticated user never sees it at all.
 */

import * as vscode from 'vscode';

import type { TrackedReport } from '../types/feedback';
import { trackedReportLabel, type ReportTrackingService } from '../services/reportTrackingService';

// ---------------------------------------------------------------------------
// Tree element type
// ---------------------------------------------------------------------------

export interface MyReportNode {
  readonly type: 'report';
  readonly report: TrackedReport;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * Codicon id for a row. Mirrors the three states `trackedReportLabel()`
 * produces: a closed issue with no `state_reason` counts as implemented.
 */
function iconIdFor(report: TrackedReport): string {
  if (report.state === 'open') return 'issues';
  return report.stateReason === 'not_planned' ? 'circle-slash' : 'pass-filled';
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class MyReportsTreeProvider implements vscode.TreeDataProvider<MyReportNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<MyReportNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly tracking: ReportTrackingService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: MyReportNode): vscode.TreeItem {
    const { report } = element;
    const item = new vscode.TreeItem(
      `#${report.number} ${report.title}`,
      vscode.TreeItemCollapsibleState.None,
    );

    item.description = trackedReportLabel(report).label;
    item.iconPath = new vscode.ThemeIcon(iconIdFor(report));
    item.contextValue = 'trackedReport';
    item.tooltip = new vscode.MarkdownString(`**${report.title}**\n\n${report.url}`);
    item.command = {
      command: 'erdStudio.openTrackedReport',
      title: 'Open on GitHub',
      arguments: [element],
    };

    return item;
  }

  getChildren(element?: MyReportNode): MyReportNode[] | undefined {
    // Flat list — nothing has children.
    if (element) return undefined;

    return this.tracking
      .getReports()
      .map((report): MyReportNode => ({ type: 'report', report }));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
