/**
 * Regenerate dbt selectors.yml in a dbt project whose model for a diagram
 * table has another name: selectors.yml still lists the table by its name on
 * the diagram (the file is derived from committed files only), and the
 * command says which tables dbt names otherwise and where to get a command
 * with dbt's names.
 *
 * The temp copy of test/fixtures/dbt-project is edited the way a real project
 * would look (no mocked lookup): dbt's model for the diagram's `fct_order` is
 * `orders_fact` (config alias fct_order, schema silver), found by the physical
 * stage through its warehouse relation; and, separately, dbt's schema yml
 * spells `dim_customer` as `DIM_Customer`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests, SELECTOR_NAMES_CHECK_MS } from '../../src/extension';
import { SHOW_LOGS_BUTTON, SHOW_LOGS_COMMAND } from '../../src/services/showLogs';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { ManifestService } from '../../src/services/manifestService';
import { CatalogService } from '../../src/services/catalogService';
import { dbtKeyIndexOf } from '../../src/services/stageDisplay';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
type Context = import('vscode').ExtensionContext;

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    ['erdStudio.startSuggestion', { shown: 1, answered: true }],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: {
      get: (k: string) => workspaceState.get(k),
      update: async (k: string, v: unknown) => { workspaceState.set(k, v); },
      keys: () => [...workspaceState.keys()],
    },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

/** dbt names the diagram's fct_order `orders_fact` (alias fct_order, schema silver). */
function orderIsOrdersFact(dbt: string): void {
  const yml = path.join(dbt, 'models/silver/fct_order.yml');
  fs.writeFileSync(yml, fs.readFileSync(yml, 'utf-8')
    .replace('  - name: fct_order\n', '  - name: orders_fact\n')
    .replace('    config:\n', '    config:\n      alias: fct_order\n'));
  fs.writeFileSync(path.join(dbt, 'models/silver/orders_fact.sql'), 'select 1 as order_id\n');
  const manifestPath = path.join(dbt, 'target/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const project = manifest.metadata.project_name;
  const like = manifest.nodes[`model.${project}.dim_task`];
  manifest.nodes[`model.${project}.orders_fact`] = {
    ...like,
    unique_id: `model.${project}.orders_fact`,
    name: 'orders_fact',
    alias: 'fct_order',
    schema: 'silver',
    description: 'Order transaction fact table',
    original_file_path: 'models/silver/orders_fact.sql',
    columns: {},
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const table = path.join(dbt, '.erd-studio/logical-models/fct_order.yml');
  fs.writeFileSync(table, fs.readFileSync(table, 'utf-8').replace('name: fct_order\n', 'name: fct_order\nschema: silver\n'));
}

/** dbt's schema yml spells dim_customer `DIM_Customer` (no manifest node, no .sql). */
function customerInAnotherCase(dbt: string): void {
  const yml = path.join(dbt, 'models/silver/dim_customer.yml');
  fs.writeFileSync(yml, fs.readFileSync(yml, 'utf-8').replace('  - name: dim_customer\n', '  - name: DIM_Customer\n'));
}

/** What dbtNodeNamesOf gives for every diagram, loaded fresh from the copy (as handleCopyDbtCommand loads it). */
async function dbtNodeNames(dbt: string): Promise<Record<string, Record<string, string | null>>> {
  const layerService = new LayerService(dbt, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  subjectAreaService.setTableLibraryService(new TableLibraryService(dbt, '.erd-studio'));
  const manifest = await new ManifestService({ parseInProcess: true }).loadManifest(dbt);
  const ymlData = await new YmlParserService().loadYmlData(dbt, undefined);
  const catalog = await new CatalogService().loadCatalog(dbt);
  const out: Record<string, Record<string, string | null>> = {};
  for (const s of subjectAreaService.listSubjectAreas(dbt, '.erd-studio')) {
    const file = (s as { filePath: string }).filePath;
    const unified = subjectAreaService.getSubjectArea(file, { dbtKeyIndex: dbtKeyIndexOf(ymlData, manifest) });
    out[path.basename(file)] = Object.fromEntries(subjectAreaService.dbtNodeNamesOf(unified, ymlData, manifest, catalog));
  }
  return out;
}

let root: string;
let dbt: string;
let context: Context;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const selectorsText = () => fs.readFileSync(path.join(dbt, 'selectors.yml'), 'utf-8');
const said = () => [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-naming-gap-'));
  dbt = path.join(root, 'dbt');
  fs.cpSync(FIXTURE_ROOT, dbt, { recursive: true });
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dbt), name: 'dbt', index: 0 }];
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) { try { await sub.dispose(); } catch { /* best effort */ } }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function regenerate(): Promise<void> {
  await activate(context);
  await vi.advanceTimersByTimeAsync(1000);
  await vscode.commands.executeCommand('erdStudio.syncDomainTags');
}

const WROTE = 'Wrote 2 selector(s) covering 7 dbt model reference(s) to selectors.yml.';
const aboutSelectors = (calls: ReturnType<typeof vi.spyOn>): string[] => calls.mock.calls.map((c) => String(c[0])).filter((m) => /selector/i.test(m));
const showcaseSelector = (): string => selectorsText().split('- name: domain_silver_showcase')[1].split('- name: ')[0];

describe('Regenerate dbt selectors.yml where dbt names a diagram table differently', () => {
  it('fct_order is dbt\'s orders_fact: selectors.yml still lists fct_order, and the command says so in one warning with Show Logs', async () => {
    orderIsOrdersFact(dbt);
    vi.useRealTimers();
    const names = await dbtNodeNames(dbt);
    vi.useFakeTimers();
    // The project really is in that state: the physical stage finds fct_order as orders_fact.
    expect(names['showcase.json'].fct_order).toBe('orders_fact');

    await activate(context);
    await vi.advanceTimersByTimeAsync(1000);
    // Opening the window says nothing: the note belongs to the command.
    expect(said()).toEqual([]);
    await vscode.commands.executeCommand('erdStudio.syncDomainTags');

    // selectors.yml names it by the diagram name, on every machine.
    expect(showcaseSelector()).toMatch(/value: fct_order\n/);
    expect(showcaseSelector()).not.toMatch(/orders_fact/);
    // The rule: some message names both.
    expect(said().some((m) => /\bfct_order\b/.test(m) && /\borders_fact\b/.test(m)), JSON.stringify(said())).toBe(true);
    // One message, a warning that still says what was written, then the note; no second toast.
    expect(aboutSelectors(info)).toEqual([]);
    expect(aboutSelectors(warn)).toEqual([
      `${WROTE} In dbt's files, 1 table has another name, so its selector may leave it out of a build. `
        + 'The dbt command button on a diagram\'s toolbar copies a command with dbt\'s names. fct_order is orders_fact in dbt.',
    ]);
    expect(warn.mock.calls.find((c) => /selector/i.test(String(c[0])))?.slice(1)).toEqual([SHOW_LOGS_BUTTON]);
    // fct_large_table is not in dbt at all: never reported as named differently.
    expect(names['scroll-test.json'].fct_large_table).toBeNull();
    expect(said().join(' ')).not.toMatch(/fct_large_table/);
  });

  it('dim_customer is dbt\'s DIM_Customer (case only): same rule, and a selector of the user\'s own is left alone', async () => {
    customerInAnotherCase(dbt);
    vi.useRealTimers();
    const names = await dbtNodeNames(dbt);
    vi.useFakeTimers();
    expect(names['showcase.json'].dim_customer).toBe('DIM_Customer');
    const userSelector = (): string => selectorsText().split('- name: incremental_critical')[1];
    const before = userSelector();
    await regenerate();
    expect(selectorsText()).toMatch(/value: dim_customer\n/);
    expect(said().some((m) => /\bdim_customer\b/.test(m) && /\bDIM_Customer\b/.test(m)), JSON.stringify(said())).toBe(true);
    expect(userSelector()).toBe(before);
  });

  it('Show Logs on the warning opens the log, which lists every table by selector', async () => {
    orderIsOrdersFact(dbt);
    customerInAnotherCase(dbt);
    warn.mockImplementation((async (message: string) => (/selector/i.test(message) ? SHOW_LOGS_BUTTON : undefined)) as never);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.spyOn(vscode.commands, 'executeCommand');
    await regenerate();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledWith(SHOW_LOGS_COMMAND);
    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('[Selectors] domain_silver_showcase lists fct_order; dbt names that model orders_fact.');
    expect(lines).toContain('[Selectors] domain_silver_showcase lists dim_customer; dbt names that model DIM_Customer.');
  });

  it('names agree: the plain message, as before, and no warning', async () => {
    await regenerate();
    expect(aboutSelectors(info)).toEqual([WROTE]);
    expect(aboutSelectors(warn)).toEqual([]);
  });

  it('selectors.yml is the same bytes with and without target/manifest.json; without it the renamed model cannot be seen, so nothing is claimed', async () => {
    orderIsOrdersFact(dbt);
    await regenerate();
    const withManifest = selectorsText();
    expect(aboutSelectors(warn)).toHaveLength(1);

    // A teammate's fresh clone: no target/ folder.
    for (const sub of [...context.subscriptions].reverse()) { try { await sub.dispose(); } catch { /* best effort */ } }
    context = makeContext(root);
    vscode._resetRegisteredCommands();
    vscode._clearMockFileWatchers();
    _resetFirstRunGuardForTests();
    fs.rmSync(path.join(dbt, 'target'), { recursive: true });
    info.mockClear();
    warn.mockClear();
    await regenerate();
    expect(selectorsText()).toBe(withManifest);
    expect(aboutSelectors(warn)).toEqual([]);
    expect(aboutSelectors(info)).toEqual([WROTE]);
  });

  it('dbt\'s files failing to read after the write never turns the write into a failure: the plain message', async () => {
    orderIsOrdersFact(dbt);
    const failed = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    fs.rmSync(path.join(dbt, 'selectors.yml'));
    await activate(context);
    await vi.advanceTimersByTimeAsync(1000);
    vi.spyOn(YmlParserService.prototype, 'loadYmlData').mockRejectedValue(new Error('EACCES: models'));
    await vscode.commands.executeCommand('erdStudio.syncDomainTags');
    expect(fs.existsSync(path.join(dbt, 'selectors.yml'))).toBe(true);
    expect(aboutSelectors(info)).toHaveLength(1);
    expect(aboutSelectors(info)[0].startsWith(WROTE)).toBe(true);
    expect(aboutSelectors(warn)).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    expect(said().join(' ')).not.toMatch(/was not changed/);
  });

  it('a diagram that cannot be read for the comparison is skipped; the others are still reported', async () => {
    orderIsOrdersFact(dbt);
    await activate(context);
    await vi.advanceTimersByTimeAsync(1000);
    const read = SubjectAreaService.prototype.dbtNodeNamesOf;
    vi.spyOn(SubjectAreaService.prototype, 'dbtNodeNamesOf').mockImplementation(function (this: SubjectAreaService, ...args: Parameters<typeof read>) {
      if (args[0].logical.models.some((m) => m.name === 'fct_large_table')) throw new Error('boom');
      return read.apply(this, args);
    });
    await vscode.commands.executeCommand('erdStudio.syncDomainTags');
    expect(aboutSelectors(warn)).toHaveLength(1);
    expect(aboutSelectors(warn)[0]).toMatch(/fct_order is orders_fact in dbt\.$/);
  });

  it('a manifest that takes too long: the command waits SELECTOR_NAMES_CHECK_MS, then says what it wrote and no more', async () => {
    orderIsOrdersFact(dbt);
    await activate(context);
    await vi.advanceTimersByTimeAsync(1000);
    vi.spyOn(ManifestService.prototype, 'loadManifest').mockReturnValue(new Promise(() => undefined));
    let done = false;
    const running = Promise.resolve(vscode.commands.executeCommand('erdStudio.syncDomainTags')).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(SELECTOR_NAMES_CHECK_MS - 100);
    expect(done).toBe(false);
    expect(said()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await running;
    expect(aboutSelectors(info)).toEqual([WROTE]);
    expect(aboutSelectors(warn)).toEqual([]);
  });

  it('a manifest kept from before a failed parse is not trusted for names: nothing is claimed', async () => {
    orderIsOrdersFact(dbt);
    vi.spyOn(ManifestService.prototype, 'isStale', 'get').mockReturnValue(true);
    await regenerate();
    expect(aboutSelectors(info)).toEqual([WROTE]);
    expect(aboutSelectors(warn)).toEqual([]);
  });
});
