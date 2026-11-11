/**
 * ERD Studio: Suggest Relationships… through the real SemanticEditorProvider,
 * with the review's UI faked: on a DBML project (`dbml-native`, the Refs of
 * gold.dbml taken out) and a YAML project (`dbt-project`'s showcase diagram,
 * its relationships taken out; the project keeps relationships in its YAML
 * table files, so they land there, each in its foreign-key table's file).
 *
 * - accepting writes exactly the accepted ones, through the one relationship
 *   write path: ONE `applyEdit` (one undo step) however many there are;
 * - a composite is one Ref (DBML) / entries sharing a compositeKey (YAML);
 * - a direction nothing decides is asked with the dialog's words; Skip skips;
 * - the list is checked again before writing (an edit made meanwhile wins);
 * - the physical stage, a cancel, an unreadable diagram or relationships
 *   file write nothing and say why;
 * - the after-import offer: once, only on a diagram with no relationship,
 *   held back while the onboarding guide runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { RELATIONSHIP_SUGGESTIONS_DECLINED_KEY, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { SuggestRelationshipsUi } from '../../src/providers/suggestRelationshipsFlow';
import type { DirectionAnswer, DirectionQuestion, SuggestionReview } from '../../src/services/relationshipSuggestionReview';
import { DIRECTION_QUESTION, directionChoice } from '../../webview/lib/relationshipDialog';

const FIXTURES = path.resolve(__dirname, '../fixtures');
let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const relOf = (abs: string): string => path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/');
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');

interface FakeUi extends SuggestRelationshipsUi {
  reviews: SuggestionReview[];
  questions: DirectionQuestion[];
  infos: string[];
  errors: string[];
}

/** A UI that ticks `choose(review)` (default: what is ticked) and answers each direction question from `answers`. */
function fakeUi(choose?: (review: SuggestionReview) => string[] | undefined, answers: Array<DirectionAnswer | undefined> = [], beforeReturn?: () => Promise<void> | void): FakeUi {
  const ui: FakeUi = {
    reviews: [], questions: [], infos: [], errors: [],
    pick: async (review) => {
      const r = review(500);
      ui.reviews.push(r);
      await beforeReturn?.();
      return choose ? choose(r) : r.sections.flatMap((s) => s.rows).filter((row) => row.picked).map((row) => row.id);
    },
    askDirection: async (q) => { ui.questions.push(q); return answers.shift(); },
    info: (m) => { ui.infos.push(m); },
    error: (m) => { ui.errors.push(m); },
  };
  return ui;
}

const rows = (r: SuggestionReview) => r.sections.flatMap((s) => s.rows);
const idsWhere = (pred: (label: string) => boolean) => (r: SuggestionReview) => rows(r).filter((row) => pred(row.label)).map((row) => row.id);

function buildProvider(options: { offers?: boolean } = {}): SemanticEditorProvider {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tables);
  const declined = new Map<string, unknown>();
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    // Every other offer stays quiet; the suggestion offer is on when a test asks for offers.
    workspaceState: {
      get: (key: string) => (declined.has(key) ? declined.get(key) : key === RELATIONSHIP_SUGGESTIONS_DECLINED_KEY ? !options.offers : true),
      update: async (key: string, value: unknown) => { declined.set(key, value); },
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    new OwnWriteTracker(),
  );
}

/** Open `diagram` on a canvas (ready, loaded) and make it the active tab. */
async function open(provider: SemanticEditorProvider, diagram: string): Promise<ReturnType<typeof createMockWebviewPanel>> {
  const document = createMockTextDocument(at(diagram), read(diagram), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  (vscode.window.tabGroups.activeTabGroup as { activeTab: unknown }).activeTab = { input: new vscode.TabInputCustom(vscode.Uri.file(at(diagram)), 'erdStudio.domainEditor') };
  return panel;
}

const writtenPaths = (): string[] =>
  [...new Set(_appliedEdits.flatMap((e) => (e as unknown as { _ops: Array<{ uri: { fsPath: string } }> })._ops.map((op) => relOf(op.uri.fsPath))))].sort();

function useDbmlProject(): void {
  fs.cpSync(path.join(FIXTURES, 'dbml-native'), root, { recursive: true });
  // gold.dbml's Refs out: the engine suggests them back (and one more).
  fs.writeFileSync(at('gold/relationships/gold.dbml'), read('gold/relationships/gold.dbml').replace(/^Ref.*\n/gm, ''));
}

function useYamlProject(extra?: () => void): void {
  fs.cpSync(path.join(FIXTURES, 'dbt-project'), root, { recursive: true });
  const file = at('silver/showcase.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  doc.logical.relationships = [];
  // Two tables keyed alike, so nothing says which way their link points.
  doc.logical.models.push('vehicle', 'registration');
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(at('logical-models/vehicle.yml'), 'name: vehicle\ncolumns:\n  - name: vin\n    dataType: VARCHAR\n    isPrimaryKey: true\n  - name: make\n    dataType: VARCHAR\n');
  fs.writeFileSync(at('logical-models/registration.yml'), 'name: registration\ncolumns:\n  - name: vin\n    dataType: VARCHAR\n    isPrimaryKey: true\n  - name: plate\n    dataType: VARCHAR\n');
  extra?.();
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-suggest-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  (vscode.window.tabGroups.activeTabGroup as { activeTab: unknown }).activeTab = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Suggest Relationships on a DBML project', () => {
  it('the review: strong ticked; OK writes only the ticked one, as one edit, in the relationships file a hand-drawn one goes to', async () => {
    useDbmlProject();
    const provider = buildProvider();
    await open(provider, 'gold/diagrams/sales.dbml');
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;
    const before = read('gold/diagrams/sales.dbml');

    const outcome = await provider.suggestRelationships();

    expect(ui.reviews).toHaveLength(1);
    const review = ui.reviews[0];
    expect(review.title).toBe('Suggested relationships for sales');
    expect(rows(review).map((r) => [r.label, r.picked])).toEqual([
      ['fct_order.customer_key → customer_profile.customer_key', true],
      ['fct_order.order_date_key → dim_date.date_key', false],
      ['fct_order.ship_date_key → dim_date.date_key', false],
      ['fct_order.region_code, country_code → dim_region.region_code, country_code', false],
    ]);
    expect(outcome).toEqual({ written: 1, dropped: 0 });
    expect(_appliedEdits).toHaveLength(1);
    expect(writtenPaths()).toEqual(['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(read('gold/relationships/gold.dbml')).toContain('Ref: gold.fct_order.customer_key >? gold.customer_profile.customer_key');
    expect(read('gold/relationships/gold.dbml').split('\n').filter((l) => l.startsWith('Ref'))).toEqual(['Ref: gold.fct_order.customer_key >? gold.customer_profile.customer_key']);
    // The diagram imports the file already: its bytes are untouched.
    expect(read('gold/diagrams/sales.dbml')).toBe(before);
    expect(ui.infos).toEqual(['Added 1 relationship to sales. Edit > Undo takes it back.']);
    expect(ui.errors).toEqual([]);
  });

  it('several accepted (a composite among them): still ONE WorkspaceEdit, one undo step; the composite is one Ref', async () => {
    useDbmlProject();
    const provider = buildProvider();
    await open(provider, 'gold/diagrams/sales.dbml');
    const ui = fakeUi((r) => rows(r).filter((row) => !row.label.startsWith('fct_order.customer_key')).map((row) => row.id));
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;

    expect(await provider.suggestRelationships()).toEqual({ written: 3, dropped: 0 });
    expect(_appliedEdits).toHaveLength(1);
    const refs = read('gold/relationships/gold.dbml').split('\n').filter((l) => l.startsWith('Ref'));
    expect(refs).toEqual(expect.arrayContaining([
      'Ref: gold.fct_order.(region_code, country_code) >? gold.dim_region.(region_code, country_code)',
    ]));
    expect(refs.filter((l) => l.includes('calendar.dim_date.date_key'))).toHaveLength(2);
    expect(ui.infos).toEqual(['Added 3 relationships to sales. Edit > Undo takes them all back.']);
  });

  it('cancelled (Esc on the list, or OK with nothing ticked): nothing is written', async () => {
    useDbmlProject();
    const provider = buildProvider();
    await open(provider, 'gold/diagrams/sales.dbml');
    _appliedEdits.length = 0;
    const before = read('gold/relationships/gold.dbml');
    provider.useSuggestionUi(fakeUi(() => undefined));
    expect(await provider.suggestRelationships()).toBe('cancelled');
    provider.useSuggestionUi(fakeUi(() => []));
    expect(await provider.suggestRelationships()).toBe('cancelled');
    expect(_appliedEdits).toHaveLength(0);
    expect(read('gold/relationships/gold.dbml')).toBe(before);
  });

  it('a relationships file that does not read: the planner refuses the add, and its message is shown; nothing is written', async () => {
    useDbmlProject();
    const provider = buildProvider();
    await open(provider, 'gold/diagrams/sales.dbml');
    fs.appendFileSync(at('gold/relationships/customers.dbml'), '\nRef: this is not dbml (\n');
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;
    const before = read('gold/relationships/gold.dbml');
    // The library reads the files again (a watcher would).
    (provider as unknown as { tableLibraryService: TableLibraryService }).tableLibraryService.invalidateCache();

    expect(await provider.suggestRelationships()).toBe('notWritten');
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toMatch(/^Couldn't add the suggested relationships: .*customers\.dbml/);
    expect(read('gold/relationships/gold.dbml')).toBe(before);
    expect(ui.infos).toEqual([]);
  });

  it('an edit in flight: the write waits for it, checks the list again, and leaves out what it drew', async () => {
    useDbmlProject();
    const provider = buildProvider();
    const panel = await open(provider, 'gold/diagrams/sales.dbml');
    let inFlight: Promise<void> | undefined;
    // While the list is open, the same link is drawn by hand on the canvas.
    const ui = fakeUi(
      (r) => idsWhere((l) => l.startsWith('fct_order.customer_key') || l.startsWith('fct_order.order_date_key'))(r),
      [],
      () => {
        inFlight = panel._simulateMessage({ type: 'addRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } }) as Promise<void>;
      },
    );
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;

    const outcome = await provider.suggestRelationships();
    await inFlight;
    expect(outcome).toEqual({ written: 1, dropped: 1 });
    // The hand-drawn edit, then the suggestions' one edit.
    expect(_appliedEdits).toHaveLength(2);
    const refs = read('gold/relationships/gold.dbml').split('\n').filter((l) => l.startsWith('Ref'));
    expect(refs.filter((l) => l.includes('order_date_key'))).toHaveLength(1);
    expect(refs.some((l) => l.includes('fct_order.customer_key'))).toBe(true);
    expect(ui.infos).toEqual(['Added 1 relationship to sales. Edit > Undo takes it back. 1 you picked no longer applied and was left out.']);
  });

  it('no canvas on screen: says so, writes nothing', async () => {
    useDbmlProject();
    const provider = buildProvider();
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    expect(await provider.suggestRelationships()).toBe('noCanvas');
    expect(ui.infos).toEqual(['Open a diagram first: Suggest Relationships works on the diagram on screen.']);
    expect(ui.reviews).toHaveLength(0);
  });

  it('a diagram where nothing is left to suggest: says so', async () => {
    fs.cpSync(path.join(FIXTURES, 'dbml-native'), root, { recursive: true });
    const provider = buildProvider();
    await open(provider, 'gold/diagrams/sales.dbml');
    // Every link the engine would make is drawn already, except the composite and the role-playing ones: draw those too.
    const ui = fakeUi((r) => rows(r).map((row) => row.id));
    provider.useSuggestionUi(ui);
    await provider.suggestRelationships();
    const again = fakeUi();
    provider.useSuggestionUi(again);
    expect(await provider.suggestRelationships()).toBe('none');
    expect(again.infos).toEqual(['No relationships to suggest for sales. ERD Studio looks for columns named after another table on the diagram, or after its key.']);
  });
});

describe('Suggest Relationships on a YAML project (relationships kept in the YAML table files)', () => {
  it('strong ticked and written as a hand-drawn one is: in each foreign-key table\'s file, as one edit', async () => {
    useYamlProject();
    const provider = buildProvider();
    await open(provider, 'silver/showcase.json');
    // The direction question would come for the vehicle/registration row only if ticked: it is not (possible).
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;

    const outcome = await provider.suggestRelationships();
    expect(rows(ui.reviews[0]).filter((r) => r.picked)).toHaveLength(6);
    expect(ui.reviews[0].sections.map((s) => s.group)).toEqual(['strong', 'likely', 'direction']);
    // A dbt project: the strong heading may name dbt's tests.
    expect(ui.reviews[0].sections[0].label).toBe('Strong: a key or a dbt test backs these');
    expect(outcome).toEqual({ written: 6, dropped: 0 });
    expect(_appliedEdits).toHaveLength(1);
    // The FK tables' files, and the diagram (the undo anchor), as one WorkspaceEdit.
    expect(writtenPaths()).toEqual(['logical-models/dim_task.yml', 'logical-models/fct_order.yml', 'logical-models/fct_task_event.yml', 'silver/showcase.json']);
    expect(JSON.parse(read('silver/showcase.json')).logical.relationships).toEqual([]);
    const library = new TableLibraryService(root, '.erd-studio');
    const stored = ['dim_task', 'fct_order', 'fct_task_event'].flatMap((m) => (library.getTable(m)!.relationships ?? []).map((r) => ({ ...r, fromModel: m })));
    expect(stored.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}:${r.cardinality}`).sort()).toEqual([
      'dim_task.project_key>dim_project.project_key:many-to-one',
      'fct_order.customer_key>dim_customer.customer_key:many-to-one',
      'fct_order.project_key>dim_project.project_key:many-to-one',
      'fct_task_event.customer_key>dim_customer.customer_key:many-to-one',
      'fct_task_event.project_key>dim_project.project_key:many-to-one',
      'fct_task_event.task_key>dim_task.task_key:many-to-one',
    ]);
    // Comments and key order survive: the yml is edited in place.
    expect(read('logical-models/fct_order.yml')).toMatch(/^name: fct_order\ndescription: Order transaction fact table\n/);
    expect(ui.questions).toEqual([]);
  });

  it('a direction nothing decides: asked with the New Relationship dialog\'s words; Skip writes nothing for it', async () => {
    useYamlProject();
    const provider = buildProvider();
    await open(provider, 'silver/showcase.json');
    const ui = fakeUi(idsWhere((l) => l.includes('vin')), ['skip']);
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;
    const before = read('silver/showcase.json');

    expect(await provider.suggestRelationships()).toBe('cancelled');
    expect(ui.questions).toHaveLength(1);
    const q = ui.questions[0];
    expect(q.title).toBe(DIRECTION_QUESTION);
    const ends = [{ model: 'registration', columns: ['vin'] }, { model: 'vehicle', columns: ['vin'] }];
    expect(q.items.map((i) => i.label)).toEqual([
      directionChoice(ends[0], ends[1], 'one-to-one').text,
      directionChoice(ends[1], ends[0], 'one-to-one').text,
      'Skip this one',
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(read('silver/showcase.json')).toBe(before);
  });

  it('a direction answered the other way round: written turned round; Esc on the question cancels everything', async () => {
    useYamlProject();
    const provider = buildProvider();
    await open(provider, 'silver/showcase.json');
    provider.useSuggestionUi(fakeUi((r) => rows(r).filter((row) => row.picked || row.label.includes('vin')).map((row) => row.id), [undefined]));
    _appliedEdits.length = 0;
    expect(await provider.suggestRelationships()).toBe('cancelled');
    expect(_appliedEdits).toHaveLength(0);

    provider.useSuggestionUi(fakeUi(idsWhere((l) => l.includes('vin')), ['reversed']));
    expect(await provider.suggestRelationships()).toEqual({ written: 1, dropped: 0 });
    expect(new TableLibraryService(root, '.erd-studio').getTable('vehicle')!.relationships).toEqual([
      expect.objectContaining({ fromColumn: 'vin', toModel: 'registration', toColumn: 'vin', cardinality: 'one-to-one' }),
    ]);
    expect(new TableLibraryService(root, '.erd-studio').getTable('registration')!.relationships ?? []).toEqual([]);
  });

  it('the physical stage writes nothing and says relationships are added on the Logical tab', async () => {
    useYamlProject();
    const provider = buildProvider();
    const panel = await open(provider, 'silver/showcase.json');
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;
    expect(await provider.suggestRelationships()).toBe('physical');
    expect(ui.infos).toEqual(['Relationships are added on the Logical tab. Switch to it, then run Suggest Relationships again.']);
    expect(ui.reviews).toHaveLength(0);
    expect(_appliedEdits).toHaveLength(0);
  });

  it('a diagram file that does not read: says so, writes nothing', async () => {
    useYamlProject();
    const provider = buildProvider();
    await open(provider, 'silver/showcase.json');
    fs.writeFileSync(at('silver/showcase.json'), '{ "schemaVersion": 5, "logical": ');
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    _appliedEdits.length = 0;
    expect(await provider.suggestRelationships()).toBe('unreadable');
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toMatch(/^Can't suggest relationships: showcase doesn't read \(.+\)\. Fix it, then try again\.$/);
    expect(_appliedEdits).toHaveLength(0);
  });

  it('a diagram with no tables: says there is nothing to suggest', async () => {
    useYamlProject(() => {
      const file = at('silver/showcase.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      doc.logical.models = [];
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    });
    const provider = buildProvider();
    await open(provider, 'silver/showcase.json');
    const ui = fakeUi();
    provider.useSuggestionUi(ui);
    expect(await provider.suggestRelationships()).toBe('noTables');
    expect(ui.infos).toEqual(['showcase has no tables yet, so there is nothing to suggest.']);
  });
});

describe('the offer after an import', () => {
  function stubInfo(answer?: string): string[] {
    const shown: string[] = [];
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (text: string) => {
      shown.push(String(text));
      return String(text).includes('ERD Studio found') ? answer : undefined;
    }) as never);
    return shown;
  }

  it('an imported diagram with no relationships: offered once when its canvas opens; Review Suggestions runs the review', async () => {
    useDbmlProject();
    // As an import leaves it: no Ref at all between the diagram's tables.
    for (const f of ['gold/relationships/customers.dbml', 'silver/relationships/calendar.dbml']) fs.writeFileSync(at(f), read(f).replace(/^Ref.*\n/gm, ''));
    const shown = stubInfo('Review Suggestions');
    const provider = buildProvider({ offers: true });
    const ui = fakeUi(() => undefined);
    provider.useSuggestionUi(ui);
    provider.offerSuggestionsWhenOpened(at('gold/diagrams/sales.dbml'));
    const panel = await open(provider, 'gold/diagrams/sales.dbml');
    await vi.waitFor(() => expect(ui.reviews).toHaveLength(1));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toEqual(['This diagram has no relationships yet. ERD Studio found 5 it can suggest.']);
    // Never twice for one diagram in a session, nor on a plain open.
    provider.offerSuggestionsWhenOpened(at('gold/diagrams/sales.dbml'));
    await panel._simulateMessage({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toHaveLength(1);
  });

  it('not offered when the diagram already has relationships, nor without an import, nor after Don\'t Ask Again', async () => {
    useDbmlProject();
    const shown = stubInfo();
    const provider = buildProvider({ offers: true });
    // customers.dbml and calendar.dbml still hold Refs between the diagram's tables.
    provider.offerSuggestionsWhenOpened(at('gold/diagrams/sales.dbml'));
    await open(provider, 'gold/diagrams/sales.dbml');
    await new Promise((r) => setTimeout(r, 20));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    useDbmlProject();
    for (const f of ['gold/relationships/customers.dbml', 'silver/relationships/calendar.dbml']) fs.writeFileSync(at(f), read(f).replace(/^Ref.*\n/gm, ''));
    const plain = buildProvider({ offers: true });
    await open(plain, 'gold/diagrams/sales.dbml');
    await new Promise((r) => setTimeout(r, 20));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toEqual([]);

    const declined = buildProvider({ offers: false });
    declined.offerSuggestionsWhenOpened(at('gold/diagrams/sales.dbml'));
    await open(declined, 'gold/diagrams/sales.dbml');
    await new Promise((r) => setTimeout(r, 20));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toEqual([]);
  });

  it('held back while the onboarding guide runs on the canvas, then made when it ends', async () => {
    useDbmlProject();
    for (const f of ['gold/relationships/customers.dbml', 'silver/relationships/calendar.dbml']) fs.writeFileSync(at(f), read(f).replace(/^Ref.*\n/gm, ''));
    const shown = stubInfo();
    const provider = buildProvider({ offers: true });
    let guideTaken = false;
    provider.setOnboardingGuide({
      takeCanvas: () => (guideTaken ? undefined : (guideTaken = true, { dbml: true, semanticDir: '.erd-studio' } as never)),
      startOnCanvas: () => ({ dbml: true, semanticDir: '.erd-studio' } as never),
      onCanvasAction: () => {},
    });
    provider.offerSuggestionsWhenOpened(at('gold/diagrams/sales.dbml'));
    const panel = await open(provider, 'gold/diagrams/sales.dbml');
    await new Promise((r) => setTimeout(r, 20));
    expect(shown.filter((m) => m.includes('ERD Studio found'))).toEqual([]);
    await panel._simulateMessage({ type: 'guide', payload: { action: 'complete' } });
    await vi.waitFor(() => expect(shown.filter((m) => m.includes('ERD Studio found'))).toHaveLength(1));
  });
});
