/**
 * New Table… and New Schema… from the Table Library (ERD Studio 2.0),
 * through `activate()` on a copy of `test/fixtures/dbml-native`: where each
 * is offered, a table made from a layer row, a schema row and the title bar
 * (`<layer>/tables/<schema>/<name>.dbml` declaring `Table <schema>.<name>`,
 * on no diagram), a new schema made with its first table, and the refusals,
 * which change nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, NO_LEGACY_ALIAS, _resetFirstRunGuardForTests } from '../../src/extension';
import { newSchemaCommand, newTableCommand, newTableTarget, validateNewSchema, type NewTableDeps } from '../../src/commands/newTable';
import { compileDbmlProject, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
type MenuEntry = { command?: string; submenu?: string; when?: string; group?: string };
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: { commands: Array<{ command: string; title: string; category?: string; icon?: string }>; menus: Record<string, MenuEntry[]> };
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
let info: ReturnType<typeof vi.spyOn>;

const erd = (...p: string[]): string => path.join(ws, '.erd-studio', ...p);
const read = (...p: string[]): string => fs.readFileSync(erd(...p), 'utf-8');

/** Every file and folder under the semantic dir, posix, sorted (a folder ends with `/`). */
function tree(): string[] {
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .map((f) => `${f.split(path.sep).join('/')}${fs.statSync(erd(f)).isDirectory() ? '/' : ''}`)
    .sort();
}

/** Every file under the semantic dir, with its bytes. */
function bytes(): Map<string, string> {
  return new Map(tree().filter((f) => !f.endsWith('/')).map((f) => [f, fs.readFileSync(erd(f)).toString('base64')]));
}

/** Every `.dbml` under the semantic dir compiles from each diagram, with no diagnostic, in 9.1.1, 10.3.1 and 11.0.0. */
function compilesClean(): void {
  const files = tree().filter((f) => f.endsWith('.dbml'));
  const texts = Object.fromEntries(files.map((f) => [f, fs.readFileSync(erd(f), 'utf-8')]));
  const diagrams = files.filter((f) => f.split('/')[1] === 'diagrams' && f.split('/').length === 3);
  const parsers: Array<[string, DbmlParserModule | undefined]> = [
    ['9.1.1', v9 as unknown as DbmlParserModule], ['10.3.1', v10 as unknown as DbmlParserModule], ['11.0.0', undefined],
  ];
  for (const [label, parser] of parsers) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(texts, diagrams, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}

/** A Table Library layer row. */
const layerRow = (layer: string): Record<string, unknown> =>
  ({ type: 'layer', layer, filePath: erd(layer, 'tables'), children: [], tableCount: 0, schemas: [] });
/** A Table Library schema row (`<layer>/tables/<schema>/`). */
const schemaRow = (layer: string, schema: string): Record<string, unknown> =>
  ({ type: 'folder', folder: schema, layer, filePath: erd(layer, 'tables', schema), children: [] });

/** Answer the input boxes in order (the schema's name, then the table's). */
function answerInputs(...answers: Array<string | undefined>): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(vscode.window, 'showInputBox');
  for (const a of answers) spy.mockResolvedValueOnce(a as never);
  spy.mockResolvedValue(undefined as never);
  return spy;
}

/** Answer each pick with the first of `labels` it offers; records what every pick offered. */
function answerPicks(...labels: string[]): { offered: string[][] } {
  const offered: string[][] = [];
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => {
    offered.push(items.map((i) => i.label));
    return items.find((i) => labels.includes(i.label));
  }) as never);
  return { offered };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-new-table-'));
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
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
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

describe('the commands are contributed', () => {
  const contributed = (id: string) => packageJson.contributes.commands.find((c) => c.command === id);
  const menu = (where: string, id: string) => (packageJson.contributes.menus[where] ?? []).filter((m) => m.command === id).map((m) => [m.group, m.when]);
  const DBML = 'erdStudio.storage =~ /^(dbml|mixed)$/';

  it('New Table… and New Schema… are post-rename ERD Studio commands', () => {
    expect(contributed('erdStudio.newTable')).toEqual({ command: 'erdStudio.newTable', title: 'New Table…', category: 'ERD Studio', icon: '$(add)' });
    expect(contributed('erdStudio.newSchema')).toEqual({ command: 'erdStudio.newSchema', title: 'New Schema…', category: 'ERD Studio' });
    expect(NO_LEGACY_ALIAS.has('erdStudio.newTable')).toBe(true);
    expect(NO_LEGACY_ALIAS.has('erdStudio.newSchema')).toBe(true);
  });

  it('a layer row offers New Table… (inline + and right-click) and New Schema…; a schema row New Table… only; DBML projects only', () => {
    const rows = `view == erdStudio.modelLibrary && viewItem =~ /^tableLibrary(Layer|Schema)$/ && ${DBML}`;
    expect(menu('view/item/context', 'erdStudio.newTable')).toEqual([['inline', rows], ['1_new@1', rows]]);
    expect(menu('view/item/context', 'erdStudio.newSchema')).toEqual([
      ['1_new@2', `view == erdStudio.modelLibrary && viewItem == tableLibraryLayer && ${DBML}`],
    ]);
    // The clause takes a layer row and a schema row, and no other row of the view.
    const when = /viewItem =~ \/(.+?)\/ &&/.exec(rows)![1];
    const takes = (viewItem: string): boolean => new RegExp(when).test(viewItem);
    expect(['tableLibraryLayer', 'tableLibrarySchema'].every(takes)).toBe(true);
    expect(['logicalModel', 'logicalModelFolder', 'logicalModelDuplicate', 'logicalModelReadOnly'].some(takes)).toBe(false);
  });

  it('the Table Library title bar lists both under …, first, and the palette has both: in a DBML project only', () => {
    const title = `view == erdStudio.modelLibrary && erdStudio.hasProject && ${DBML}`;
    expect(menu('view/title', 'erdStudio.newTable')).toEqual([['0_new@1', title]]);
    expect(menu('view/title', 'erdStudio.newSchema')).toEqual([['0_new@2', title]]);
    expect(menu('commandPalette', 'erdStudio.newTable')).toEqual([[undefined, `erdStudio.hasProject && ${DBML}`]]);
    expect(menu('commandPalette', 'erdStudio.newSchema')).toEqual([[undefined, `erdStudio.hasProject && ${DBML}`]]);
    // A YAML project (storage == yaml) matches neither clause.
    expect(/^(dbml|mixed)$/.test('yaml')).toBe(false);
  });
});

describe('what a row names, and the new schema box', () => {
  it('reads a layer row, a DBML schema row and no row; a YAML folder or a table row is neither', () => {
    expect(newTableTarget(undefined)).toEqual({});
    expect(newTableTarget({ type: 'layer', layer: 'gold' })).toEqual({ layer: 'gold' });
    expect(newTableTarget({ type: 'folder', layer: 'silver', folder: 'calendar' })).toEqual({ layer: 'silver', schema: 'calendar' });
    expect(newTableTarget({ type: 'folder', folder: 'gold' })).toBe('invalid');
    expect(newTableTarget({ type: 'model', name: 'x', filePath: '/x' })).toBe('invalid');
    expect(newTableTarget('gold')).toBe('invalid');
  });

  it('holds a new schema to the schema-folder rule and refuses one the layer has, in any case', () => {
    expect(validateNewSchema('crm', 'Silver', ['calendar'])).toBeNull();
    expect(validateNewSchema('  ', 'Silver', [])).toBe('Enter a schema name.');
    expect(validateNewSchema('{{ target.schema }}', 'Silver', [])).toMatch(/cannot be a schema folder name/);
    expect(validateNewSchema("o'neil", 'Silver', [])).toMatch(/cannot be a schema folder name/);
    expect(validateNewSchema('a/b', 'Silver', [])).toMatch(/cannot be a schema folder name/);
    expect(validateNewSchema('Calendar', 'Silver', ['calendar'])).toMatch(/^Silver already has the schema folder "calendar"\./);
    expect(validateNewSchema('calendar', 'Silver', ['calendar']))
      .toBe('Silver already has the schema "calendar". To add a table to it, right-click it in the Table Library and choose New Table…');
  });
});

describe('New Table…', () => {
  it('from a schema row: asks only the name and writes <layer>/tables/<schema>/<name>.dbml declaring Table <schema>.<name>, in ONE edit', async () => {
    await activate(context);
    const before = bytes();
    const inputs = answerInputs('dim_holiday');
    const picks = answerPicks();
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.newTable', schemaRow('silver', 'calendar'));

    expect(errors).not.toHaveBeenCalled();
    expect(picks.offered).toEqual([]);
    expect(inputs).toHaveBeenCalledTimes(1);
    expect((inputs.mock.calls[0][0] as { title: string }).title).toBe('New table in Silver › calendar');
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('silver', 'tables', 'calendar', 'dim_holiday.dbml')).toMatch(/^Table calendar\.dim_holiday \{$/m);
    // Nothing else changed: the table is on no diagram.
    const after = bytes();
    expect([...after.keys()].filter((f) => !before.has(f))).toEqual(['silver/tables/calendar/dim_holiday.dbml']);
    for (const [file, was] of before) expect(after.get(file), file).toBe(was);
    expect(info).toHaveBeenCalledWith('Created .erd-studio/silver/tables/calendar/dim_holiday.dbml. It is on no diagram yet: right-click it in the Table Library and choose Add to Diagram…');
    compilesClean();
  });

  it('the new table is in the Table Library, on no diagram', async () => {
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    await activate(context);
    answerInputs('dim_holiday');
    await vscode.commands.executeCommand('erdStudio.newTable', schemaRow('silver', 'calendar'));
    const provider = createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.modelLibrary')![1].treeDataProvider as unknown as {
      findTableNode(name: string): { name: string; layer?: string; folder?: string; referencingDomains: string[]; filePath: string } | undefined;
    };
    const node = provider.findTableNode('dim_holiday');
    expect(node).toMatchObject({ name: 'dim_holiday', layer: 'silver', folder: 'calendar', referencingDomains: [] });
    expect(node!.filePath).toBe(erd('silver', 'tables', 'calendar', 'dim_holiday.dbml'));
  });

  it('from a layer row: asks which schema of that layer, then the name', async () => {
    await activate(context);
    const picks = answerPicks('gold');
    answerInputs('dim_product');
    await vscode.commands.executeCommand('erdStudio.newTable', layerRow('gold'));

    expect(errors).not.toHaveBeenCalled();
    // The layer is the row's: only its schemas are offered, and a new one.
    expect(picks.offered).toEqual([['gold', '$(add) New schema in Gold…']]);
    expect(read('gold', 'tables', 'gold', 'dim_product.dbml')).toMatch(/^Table gold\.dim_product \{$/m);
    compilesClean();
  });

  it('from a layer row, into a new schema: the schema\'s name, then the table\'s', async () => {
    await activate(context);
    answerPicks('$(add) New schema in Gold…');
    const inputs = answerInputs('sales', 'fct_refund');
    await vscode.commands.executeCommand('erdStudio.newTable', layerRow('gold'));

    expect(errors).not.toHaveBeenCalled();
    expect(inputs.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['New schema in Gold', 'New table in Gold › sales']);
    expect(read('gold', 'tables', 'sales', 'fct_refund.dbml')).toMatch(/^Table sales\.fct_refund \{$/m);
    compilesClean();
  });

  it('from the title bar or the palette: the layer, the schema, then the name', async () => {
    await activate(context);
    const picks = answerPicks('Silver', 'calendar');
    answerInputs('dim_week');
    await vscode.commands.executeCommand('erdStudio.newTable');

    expect(errors).not.toHaveBeenCalled();
    expect(picks.offered).toEqual([['Silver', 'Gold'], ['calendar', '$(add) New schema in Silver…']]);
    expect(read('silver', 'tables', 'calendar', 'dim_week.dbml')).toMatch(/^Table calendar\.dim_week \{$/m);
  });

  it('refuses a name the library already has, in any case and in any layer: nothing is written', async () => {
    await activate(context);
    const before = tree();
    const beforeBytes = bytes();
    for (const name of ['dim_customer', 'DIM_Customer', 'Fct_Order']) {
      errors.mockClear();
      const inputs = answerInputs(name);
      // gold.dim_customer and gold.fct_order exist; the new one is asked for in silver › calendar.
      await vscode.commands.executeCommand('erdStudio.newTable', schemaRow('silver', 'calendar'));
      const taken = name.toLowerCase();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toBe(
        `New Table: Table "${taken}" already exists in the Table Library (.erd-studio/gold/tables/gold/${taken}.dbml). Table names are unique across the project. ` +
        `For a separate table also called ${name}, name it calendar_${name} and set its warehouse name (alias) to ${name}. Nothing was created.`,
      );
      // The box itself says so while typing.
      const validate = (inputs.mock.calls[0][0] as { validateInput(v: string): string | null }).validateInput;
      expect(validate(name)).toMatch(/already exists in the Table Library/);
      expect(validate('dim_brand_new')).toBeNull();
      inputs.mockRestore();
    }
    expect(tree()).toEqual(before);
    expect(bytes()).toEqual(beforeBytes);
  });

  it('refuses a name that is not a table name: nothing is written', async () => {
    await activate(context);
    const before = tree();
    for (const name of ['order items', '../x', '1st']) {
      errors.mockClear();
      answerInputs(name).mockName(name);
      await vscode.commands.executeCommand('erdStudio.newTable', schemaRow('silver', 'calendar'));
      expect(errors, name).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toMatch(/^New Table: .* Nothing was created\.$/);
      vi.mocked(vscode.window.showInputBox).mockRestore();
    }
    expect(tree()).toEqual(before);
  });

  it('cancelling the name writes nothing, and a row that is not a layer or a schema is refused', async () => {
    await activate(context);
    const before = tree();
    answerInputs(undefined);
    await vscode.commands.executeCommand('erdStudio.newTable', schemaRow('silver', 'calendar'));
    expect(errors).not.toHaveBeenCalled();
    await vscode.commands.executeCommand('erdStudio.newTable', { type: 'model', name: 'dim_customer', filePath: erd('gold', 'tables', 'gold', 'dim_customer.dbml') });
    expect(errors).toHaveBeenCalledWith('New Table: right-click a layer or a schema in the Table Library, or run "ERD Studio: New Table…" from the Command Palette.');
    expect(tree()).toEqual(before);
  });
});

describe('New Schema…', () => {
  it('from a layer row: the schema\'s name, then its first table, whose file makes the folder', async () => {
    await activate(context);
    const picks = answerPicks();
    const inputs = answerInputs('crm', 'dim_lead');
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.newSchema', layerRow('silver'));

    expect(errors).not.toHaveBeenCalled();
    expect(picks.offered).toEqual([]);
    expect(inputs.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['New schema in Silver', 'New table in Silver › crm']);
    expect((inputs.mock.calls[0][0] as { prompt: string }).prompt).toContain('made with its first table');
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(read('silver', 'tables', 'crm', 'dim_lead.dbml')).toMatch(/^Table crm\.dim_lead \{$/m);
    compilesClean();
  });

  it('the box refuses a name that is not a folder name, and one the layer has in any case', async () => {
    await activate(context);
    const inputs = answerInputs(undefined);
    await vscode.commands.executeCommand('erdStudio.newSchema', layerRow('silver'));
    const validate = (inputs.mock.calls[0][0] as { validateInput(v: string): string | null }).validateInput;
    expect(validate('crm')).toBeNull();
    expect(validate('a/b')).toMatch(/cannot be a schema folder name/);
    expect(validate('{{ env }}')).toMatch(/cannot be a schema folder name/);
    expect(validate('calendar')).toMatch(/^Silver already has the schema "calendar"/);
    expect(validate('CALENDAR')).toMatch(/^Silver already has the schema folder "calendar"/);
  });

  it('a clashing or invalid schema answered anyway is refused, and cancelling the first table leaves no folder', async () => {
    await activate(context);
    const before = tree();
    for (const schema of ['Calendar', 'calendar', 'a/b']) {
      errors.mockClear();
      const inputs = answerInputs(schema, 'dim_lead');
      await vscode.commands.executeCommand('erdStudio.newSchema', layerRow('silver'));
      expect(errors, schema).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toMatch(/^New Schema: .* Nothing was created\.$/);
      // The table's name was never asked.
      expect(inputs).toHaveBeenCalledTimes(1);
      inputs.mockRestore();
    }
    errors.mockClear();
    answerInputs('crm', undefined);
    await vscode.commands.executeCommand('erdStudio.newSchema', layerRow('silver'));
    expect(errors).not.toHaveBeenCalled();
    expect(tree()).toEqual(before);
    expect(fs.existsSync(erd('silver', 'tables', 'crm'))).toBe(false);
  });

  it('with no row: the layer is picked first', async () => {
    await activate(context);
    const picks = answerPicks('Gold');
    answerInputs('finance', 'fct_invoice');
    await vscode.commands.executeCommand('erdStudio.newSchema');
    expect(errors).not.toHaveBeenCalled();
    expect(picks.offered).toEqual([['Silver', 'Gold']]);
    expect(read('gold', 'tables', 'finance', 'fct_invoice.dbml')).toMatch(/^Table finance\.fct_invoice \{$/m);
  });
});

describe('a project that stores its tables as YAML', () => {
  it('is refused by both commands before anything is asked', async () => {
    const deps = {
      storage: () => 'yaml',
      layers: () => [{ id: 'gold', label: 'Gold' }],
    } as unknown as NewTableDeps;
    const inputs = vi.spyOn(vscode.window, 'showInputBox');
    const picks = vi.spyOn(vscode.window, 'showQuickPick');
    await newTableCommand(deps, { type: 'layer', layer: 'gold' });
    await newSchemaCommand(deps, { type: 'layer', layer: 'gold' });
    expect(inputs).not.toHaveBeenCalled();
    expect(picks).not.toHaveBeenCalled();
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      'New Table: this project stores its tables as YAML files, and New Table adds a DBML table file. Add the table from a diagram (New Table), or run "ERD Studio: Convert Project to DBML" first. Nothing was created.',
      'New Schema: this project stores its tables as YAML files, and New Schema adds a DBML table file. Add the table from a diagram (New Table), or run "ERD Studio: Convert Project to DBML" first. Nothing was created.',
    ]);
  });
});
