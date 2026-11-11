/**
 * The write commands on two tables of one name in different schema folders,
 * through `activate()` on a copy of the twin fixture
 * (`test/fixtures/same-name-two-schemas`: `bronze/tables/{bqs,ccc}/{addresse,kunde}.dbml`,
 * one relationships file with a Ref per schema and one between the two
 * `addresse` tables, and the diagrams ccc.dbml, kunden.dbml and
 * kunden-bare.dbml), plus a diagram of bqs's tables only.
 *
 * `activate()` builds its own Table Library, which tells tables apart by
 * identity only once that is the default; until then this file turns the
 * internal option `schemaScopedNames` on for every library the extension
 * builds. Move Table, the Explorer's moves, Organise, Delete Table and
 * Import DBML then act on one twin and leave the other's file, Refs, `use`
 * lines and diagrams as they were; a move onto an identity another layer
 * has is refused, naming that file, and writes nothing (D-7); a command
 * that still names a table by a shared name alone is refused, never sent to
 * the first file of that name (D-5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { compileDbmlProject, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';
import { answerDraft, nextDraft } from './helpers/draftDriver';

vi.mock('../../src/services/logicalModelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/logicalModelService')>();
  /** The extension's Table Library with the identity rule on, whoever builds it. */
  class ScopedTableLibraryService extends actual.TableLibraryService {
    constructor(...args: ConstructorParameters<typeof actual.TableLibraryService>) {
      const [workspaceRoot, semanticDir, ownWriteTracker, options] = args;
      super(workspaceRoot, semanticDir, ownWriteTracker, { ...options, schemaScopedNames: true });
    }
  }
  return { ...actual, TableLibraryService: ScopedTableLibraryService };
});

const REPO_ROOT = path.resolve(__dirname, '../..');
const TWINS = path.join(REPO_ROOT, 'test', 'fixtures', 'same-name-two-schemas');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };

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

const erd = (...p: string[]): string => path.join(ws, '.erd-studio', ...p);
const at = (rel: string): string => erd(...rel.split('/'));
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};

/** Every file under the semantic dir with its text, by posix path. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of (fs.readdirSync(erd(), { recursive: true }) as string[]).map((x) => x.split(path.sep).join('/')).sort()) {
    if (fs.statSync(at(f)).isFile()) out[f] = read(f);
  }
  return out;
}

/** The files that differ between two snapshots: changed, created ('+') or deleted ('-'). */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [p, text] of Object.entries(after)) if (before[p] === undefined) out.push(`+${p}`); else if (before[p] !== text) out.push(p);
  for (const p of Object.keys(before)) if (after[p] === undefined) out.push(`-${p}`);
  return out.sort();
}

/** bqs's table files, its diagram and its own Ref lines: what an edit of a ccc table leaves as they were. */
function bqsSide(files: Record<string, string>): Record<string, string | undefined> {
  return {
    'bqs/addresse': files['bronze/tables/bqs/addresse.dbml'],
    'bqs/kunde': files['bronze/tables/bqs/kunde.dbml'],
    'bqs diagram': files['bronze/diagrams/bqs.dbml'],
    'bqs Ref': (files['bronze/relationships/bronze.dbml'] ?? '').split('\n').filter((l) => l.startsWith('Ref: bqs.')).join('\n'),
  };
}

/** Every `.dbml` under the semantic dir compiles from each diagram, with no diagnostic, in 9.1.1, 10.3.1 and 11.0.0. */
function compilesClean(): void {
  const texts = Object.fromEntries(Object.entries(snapshot()).filter(([f]) => f.endsWith('.dbml')));
  const diagrams = Object.keys(texts).filter((f) => f.split('/')[1] === 'diagrams' && f.split('/').length === 3);
  const parsers: Array<[string, DbmlParserModule | undefined]> = [
    ['9.1.1', v9 as unknown as DbmlParserModule], ['10.3.1', v10 as unknown as DbmlParserModule], ['11.0.0', undefined],
  ];
  for (const [label, parser] of parsers) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(texts, diagrams, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}

/** A Table Library row for the table file at `rel`. */
function row(rel: string): { type: 'model'; name: string; filePath: string; referencingDomains: string[] } {
  return { type: 'model', name: path.basename(rel, '.dbml'), filePath: at(rel), referencingDomains: [] };
}

/** Answer every modal question with `button`. */
function answer(button: string): void {
  info.mockImplementation((async (...args: unknown[]) => (args.includes(button) ? button : undefined)) as never);
}

const TWO_LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [
    { id: 'bronze', label: 'Bronze', creatable: true, order: 1 },
    { id: 'silver', label: 'Silver', creatable: true, order: 2 },
  ],
});

/** A diagram that shows only bqs's tables. */
const BQS_DIAGRAM = [
  'Project bqs {',
  "  erd_schema_version: '7'",
  "  erd_layout: '''",
  '    addresse 10 20',
  '    kunde 300 20',
  "  '''",
  '}',
  '',
  "use { table bqs.addresse } from '../tables/bqs/addresse.dbml'",
  "use { table bqs.kunde }    from '../tables/bqs/kunde.dbml'",
  "use * from '../relationships/bronze.dbml'",
  '',
].join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-same-name-activate-'));
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
  vi.useFakeTimers();
  fs.cpSync(TWINS, ws, { recursive: true });
  write('bronze/diagrams/bqs.dbml', BQS_DIAGRAM);
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

describe('Move Table… on one of two tables of one name', () => {
  it('moves the table whose file the row holds to a new schema: only its own ends and use lines follow', async () => {
    await activate(context);
    const before = snapshot();
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) =>
      items.find((i) => i.label === '$(add) New schema in Bronze…')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('ddd');
    answer('Move');
    await vscode.commands.executeCommand('erdStudio.moveTable', row('bronze/tables/ccc/addresse.dbml'));
    expect(errors).not.toHaveBeenCalled();
    const after = snapshot();
    expect(after['bronze/tables/ddd/addresse.dbml']).toMatch(/^Table ddd\.addresse \{\n {2}id INT \[pk\]\n {2}street/);
    expect(after['bronze/tables/ccc/addresse.dbml']).toBeUndefined();
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ddd.addresse.id');
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ddd.addresse.id >? bqs.addresse.id');
    expect(after['bronze/diagrams/ccc.dbml']).toContain("use { table ddd.addresse } from '../tables/ddd/addresse.dbml'");
    // The diagram that shows both keeps each at its place: the moved one under its new reference.
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}bqs\.addresse 40 40\n/);
    expect(after['bronze/diagrams/kunden.dbml']).toMatch(/\n {4}ddd\.addresse 40 360\n/);
    compilesClean();
  });

  it('refuses a move onto the schema folder that holds the other one, or onto its identity in another layer, and writes nothing', async () => {
    write('layers.json', TWO_LAYERS);
    write('silver/tables/silver/s.dbml', 'Table silver.s {\n  id INT [pk]\n}\n');
    await activate(context);
    const before = snapshot();
    for (const destination of ['Bronze › ccc', '$(add) New schema in Silver…']) {
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) =>
        items.find((i) => i.label === destination)) as never);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('ccc');
      answer('Move');
      errors.mockClear();
      await vscode.commands.executeCommand('erdStudio.moveTable', row('bronze/tables/bqs/addresse.dbml'));
      expect(snapshot(), destination).toEqual(before);
    }
    // Into another layer's ccc folder: the other table's identity there, named.
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toContain('ccc.addresse already exists in layer bronze (bronze/tables/ccc/addresse.dbml)');
  });
});

describe('the Explorer\'s moves of one of two tables of one name', () => {
  /** Move `from` to `to` on disk, as the Explorer does, then tell ERD Studio. */
  async function explorerMove(from: string, to: string): Promise<void> {
    fs.mkdirSync(path.dirname(at(to)), { recursive: true });
    fs.renameSync(at(from), at(to));
    await vscode._fireDidRenameFiles([{ oldUri: vscode.Uri.file(at(from)), newUri: vscode.Uri.file(at(to)) }]);
  }

  it('a drag of ccc/addresse.dbml to ddd/ moves ccc\'s own text and re-spells only its ends (never bqs\'s file)', async () => {
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    await activate(context);
    const before = snapshot();
    await explorerMove('bronze/tables/ccc/addresse.dbml', 'bronze/tables/ddd/addresse.dbml');
    expect(errors).not.toHaveBeenCalled();
    const after = snapshot();
    expect(after['bronze/tables/ddd/addresse.dbml']).toMatch(/^Table ddd\.addresse \{\n {2}id INT \[pk\]\n {2}street VARCHAR/);
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['bronze/relationships/bronze.dbml']).toContain('Ref: ccc.kunde.addresse_id >? ddd.addresse.id');
    compilesClean();
  });

  it('renaming the schema folder bqs to src1, while another layer holds src1/addresse.dbml, is refused as a batch naming that file; nothing else changes', async () => {
    write('layers.json', TWO_LAYERS);
    write('silver/tables/src1/addresse.dbml', 'Table src1.addresse {\n  id INT [pk]\n}\n');
    vscode._setMockConfiguration('erdStudio', 'dbml.updateReferencesOnMove', { globalValue: 'always' });
    await activate(context);
    const before = snapshot();
    await explorerMove('bronze/tables/bqs', 'bronze/tables/src1');
    const said = [...warnings.mock.calls, ...errors.mock.calls].map((c) => String(c[0])).join('\n');
    expect(said).toContain('src1.addresse already exists in layer silver (silver/tables/src1/addresse.dbml)');
    // Only the user's own move happened: every other file is as it was.
    const moved = Object.fromEntries(Object.entries(before).map(([p, t]) => [p.replace('bronze/tables/bqs/', 'bronze/tables/src1/'), t]));
    expect(snapshot()).toEqual(moved);
  });
});

describe('Organise Table Library with two tables of one name', () => {
  it('moves only the one whose diagrams are all in another layer, by its file, with its own ends', async () => {
    write('layers.json', TWO_LAYERS);
    // ccc's tables are shown only in silver; bqs's only in bronze.
    for (const f of ['bronze/diagrams/kunden.dbml', 'bronze/diagrams/kunden-bare.dbml', 'bronze/diagrams/ccc.dbml']) fs.rmSync(at(f));
    write('silver/diagrams/ccc.dbml', [
      'Project ccc {',
      "  erd_schema_version: '7'",
      "  erd_layout: '''",
      '    addresse 40 40',
      '    kunde 400 40',
      "  '''",
      '}',
      '',
      "use { table ccc.addresse } from '../../bronze/tables/ccc/addresse.dbml'",
      "use { table ccc.kunde }    from '../../bronze/tables/ccc/kunde.dbml'",
      "use * from '../../bronze/relationships/bronze.dbml'",
      '',
    ].join('\n'));
    await activate(context);
    const before = snapshot();
    answer('Move Files');
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    const after = snapshot();
    expect(changed(before, after)).toEqual([
      '+silver/tables/ccc/addresse.dbml', '+silver/tables/ccc/kunde.dbml',
      '-bronze/tables/ccc/addresse.dbml', '-bronze/tables/ccc/kunde.dbml',
      'bronze/relationships/bronze.dbml', 'silver/diagrams/ccc.dbml',
    ]);
    expect(after['silver/tables/ccc/addresse.dbml']).toBe(before['bronze/tables/ccc/addresse.dbml']);
    expect(bqsSide(after)).toEqual(bqsSide(before));
    expect(after['silver/diagrams/ccc.dbml']).toContain("use { table ccc.addresse } from '../tables/ccc/addresse.dbml'");
    compilesClean();
  });
});

describe('Delete Table on one of two tables of one name', () => {
  it('still acts by name here, so it is refused, never the first file of that name; nothing is deleted', async () => {
    await activate(context);
    const before = snapshot();
    warnings.mockImplementation((async (...args: unknown[]) => (args.includes('Delete') ? 'Delete' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.deleteLogicalModel', row('bronze/tables/ccc/addresse.dbml'));
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/more than one table is named addresse/i);
    expect(snapshot()).toEqual(before);
  });
});

describe('Import DBML beside two tables of one name', () => {
  it('writes the new table and its Ref, and leaves both tables of the shared name, their Refs and diagrams as they are', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    const source = path.join(inbox, 'lieferung.dbml');
    fs.writeFileSync(source, 'Table ddd.lieferant {\n  id int [pk]\n}\nTable ddd.lieferung {\n  id int [pk]\n  lieferant_id int [ref: > ddd.lieferant.id]\n}\n');
    await activate(context);
    const before = snapshot();
    vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file(source)] as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation((async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath)) as never);
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation((async (uri: vscode.Uri) => {
      if (!fs.existsSync(uri.fsPath)) throw new Error('FileNotFound');
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    }) as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ id?: string }>) => items.find((i) => i.id === 'bronze') ?? items[0]) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o?: { value?: string }) => o?.value) as never);
    const run = vscode.commands.executeCommand('erdStudio.importDbml');
    await nextDraft();
    answerDraft({ type: 'keep' });
    await run;
    expect(errors).not.toHaveBeenCalled();
    const after = snapshot();
    expect(after['bronze/tables/ddd/lieferung.dbml']).toMatch(/^Table ddd\.lieferung \{/);
    expect(after['bronze/tables/ddd/lieferant.dbml']).toMatch(/^Table ddd\.lieferant \{/);
    for (const f of Object.keys(before)) {
      if (f.startsWith('bronze/tables/') || f.startsWith('bronze/diagrams/')) expect(after[f], f).toBe(before[f]);
    }
    expect(after['bronze/relationships/bronze.dbml'].split('\n').filter((l) => l.startsWith('Ref: bqs.') || l.startsWith('Ref: ccc.')))
      .toEqual(before['bronze/relationships/bronze.dbml'].split('\n').filter((l) => l.startsWith('Ref: bqs.') || l.startsWith('Ref: ccc.')));
    compilesClean();
  });
});
