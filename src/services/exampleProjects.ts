/**
 * The example projects Open an Example Project… offers
 * (`src/commands/openExampleProject.ts`): one per modelling pattern, each a
 * whole native-DBML project from `docs/examples/`, written into a new folder
 * of its own and opened there.
 *
 * The files are not shipped as files (the VSIX is capped at 60): esbuild.js
 * inlines every example as the `__ERD_EXAMPLES__` define, read by
 * `scripts/exampleBundle.cjs`, and vitest.config.ts defines the same value.
 * `docs/examples/` stays the one source; `test/unit/exampleProjects.test.ts`
 * checks the bundle is exactly what is on disk and that this catalog matches it.
 *
 * Pure: no `vscode`, no Node built-ins. Never reached by the CLI bundle,
 * which has no `__ERD_EXAMPLES__`; a bundle without it reads an empty catalog.
 */

import type { TelemetryFeature } from './telemetryPayload';

/** One example project, as the picker lists it. */
export interface ExampleProject {
  /** Its folder under `docs/examples/`, and the folder it is written to. */
  readonly id: string;
  /** Counted when this example is written (one fixed key per example). */
  readonly feature: TelemetryFeature;
  /** The pattern, as the picker's label. */
  readonly label: string;
  /** Its layers, as its `layers.json` labels them, in order. */
  readonly description: string;
  /** What it shows. */
  readonly detail: string;
  /** The diagram opened first, a posix path inside the example: `.erd-studio/<layer>/diagrams/<name>.dbml`. */
  readonly startDiagram: string;
  /** The one to open when unsure (docs/examples/README.md, "Where to start"). */
  readonly recommended?: boolean;
}

/**
 * Every example, in the order the picker lists them: enterprise-warehouse
 * first (the examples index says to start there), then the index's table.
 * No dbt word in any of it: the picker shows in folders without dbt and in
 * an empty window (docs/dev/onboarding-and-cli.md, "User-facing wording").
 */
export const EXAMPLE_PROJECTS: readonly ExampleProject[] = [
  {
    id: 'enterprise-warehouse',
    feature: 'exampleEnterpriseWarehouse',
    label: 'Enterprise warehouse',
    description: 'Landing, Enterprise warehouse, Marts, Reporting',
    detail: 'Start here. Source data cleaned into one shared core, then a set of tables for each team. Its README walks you through it in ten minutes.',
    // The walkthrough's first diagram (its step 2, "Many sources, one file").
    startDiagram: '.erd-studio/landing/diagrams/source-systems.dbml',
    recommended: true,
  },
  {
    id: 'medallion',
    feature: 'exampleMedallion',
    label: 'Medallion lakehouse',
    description: 'Bronze, Silver, Gold',
    detail: 'Raw, cleaned and business-ready layers, as many Databricks teams set them up.',
    startDiagram: '.erd-studio/gold/diagrams/sales.dbml',
  },
  {
    id: 'dbt-project-layers',
    feature: 'exampleDbtProjectLayers',
    label: 'Staging, intermediate and marts',
    description: 'Staging, Intermediate, Marts',
    detail: 'A layer for each step from raw data to reports, with a diagram for each source and each department.',
    startDiagram: '.erd-studio/marts/diagrams/finance.dbml',
  },
  {
    id: 'kimball-bus-matrix',
    feature: 'exampleKimballBusMatrix',
    label: 'Kimball bus matrix',
    description: 'Presentation',
    detail: 'A star schema for each business process, all sharing the same customers, products and dates.',
    startDiagram: '.erd-studio/presentation/diagrams/retail-sales.dbml',
  },
  {
    id: 'data-vault',
    feature: 'exampleDataVault',
    label: 'Data Vault 2.0',
    description: 'Raw Vault, Business Vault, Information Marts',
    detail: 'Business keys, the links between them and their history, each in tables of their own.',
    startDiagram: '.erd-studio/raw_vault/diagrams/customer-and-policy.dbml',
  },
  {
    id: 'gitlab-style',
    feature: 'exampleGitlabStyle',
    label: 'A database per stage',
    description: 'RAW, PREP, PROD',
    detail: "One database for each stage, as GitLab's data team lays it out.",
    startDiagram: '.erd-studio/prod/diagrams/arr.dbml',
  },
  {
    id: 'bigquery-versioned',
    feature: 'exampleBigqueryVersioned',
    label: 'Stage in the dataset name',
    description: 'Live, Stable, Derived, User-facing views',
    detail: "The stage in each dataset's name, as Mozilla does on BigQuery.",
    startDiagram: '.erd-studio/derived/diagrams/clients.dbml',
  },
  {
    id: 'data-mesh',
    feature: 'exampleDataMesh',
    label: 'Data mesh',
    description: 'Source-aligned, Aggregate, Consumer-aligned',
    detail: "Each team owns the tables for its own part of the business, and can use another team's.",
    startDiagram: '.erd-studio/source_aligned/diagrams/shipping.dbml',
  },
];

/** The example with this id, or undefined. */
export function exampleProject(id: string): ExampleProject | undefined {
  return EXAMPLE_PROJECTS.find((e) => e.id === id);
}

type ExampleBundle = Record<string, Record<string, string>>;

let bundle: ExampleBundle | undefined;

/** The bundled examples, parsed on first use; empty in a bundle built without them. */
function readBundle(): ExampleBundle {
  if (bundle) return bundle;
  try {
    bundle = typeof __ERD_EXAMPLES__ === 'undefined' ? {} : JSON.parse(__ERD_EXAMPLES__) as ExampleBundle;
  } catch {
    bundle = {};
  }
  return bundle;
}

/** The ids of every bundled example (sorted). */
export function bundledExampleIds(): string[] {
  return Object.keys(readBundle()).sort();
}

/**
 * Every file of example `id`: posix paths inside the example → text. Empty
 * for an id that is not bundled.
 */
export function exampleFiles(id: string): Readonly<Record<string, string>> {
  return Object.prototype.hasOwnProperty.call(readBundle(), id) ? readBundle()[id] : {};
}

/** The catalog entries whose files are in this bundle (all of them, in a build with examples). */
export function availableExampleProjects(): ExampleProject[] {
  const ids = new Set(bundledExampleIds());
  return EXAMPLE_PROJECTS.filter((e) => ids.has(e.id));
}

// ---------------------------------------------------------------------------
// The hand-off to the new window
// ---------------------------------------------------------------------------

/**
 * globalState key: the example just opened, so the window it opens in can
 * open its first diagram. Written by Open an Example Project… right before
 * `vscode.openFolder`; read and cleared on activation.
 */
export const PENDING_EXAMPLE_OPEN_KEY = 'erdStudio.pendingExampleOpen';

/** globalState key: the folder the last example was saved in (the next Save dialog starts there). */
export const EXAMPLE_PARENT_FOLDER_KEY = 'erdStudio.exampleParentFolder';

/** How long a pending record stays good: long enough for a slow window to open, short enough that a stale one never fires. */
export const PENDING_EXAMPLE_TTL_MS = 10 * 60 * 1000;

/** The record stored under {@link PENDING_EXAMPLE_OPEN_KEY}. */
export interface PendingExampleOpen {
  /** The example's folder (absolute, as the OS spells it). */
  folder: string;
  /** The diagram to open, a posix path relative to `folder`. */
  diagram: string;
  /** When it was stored (ms since the epoch). */
  at: number;
}

/** A folder path as the file system compares it: one separator, no trailing one, lower case where the OS ignores case. */
function folderKey(p: string, platform: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

/** A relative posix path that stays inside its folder. */
function isSafeRelative(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * The diagram to open in this window, from the stored pending record: its
 * absolute path when `record` is well formed, names `workspaceRoot` as its
 * folder and was stored less than {@link PENDING_EXAMPLE_TTL_MS} ago; else
 * undefined. The caller clears the key either way.
 */
export function takePendingExample(
  record: unknown,
  workspaceRoot: string,
  now: number,
  platform: string = typeof process === 'undefined' ? 'linux' : process.platform,
): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const { folder, diagram, at } = record as Partial<Record<keyof PendingExampleOpen, unknown>>;
  if (typeof folder !== 'string' || !folder || typeof diagram !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (!isSafeRelative(diagram)) return undefined;
  // A minute of slack for a clock that moved back; never one stored in the future beyond that.
  if (now - at >= PENDING_EXAMPLE_TTL_MS || at - now > 60_000) return undefined;
  if (!workspaceRoot || folderKey(folder, platform) !== folderKey(workspaceRoot, platform)) return undefined;
  const sep = /^[A-Za-z]:\\|^\\\\/.test(workspaceRoot) || (workspaceRoot.includes('\\') && !workspaceRoot.includes('/')) ? '\\' : '/';
  const root = workspaceRoot.replace(/[\\/]+$/, '');
  return `${root}${sep}${diagram.split('/').join(sep)}`;
}
