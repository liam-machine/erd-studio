/**
 * REPRO (gerhard-feedback-3, stage 1 diagnosis) — these tests FAIL on
 * origin/develop and on v2.0.4 by design. The fix (stage 2) makes them pass;
 * fold them into domainTreeProvider.test.ts / goToTable.test.ts then.
 *
 * 1. Table Library rows dropped on a diagram's row in the Diagrams view do
 *    nothing at all, on every platform (Gerhard: "neither dropping on the
 *    diagram view on the right nor dropping on the diagram tree view in the
 *    sidebar"). The drag's custom mime type, `TABLE_LIBRARY_DRAG_MIME`, is
 *    VS Code's OWN tree mime type for the source view
 *    (`application/vnd.code.tree.<view id lower-cased>` =
 *    `application/vnd.code.tree.erdstudio.modellibrary`). At dragstart the
 *    workbench writes `{"id":"erdStudio.modelLibrary","itemHandles":[…]}`
 *    under that type in the native DataTransfer; on a drop in ANOTHER tree it
 *    copies the native entries first and appends the drag controller's own
 *    items after them (`CustomTreeViewDragAndDrop.drop`: `u.append(native)`
 *    then `for (… of removeDragOperationTransfer(uuid)) u.append(…)`), and the
 *    extension host's `DataTransfer.get()` returns the FIRST item of a mime
 *    type. So `handleDrop` reads VS Code's source-info object instead of the
 *    table names, `draggedTableNames` returns [], and `dropTables` returns
 *    without a word. The mock DataTransfer in test/__mocks__/vscode.ts holds
 *    one item per type, which is why the existing tests pass.
 *
 * 2. Add to Diagram… always asks which diagram, even with a diagram open
 *    (it only lists the open one first).
 */
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

import { SubjectAreaTreeProvider, type TreeElement } from '../../src/providers/DomainTreeProvider';
import { addToDiagramCommand } from '../../src/commands/goToTable';
import { TABLE_LIBRARY_DRAG_MIME } from '../../src/types/messages';
import type { SubjectAreaSummary } from '../../src/types/semantic';

/**
 * A DataTransfer as VS Code's extension host builds it for a tree drop
 * (`extHostTypes.DataTransfer`): several items per mime type, in the order
 * the workbench sent them, and `get()` returns the first.
 */
class VSCodeDataTransfer {
  private readonly items = new Map<string, vscode.DataTransferItem[]>();
  constructor(init: ReadonlyArray<readonly [string, vscode.DataTransferItem]>) {
    for (const [mime, item] of init) {
      const key = mime.toLowerCase();
      const list = this.items.get(key);
      if (list) list.push(item); else this.items.set(key, [item]);
    }
  }
  get(mime: string): vscode.DataTransferItem | undefined { return this.items.get(mime.toLowerCase())?.[0]; }
  set(mime: string, item: vscode.DataTransferItem): void { this.items.set(mime.toLowerCase(), [item]); }
  forEach(cb: (item: vscode.DataTransferItem, mime: string) => void): void { this.items.forEach((list, mime) => list.forEach((i) => cb(i, mime))); }
}

/**
 * What a Table Library row dropped on a Diagrams row hands `handleDrop`
 * (VS Code 1.145, recorded with test/stories/repro/gerhard3-dragdrop.mjs):
 * the native entry VS Code wrote at dragstart first, then the items
 * `TableLibraryDragController.handleDrag` set, serialised (an array becomes
 * its JSON text).
 */
function libraryDropTransfer(): VSCodeDataTransfer {
  const file = 'file:///c%3A/Users/gerhard/proj/.erd-studio/silver/tables/silver/dim_location.dbml';
  return new VSCodeDataTransfer([
    [TABLE_LIBRARY_DRAG_MIME, new vscode.DataTransferItem('{"id":"erdStudio.modelLibrary","itemHandles":["1/erdStudio.modelLibrary.folder:silver/tables/silver/0:dim_location"]}')],
    [TABLE_LIBRARY_DRAG_MIME, new vscode.DataTransferItem('["dim_location"]')],
    ['text/uri-list', new vscode.DataTransferItem(file)],
  ]);
}

describe('REPRO gerhard-feedback-3: Table Library rows dropped on a Diagrams row', () => {
  const diagram: TreeElement = {
    type: 'domain',
    summary: { domain: 'ttt', layer: 'silver', filePath: '/p/.erd-studio/silver/diagrams/ttt.dbml' } as never,
    modelCount: 0,
  };

  it('adds the dragged table to that diagram (today: nothing happens, nothing is said)', async () => {
    const provider = new SubjectAreaTreeProvider({} as never, {} as never, '/p');
    const added: Array<[string, string[]]> = [];
    provider.setTablesDropHandler(async (filePath, tables) => { added.push([filePath, tables]); });
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const error = vi.spyOn(vscode.window, 'showErrorMessage');

    await provider.handleDrop(diagram, libraryDropTransfer() as never, {} as never);

    expect(added).toEqual([['/p/.erd-studio/silver/diagrams/ttt.dbml', ['dim_location']]]);
    info.mockRestore();
    error.mockRestore();
  });
});

describe('REPRO gerhard-feedback-3: Add to Diagram… with a diagram open', () => {
  const SEM = '/p/.erd-studio';
  const summaries: SubjectAreaSummary[] = [
    { domain: 'sales', layer: 'gold', filePath: `${SEM}/gold/diagrams/sales.dbml`, storage: 'dbml' } as SubjectAreaSummary,
    { domain: 'staging', layer: 'silver', filePath: `${SEM}/silver/diagrams/staging.dbml`, storage: 'dbml' } as SubjectAreaSummary,
  ];

  it('adds to the open diagram without asking (today: a pick of every diagram)', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async () => undefined) as never);
    const addTables = vi.fn(async () => undefined);
    await addToDiagramCommand({
      listSubjectAreas: () => summaries,
      memberNames: () => [],
      layerLabel: (id) => id,
      addTables,
      activeDiagramPath: () => `${SEM}/silver/diagrams/staging.dbml`,
    }, ['dim_location']);
    expect(pick).not.toHaveBeenCalled();
    expect(addTables).toHaveBeenCalledWith(`${SEM}/silver/diagrams/staging.dbml`, ['dim_location']);
    pick.mockRestore();
  });
});
