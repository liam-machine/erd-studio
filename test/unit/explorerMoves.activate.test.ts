/**
 * Moves and renames done in the Explorer (ERD Studio 2.0, §2.8; spec M2),
 * through `activate()` on a copy of `test/fixtures/dbml-native`: the file is
 * moved on disk, then `onDidRenameFiles` fires, as VS Code does after a drag
 * and drop or an F2. Every case of the planner (a table to another schema
 * folder, a table renamed, a relationships file, a diagram, a folder, a file
 * dropped in the wrong place), the setting, the refusals, ERD Studio's own
 * moves being left alone, and a YAML/JSON project untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { OWN_FILE_OPERATION_GRACE_MS, OwnFileOperations } from '../../src/services/ownFileOperations';
import { compileDbmlProject, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: { configuration: { properties: Record<string, { type: string; enum?: string[]; default: unknown; markdownDescription: string }> } };
};

type Context = import('vscode').ExtensionContext;

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], ['erdStudio.diagramsNudgeShown', true]]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

let root: string;
let ws: string;
let context: Context;
let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let status: ReturnType<typeof vi.spyOn>;

const erd = (...p: string[]): string => path.join(ws, '.erd-studio', ...p);
const at = (rel: string): string => erd(...rel.split('/'));
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');

/** Every file under the semantic dir, posix, sorted. */
function files(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

/** Every file under the semantic dir, with its bytes. */
function bytes(): Map<string, string> {
  return new Map(files().map((f) => [f, fs.readFileSync(erd(f)).toString('base64')]));
}

/** Every `.dbml` under the semantic dir compiles from each diagram, with no diagnostic, in 9.1.1, 10.3.1 and 11.0.0. */
function compilesClean(): void {
  const texts = Object.fromEntries(files().filter((f) => f.endsWith('.dbml')).map((f) => [f, fs.readFileSync(erd(f), 'utf-8')]));
  const diagrams = Object.keys(texts).filter((f) => f.split('/')[1] === 'diagrams' && f.split('/').length === 3);
  const parsers: Array<[string, DbmlParserModule | undefined]> = [
    ['9.1.1', v9 as unknown as DbmlParserModule], ['10.3.1', v10 as unknown as DbmlParserModule], ['11.0.0', undefined],
  ];
  for (const [label, parser] of parsers) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(texts, diagrams, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}

/** Move (or rename) `from` to `to` on disk, as the Explorer does, then fire onDidRenameFiles for them. */
async function explorerMove(...pairs: Array<[string, string]>): Promise<void> {
  for (const [from, to] of pairs) {
    fs.mkdirSync(path.dirname(at(to)), { recursive: true });
    fs.renameSync(at(from), at(to));
  }
  await vscode._fireDidRenameFiles(pairs.map(([from, to]) => ({ oldUri: vscode.Uri.file(at(from)), newUri: vscode.Uri.file(at(to)) })));
}

/**
 * Edit > Undo of an update: every file's bytes back (`moved[0]`'s at `moved[1]`, where the file still
 * is until the move itself is undone), and the open documents with them, as VS Code's undo edits them.
 */
function undoUpdate(original: Map<string, string>, moved: [string, string]): void {
  for (const [f, b64] of original) fs.writeFileSync(at(f === moved[0] ? moved[1] : f), Buffer.from(b64, 'base64'));
  for (const f of files()) vscode._closeMockDocument(at(f));
}

/** Answer the question with `button` (and nothing else). */
function answer(button: string | undefined): void {
  info.mockImplementation((async (...args: unknown[]) => (button !== undefined && args.includes(button) ? button : undefined)) as never);
}

/** The questions asked (messages with Update / Always / Never). */
function questions(): string[] {
  return info.mock.calls.filter((c) => c.includes('Update') && c.includes('Always') && c.includes('Never')).map((c) => c[0] as string);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-explorer-moves-'));
  ws = path.join(root, 'project');
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode.workspace.workspaceFolders = [];
  vscode.window.tabGroups.all = [];
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnings = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  status = vi.spyOn(vscode.window, 'setStatusBarMessage');
  vi.useFakeTimers();
  fs.cpSync(DBML_NATIVE, ws, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vscode.workspace.textDocuments.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the setting', () => {
  it('is contributed: prompt (default), always or never', () => {
    const setting = packageJson.contributes.configuration.properties['erdStudio.dbml.updateReferencesOnMove'];
    expect(setting.type).toBe('string');
    expect(setting.enum).toEqual(['prompt', 'always', 'never']);
    expect(setting.default).toBe('prompt');
    expect(setting.markdownDescription).toMatch(/Explorer/);
  });
});

describe('a table file moved to another schema folder', () => {
  it('asks once, then makes every use line and Ref end follow and re-qualifies the table, in ONE edit (Move Table\'s result)', async () => {
    await activate(context);
    answer('Update');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/crm/fct_order.dbml']);

    expect(errors).not.toHaveBeenCalled();
    expect(questions()).toEqual(['Update the 3 ERD Studio files that point at fct_order.dbml?']);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('silver/tables/crm/fct_order.dbml')).toMatch(/^Table crm\.fct_order \[/m);
    expect(read('silver/tables/crm/fct_order.dbml')).toContain('// Order lines from the shop.');
    const goldRels = read('gold/relationships/gold.dbml');
    expect(goldRels).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/crm\/fct_order\.dbml'$/m);
    expect(goldRels).toContain('Ref: crm.fct_order.customer_key >? gold.dim_customer.customer_key');
    expect(goldRels).not.toMatch(/gold\.fct_order/);
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/crm\/fct_order\.dbml'$/m);
    expect(read('silver/diagrams/staging.dbml')).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/tables\/crm\/fct_order\.dbml'$/m);
    expect(read('gold/diagrams/sales.dbml')).toContain('    fct_order 400 200\n');
    expect(status).toHaveBeenCalledWith('ERD Studio: Updated 3 files that point at fct_order.dbml.', 5000);
    compilesClean();
  });

  it('with "always": updates without asking', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(read('silver/tables/calendar/fct_order.dbml')).toMatch(/^Table calendar\.fct_order \[/m);
    expect(read('silver/diagrams/staging.dbml')).toMatch(/^use \{ table calendar\.fct_order \} +from '\.\.\/tables\/calendar\/fct_order\.dbml'$/m);
    compilesClean();
  });

  it('with "never": asks nothing and changes nothing else', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { workspaceValue: 'never' });
    await activate(context);
    const before = read('gold/relationships/gold.dbml');
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    expect(read('gold/relationships/gold.dbml')).toBe(before);
  });

  it.each([
    ['Never', 'never'],
    ['Always', 'always'],
  ])('%s writes the setting (user scope); Always updates too', async (button, value) => {
    await activate(context);
    answer(button);
    const before = read('gold/relationships/gold.dbml');
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(vscode.workspace.getConfiguration('erdStudio').inspect('dbml.updateReferencesOnMove')).toMatchObject({ globalValue: value });
    if (value === 'never') expect(read('gold/relationships/gold.dbml')).toBe(before);
    else expect(read('gold/relationships/gold.dbml')).toContain("from '../../silver/tables/calendar/fct_order.dbml'");
  });

  it('dismissed: nothing else changes', async () => {
    await activate(context);
    answer(undefined);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    const after = bytes();
    expect(questions()).toHaveLength(1);
    expect(after.get('gold/relationships/gold.dbml')).toBe(Buffer.from(fs.readFileSync(path.join(DBML_NATIVE, '.erd-studio', 'gold', 'relationships', 'gold.dbml'))).toString('base64'));
  });

  it('several files moved at once: one question, one edit', async () => {
    await activate(context);
    answer('Update');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(
      ['gold/tables/gold/dim_customer.dbml', 'gold/tables/crm/dim_customer.dbml'],
      ['gold/tables/gold/customer_profile.dbml', 'gold/tables/crm/customer_profile.dbml'],
    );
    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatch(/^Update the \d+ ERD Studio files that point at the 2 moved files\?$/);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('gold/relationships/customers.dbml')).toContain('Ref: crm.dim_customer.customer_key ?- crm.customer_profile.customer_key');
    compilesClean();
  });

  it('a file that does not read: a warning naming it, nothing else changed, and Move It Back', async () => {
    fs.appendFileSync(at('gold/relationships/gold.dbml'), 'Ref: gold.fct_order.customer_key >\n');
    await activate(context);
    const before = read('gold/relationships/gold.dbml');
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Move It Back') ? 'Move It Back' : undefined)) as never);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(String(warnings.mock.calls[0][0])).toMatch(/^ERD Studio could not update the files that point at fct_order\.dbml: .*gold\/relationships\/gold\.dbml.* Nothing else was changed\.$/);
    await vi.waitFor(() => expect(fs.existsSync(at('gold/tables/gold/fct_order.dbml'))).toBe(true));
    expect(fs.existsSync(at('silver/tables/calendar/fct_order.dbml'))).toBe(false);
    expect(read('gold/relationships/gold.dbml')).toBe(before);
    // Moving it back is ERD Studio's own move: no question about it.
    expect(questions()).toEqual([]);
  });

  it('a file it would change with unsaved edits: refuses, naming it, until Try Again', async () => {
    await activate(context);
    answer('Update');
    const staging = at('silver/diagrams/staging.dbml');
    const dirty = { uri: vscode.Uri.file(staging), isDirty: true, getText: () => fs.readFileSync(staging, 'utf-8') };
    vscode.workspace.textDocuments.push(dirty);
    let tries = 0;
    errors.mockImplementation((async () => {
      tries++;
      if (tries === 1) {
        vscode.workspace.textDocuments.splice(vscode.workspace.textDocuments.indexOf(dirty), 1);
        return 'Try Again';
      }
      return undefined;
    }) as never);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(errors).toHaveBeenCalledWith('ERD Studio could not update the files that point at fct_order.dbml: .erd-studio/silver/diagrams/staging.dbml has unsaved changes. Save or revert it, then choose Try Again.', 'Try Again');
    expect(tries).toBe(1);
    expect(read('silver/diagrams/staging.dbml')).toMatch(/^use \{ table calendar\.fct_order \} +from '\.\.\/tables\/calendar\/fct_order\.dbml'$/m);
    compilesClean();
  });
});

describe('a table file renamed', () => {
  it('renames the table everywhere, as the canvas does: Ref ends, use lines, positions and sticky notes', async () => {
    await activate(context);
    answer('Update');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct_orders.dbml']);
    expect(errors).not.toHaveBeenCalled();
    expect(questions()).toEqual(['Rename table fct_order to fct_orders everywhere (4 files)? Its file\'s name is the table\'s name.']);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('gold/tables/gold/fct_orders.dbml')).toMatch(/^Table gold\.fct_orders \[/m);
    const goldRels = read('gold/relationships/gold.dbml');
    expect(goldRels).toMatch(/^use \{ table gold\.fct_orders \} +from '\.\.\/tables\/gold\/fct_orders\.dbml'$/m);
    expect(goldRels).toContain('Ref: gold.fct_orders.customer_key >? gold.dim_customer.customer_key');
    expect(goldRels).not.toMatch(/fct_order\b/);
    const sales = read('gold/diagrams/sales.dbml');
    expect(sales).toMatch(/^use \{ table gold\.fct_orders \} +from '\.\.\/tables\/gold\/fct_orders\.dbml'$/m);
    expect(sales).toContain('    fct_orders 400 200\n');
    expect(sales).toContain("linked_table: 'fct_orders'");
    expect(read('silver/diagrams/staging.dbml')).toMatch(/^use \{ table gold\.fct_orders \} +from '\.\.\/\.\.\/gold\/tables\/gold\/fct_orders\.dbml'$/m);
    compilesClean();
  });

  it.each([
    ['not a table name', 'gold/tables/gold/fct-order.dbml', /"fct-order" is not a table name\./],
    ['another table\'s name', 'gold/tables/gold/dim_date.dbml', /the table "dim_date" already has that name/],
    ['the same name in other case', 'gold/tables/gold/FCT_ORDER.dbml', /differs from "fct_order" only in upper\/lower case/],
    ['renamed and moved at once', 'silver/tables/calendar/fct_orders.dbml', /renamed and moved in one step/],
  ])('%s: renames nothing, warns, and Rename File Back puts the file back', async (_label, to, why) => {
    await activate(context);
    const before = bytes();
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Rename File Back') ? 'Rename File Back' : undefined)) as never);
    await explorerMove(['gold/tables/gold/fct_order.dbml', to]);
    expect(questions()).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(String(warnings.mock.calls[0][0])).toMatch(/^A table file's name is its table's name, so .* would rename the table fct_order to /);
    expect(String(warnings.mock.calls[0][0])).toMatch(why);
    await vi.waitFor(() => expect(bytes()).toEqual(before));
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe('a relationships file or a diagram moved or renamed', () => {
  it('a relationships file to another layer: its own use lines and every diagram\'s use * line follow', async () => {
    await activate(context);
    answer('Update');
    await explorerMove(['gold/relationships/customers.dbml', 'silver/relationships/customers.dbml']);
    expect(questions()).toEqual(['Update the 1 ERD Studio file that points at customers.dbml?']);
    expect(read('silver/relationships/customers.dbml')).toMatch(/^use \{ table gold\.dim_customer \} +from '\.\.\/\.\.\/gold\/tables\/gold\/dim_customer\.dbml'$/m);
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \* from '\.\.\/\.\.\/silver\/relationships\/customers\.dbml'$/m);
    compilesClean();
  });

  it('a diagram to another layer: its own use lines are re-derived (Move Diagram to Layer\'s result)', async () => {
    await activate(context);
    answer('Update');
    await explorerMove(['gold/diagrams/sales.dbml', 'silver/diagrams/sales.dbml']);
    expect(questions()).toEqual(['Update sales.dbml for its new place?']);
    const moved = read('silver/diagrams/sales.dbml');
    expect(moved).toMatch(/^use \{ table gold\.fct_order \} +from '\.\.\/\.\.\/gold\/tables\/gold\/fct_order\.dbml'$/m);
    expect(moved).toMatch(/^use \{ table calendar\.dim_date \} +from '\.\.\/tables\/calendar\/dim_date\.dbml'$/m);
    expect(moved).toMatch(/^use \* from '\.\.\/relationships\/calendar\.dbml'$/m);
    expect(moved).toContain('Project sales {');
    compilesClean();
  });

  it('a diagram renamed: its Project name follows', async () => {
    await activate(context);
    answer('Update');
    await explorerMove(['gold/diagrams/sales.dbml', 'gold/diagrams/sales_2026.dbml']);
    expect(questions()).toEqual(['Update sales_2026.dbml for its new name?']);
    expect(read('gold/diagrams/sales_2026.dbml')).toContain('Project sales_2026 {');
    compilesClean();
  });

  it('a diagram renamed to a name that is not a diagram name: nothing to do, nothing asked', async () => {
    await activate(context);
    const before = read('gold/diagrams/sales.dbml');
    await explorerMove(['gold/diagrams/sales.dbml', 'gold/diagrams/SalesReport.dbml']);
    expect(questions()).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    expect(read('gold/diagrams/SalesReport.dbml')).toBe(before);
  });
});

describe('a folder renamed or moved', () => {
  it('a schema folder: every table in it follows, in one question and one edit', async () => {
    await activate(context);
    answer('Update');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['gold/tables/gold', 'gold/tables/finance']);
    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatch(/^Update the \d+ ERD Studio files that point at the 5 moved files\?$/);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('gold/tables/finance/fct_order.dbml')).toMatch(/^Table finance\.fct_order \[/m);
    expect(read('gold/relationships/gold.dbml')).toContain('Ref: finance.fct_order.customer_key >? finance.dim_customer.customer_key');
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \{ table finance\.fct_order \} +from '\.\.\/tables\/finance\/fct_order\.dbml'$/m);
    compilesClean();
  });

  it('a layer folder: every file in it follows, and the message says layers.json still lists the old layer', async () => {
    await activate(context);
    answer('Update');
    await explorerMove(['silver', 'bronze']);
    expect(questions()).toHaveLength(1);
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \{ table calendar\.dim_date \} +from '\.\.\/\.\.\/bronze\/tables\/calendar\/dim_date\.dbml'$/m);
    expect(read('gold/diagrams/sales.dbml')).toMatch(/^use \* from '\.\.\/\.\.\/bronze\/relationships\/calendar\.dbml'$/m);
    expect(read('gold/relationships/gold.dbml')).toContain("from '../../bronze/tables/calendar/dim_date.dbml'");
    expect(read('bronze/diagrams/staging.dbml')).toMatch(/^use \{ table gold\.fct_order \} +from '\.\.\/\.\.\/gold\/tables\/gold\/fct_order\.dbml'$/m);
    expect(read('layers.json')).toContain('"id": "silver"');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/ layers\.json still lists the layer "silver", not "bronze": change its id there so the diagrams in bronze\/ open\.$/));
    compilesClean();
  });
});

describe('a file dropped where ERD Studio does not read its kind', () => {
  it('changes nothing, says where it belongs, and Move It Back puts it back', async () => {
    await activate(context);
    const before = bytes();
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Move It Back') ? 'Move It Back' : undefined)) as never);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(
      'fct_order.dbml is now in gold/diagrams/, where ERD Studio does not read a table file: table files live in <layer>/tables/<schema>/. The files that point at it were left as they are; move it back, or into a <layer>/tables/<schema>/ folder, and they follow.',
      'Move It Back',
    );
    await vi.waitFor(() => expect(bytes()).toEqual(before));
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe("ERD Studio's own moves", () => {
  it('Move Table… is not followed a second time (nor asked about), even when VS Code reports its files', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver › calendar')) as never);
    info.mockImplementation((async (...args: unknown[]) => (args.includes('Move') ? 'Move' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.moveTable', vscode.Uri.file(at('gold/tables/gold/fct_order.dbml')));
    expect(errors).not.toHaveBeenCalled();
    const after = bytes();
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode._fireDidRenameFiles([{ oldUri: vscode.Uri.file(at('gold/tables/gold/fct_order.dbml')), newUri: vscode.Uri.file(at('silver/tables/calendar/fct_order.dbml')) }]);
    expect(questions()).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
    expect(bytes()).toEqual(after);
  });

  it('Move Diagram to Layer… likewise', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver')) as never);
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(at('gold/diagrams/sales.dbml')));
    expect(errors).not.toHaveBeenCalled();
    await vscode._fireDidRenameFiles([{ oldUri: vscode.Uri.file(at('gold/diagrams/sales.dbml')), newUri: vscode.Uri.file(at('silver/diagrams/sales.dbml')) }]);
    expect(questions()).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('a mark matches its exact rename once, while in flight and a grace after; a reverse or a repeat is the user\'s', () => {
    let now = 1_000;
    const own = new OwnFileOperations(() => now);
    const end = own.begin([{ from: '/p/a.dbml', to: '/q/a.dbml' }, { from: '/p/b.dbml', to: '/q/b.dbml' }]);
    expect(own.takeOwnRename('/p/c.dbml', '/q/c.dbml')).toBe(false);
    // The undo of ERD Studio's move is the reverse pair: never its own.
    expect(own.takeOwnRename('/q/a.dbml', '/p/a.dbml')).toBe(false);
    now += 60_000;
    expect(own.takeOwnRename('/p/a.dbml', '/q/a.dbml')).toBe(true);
    // Reported once: the same move again is the user's.
    expect(own.takeOwnRename('/p/a.dbml', '/q/a.dbml')).toBe(false);
    end();
    now += OWN_FILE_OPERATION_GRACE_MS;
    expect(own.takeOwnRename('/p/b.dbml', '/q/b.dbml')).toBe(true);
    const end2 = own.begin([{ from: '/p/d.dbml', to: '/q/d.dbml' }]);
    end2();
    now += OWN_FILE_OPERATION_GRACE_MS + 1;
    expect(own.takeOwnRename('/p/d.dbml', '/q/d.dbml')).toBe(false);
  });

  it('Move It Back, then a drag to the right folder at once: the drag is followed (only the exact rename was ERD Studio\'s)', async () => {
    await activate(context);
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Move It Back') ? 'Move It Back' : undefined)) as never);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    await vi.waitFor(() => expect(fs.existsSync(at('gold/tables/gold/fct_order.dbml'))).toBe(true));
    vi.setSystemTime(Date.now() + 2_000);
    answer('Update');
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(questions()).toEqual(['Update the 3 ERD Studio files that point at fct_order.dbml?']);
    expect(read('gold/relationships/gold.dbml')).toContain("from '../../silver/tables/calendar/fct_order.dbml'");
    compilesClean();
  });
});

describe('an undone move, or a file put back by hand, plans nothing', () => {
  it('an Explorer move updated, then both undone (the update, then the move): nothing asked, nothing written', async () => {
    const original = bytes();
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(read('gold/relationships/gold.dbml')).toContain('calendar.fct_order');
    // Edit > Undo twice: every byte back (the update), then the file moved back, which VS Code reports.
    undoUpdate(original, ['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    vi.setSystemTime(Date.now() + OWN_FILE_OPERATION_GRACE_MS + 1_000);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['silver/tables/calendar/fct_order.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(bytes()).toEqual(original);
    compilesClean();
  });

  it('Move Table… undone: the reverse rename VS Code reports is not followed (nor asked about)', async () => {
    const original = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver › calendar')) as never);
    info.mockImplementation((async (...args: unknown[]) => (args.includes('Move') ? 'Move' : args.includes('Update') ? 'Update' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.moveTable', vscode.Uri.file(at('gold/tables/gold/fct_order.dbml')));
    expect(fs.existsSync(at('silver/tables/calendar/fct_order.dbml'))).toBe(true);
    // Edit > Undo: the texts back, then the file renamed back (no grace in between).
    undoUpdate(original, ['gold/tables/gold/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['silver/tables/calendar/fct_order.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(bytes()).toEqual(original);
  });

  it('a table rename updated, then undone: nothing asked, nothing written', async () => {
    const original = bytes();
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct_orders.dbml']);
    expect(read('gold/relationships/gold.dbml')).toContain('gold.fct_orders');
    undoUpdate(original, ['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct_orders.dbml']);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['gold/tables/gold/fct_orders.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(bytes()).toEqual(original);
  });

  it('a table file dropped into diagrams/ and moved back by hand: no warning, nothing asked', async () => {
    await activate(context);
    const before = bytes();
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    await explorerMove(['gold/diagrams/fct_order.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(questions()).toEqual([]);
    expect(bytes()).toEqual(before);
  });

  it('a table file dropped into diagrams/ and then moved on to a schema folder by hand: the files that point at it follow, as promised', async () => {
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    expect(String(warnings.mock.calls[0][0])).toMatch(/and they follow\.$/);
    answer('Update');
    await explorerMove(['gold/diagrams/fct_order.dbml', 'silver/tables/calendar/fct_order.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(questions()).toEqual(['Update the 3 ERD Studio files that point at fct_order.dbml?']);
    expect(read('silver/tables/calendar/fct_order.dbml')).toMatch(/^Table calendar\.fct_order \[/m);
    compilesClean();
  });

  it('a case-only rename refused, then renamed back by hand: nothing asked, no warning', async () => {
    await activate(context);
    const before = bytes();
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/FCT_ORDER.dbml']);
    expect(String(warnings.mock.calls[0][0])).toMatch(/only in upper\/lower case/);
    await explorerMove(['gold/tables/gold/FCT_ORDER.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(questions()).toEqual([]);
    expect(bytes()).toEqual(before);
  });

  it('a rename refused (not a table name), then F2 again: the table is renamed from its declared name', async () => {
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct-order.dbml']);
    expect(String(warnings.mock.calls[0][0])).toMatch(/"fct-order" is not a table name/);
    answer('Update');
    await explorerMove(['gold/tables/gold/fct-order.dbml', 'gold/tables/gold/fct_orders.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(questions()).toEqual(['Rename table fct_order to fct_orders everywhere (4 files)? Its file\'s name is the table\'s name.']);
    expect(read('gold/tables/gold/fct_orders.dbml')).toMatch(/^Table gold\.fct_orders \[/m);
    compilesClean();
  });

  it('a rename refused (another table\'s name), then renamed straight back by hand: nothing asked, no warning', async () => {
    await activate(context);
    const before = bytes();
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/dim_date.dbml']);
    expect(String(warnings.mock.calls[0][0])).toMatch(/the table "dim_date" already has that name/);
    await explorerMove(['gold/tables/gold/dim_date.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(questions()).toEqual([]);
    expect(bytes()).toEqual(before);
  });
});

describe('several files moved at once, one of them to the wrong place', () => {
  it('names the other one too, says none was followed, and Move It Back puts every moved file back', async () => {
    await activate(context);
    const before = bytes();
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Move It Back') ? 'Move It Back' : undefined)) as never);
    await explorerMove(
      ['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml'],
      ['gold/tables/gold/dim_customer.dbml', 'gold/tables/crm/dim_customer.dbml'],
    );
    expect(questions()).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(
      'fct_order.dbml is now in gold/diagrams/, where ERD Studio does not read a table file: table files live in <layer>/tables/<schema>/. None of the 2 moved files was followed, and the files that point at them were left as they are; Move It Back puts every moved file back.',
      'Move It Back',
    );
    await vi.waitFor(() => expect(bytes()).toEqual(before));
  });

  it('two misplaced: names the second one', async () => {
    await activate(context);
    await explorerMove(
      ['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml'],
      ['gold/tables/gold/dim_customer.dbml', 'gold/diagrams/dim_customer.dbml'],
    );
    expect(String(warnings.mock.calls[0][0])).toContain(' dim_customer.dbml also landed where ERD Studio does not read it. ');
  });
});

describe('the warnings with "never"', () => {
  it('a file dropped in the wrong place is still pointed out (it changes nothing)', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'never' });
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    expect(questions()).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/^fct_order\.dbml is now in gold\/diagrams\//), 'Move It Back');
  });

  it('a layer folder renamed: layers.json\'s old id is pointed out, and nothing else is said or written', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'never' });
    await activate(context);
    const before = read('gold/diagrams/sales.dbml');
    await explorerMove(['silver', 'bronze']);
    expect(questions()).toEqual([]);
    expect(info).toHaveBeenCalledWith('layers.json still lists the layer "silver", not "bronze": change its id there so the diagrams in bronze/ open.');
    expect(read('gold/diagrams/sales.dbml')).toBe(before);
  });
});

describe('a layer folder renamed that nothing outside points into', () => {
  it('nothing to update, but layers.json\'s old id is still pointed out', async () => {
    fs.mkdirSync(erd('bronze', 'tables', 'raw'), { recursive: true });
    fs.mkdirSync(erd('bronze', 'diagrams'), { recursive: true });
    fs.writeFileSync(erd('bronze', 'tables', 'raw', 'raw_event.dbml'), 'Table raw.raw_event {\n  id INT [pk]\n}\n');
    fs.writeFileSync(erd('bronze', 'diagrams', 'landing.dbml'), "Project landing {\n  erd_schema_version: '7'\n}\n\nuse { table raw.raw_event } from '../tables/raw/raw_event.dbml'\n");
    const layers = JSON.parse(read('layers.json')) as { layers: Array<Record<string, unknown>> };
    layers.layers.unshift({ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 0 });
    fs.writeFileSync(at('layers.json'), JSON.stringify(layers, null, 2));
    await activate(context);
    const before = bytes();
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['bronze', 'landing_zone']);
    expect(questions()).toEqual([]);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('layers.json still lists the layer "bronze", not "landing_zone": change its id there so the diagrams in landing_zone/ open.');
    expect([...bytes().values()].sort()).toEqual([...before.values()].sort());
  });
});

describe('Move It Back refreshes the views', () => {
  it('the Table Library refreshes after the file is moved back (ERD Studio\'s own move, which the watchers skip)', async () => {
    const { TableLibraryTreeProvider } = await import('../../src/providers/ModelLibraryTreeProvider');
    const refresh = vi.spyOn(TableLibraryTreeProvider.prototype, 'refresh');
    await activate(context);
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Move It Back') ? 'Move It Back' : undefined)) as never);
    refresh.mockClear();
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/diagrams/fct_order.dbml']);
    await vi.waitFor(() => expect(fs.existsSync(at('gold/tables/gold/fct_order.dbml'))).toBe(true));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('names ERD Studio cannot read', () => {
  it('a layer folder renamed to a name that is not a layer id: says so, naming the folder and the rule; Rename Folder Back', async () => {
    await activate(context);
    const before = bytes();
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Rename Folder Back') ? 'Rename Folder Back' : undefined)) as never);
    await explorerMove(['silver', 'Staging']);
    expect(questions()).toEqual([]);
    expect(String(warnings.mock.calls[0][0])).toBe(
      '"Staging" cannot be a layer folder name, so ERD Studio does not read the files in Staging/. A layer folder\'s name is lower-case letters, digits, - and _, starting with a letter. The files that point at them were left as they are; rename the folder back, or give it a name that fits, and they follow.',
    );
    await vi.waitFor(() => expect(bytes()).toEqual(before));
  });

  it('a table file moved into a schema folder Move Table would refuse: not followed, Move Table\'s rule', async () => {
    await activate(context);
    answer('Update');
    const before = read('gold/relationships/gold.dbml');
    await explorerMove(['gold/tables/gold/fct_order.dbml', "gold/tables/o'brien/fct_order.dbml"]);
    expect(questions()).toEqual([]);
    expect(String(warnings.mock.calls[0][0])).toMatch(/^"o'brien" cannot be a schema folder name, so ERD Studio did not follow fct_order\.dbml into gold\/tables\/o'brien\/: .* Leave out quotes, slashes, /);
    expect(warnings.mock.calls[0][1]).toBe('Move It Back');
    expect(read('gold/relationships/gold.dbml')).toBe(before);
  });

  it('a table file whose extension is renamed to upper case: says ERD Studio reads only .dbml', async () => {
    await activate(context);
    await explorerMove(['gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct_order.DBML']);
    expect(questions()).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(
      'ERD Studio reads only files whose names end in .dbml, in lower case, so it no longer reads fct_order.DBML. The files that point at it were left as they are; rename the file back to fct_order.dbml, and they follow.',
      'Rename File Back',
    );
  });
});

describe('in a YAML/JSON project', () => {
  it('a move in the Explorer is never followed, a .dbml diagram\'s included', async () => {
    fs.rmSync(erd(), { recursive: true });
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.mkdirSync(erd('gold', 'diagrams'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'dim_a.yml'), 'name: dim_a\ncolumns: []\n');
    fs.writeFileSync(erd('gold', 'a.json'), '{"schemaVersion":5,"domain":"a","layer":"gold","logical":{"models":["dim_a"]}}\n');
    // A diagram whose use line a move would re-derive in a DBML project (diagrams are no DBML evidence).
    fs.writeFileSync(erd('gold', 'diagrams', 'x.dbml'), "Project x {\n  erd_schema_version: '7'\n}\n\nuse { table gold.t } from '../tables/gold/t.dbml'\n");
    await activate(context);
    answer('Update');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await explorerMove(['logical-models/dim_a.yml', 'logical-models/dim_b.yml'], ['gold/a.json', 'gold/b.json'], ['gold/diagrams/x.dbml', 'silver/diagrams/x.dbml']);
    expect(questions()).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
    expect(read('gold/b.json')).toContain('"dim_a"');
    expect(read('silver/diagrams/x.dbml')).toContain("from '../tables/gold/t.dbml'");
  });
});
