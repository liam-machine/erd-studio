/**
 * A Table Library drag that missed the canvas: let go over a diagram without
 * Shift (or with Shift released a moment before the mouse button), the editor
 * group takes the drop and VS Code opens the dragged table files there,
 * pinned, instead of the canvas adding them. An extension cannot change that
 * (VS Code turns a webview's pointer events off during a workbench drag
 * unless Shift is held), so this watches for it and says what happened, with
 * a button that adds the tables to the diagram the drop was aimed at.
 *
 * The decision is the pure `missedCanvasDrop` (`src/services/tableDrop.ts`):
 * a fresh remembered drag, a pinned text tab of one of its files that opened
 * or (already open) came to the front, in a group whose front tab was a
 * diagram just before. The drag is then used up (the
 * canvases take their "Hold Shift and drop" hint down). Nothing is written
 * unless the user presses the button, and then only through Add to Diagram's
 * own route (`addTables`: the canvas's Add Existing Tables edit).
 */
import * as vscode from 'vscode';

import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { missedCanvasDrop, missedCanvasDropButton, missedCanvasDropMessage, type DroppableTableFile } from '../services/tableDrop';

export interface MissedCanvasDropDeps {
  /** The remembered Table Library drag, not used up (`SemanticEditorProvider.peekRememberedLibraryDrag`). */
  peekDrag(): { tables: string[]; files?: string[]; at: number } | undefined;
  /** Use the remembered drag up (`takeRememberedLibraryDrag`). */
  takeDrag(): unknown;
  listTableFiles(): readonly DroppableTableFile[];
  /** The diagram's name as the Diagrams view shows it. */
  diagramName(filePath: string): string;
  /** Add to Diagram's add: bring the diagram forward and add the tables in one edit. */
  addTables(filePath: string, tables: readonly string[], files?: readonly string[]): Promise<unknown>;
  /** Tests pass their own clock. */
  now?(): number;
}

/** The file of the diagram canvas in front of `group`, if its active tab is one. */
function diagramInFront(group: vscode.TabGroup): string | undefined {
  const input = group.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === SUBJECT_AREA_EDITOR_VIEW_TYPE && input.uri.scheme === 'file'
    ? input.uri.fsPath
    : undefined;
}

/** Watch for missed canvas drops until disposed. */
export function watchMissedCanvasDrops(deps: MissedCanvasDropDeps): vscode.Disposable {
  // Each group's front diagram as it was before the latest tab change: the drop's target.
  const frontBefore = new Map<vscode.TabGroup, string | undefined>();
  const snapshot = (): void => {
    frontBefore.clear();
    for (const group of vscode.window.tabGroups.all) frontBefore.set(group, diagramInFront(group));
  };
  snapshot();
  const onTabs = vscode.window.tabGroups.onDidChangeTabs((event) => {
    try {
      // A dropped file whose tab was already open is not opened again: VS Code
      // brings its tab to the front (a `changed` tab that is now its group's
      // active one, where a diagram was in front before).
      const broughtForward = event.changed.filter((tab) =>
        tab.isActive && tab.group.activeTab === tab && frontBefore.get(tab.group) !== undefined && !event.opened.includes(tab));
      for (const tab of [...event.opened, ...broughtForward]) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== 'file') continue;
        const drag = deps.peekDrag();
        if (!drag) return;
        const missed = missedCanvasDrop({
          opened: { filePath: input.uri.fsPath, preview: tab.isPreview },
          drag,
          now: deps.now?.() ?? Date.now(),
          frontDiagram: frontBefore.get(tab.group),
          library: deps.listTableFiles(),
        });
        if (!missed) continue;
        deps.takeDrag();
        const diagram = deps.diagramName(missed.diagramPath);
        const button = missedCanvasDropButton(diagram);
        void Promise.resolve(vscode.window.showInformationMessage(missedCanvasDropMessage(missed.names, diagram), button)).then(async (choice) => {
          if (choice !== button) return;
          await deps.addTables(missed.diagramPath, missed.names, missed.files);
        }).catch((err: unknown) => {
          void vscode.window.showErrorMessage(`Add to Diagram: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
    } finally {
      snapshot();
    }
  });
  const onGroups = vscode.window.tabGroups.onDidChangeTabGroups(snapshot);
  return vscode.Disposable.from(onTabs, onGroups);
}
