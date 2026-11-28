/**
 * #335: New Table, Move Table, Move Diagram to Layer, a move in the Explorer
 * and Go to Table never show an exception's own text. A failure that is
 * ERD Studio's says so, offers Send Feedback (the exception goes in its
 * prefill, redacted) and records `commandFailedOurs` once; a refusal written
 * for the user keeps its own words and records nothing; VS Code not applying
 * the edit says what that usually means, with Try Again; a diagram that could
 * not be read offers Show File and Try Again.
 *
 * Each planner is made to throw through a mocked `dbmlLifecycle`, so the rule
 * is pinned at every site rather than for one exception's wording.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { DbmlEditRefused } from '@erd-studio/core/dbml';

import { UnsavedFilesRefused } from '../../src/services/fileWrites';
import { telemetry } from '../../src/services/telemetryService';

/** What each mocked planner does: throw this, or (undefined) plan as usual. */
const planners = vi.hoisted(() => ({
  tableMoves: undefined as unknown,
  diagramMove: undefined as unknown,
  explorer: undefined as unknown,
  explorerCalls: 0,
}));

vi.mock('../../src/commands/dbmlLifecycle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/commands/dbmlLifecycle')>();
  return {
    ...real,
    planDbmlTableMoves: ((input: never) => {
      if (planners.tableMoves === 'plan') {
        // The table's own file moves, and nothing else changes: no question is asked.
        const { moves } = input as { moves: Array<{ filePath: string; toLayer: string; toSchema: string }> };
        const semanticRoot = moves[0].filePath.split('/.erd-studio/')[0] + '/.erd-studio';
        return {
          writes: [
            { kind: 'create', path: `${semanticRoot}/${moves[0].toLayer}/tables/${moves[0].toSchema}/fct_order.dbml`, text: 'Table x {\n}\n' },
            { kind: 'delete', path: moves[0].filePath },
          ],
          requalified: [],
        };
      }
      if (planners.tableMoves !== undefined) throw planners.tableMoves;
      return real.planDbmlTableMoves(input);
    }) as typeof real.planDbmlTableMoves,
    planDbmlDiagramLayerMove: ((input: never) => {
      if (planners.diagramMove !== undefined) throw planners.diagramMove;
      return real.planDbmlDiagramLayerMove(input);
    }) as typeof real.planDbmlDiagramLayerMove,
    planDbmlExplorerMoves: ((input: never) => {
      planners.explorerCalls++;
      if (planners.explorer === 'update') {
        return { kind: 'update', writes: [{ kind: 'replace', path: '/x/.erd-studio/gold/diagrams/sales.dbml', text: 'x' }], moved: [(input as { moves: unknown[] }).moves[0]], tableRenames: [], others: ['a'] };
      }
      if (planners.explorer !== undefined) throw planners.explorer;
      return real.planDbmlExplorerMoves(input);
    }) as typeof real.planDbmlExplorerMoves,
  };
});

import { createDbmlTable, type NewTableDeps } from '../../src/commands/newTable';
import { moveDbmlDiagram, moveDbmlTables, type MoveDbmlDeps } from '../../src/commands/moveDbml';
import { onDbmlFilesRenamed, type ExplorerMoveDeps } from '../../src/commands/explorerMoves';
import { goToTableCommand, type GoToTableDeps, type GoToTableItem } from '../../src/commands/goToTable';

const BOOM = 'boom /Users/someone/secret/project/.erd-studio/gold/tables/sales/fct_order.dbml';

let root: string;
let ws: string;
let sem: string;
let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
let exec: ReturnType<typeof vi.spyOn>;
let recorded: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-335-'));
  ws = path.join(root, 'project');
  sem = path.join(ws, '.erd-studio');
  fs.mkdirSync(path.join(sem, 'gold', 'tables', 'sales'), { recursive: true });
  fs.mkdirSync(path.join(sem, 'gold', 'diagrams'), { recursive: true });
  fs.writeFileSync(path.join(sem, 'gold', 'tables', 'sales', 'fct_order.dbml'), 'Table sales.fct_order {\n  id int\n}\n');
  fs.writeFileSync(path.join(sem, 'gold', 'diagrams', 'sales.dbml'), "use * from '../tables/sales/fct_order.dbml'\n");
  planners.tableMoves = undefined;
  planners.diagramMove = undefined;
  planners.explorer = undefined;
  planners.explorerCalls = 0;
  vscode.window.tabGroups.all = [];
  vscode._resetMockConfiguration();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  warnings = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
  recorded = vi.spyOn(telemetry, 'error');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every toast's text: errors and warnings. */
function toasts(): string[] {
  return [...errors.mock.calls, ...warnings.mock.calls].map((c) => String(c[0]));
}

/** The one error toast's message and buttons. */
function onlyError(): { message: string; buttons: string[] } {
  expect(errors).toHaveBeenCalledTimes(1);
  const [message, ...rest] = errors.mock.calls[0] as unknown[];
  return { message: String(message), buttons: rest.filter((b): b is string => typeof b === 'string') };
}

/** The `commandFailedOurs` records so far. */
function oursCount(): number {
  return recorded.mock.calls.filter((c) => c[0] === 'commandFailedOurs').length;
}

/** Choose `button` on the first error toast. */
async function choose(button: string): Promise<void> {
  errors.mockResolvedValueOnce(button as never);
}

/** Send Feedback's prefill, once the button ran. */
async function feedbackSent(): Promise<{ title: string; description: string }> {
  await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.reportBug', expect.anything()));
  const call = exec.mock.calls.find((c) => c[0] === 'erdStudio.reportBug')!;
  return call[1] as { title: string; description: string };
}

function newTableDeps(over: Partial<NewTableDeps> = {}): NewTableDeps {
  return {
    workspaceRoot: ws,
    semanticRoot: sem,
    tableLibraryService: {
      listTableFiles: () => [],
      listDbmlLayerFolders: () => ['gold'],
      tableTakingName: () => undefined,
      planDbmlBatch: () => { throw new Error(BOOM); },
    } as unknown as NewTableDeps['tableLibraryService'],
    storage: () => 'dbml',
    layers: () => [{ id: 'gold', label: 'Gold' }],
    readText: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null),
    dirtyFiles: () => [],
    applyWrites: async () => ({ ok: true, unsaved: [], unrestored: [] }),
    afterCreated: async () => undefined,
    show: async () => undefined,
    ...over,
  };
}

function moveDeps(over: Partial<MoveDbmlDeps> = {}): MoveDbmlDeps {
  return {
    workspaceRoot: ws,
    semanticRoot: sem,
    tableLibraryService: {
      listTableFiles: () => [],
      planDbmlLibraryOps: () => { throw new Error('not planned here'); },
      getTablesDir: () => path.join(sem, 'tables'),
      listDbmlDiagrams: () => [path.join(sem, 'gold', 'diagrams', 'sales.dbml')],
      listDbmlLayerFolders: () => ['gold', 'silver'],
    } as unknown as MoveDbmlDeps['tableLibraryService'],
    layers: () => [{ id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }],
    readText: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null),
    dirtyFiles: () => [],
    applyWrites: async () => ({ ok: true, unsaved: [], unrestored: [] }),
    afterTablesMoved: async () => undefined,
    afterDiagramMoved: async () => undefined,
    ...over,
  };
}

const orderTable = (): { name: string; filePath: string; layer: string; folder: string } => ({
  name: 'fct_order', filePath: path.join(sem, 'gold', 'tables', 'sales', 'fct_order.dbml'), layer: 'gold', folder: 'sales',
});
const salesDiagram = (): string => path.join(sem, 'gold', 'diagrams', 'sales.dbml');

/** The rule every "ours" site holds to. */
async function expectOurs(title: string, buttons: string[], doing: RegExp): Promise<void> {
  const { message, buttons: shown } = onlyError();
  expect(message).not.toContain('boom');
  expect(message).toMatch(new RegExp(`^${title} hit a problem in ERD Studio `));
  expect(message).toMatch(doing);
  expect(message).toMatch(/This isn't something you did\. Please send us a report\.$/);
  expect(shown).toEqual(buttons);
  expect(oursCount()).toBe(1);
}

describe('#335 table 1: a failure that is ours never shows the raw exception', () => {
  it('New Table: the planner throws', async () => {
    await choose('Send Feedback');
    expect(await createDbmlTable(newTableDeps(), { layer: 'gold', schema: 'sales' }, 'dim_new')).toBeUndefined();
    await expectOurs('New Table', ['Send Feedback', 'Try Again'],
      /^New Table hit a problem in ERD Studio while working out the new table's file, so nothing was created\./);
    const prefill = await feedbackSent();
    expect(prefill.title).toBe('New Table failed');
    expect(prefill.description).toContain('boom');
    // Redacted: the report never carries the user's folders.
    expect(prefill.description).not.toContain('/Users/someone');
  });

  it('New Table: the plan names no file (the same failure)', async () => {
    const deps = newTableDeps({
      tableLibraryService: {
        listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
        planDbmlBatch: () => ({ writes: [], plan: { createdTablePaths: [], resolveTable: () => undefined } }),
      } as unknown as NewTableDeps['tableLibraryService'],
    });
    await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
    await expectOurs('New Table', ['Send Feedback', 'Try Again'], /while working out the new table's file, so nothing was created\./);
  });

  it('New Table: Try Again creates it with the same name, in the same schema', async () => {
    let calls = 0;
    const planned: string[] = [];
    const deps = newTableDeps({
      tableLibraryService: {
        listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
        planDbmlBatch: (input: { ops: { save: Array<{ model: { name: string }; home: { schema: string } }> } }) => {
          calls++;
          planned.push(`${input.ops.save[0].home.schema}.${input.ops.save[0].model.name}`);
          if (calls === 1) throw new Error(BOOM);
          return { writes: [], plan: { createdTablePaths: ['gold/tables/sales/dim_new.dbml'], resolveTable: () => undefined } };
        },
      } as unknown as NewTableDeps['tableLibraryService'],
    });
    await choose('Try Again');
    await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(planned).toEqual(['sales.dim_new', 'sales.dim_new']);
  });

  it('Move Table: the planner throws', async () => {
    planners.tableMoves = new Error(BOOM);
    await choose('Send Feedback');
    expect(await moveDbmlTables(moveDeps(), [orderTable()], { layer: 'silver', schema: 'calendar' })).toBe(false);
    await expectOurs('Move Table', ['Send Feedback', 'Try Again'],
      /^Move Table hit a problem in ERD Studio while working out which files to change, so nothing was moved\./);
    expect((await feedbackSent()).description).toContain('boom');
  });

  it('Move Diagram to Layer: the planner throws', async () => {
    planners.diagramMove = new Error(BOOM);
    expect(await moveDbmlDiagram(moveDeps(), salesDiagram(), 'silver')).toBeUndefined();
    await expectOurs('Move Diagram to Layer', ['Send Feedback', 'Try Again'],
      /^Move Diagram to Layer hit a problem in ERD Studio while working out which files to change, so nothing was moved\./);
  });

  it('Go to Table: opening the picked table throws', async () => {
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const qp = {
      items: [] as GoToTableItem[], activeItems: [] as GoToTableItem[], selectedItems: [] as GoToTableItem[], value: '', title: '', shown: false,
      show() { qp.shown = true; }, hide() { listeners.hide?.(); }, dispose() {},
      onDidAccept(fn: () => void) { listeners.accept = fn; return { dispose() {} }; },
      onDidTriggerItemButton(fn: () => void) { listeners.button = fn; return { dispose() {} }; },
      onDidHide(fn: () => void) { listeners.hide = fn; return { dispose() {} }; },
      onDidChangeValue(fn: () => void) { listeners.value = fn; return { dispose() {} }; },
    };
    const deps: GoToTableDeps = {
      listTableFiles: () => [{ name: 'fct_order', filePath: orderTable().filePath, storage: 'dbml', layer: 'gold', folder: 'sales' } as never],
      tableHomes: () => new Map([['fct_order', { layer: 'gold', schema: 'sales' }]]),
      listSubjectAreas: () => [],
      memberNames: () => [],
      layerLabel: (l) => l,
      peekDetails: () => ({}),
      openInDiagram: async () => { throw new Error(BOOM); },
      openFile: async () => undefined,
      showRelationships: async () => undefined,
      createQuickPick: () => qp as unknown as vscode.QuickPick<GoToTableItem>,
    };
    const done = goToTableCommand(deps);
    await vi.waitFor(() => expect(qp.shown).toBe(true));
    qp.selectedItems = [qp.items[0]];
    listeners.accept?.();
    await done;
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    await expectOurs('Go to Table', ['Send Feedback'],
      /^Go to Table hit a problem in ERD Studio while opening that table, so nothing was opened\./);
  });
});

describe('#335: a refusal written for the user keeps its words and records nothing', () => {
  it('Move Table', async () => {
    planners.tableMoves = new DbmlEditRefused('gold/relationships/gold.dbml', 'The Ref on line 3 names a column the table does not have.', 3);
    await moveDbmlTables(moveDeps(), [orderTable()], { layer: 'silver', schema: 'calendar' });
    expect(onlyError().message).toBe('Move Table: The Ref on line 3 names a column the table does not have. Nothing was moved.');
    expect(oursCount()).toBe(0);
  });

  it('Move Diagram to Layer', async () => {
    planners.diagramMove = new DbmlEditRefused('gold/diagrams/sales.dbml', 'A use line names a file that is not there.');
    await moveDbmlDiagram(moveDeps(), salesDiagram(), 'silver');
    expect(onlyError().message).toBe('Move Diagram to Layer: A use line names a file that is not there. Nothing was moved.');
    expect(oursCount()).toBe(0);
  });

  it('New Table: a diagram it would change has unsaved edits, said by its name, not counted as ours', async () => {
    const dirty = path.join(sem, 'gold', 'diagrams', 'sales.dbml');
    const deps = newTableDeps({
      tableLibraryService: {
        listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
        planDbmlBatch: () => { throw new UnsavedFilesRefused([dirty]); },
      } as unknown as NewTableDeps['tableLibraryService'],
    });
    await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
    expect(onlyError().message).toBe('New Table: .erd-studio/gold/diagrams/sales.dbml has unsaved changes. Save or revert it, then try again. Nothing was created.');
    expect(oursCount()).toBe(0);
  });
});

describe("#335 table 2: VS Code didn't accept the edit", () => {
  it('New Table: says what that usually means, offers Try Again then Send Feedback, records no ours', async () => {
    const applied: number[] = [];
    const deps = newTableDeps({
      tableLibraryService: {
        listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
        planDbmlBatch: () => ({
          writes: [{ kind: 'create', path: path.join(sem, 'gold', 'tables', 'sales', 'dim_new.dbml'), text: 'Table sales.dim_new {\n}\n' }],
          plan: { createdTablePaths: ['gold/tables/sales/dim_new.dbml'], resolveTable: () => undefined },
        }),
      } as unknown as NewTableDeps['tableLibraryService'],
      applyWrites: async () => { applied.push(1); return { ok: applied.length > 1, unsaved: [], unrestored: [] }; },
    });
    await choose('Try Again');
    await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
    const first = errors.mock.calls[0] as unknown[];
    expect(first[0]).toBe("New Table: VS Code didn't accept the new file, so nothing was created. This is usually a file another program has open or a folder you can't write to.");
    expect(first.slice(1)).toEqual(['Try Again', 'Send Feedback']);
    expect(oursCount()).toBe(0);
    // Try Again runs it again, with the same name in the same schema.
    await vi.waitFor(() => expect(applied).toHaveLength(2));
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    "New Table: when the schema folder can't be written, the toast says that and asks for no report", async () => {
      const folder = path.join(sem, 'gold', 'tables', 'sales');
      fs.mkdirSync(folder, { recursive: true });
      fs.chmodSync(folder, 0o555);
      try {
        const deps = newTableDeps({
          tableLibraryService: {
            listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
            planDbmlBatch: () => ({
              writes: [{ kind: 'create', path: path.join(folder, 'dim_new.dbml'), text: 'Table sales.dim_new {\n}\n' }],
              plan: { createdTablePaths: ['gold/tables/sales/dim_new.dbml'], resolveTable: () => undefined },
            }),
          } as unknown as NewTableDeps['tableLibraryService'],
          applyWrites: async () => ({ ok: false, unsaved: [], unrestored: [] }),
        });
        await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
        const { message, buttons } = onlyError();
        expect(message).toBe("New Table: ERD Studio isn't allowed to write to .erd-studio/gold/tables/sales, so nothing was created. Check its permissions, then try again.");
        expect(buttons).toEqual(['Show Folder', 'Try Again']);
        expect(oursCount()).toBe(0);
      } finally {
        fs.chmodSync(folder, 0o755);
      }
    });

  it('Move Table: a planner that hits a file it may not open says so, with no Send Feedback and nothing counted as ours', async () => {
    planners.tableMoves = Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES', path: orderTable().filePath });
    await moveDbmlTables(moveDeps(), [orderTable()], { layer: 'silver', schema: 'sales' });
    const { message, buttons } = onlyError();
    expect(message).toBe("Move Table: ERD Studio isn't allowed to open .erd-studio/gold/tables/sales/fct_order.dbml, so nothing was moved. Check its permissions, then try again.");
    expect(buttons).toEqual(['Show File', 'Try Again']);
    expect(oursCount()).toBe(0);
  });

  it("New Table: Send Feedback's report says what happened, with no undefined in it", async () => {
    const deps = newTableDeps({
      tableLibraryService: {
        listTableFiles: () => [], listDbmlLayerFolders: () => ['gold'], tableTakingName: () => undefined,
        planDbmlBatch: () => ({ writes: [], plan: { createdTablePaths: ['gold/tables/sales/dim_new.dbml'], resolveTable: () => undefined } }),
      } as unknown as NewTableDeps['tableLibraryService'],
      applyWrites: async () => ({ ok: false, unsaved: [], unrestored: [] }),
    });
    await choose('Send Feedback');
    await createDbmlTable(deps, { layer: 'gold', schema: 'sales' }, 'dim_new');
    const prefill = await feedbackSent();
    expect(prefill.description).toBe('New Table hit a problem while applying the new file.\n\nError: VS Code did not apply the edit (applyEdit returned false).');
    expect(oursCount()).toBe(0);
  });

  it('Move Table', async () => {
    planners.tableMoves = 'plan';
    await moveDbmlTables(moveDeps({ applyWrites: async () => ({ ok: false, unsaved: [], unrestored: [] }) }), [orderTable()], { layer: 'silver', schema: 'calendar' });
    const { message, buttons } = onlyError();
    expect(message).toBe("Move Table: VS Code didn't accept the move, so nothing was changed. This is usually a file another program has open or a folder you can't write to.");
    expect(buttons).toEqual(['Try Again', 'Send Feedback']);
    expect(oursCount()).toBe(0);
  });

  it('Move Diagram to Layer', async () => {
    await moveDbmlDiagram(moveDeps({ applyWrites: async () => ({ ok: false, unsaved: [], unrestored: [] }) }), salesDiagram(), 'silver');
    const { message, buttons } = onlyError();
    expect(message).toBe("Move Diagram to Layer: VS Code didn't accept the move, so nothing was changed. This is usually a file another program has open or a folder you can't write to.");
    expect(buttons).toEqual(['Try Again', 'Send Feedback']);
    expect(oursCount()).toBe(0);
  });

  it('nothing is said here when the reconcile already named a file it could not put back', async () => {
    await moveDbmlDiagram(moveDeps({ applyWrites: async () => ({ ok: false, unsaved: [], unrestored: ['/x'] }) }), salesDiagram(), 'silver');
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('#335 table 3: a diagram that could not be read', () => {
  it('Move Diagram to Layer: Show File and Try Again, nothing counted', async () => {
    let reads = 0;
    const deps = moveDeps({ readText: (p) => (++reads === 1 ? null : fs.readFileSync(p, 'utf-8')) });
    await choose('Show File');
    await moveDbmlDiagram(deps, salesDiagram(), 'silver');
    const { message, buttons } = onlyError();
    expect(message).toBe('Move Diagram to Layer: .erd-studio/gold/diagrams/sales.dbml could not be read, so nothing was moved. Check the file still exists and that VS Code can open it.');
    expect(buttons).toEqual(['Show File', 'Try Again']);
    expect(oursCount()).toBe(0);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('revealFileInOS', expect.objectContaining({ fsPath: salesDiagram() })));
  });
});

describe('#335: a move in the Explorer', () => {
  /** The listener's deps over the temp project, moving fct_order.dbml to silver. */
  function explorerDeps(over: Partial<ExplorerMoveDeps> = {}): { deps: ExplorerMoveDeps; renames: Array<{ from: string; to: string }> } {
    const from = orderTable().filePath;
    const to = path.join(sem, 'silver', 'tables', 'calendar', 'fct_order.dbml');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    const renames: Array<{ from: string; to: string }> = [];
    const deps: ExplorerMoveDeps = {
      workspaceRoot: ws,
      semanticRoot: sem,
      tableLibraryService: { invalidateCache: () => undefined } as unknown as ExplorerMoveDeps['tableLibraryService'],
      layers: () => [{ id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }],
      storage: () => 'dbml',
      readText: () => null,
      dirtyFiles: () => [],
      takeOwnRename: () => false,
      applyWrites: async (_w, r) => { if (r) renames.push(...r); return { ok: true, unsaved: [], unrestored: [] }; },
      afterUpdated: async () => undefined,
      saveFile: async () => true,
      ...over,
    };
    return { deps, renames };
  }
  const fire = (deps: ExplorerMoveDeps): Promise<void> => onDbmlFilesRenamed(deps, [{
    oldUri: vscode.Uri.file(orderTable().filePath),
    newUri: vscode.Uri.file(path.join(sem, 'silver', 'tables', 'calendar', 'fct_order.dbml')),
  }]);

  it('the planner throws: ours, with Move It Back and Send Feedback, counted once', async () => {
    planners.explorer = new Error(BOOM);
    const { deps, renames } = explorerDeps();
    errors.mockResolvedValueOnce('Move It Back' as never);
    await fire(deps);
    expect(toasts().join('\n')).not.toContain('boom');
    const { message, buttons } = onlyError();
    expect(message).toBe("ERD Studio hit a problem while updating the files that point at fct_order.dbml, so nothing else was changed. This isn't something you did. Move it back, or send us a report.");
    expect(buttons).toEqual(['Move It Back', 'Send Feedback']);
    expect(oursCount()).toBe(1);
    // Move It Back still puts the file back.
    await vi.waitFor(() => expect(renames).toHaveLength(1));
    expect(renames[0].to).toBe(orderTable().filePath);
  });

  it('a refusal: the warning it always gave, not counted', async () => {
    planners.explorer = new DbmlEditRefused('gold/relationships/gold.dbml', 'line 3 does not read.', 3);
    const { deps } = explorerDeps();
    await fire(deps);
    expect(errors).not.toHaveBeenCalled();
    expect(String(warnings.mock.calls[0][0])).toBe('ERD Studio could not update the files that point at fct_order.dbml: line 3 does not read. Nothing else was changed.');
    expect(oursCount()).toBe(0);
  });

  it('"never": nothing said and nothing counted, even when the planner throws', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'never' });
    planners.explorer = new Error(BOOM);
    const { deps } = explorerDeps();
    await fire(deps);
    expect(toasts()).toEqual([]);
    expect(oursCount()).toBe(0);
  });

  it("VS Code didn't accept the update: Try Again plans again before it applies, and Move It Back is offered", async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    {
      planners.explorer = 'update';
      let applies = 0;
      const { deps } = explorerDeps({ applyWrites: async () => { applies++; return { ok: applies > 1, unsaved: [], unrestored: [] }; } });
      errors.mockResolvedValueOnce('Try Again' as never);
      await fire(deps);
      const first = errors.mock.calls[0] as unknown[];
      expect(first[0]).toBe("ERD Studio: VS Code didn't accept the update of the files that point at fct_order.dbml, so nothing else was changed. This is usually a file another program has open or a folder you can't write to.");
      expect(first.slice(1)).toEqual(['Try Again', 'Move It Back', 'Send Feedback']);
      expect(oursCount()).toBe(0);
      await vi.waitFor(() => expect(applies).toBe(2));
      // Planned again from the files as they are now (once at the move, once at Try Again), never the old plan's text.
      expect(planners.explorerCalls).toBe(2);
    }
  });
});
