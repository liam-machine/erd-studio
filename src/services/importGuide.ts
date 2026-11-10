/**
 * **Bring In Your Data Model…** (`erdStudio.showImportGuide`): the
 * guide to turning the model a team already has — in Databricks, Snowflake,
 * Power BI, Fabric, SQL Server, PostgreSQL, MySQL, a DBML tool or another
 * modelling tool — into DBML, an open format, with ERD Studio's own imports.
 *
 * One card per source: what to export, the exact step or command (a **Copy**
 * button on each command), and the button that runs the right import with
 * the source preselected — Import SQL DDL… with its dialect, Import Semantic
 * Model…, Import DBML…, Import…, Import from dbt (its card only in a dbt
 * project) — and a **Not yet** card (live connections) whose Send Feedback
 * lets people ask for theirs. Oracle, BigQuery, Redshift and SQLite scripts
 * are read by Import SQL DDL… (the other-tools card's Import…); they have no
 * card of their own yet, as each card's button is a telemetry key. The folder's suggested
 * start (`startIntentFor`) leads: a "Found in this folder" card for a direct
 * import, the dbt card in a dbt project; then the sources in the order
 * telemetry sees them.
 *
 * Every command, argument and snippet is a fixed constant here: the page
 * posts only an action id, a snippet id or `openFolder` (validated by
 * {@link isImportGuideToHost}); nothing it sends is ever run or copied as
 * given. Nonce-only CSP, no remote resource, `--vscode-*` colours only. The
 * page writes nothing; each import asks its own questions and shows its dry
 * run before it writes.
 *
 * Pure and vscode-free; the host half is `src/providers/ImportGuidePanel.ts`.
 */

import { escapeHtml } from './dbmlConversionReview';
import type { SqlDialect } from './sqlDdlImport';
import type { TelemetryFeature } from './telemetryPayload';
import {
  IMPORT_GUIDE_COMMAND,
  IMPORT_GUIDE_LABEL,
  START_ACTION_COMMANDS,
  START_INTENT_REASONS,
  importGuideCommandLink,
  startActionArgs,
  type StartIntent,
} from '../types/startActions';

export { IMPORT_GUIDE_COMMAND, IMPORT_GUIDE_LABEL, importGuideCommandLink };
/** The command's title, as the palette names it (category ERD Studio): the guide's one label. */
export const IMPORT_GUIDE_COMMAND_TITLE = IMPORT_GUIDE_LABEL;
export const IMPORT_GUIDE_VIEW_TYPE = 'erdStudio.importGuide';
/** The tab's title: the same words, without the ellipsis. */
export const IMPORT_GUIDE_TITLE = IMPORT_GUIDE_LABEL.replace(/…$/, '');

// ---------------------------------------------------------------------------
// Where it was opened from (the command's one optional argument)
// ---------------------------------------------------------------------------

/**
 * The surfaces that link the guide: the Welcome panel's start card, the
 * walkthrough's blank start step, the empty Diagrams view's blank variant,
 * Import…'s picker, the start quick pick, the nothing-found notification
 * (no longer shown: kept so an old link still counts) and a draft's Other
 * Ways to Start (`draft`). The palette passes nothing.
 */
export const IMPORT_GUIDE_SURFACES = ['welcome', 'walkthrough', 'sidebar', 'picker', 'startPick', 'prompt', 'draft'] as const;
export type ImportGuideSurface = (typeof IMPORT_GUIDE_SURFACES)[number];

/** The command's argument: `{ from }`, or undefined for anything else (the palette, a stray value). */
export function parseImportGuideArgs(arg: unknown): ImportGuideSurface | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const from = (arg as { from?: unknown }).from;
  return (IMPORT_GUIDE_SURFACES as readonly unknown[]).includes(from) ? from as ImportGuideSurface : undefined;
}

/** The last item of Import…'s picker and of the start quick pick ("More ways to start…"). */
export const IMPORT_GUIDE_PICK_ITEM = {
  label: `$(question) ${IMPORT_GUIDE_LABEL}`,
  detail: 'How to export from Databricks, Snowflake, Power BI, Fabric and more',
} as const;

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

export type ImportGuideCardId =
  | 'found' | 'dbt' | 'databricks' | 'snowflake' | 'powerBi' | 'fabric'
  | 'sqlServer' | 'postgres' | 'mysql' | 'dbml' | 'otherTools' | 'notYet';

/** What a card's button does: one fixed command each. */
export const IMPORT_GUIDE_ACTIONS = [
  'found', 'dbt', 'databricks', 'snowflake', 'powerBi', 'fabric', 'fabricWarehouse',
  'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools', 'feedback',
] as const;
export type ImportGuideAction = (typeof IMPORT_GUIDE_ACTIONS)[number];

/** The text each Copy button copies, exactly. */
export const IMPORT_GUIDE_SNIPPETS = {
  databricksSchema: [
    'catalog, schema = "main", "sales"  # your catalog and schema',
    'tables = spark.sql(f"""',
    '  SELECT table_name FROM {catalog}.information_schema.tables',
    "  WHERE table_schema = '{schema}' AND table_type IN ('MANAGED', 'EXTERNAL')",
    '""").collect()',
    'for t in tables:',
    '    ddl = spark.sql(f"SHOW CREATE TABLE `{catalog}`.`{schema}`.`{t.table_name}`").first()[0]',
    '    print(ddl.rstrip().rstrip(";") + ";\\n")',
  ].join('\n'),
  snowflakeSchema: "SELECT GET_DDL('SCHEMA', '<database>.<schema>');",
  postgres: 'pg_dump --schema-only --no-owner --no-privileges -d <database> -f schema.sql',
  mysql: 'mysqldump --no-data --result-file=schema.sql <database>',
} as const satisfies Record<string, string>;
export type ImportGuideSnippet = keyof typeof IMPORT_GUIDE_SNIPPETS;

/** One step: plain text (`code` in backticks), and the command to copy, if any. */
export interface ImportGuideStep {
  text: string;
  snippet?: ImportGuideSnippet;
}

/**
 * A part of a card: its steps, any notes, and the button that imports what
 * they made. Steps are consecutive actions: one step shows on its own, never
 * as "1."; only two or more are numbered. An alternative or a fallback (a
 * whole database instead of a schema, an option Power BI hides) is a note,
 * shown quietly after the steps, never a numbered step. Getting the DDL out
 * is one step, at schema or database grain, never one table at a time.
 */
export interface ImportGuideSection {
  heading?: string;
  steps: readonly ImportGuideStep[];
  notes?: readonly string[];
  action: ImportGuideAction;
}

export interface ImportGuideCard {
  id: ImportGuideCardId;
  title: string;
  /** What to export, in a sentence or two. */
  what: string;
  sections: readonly ImportGuideSection[];
}

/** Each button's label: says which import runs, and for SQL which dialect it reads. */
export const IMPORT_GUIDE_ACTION_LABELS: Readonly<Record<Exclude<ImportGuideAction, 'found'>, string>> = {
  dbt: 'Import from dbt',
  databricks: 'Import Databricks DDL…',
  snowflake: 'Import Snowflake DDL…',
  powerBi: 'Import Semantic Model…',
  fabric: 'Import Semantic Model…',
  fabricWarehouse: 'Import SQL Server DDL…',
  sqlServer: 'Import SQL Server DDL…',
  postgres: 'Import PostgreSQL DDL…',
  mysql: 'Import MySQL DDL…',
  dbml: 'Import DBML…',
  otherTools: 'Import…',
  feedback: 'Send Feedback',
};

/** The "Found in this folder" card's button: the start surfaces' own label for that import. */
export const IMPORT_GUIDE_FOUND_LABELS: Readonly<Record<FoundIntent, string>> = {
  importSqlDdl: 'Import your SQL scripts',
  importSemanticModel: 'Import your Power BI semantic model',
  importDbmlFile: 'Import your DBML file',
};

/** The suggestions that lead the guide with a "Found in this folder" card: the three direct imports. */
export type FoundIntent = 'importSqlDdl' | 'importSemanticModel' | 'importDbmlFile';
export function isFoundIntent(intent: StartIntent | undefined): intent is FoundIntent {
  return intent === 'importSqlDdl' || intent === 'importSemanticModel' || intent === 'importDbmlFile';
}

const FOUND_TEXT: Readonly<Record<FoundIntent, string>> = {
  importSqlDdl: 'ERD Studio works out which SQL dialect they are written in: PostgreSQL, MySQL, SQL Server, Snowflake, Databricks, Oracle, BigQuery, Redshift or SQLite.',
  importSemanticModel: 'Its tables, columns and relationships become a diagram; measures stay in Power BI.',
  importDbmlFile: 'Its tables and relationships become a diagram.',
};

/** The SQL import for each SQL card, with its dialect chosen (`erdStudio.importSqlDdl` with `{ dialect }`). */
export const IMPORT_GUIDE_SQL_DIALECTS: Readonly<Partial<Record<ImportGuideAction, SqlDialect>>> = {
  databricks: 'databricks',
  snowflake: 'snowflake',
  fabricWarehouse: 'sqlserver',
  sqlServer: 'sqlserver',
  postgres: 'postgres',
  mysql: 'mysql',
};

/** The fixed Send Feedback prefill of the Not yet card (`erdStudio.reportBug`'s argument). */
export const IMPORT_GUIDE_FEEDBACK_PREFILL = {
  kind: 'feature',
  title: 'Import from another source',
  description: 'I would like to bring in my data model from: ',
} as const;

/**
 * The command (and arguments) each button runs: fixed here, never from the
 * page. `found` runs the suggestion's own quick import; without a direct
 * import suggested it runs nothing (undefined).
 */
export function importGuideActionCommand(action: ImportGuideAction, intent: StartIntent | undefined): { command: string; args: unknown[] } | undefined {
  const dialect = IMPORT_GUIDE_SQL_DIALECTS[action];
  if (dialect) return { command: 'erdStudio.importSqlDdl', args: [{ dialect }] };
  switch (action) {
    case 'found':
      return isFoundIntent(intent) ? { command: START_ACTION_COMMANDS[intent], args: startActionArgs(intent) } : undefined;
    case 'dbt':
      return { command: 'erdStudio.drawFromDbt', args: [] };
    case 'powerBi':
    case 'fabric':
      return { command: 'erdStudio.importSemanticModel', args: [] };
    case 'dbml':
      return { command: 'erdStudio.importDbml', args: [] };
    case 'otherTools':
      return { command: 'erdStudio.importModel', args: [] };
    case 'feedback':
      return { command: 'erdStudio.reportBug', args: [{ ...IMPORT_GUIDE_FEEDBACK_PREFILL }] };
    default:
      return undefined;
  }
}

/** Whether a button needs an open folder (every import does; Send Feedback does not). */
export function importGuideActionNeedsFolder(action: ImportGuideAction): boolean {
  return action !== 'feedback';
}

/** The sources in the order the guide lists them after the suggestion (telemetry's, most used first). */
export const IMPORT_GUIDE_ORDER: readonly ImportGuideCardId[] = [
  'databricks', 'snowflake', 'powerBi', 'fabric', 'sqlServer', 'postgres', 'mysql', 'dbml', 'otherTools',
];

/** Where the guide stands: is a folder open, is it a dbt project, and what does it suggest. */
export interface ImportGuideContext {
  hasProject: boolean;
  hasDbt: boolean;
  intent?: StartIntent;
}

/**
 * The cards, in order: the folder's suggestion first (a "Found in this
 * folder" card for a direct import; the dbt card in a dbt project, the only
 * place it shows), then every source in {@link IMPORT_GUIDE_ORDER}, then Not
 * yet.
 */
export function importGuideCards(ctx: ImportGuideContext): ImportGuideCardId[] {
  const lead: ImportGuideCardId[] = [];
  if (ctx.hasProject && isFoundIntent(ctx.intent)) lead.push('found');
  if (ctx.hasProject && ctx.hasDbt) lead.push('dbt');
  return [...lead, ...IMPORT_GUIDE_ORDER, 'notYet'];
}

const SOURCE_CARDS: Readonly<Record<Exclude<ImportGuideCardId, 'found'>, ImportGuideCard>> = {
  dbt: {
    id: 'dbt',
    title: 'dbt',
    what: 'This folder is a dbt project: Import from dbt copies your dbt models and their relationship tests into a diagram, and the Physical tab compares your design with what dbt built.',
    sections: [{ steps: [{ text: 'Nothing to export: ERD Studio reads the project as it is.' }], action: 'dbt' }],
  },
  databricks: {
    id: 'databricks',
    title: 'Databricks (Unity Catalog)',
    what: 'Export the CREATE TABLE statements of a whole schema in one notebook cell. Declared PRIMARY KEY and FOREIGN KEY constraints become keys and relationships.',
    sections: [{
      steps: [
        { text: 'Run this in a Python notebook cell, with your catalog and schema, then copy what it prints into `schema.sql` in this folder.', snippet: 'databricksSchema' },
      ],
      action: 'databricks',
    }],
  },
  snowflake: {
    id: 'snowflake',
    title: 'Snowflake',
    what: 'Snowflake writes the DDL of a whole schema, or a whole database, in one call.',
    sections: [{
      steps: [
        { text: 'Run this in a worksheet, and copy the result into a `.sql` file in this folder.', snippet: 'snowflakeSchema' },
      ],
      notes: ["For a whole database: `SELECT GET_DDL('DATABASE', '<database>');`"],
      action: 'snowflake',
    }],
  },
  powerBi: {
    id: 'powerBi',
    title: 'Power BI',
    what: 'A report saved as a Power BI project keeps its semantic model in a `<Name>.SemanticModel` folder, which ERD Studio reads (TMDL or `model.bim`).',
    sections: [{
      steps: [
        { text: 'In Power BI Desktop, choose File → Save as, pick Power BI project files (`*.pbip`), and save it in this folder.' },
      ],
      notes: ['No such option? Turn on Power BI Project (.pbip) save option in File → Options and settings → Options → Preview features, then restart Power BI Desktop.'],
      action: 'powerBi',
    }],
  },
  fabric: {
    id: 'fabric',
    title: 'Microsoft Fabric',
    what: 'A semantic model comes in through Fabric\'s Git integration; a Warehouse or a Lakehouse\'s SQL analytics endpoint through its CREATE TABLE scripts.',
    sections: [
      {
        heading: 'Semantic model',
        steps: [
          { text: 'Connect the workspace to a Git repository (Workspace settings → Git integration) and commit. Each semantic model is a `<Name>.SemanticModel` folder in the repository: open the repository here.' },
        ],
        action: 'fabric',
      },
      {
        heading: 'Warehouse or SQL analytics endpoint',
        steps: [
          { text: 'Connect to its SQL connection string in SQL Server Management Studio, select the tables in Object Explorer Details (F7), right-click → Script Table as → CREATE To → File…, and save the `.sql` file in this folder. ERD Studio reads it as SQL Server.' },
        ],
        action: 'fabricWarehouse',
      },
    ],
  },
  sqlServer: {
    id: 'sqlServer',
    title: 'SQL Server and Azure SQL',
    what: 'SQL Server Management Studio scripts a database\'s tables, keys and foreign keys into one file.',
    sections: [{
      steps: [
        { text: 'Right-click the database → Tasks → Generate Scripts…, choose the tables, and on Set Scripting Options save to one file in this folder. Schema only is the default (Advanced → Types of data to script).' },
      ],
      action: 'sqlServer',
    }],
  },
  postgres: {
    id: 'postgres',
    title: 'PostgreSQL',
    what: 'pg_dump writes the schema without the data. Add `-n <schema>` for one schema.',
    sections: [{
      steps: [{ text: 'Run this in a terminal in this folder:', snippet: 'postgres' }],
      action: 'postgres',
    }],
  },
  mysql: {
    id: 'mysql',
    title: 'MySQL and MariaDB',
    what: 'mysqldump writes the tables without the data (MariaDB also calls it mariadb-dump). Add `-h`, `-u` and `-p` as you connect.',
    sections: [{
      steps: [{ text: 'Run this in a terminal in this folder:', snippet: 'mysql' }],
      action: 'mysql',
    }],
  },
  dbml: {
    id: 'dbml',
    title: 'dbdiagram.io and other DBML tools',
    what: 'DBML is the open-source schema language behind dbdiagram.io: ERD Studio imports it as it is.',
    sections: [{
      steps: [
        { text: 'dbdiagram.io: copy all the code from the editor into a file such as `model.dbml` in this folder.' },
      ],
      notes: ['Another DBML tool: save or export the `.dbml` file into this folder.'],
      action: 'dbml',
    }],
  },
  otherTools: {
    id: 'otherTools',
    title: 'Other modelling tools',
    what: 'erwin Data Modeler, ER/Studio, DbSchema, DBeaver, DataGrip, Visual Paradigm and most other tools can generate SQL DDL (often called forward engineering) or export DBML.',
    sections: [{
      steps: [
        { text: 'Generate the DDL for PostgreSQL, MySQL, SQL Server, Snowflake or Databricks (or export DBML), save it in this folder, then pick it in Import….' },
      ],
      notes: ['Oracle, BigQuery, Amazon Redshift and SQLite: save the CREATE TABLE scripts in this folder (a SQL*Plus script, `INFORMATION_SCHEMA.TABLES.ddl`, `SHOW TABLE` output, a `.schema` dump), then pick them in Import….'],
      action: 'otherTools',
    }],
  },
  notYet: {
    id: 'notYet',
    title: 'Not yet',
    what: 'Some sources do not come in yet. Tell us which one you need.',
    sections: [{
      steps: [
        { text: 'Live database connections: ERD Studio reads files you export, never a database.' },
      ],
      action: 'feedback',
    }],
  },
};

/** A card's content; the "Found in this folder" card follows the suggestion (undefined without a direct import). */
export function importGuideCard(id: ImportGuideCardId, intent?: StartIntent): ImportGuideCard | undefined {
  if (id !== 'found') return SOURCE_CARDS[id];
  if (!isFoundIntent(intent)) return undefined;
  return {
    id: 'found',
    title: 'Found in this folder',
    what: START_INTENT_REASONS[intent] ?? '',
    sections: [{ steps: [{ text: FOUND_TEXT[intent] }], action: 'found' }],
  };
}

/** A button's label (the found card's follows the suggestion). */
export function importGuideActionLabel(action: ImportGuideAction, intent?: StartIntent): string {
  if (action === 'found') return isFoundIntent(intent) ? IMPORT_GUIDE_FOUND_LABELS[intent] : '';
  return IMPORT_GUIDE_ACTION_LABELS[action];
}

// ---------------------------------------------------------------------------
// Telemetry: fixed keys only (never a name, a path or what was copied)
// ---------------------------------------------------------------------------

export const IMPORT_GUIDE_OPENED_FEATURE = 'importGuideOpened' satisfies TelemetryFeature;
export const IMPORT_GUIDE_COPIED_FEATURE = 'importGuideCopied' satisfies TelemetryFeature;

/** Where it was opened from, beside `importGuideOpened` (the palette has none). */
export const IMPORT_GUIDE_SURFACE_FEATURES: Readonly<Record<ImportGuideSurface, TelemetryFeature>> = {
  welcome: 'importGuideFromWelcome',
  walkthrough: 'importGuideFromWalkthrough',
  sidebar: 'importGuideFromSidebar',
  picker: 'importGuideFromPicker',
  startPick: 'importGuideFromStartPick',
  prompt: 'importGuideFromPrompt',
  draft: 'importGuideFromDraft',
};

/** Which card's button was pressed. */
export const IMPORT_GUIDE_ACTION_FEATURES: Readonly<Record<ImportGuideAction, TelemetryFeature>> = {
  found: 'importGuideActionFound',
  dbt: 'importGuideActionDbt',
  databricks: 'importGuideActionDatabricks',
  snowflake: 'importGuideActionSnowflake',
  powerBi: 'importGuideActionPowerBi',
  fabric: 'importGuideActionFabric',
  fabricWarehouse: 'importGuideActionFabricWarehouse',
  sqlServer: 'importGuideActionSqlServer',
  postgres: 'importGuideActionPostgres',
  mysql: 'importGuideActionMysql',
  dbml: 'importGuideActionDbml',
  otherTools: 'importGuideActionOtherTools',
  feedback: 'importGuideActionFeedback',
};

// ---------------------------------------------------------------------------
// The page's protocol
// ---------------------------------------------------------------------------

export type ImportGuideToHost =
  /** A card's button: the host runs that action's fixed command. */
  | { type: 'run'; action: ImportGuideAction }
  /** A Copy button: the host copies that snippet's fixed text. */
  | { type: 'copy'; snippet: ImportGuideSnippet }
  /** No folder open: VS Code's own folder picker. */
  | { type: 'openFolder' };

export function isImportGuideToHost(value: unknown): value is ImportGuideToHost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const msg = value as { type?: unknown; action?: unknown; snippet?: unknown };
  switch (msg.type) {
    case 'run':
      return (IMPORT_GUIDE_ACTIONS as readonly unknown[]).includes(msg.action);
    case 'copy':
      return typeof msg.snippet === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_GUIDE_SNIPPETS, msg.snippet);
    case 'openFolder':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

/** The page's intro: what it is for, in the wording rules' words. */
export const IMPORT_GUIDE_INTRO =
  'Turn the data model you already have into DBML, an open format your team can read, review and diff in Git.';
export const IMPORT_GUIDE_INTRO_DRY_RUN = 'Each import shows you a draft first: nothing is saved until you keep it.';
export const IMPORT_GUIDE_NO_FOLDER = 'Open the folder you keep your data model in first: each import saves into it.';

export function buildImportGuideCsp(nonce: string): string {
  return ["default-src 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ') + ';';
}

/** `code` in backticks becomes `<code>`; everything else is escaped text. */
function inline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code class="ig-code">$1</code>');
}

export const IMPORT_GUIDE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
.ig { max-width: 880px; margin: 0 auto; padding: 24px 24px 48px; }
.ig__heading { margin: 0 0 8px; font-size: 1.5em; font-weight: 600; }
.ig__intro { margin: 0 0 6px; line-height: 1.5; max-width: 72ch; }
.ig__note { margin: 0 0 6px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.ig__nofolder {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 14px 0 0; padding: 10px 14px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 4px;
}
.ig__nofolder-text { margin: 0; }
.ig__cards { display: grid; gap: 14px; margin: 20px 0 0; padding: 0; list-style: none; }
.ig-card {
  padding: 14px 16px; border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.ig-card--lead { border-color: var(--vscode-focusBorder); }
.ig-card__title { margin: 0 0 6px; font-size: 1.1em; font-weight: 600; }
.ig-card__what { margin: 0 0 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.ig-section { margin: 0 0 10px; }
.ig-section:last-child { margin-bottom: 0; }
.ig-section__heading { margin: 0 0 6px; font-weight: 600; }
.ig-steps { margin: 0 0 10px; padding: 0 0 0 20px; }
.ig-step { margin: 0 0 8px; line-height: 1.5; }
.ig-step--only { margin: 0 0 10px; }
.ig-note { margin: 0 0 10px; line-height: 1.5; font-size: 0.95em; color: var(--vscode-descriptionForeground); }
.ig-code {
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  padding: 0 3px; border-radius: 3px; background: var(--vscode-textCodeBlock-background);
}
.ig-snippet { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0 0; }
.ig-snippet__code {
  flex: 1 1 auto; margin: 0; padding: 8px 10px; overflow-x: auto; white-space: pre;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  border-radius: 3px; background: var(--vscode-textCodeBlock-background);
}
.ig-btn {
  padding: 5px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
  font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
.ig-btn:hover { background: var(--vscode-button-hoverBackground); }
.ig-btn:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ig-btn--secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.ig-btn--secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.ig-btn--copy { flex: none; }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var el = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!el) { return; }
    var action = el.getAttribute('data-action');
    if (action === 'run') {
      vscode.postMessage({ type: 'run', action: el.getAttribute('data-guide-action') });
    } else if (action === 'copy') {
      vscode.postMessage({ type: 'copy', snippet: el.getAttribute('data-snippet') });
      var before = el.textContent;
      el.textContent = 'Copied';
      setTimeout(function () { el.textContent = before; }, 1600);
    } else if (action === 'openFolder') {
      vscode.postMessage({ type: 'openFolder' });
    }
  });
})();
`;

function renderSnippet(step: ImportGuideStep): string {
  return step.snippet
    ? `<div class="ig-snippet"><pre class="ig-snippet__code"><code>${escapeHtml(IMPORT_GUIDE_SNIPPETS[step.snippet])}</code></pre>` +
      `<button class="ig-btn ig-btn--secondary ig-btn--copy" type="button" data-action="copy" data-snippet="${step.snippet}">Copy</button></div>`
    : '';
}

/** One step stands on its own (no "1."); only consecutive steps are a numbered list. Notes follow, quietly. */
function renderSteps(section: ImportGuideSection): string {
  const steps = section.steps.length === 1
    ? `<div class="ig-step ig-step--only">${inline(section.steps[0].text)}${renderSnippet(section.steps[0])}</div>`
    : `<ol class="ig-steps">${section.steps.map((step) => `<li class="ig-step">${inline(step.text)}${renderSnippet(step)}</li>`).join('')}</ol>`;
  const notes = (section.notes ?? []).map((note) => `<p class="ig-note">${inline(note)}</p>`).join('');
  return steps + notes;
}

function renderCard(card: ImportGuideCard, lead: boolean, intent: StartIntent | undefined): string {
  const sections = card.sections.map((section) => `
      <div class="ig-section">${section.heading ? `
        <h3 class="ig-section__heading">${escapeHtml(section.heading)}</h3>` : ''}
        ${renderSteps(section)}
        <button class="ig-btn${lead ? '' : ' ig-btn--secondary'}" type="button" data-action="run" data-guide-action="${section.action}">${escapeHtml(importGuideActionLabel(section.action, intent))}</button>
      </div>`).join('');
  return `
    <li class="ig-card${lead ? ' ig-card--lead' : ''}" data-card="${card.id}">
      <h2 class="ig-card__title">${escapeHtml(card.title)}</h2>
      <p class="ig-card__what">${inline(card.what)}</p>${sections}
    </li>`;
}

/**
 * The page: the intro, an open-a-folder line when none is open, then the
 * cards in {@link importGuideCards} order. Only the first card's button is a
 * primary button, and only when the folder suggested it (one primary button).
 */
export function buildImportGuideHtml(ctx: ImportGuideContext, nonce: string): string {
  const n = escapeHtml(nonce);
  const ids = importGuideCards(ctx);
  const suggested = ids[0] === 'found' || ids[0] === 'dbt';
  const cards = ids
    .map((id) => importGuideCard(id, ctx.intent))
    .filter((card): card is ImportGuideCard => card !== undefined)
    .map((card, i) => renderCard(card, suggested && i === 0, ctx.intent))
    .join('');
  const noFolder = ctx.hasProject ? '' : `
  <div class="ig__nofolder">
    <p class="ig__nofolder-text">${escapeHtml(IMPORT_GUIDE_NO_FOLDER)}</p>
    <button class="ig-btn" type="button" data-action="openFolder">Open Folder&hellip;</button>
  </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildImportGuideCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(IMPORT_GUIDE_TITLE)}</title>
<style nonce="${n}">${IMPORT_GUIDE_STYLE}</style>
</head>
<body>
<main class="ig" data-project="${ctx.hasProject}">
  <h1 class="ig__heading">${escapeHtml(IMPORT_GUIDE_TITLE)}</h1>
  <p class="ig__intro">${escapeHtml(IMPORT_GUIDE_INTRO)}</p>
  <p class="ig__note">${escapeHtml(IMPORT_GUIDE_INTRO_DRY_RUN)}</p>${noFolder}
  <ol class="ig__cards">${cards}
  </ol>
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
