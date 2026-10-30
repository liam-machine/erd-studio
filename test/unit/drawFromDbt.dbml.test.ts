/**
 * Draw from dbt in an existing DBML project (native DBML storage, S6, §5.7,
 * §9.6 "DBML-project cases"): end to end through `drawFromDbt` on a copy of
 * `test/fixtures/dbml-native`, with the real services. The new diagram is a
 * `.dbml`, its relationships go to the library, another diagram whose member's
 * folder gains a relationships file is settled, the skip reasons and any
 * relationship it cannot store are named, and a settle target with unsaved
 * edits stops it before anything is written.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createMockTextDocument, _resetMockWorkspace } from '../__mocks__/vscode';
import type { DbtDraft } from '../../src/services/dbtDraft';
import { compileDbmlProject, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

const draft = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/dbtDraft')>()),
  listDraftModels: () => [{ name: 'fct_visit' }, { name: 'dim_store' }],
  listDraftScopes: () => [],
  buildDbtDraft: () => draft.value,
}));
vi.mock('../../src/providers/dbtDraftPicker', () => ({
  pickDraftScope: async () => ({ scope: { label: 'All models', suggestedLayer: 'silver' }, modelNames: ['fct_visit', 'dim_store'] }),
}));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { LayerService } from '../../src/services/layerService';
import { SubjectAreaService } from '../../src/services/domainService';
import { TableLibraryService } from '../../src/services/logicalModelService';

const DBML_NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');

let tmp: string;
const erd = (...p: string[]): string => path.join(tmp, '.erd-studio', ...p);

function deps(): DrawFromDbtDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    modelPaths: ['models'],
    layerService,
    subjectAreaService,
    tableLibraryService,
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
  };
}

/** Every file under the semantic dir, posix, with its bytes. */
function snapshot(): Map<string, string> {
  return new Map((fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => [f.split(path.sep).join('/'), fs.readFileSync(erd(f), 'utf-8')]));
}

const STORE = 'Table silver.dim_store {\n  store_key INT [pk]\n}\n';
// A diagram that shows dim_store, and fct_visit before it has a table file (erd_unlinked_tables, D26).
const PLAIN = "use { table silver.dim_store } from '../tables/silver/dim_store.dbml'\n\nProject plain {\n  erd_schema_version: '7'\n  erd_unlinked_tables: 'fct_visit'\n}\n";

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-draw-dbml-'));
  fs.cpSync(DBML_NATIVE, tmp, { recursive: true });
  // silver/tables/silver/ holds one table and silver has no relationships file of its own yet; silver/diagrams/plain.dbml uses it.
  fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
  fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_store.dbml'), STORE);
  fs.writeFileSync(erd('silver', 'diagrams', 'plain.dbml'), PLAIN);
  draft.value = {
    modelNames: ['fct_visit', 'dim_store'],
    newModels: [{ name: 'fct_visit', columns: [{ name: 'visit_key', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'store_key', dataType: 'INT', description: '' }] }],
    reusedModels: ['dim_store'],
    relationships: [
      { fromModel: 'fct_visit', fromColumn: 'store_key', toModel: 'dim_store', toColumn: 'store_key', cardinality: 'many-to-one' },
      // Its many side has no readable file: a DBML diagram has nowhere to keep it.
      { fromModel: 'ghost', fromColumn: 'store_key', toModel: 'dim_store', toColumn: 'store_key', cardinality: 'many-to-one' },
    ],
    skipped: [{ name: 'dim_yaml', reason: 'yaml-table' }, { name: '_relationships', reason: 'reserved-name' }],
    truncated: false,
  } satisfies DbtDraft;
  vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('visits' as never);
  vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Draw from dbt in a DBML project', () => {
  it('writes a .dbml diagram, stores the relationship in the library, settles the other diagram and names what it left out', async () => {
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    const result = await drawFromDbt(deps());

    expect(error).not.toHaveBeenCalled();
    expect(result?.domainPath).toBe(erd('silver', 'diagrams', 'visits.dbml'));
    expect(fs.existsSync(erd('silver', 'visits.json'))).toBe(false);
    expect(fs.readFileSync(erd('silver', 'tables', 'silver', 'fct_visit.dbml'), 'utf-8')).toMatch(/^Table silver\.fct_visit/m);
    const rels = fs.readFileSync(erd('silver', 'relationships', 'silver.dbml'), 'utf-8');
    expect(rels).toContain('Ref: silver.fct_visit.store_key >? silver.dim_store.store_key');
    expect(rels).not.toContain('ghost');
    expect(fs.readFileSync(erd('silver', 'diagrams', 'visits.dbml'), 'utf-8')).toContain("use * from '../relationships/silver.dbml'");
    // The other diagram, which listed fct_visit before it had a file, gains its use line and the relationships file.
    const plain = fs.readFileSync(erd('silver', 'diagrams', 'plain.dbml'), 'utf-8');
    expect(plain).toMatch(/^use \{ table silver\.fct_visit \} +from '\.\.\/tables\/silver\/fct_visit\.dbml'$/m);
    expect(plain).toContain("use * from '../relationships/silver.dbml'");
    expect(plain).not.toContain('erd_unlinked_tables');
    // The skip reasons and the relationship it could not store, in one notice.
    const notice = String(info.mock.calls.at(-1)?.[0]);
    expect(notice).toContain("Skipped dim_yaml: a YAML table can't join a DBML diagram; convert the project first.");
    expect(notice).toContain('Skipped _relationships:');
    expect(notice).toContain("Not stored, because a table's file could not be read: ghost.store_key → dim_store.store_key.");

    const texts = Object.fromEntries([...snapshot()].filter(([f]) => f.endsWith('.dbml')));
    const diagrams = Object.keys(texts).filter((f) => f.split('/')[1] === 'diagrams');
    for (const parser of [v9 as unknown as DbmlParserModule, v10 as unknown as DbmlParserModule, undefined]) {
      expect(Object.values(compileDbmlProject(texts, diagrams, parser)).flat()).toEqual([]);
    }
  });

  it('refuses, naming the file, when a diagram it would settle has unsaved edits, and writes nothing', async () => {
    const tab = createMockTextDocument(erd('silver', 'diagrams', 'plain.dbml'), PLAIN);
    tab._setText(`${PLAIN}// my unsaved note\n`);
    (vscode.workspace.textDocuments as unknown[]).push(tab);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const before = snapshot();

    await expect(drawFromDbt(deps())).resolves.toBeUndefined();

    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      'Draw from dbt: silver/diagrams/plain.dbml has unsaved changes. Save or revert it, then try again. Nothing was changed.',
    ]);
    expect(snapshot()).toEqual(before);
    expect(tab.getText()).toBe(`${PLAIN}// my unsaved note\n`);
  });
});

describe('Draw from dbt: where a new DBML table goes (§2.4)', () => {
  const visit = { name: 'fct_visit', columns: [{ name: 'visit_key', dataType: 'INT', description: '', isPrimaryKey: true }] };

  it('a model with a dbt custom schema (configuredSchema) goes in that schema\'s folder of the layer, never the schema it is built in', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    draft.value = {
      modelNames: ['fct_visit'],
      newModels: [{ ...visit, schema: 'dbt_liam_finance', configuredSchema: 'finance' }],
      reusedModels: [], relationships: [], skipped: [], truncated: false,
    } satisfies DbtDraft;
    const result = await drawFromDbt(deps());
    expect(result?.domainPath).toBe(erd('silver', 'diagrams', 'visits.dbml'));
    expect(fs.readFileSync(erd('silver', 'tables', 'finance', 'fct_visit.dbml'), 'utf-8')).toMatch(/^Table finance\.fct_visit \{/);
    expect(fs.existsSync(erd('silver', 'tables', 'dbt_liam_finance'))).toBe(false);
    expect(fs.readFileSync(erd('silver', 'diagrams', 'visits.dbml'), 'utf-8')).toMatch(/^use \{ table finance\.fct_visit \} +from '\.\.\/tables\/finance\/fct_visit\.dbml'$/m);
  });

  it('a mixed project (layers bronze/silver/gold, a flat YAML library, gold/tables/gold/): the new table goes to the chosen layer\'s tables', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    fs.rmSync(erd(), { recursive: true });
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.writeFileSync(erd('layers.json'), `${JSON.stringify({ schemaVersion: 1, layers: ['bronze', 'silver', 'gold'].map((id, order) => ({ id, label: id[0].toUpperCase() + id.slice(1), color: '#888888', creatable: true, order })) }, null, 2)}\n`);
    fs.writeFileSync(erd('logical-models', 'dim_a.yml'), 'name: dim_a\ncolumns:\n  - name: id\n    dataType: INT\n    description: ""\n');
    fs.mkdirSync(erd('gold', 'tables', 'gold'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'gold', 'fct_x.dbml'), 'Table gold.fct_x {\n  id INT [pk]\n}\n');
    draft.value = { modelNames: ['fct_visit'], newModels: [visit], reusedModels: [], relationships: [], skipped: [], truncated: false } satisfies DbtDraft;
    const pick = { scope: { label: 'All models', suggestedLayer: 'gold' }, modelNames: ['fct_visit'] };
    const result = await drawFromDbt(deps(), { pick, layer: 'gold' } as never);
    expect(result?.domainPath).toBe(erd('gold', 'diagrams', 'visits.dbml'));
    expect(fs.readFileSync(erd('gold', 'tables', 'gold', 'fct_visit.dbml'), 'utf-8')).toMatch(/^Table gold\.fct_visit \{/);
    expect(fs.existsSync(erd('logical-models', 'gold'))).toBe(false);
    expect(fs.existsSync(erd('logical-models', 'fct_visit.yml'))).toBe(false);
  });
});
