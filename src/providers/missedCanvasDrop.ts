/**
 * A Table Library drag let go over a diagram without Shift (or with Shift
 * released a moment before the mouse button): the editor group takes the
 * drop and VS Code opens the dragged table files there, pinned, instead of
 * the canvas adding them. An extension cannot change that (VS Code turns a
 * webview's pointer events off during a workbench drag unless Shift is held),
 * and the drop was plainly aimed at the diagram, so this finishes it: the
 * tables go on that diagram (or, already there, are selected and named on its
 * canvas) and the file tabs the drop opened are closed again.
 *
 * The decision is the pure `missedCanvasDrop` (`src/services/tableDrop.ts`):
 * a fresh remembered drag, a pinned text tab of one of its files that opened
 * or (already open) came to the front, in a group whose front tab was a
 * diagram just before. The drag is then used up (the canvases take their
 * hint down). The write is Add to Diagram's own route (`addTables`: the
 * canvas's Add Existing Tables edit, one undo step). A tab that was open
 * before the drop is left open; only tabs the drop opened are closed.
 */
import * as vscode from 'vscode';

import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { ADDED_TO_DIAGRAM_STATUS_MS, addedToDiagramStatus } from '../commands/goToTable';
import { samePath } from '../services/projectDiscovery';
import { missedCanvasDrop, type DroppableTableFile } from '../services/tableDrop';

export interface MissedCanvasDropDeps {
  /** The remembered Table Library drag, not used up (`SemanticEditorProvider.peekRememberedLibraryDrag`). */
  peekDrag(): { tables: string[]; files?: string[]; at: number } | undefined;
  /** Use the remembered drag up (`takeRememberedLibraryDrag`). */
  takeDrag(): unknown;
  listTableFiles(): readonly DroppableTableFile[];
  /** The diagram's name as the Diagrams view shows it. */
  diagramName(filePath: string): string;
  /** Add to Diagram's add: bring the diagram forward and add the tables in one edit; resolves to the tables it added. */
  addTables(filePath: string, tables: readonly string[], files?: readonly string[]): Promise<readonly string[] | undefined | unknown>;
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

/** How long after a missed drop the other files of the same drag may still open (VS Code opens each dropped file) and are closed too. */
export const MISSED_DROP_CLOSE_MS = 3_000;

/** Watch for missed canvas drops until disposed. */
export function watchMissedCanvasDrops(deps: MissedCanvasDropDeps): vscode.Disposable {
  // Each group's front diagram as it was before the latest tab change: the drop's target.
  const frontBefore = new Map<vscode.TabGroup, string | undefined>();
  const snapshot = (): void => {
    frontBefore.clear();
    for (const group of vscode.window.tabGroups.all) frontBefore.set(group, diagramInFront(group));
  };
  snapshot();
  // The drag a missed drop just finished: its other files, when VS Code opens them too, are closed as well.
  let finished: { files: string[]; until: number } | undefined;
  const now = (): number => deps.now?.() ?? Date.now();
  const close = (tab: vscode.Tab): void => {
    void Promise.resolve(vscode.window.tabGroups.close(tab, true)).catch(() => undefined);
  };
  const onTabs = vscode.window.tabGroups.onDidChangeTabs((event) => {
    try {
      // The rest of a drag just finished: VS Code opened each of its files.
      if (finished && now() <= finished.until) {
        for (const tab of event.opened) {
          const input = tab.input;
          if (input instanceof vscode.TabInputText && finished.files.some((f) => samePath(f, input.uri.fsPath))) close(tab);
        }
      }
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
        const library = deps.listTableFiles();
        const missed = missedCanvasDrop({
          opened: { filePath: input.uri.fsPath, preview: tab.isPreview },
          drag,
          now: now(),
          frontDiagram: frontBefore.get(tab.group),
          library,
        });
        if (!missed) continue;
        deps.takeDrag();
        // Every file of the drag, so the ones VS Code opens next are closed too.
        const files = missed.files ?? missed.names.flatMap((name) => library.filter((f) => !f.shadowedBy && f.name.toLowerCase() === name.toLowerCase()).map((f) => f.filePath));
        finished = { files, until: now() + MISSED_DROP_CLOSE_MS };
        // Only a tab the drop opened is closed: one that was open before stays.
        if (event.opened.includes(tab)) close(tab);
        for (const other of event.opened) {
          const otherInput = other.input;
          if (other !== tab && otherInput instanceof vscode.TabInputText && files.some((f) => samePath(f, otherInput.uri.fsPath))) close(other);
        }
        const diagram = deps.diagramName(missed.diagramPath);
        void Promise.resolve(deps.addTables(missed.diagramPath, missed.names, missed.files)).then((added) => {
          // What the canvas added; nothing when all were there already or it refused (the canvas said so).
          const fresh = Array.isArray(added) ? [...new Set(added as string[])] : [];
          if (fresh.length === 0) return;
          const what = fresh.length === 1 ? `"${fresh[0]}"` : `${fresh.length} tables`;
          vscode.window.setStatusBarMessage(addedToDiagramStatus(what, diagram), ADDED_TO_DIAGRAM_STATUS_MS);
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
