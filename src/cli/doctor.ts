/**
 * `erd-studio doctor` — one report on everything the setup skill needs to
 * know before it starts: is there a dbt project, does dbt run, where is
 * profiles.yml, how fresh are manifest.json and catalog.json, what is
 * already in the ERD Studio folder, and is the Claude harness current.
 *
 * In a logical-only folder (the ERD Studio folder, no dbt_project.yml) the
 * logical-file checks run as usual and the dbt checks are skipped and said
 * to be (`skippedChecks`): nothing is probed, and no dbt step is suggested.
 *
 * Runs `dbt --version` at most (never `dbt parse` or `docs generate`), and
 * writes nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FileState, HarnessStatus } from '../types/harness';
import { redactPaths } from '../types/feedback';
import { detectSubjectAreaFormat, mixesTableNaming, usesTableLibrary } from '../types/semantic';
import type { ProjectNaming } from '../types/semantic';
import { projectNamingOf } from '../services/projectNaming';
import { describeNamingMigration, planNamingMigration } from '../services/namingMigration';
import { readNamingMigrationInput } from '../services/namingMigrationFiles';
import { dbmlConversionIsEmpty, describeDbmlConversion, planDbmlConversion } from '../services/dbmlConversion';
import type { DbmlConversionPlan } from '../services/dbmlConversion';
import { readDbmlConversionInput } from '../services/dbmlConversionFiles';
import { tablesDirIsLayer, TABLES_DIR } from '../services/logicalModelService';
import { normaliseName } from '../services/nameUtils';
import { SubjectAreaFileError } from '../services/domainService';
import { keysContradictedRelationships, layoutFilePathOf, linkKey, parseSubjectAreaJson, subjectAreaStorageOf } from '@erd-studio/core';
import type { ProjectStorage, Relationship } from '@erd-studio/core';
import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';
import { projectStorageOf } from '../services/projectStorage';
import { dbtKeyIndexOf } from '../services/stageDisplay';
import {
  dbtCommands,
  dbtExecutableCandidates,
  dbtInvocation,
  detectDepsStatus,
  isUntrustedProjectExecutable,
  displayPath,
  findProfiles,
  probeDbt,
  readDbtProjectIdentity,
  type DbtCandidate,
  type DbtFlavour,
  type DbtProbeResult,
  type DbtSource,
  type DbtVersionRun,
  type ProfilesInfo,
} from '../services/dbtEnv';
import { HARNESS_VERSION, HarnessService } from '../services/harnessService';
import { hasDbtProjectFile } from '../services/projectDiscovery';
import {
  buildCliContext,
  makeEnvelope,
  relPath,
  resolveProjectRoot,
  type CatalogStatus,
  type ArtifactStatus,
  type CliContext,
  type Envelope,
} from './context';
import { toUnreadableTableFile, unreadableHint, type UnreadableTableFile } from './diff';
import { collectDbmlProblems, FORMAT_CONFLICT_CODE, type DbmlProblemEntry } from './dbmlProblems';

export type NextStepId =
  | 'install-dbt' | 'confirm-venv' | 'create-profile' | 'run-deps' | 'run-parse' | 'refresh-parse' | 'run-catalog'
  | 'resolve-merge-conflicts' | 'fix-model-yaml' | 'resolve-naming-conflicts' | 'fix-subject-area-naming' | 'migrate-v5' | 'turn-round-relationships' | 'update-harness'
  | 'finish-dbml-conversion' | 'fix-dbml-file' | 'resolve-format-conflicts' | 'import-dbml-file' | 'ready';

export interface NextStep {
  id: NextStepId;
  title: string;
  why: string;
  /** Ready to run from the project root, or null when it is not a shell command. */
  command: string | null;
}

/** The dbt checks doctor reports on; all of them are skipped in a logical-only folder. */
export type DbtCheckId = 'dbt' | 'profiles' | 'artifacts' | 'projectFiles' | 'deps';

export const DBT_CHECK_IDS: readonly DbtCheckId[] = ['dbt', 'profiles', 'artifacts', 'projectFiles', 'deps'];

export interface DoctorResult extends Envelope {
  runtime: { kind: 'node' | 'electron'; version: string };
  /**
   * Present only in a logical-only folder (`dbtProject: false` with the ERD
   * Studio folder found): the dbt checks that did not run, and why. Their
   * blocks below keep their shape, holding the "nothing found" values.
   */
  skippedChecks?: { reason: 'not-dbt-project'; checks: DbtCheckId[] };
  project: { found: boolean; name: string | null; profile: string | null; modelPaths: string[]; targetPath: string };
  dbt: {
    found: boolean;
    /** Where the executable was found (spec's `venv | path`, widened by addendum A5). */
    source: DbtSource | null;
    executable: string | null;
    venvDir: string | null;
    flavour: DbtFlavour | null;
    version: string | null;
    rawVersionOutput: string | null;
    commands: { parse: string | null; catalog: string | null; debug: string | null };
    /** False when `--no-dbt` skipped the probe — `found: false` then means "not checked". */
    checked: boolean;
    /**
     * A dbt inside the project's own venv (project-relative, forward slashes)
     * that was NOT run, because `--trust-venv` was not passed: a cloned repo
     * can ship any program there. Show the user this path, and only with
     * their go-ahead re-run doctor with `--trust-venv`. Null otherwise.
     */
    untrustedVenvDbt: string | null;
  };
  profiles: ProfilesInfo;
  artifacts: {
    manifest: { status: ArtifactStatus; path: string; modifiedAt: string | null; models: number | null; newestSourceChange: string | null };
    catalog: { status: CatalogStatus; path: string; modifiedAt: string | null; nodes: number | null };
  };
  projectFiles: { schemaYmlFiles: number; sourceFiles: number; modelsDiscovered: number };
  erd: {
    semanticDirExists: boolean;
    layers: string[];
    domains: number;
    logicalModels: number;
    domainFormatIssues: Array<{ file: string; format: 'v4' | 'hybrid' | 'legacy'; namingMix?: true }>;
    /**
     * The file naming the project uses (#162): `v5` (`logical-models/`,
     * `logical.models`), `v6` (`tables/`, `logical.tables`, schemaVersion 6)
     * or `mixed`. Assistants write files in the naming reported here: a v5
     * project writes v5 until it migrates; a `mixed` one, and a new one with
     * no library folder yet, writes v6 (#182).
     */
    naming: ProjectNaming;
    /**
     * How the project stores its logical model (native DBML storage, §3.2):
     * `dbml` (also when there is no `.erd-studio` yet), `yaml` or `mixed`.
     * When it is `dbml`, `naming` says nothing: the library is `tables/`.
     */
    storage: ProjectStorage;
    /** Every diagram, project-relative, with its file format (`json` or `dbml`, by the classifier). */
    diagrams: Array<{ file: string; format: 'json' | 'dbml' }>;
    /**
     * Every problem in the project's `.dbml` and `.dbdiagram` files (§7.1),
     * each with a fixed severity. Errors raise `fix-dbml-file` (or, with
     * `mergeConflict`, `resolve-merge-conflicts`; a table or diagram in both
     * formats, `resolve-format-conflicts`); warnings never raise a next step.
     * Where a line is missing or wrong, the message gives the exact line.
     */
    dbmlProblems: DbmlProblemEntry[];
    /**
     * What "ERD Studio: Migrate to the New File Naming" would change (#182),
     * when the project is not already v6. The CLI only describes it: the
     * migration runs in VS Code, as one undoable edit.
     */
    /**
     * What "ERD Studio: Convert Project to DBML" would write (native DBML
     * storage, §6.5), when the project is not stored as DBML alone. A
     * preview, not a next step: the conversion runs in VS Code, as one
     * undoable edit. Paths are relative to the semantic dir.
     */
    dbmlConversion?: {
      tables: number;
      diagrams: number;
      relationshipsFiles: number;
      relationships: number;
      /** Diagrams still in schema v4: the command runs the v4 → v5 step first. */
      v4SubjectAreas: string[];
      /** Relationships a diagram file holds, moving to the table library, and the other diagrams where they will also draw. */
      movedRelationships: Array<{ from: string; to: string; diagrams: string[] }>;
      /** Why it would refuse (empty when it can run). */
      refusals: string[];
      notes: string[];
      /** Files an earlier run already converted (a half-applied conversion). */
      resumed: string[];
      /** Lossless fixes Convert applies by itself (a member spelled in another case, identical duplicate keys). */
      handled?: Array<{ path: string; text: string }>;
      /** Files Convert leaves exactly as they are until fixed (the project stays mixed); running it again finishes the job. */
      leftAsIs?: Array<{ path: string; line?: number; problem: string }>;
      /** Diagram members with no table file, kept on the converted diagram and drawn as missing (erd_unlinked_tables). */
      keptMissing?: Array<{ diagram: string; tables: string[] }>;
      /** The plan in words, as the VS Code dialog shows it. */
      preview: string;
    };
    namingMigration?: {
      /** Table files it would move from `logical-models/` to `tables/`. */
      moves: number;
      /** Subject area files whose keys it would rename. */
      rewrites: number;
      /** Why it would refuse (empty when it can run); a v4 file means "Migrate to v5" first. */
      refusals: string[];
      /** The plan in words, as the VS Code dialog shows it. */
      preview: string;
    };
    /**
     * `.erd-studio/tables/` is a layer folder made before v6 (it holds
     * subject area files, or layers.json lists a `tables` layer), so it is
     * never read as the v6 table library.
     */
    tablesFolderIsLayer: boolean;
    /**
     * Tables with a file in both `logical-models/` and `tables/` (names
     * compared ignoring case): `kept` is read, `ignored` is not. Paths are
     * relative to the project root.
     */
    namingConflicts: Array<{ name: string; kept: string; ignored: string }>;
    /** Library model files that exist but do not parse (shadowed duplicates are never read, so never listed). */
    unreadableModelFiles: UnreadableTableFile[];
    /**
     * Domain files holding unresolved git merge conflicts (`<<<<<<<` …
     * `=======` … `>>>>>>>`); `line` is the first `<<<<<<<`. These cannot load
     * until the conflict is resolved and the file is saved.
     */
    conflictedDomainFiles: ConflictedSubjectAreaFile[];
    /**
     * Model files that spell a column type dbt's way (`data_type:`). They read
     * as `dataType`, and the next time ERD Studio writes that model's file (a
     * canvas edit to the model or a relationship stored in it) the key is
     * renamed `dataType` — a warning, not a next step: nothing is broken.
     */
    dataTypeAliasFiles: DataTypeAliasFile[];
    /**
     * Relationships drawn backwards (#163): stored starting at a model's
     * whole key and pointing at columns that are certainly not the other
     * model's key, as the canvas flags them with a ⚠. Each link once, with
     * every diagram that draws it.
     */
    backwardsRelationships: BackwardsRelationship[];
  };
  harness: {
    /** The Claude schema skill (`.claude/skills/erd-studio/`, folding in its companions). */
    schemaSkill: FileState;
    setupSkill: FileState;
    version: string;
    /** Every helper target whose files carry an older marker (Claude, `.agents`, Copilot, Gemini, `AGENTS.md`): `update-harness`. */
    outdated: string[];
    /** Every helper target whose files come from a newer ERD Studio (a teammate's): update ERD Studio, never these files. */
    newer: string[];
  };
  nextSteps: NextStep[];
}

export interface BackwardsRelationship {
  /** As stored: it starts here, at this model's key. */
  fromModel: string;
  fromColumns: string[];
  toModel: string;
  toColumns: string[];
  cardinality: string;
  /** The diagrams that draw it, project-relative, forward slashes. */
  domains: string[];
}

export interface ConflictedSubjectAreaFile {
  /** Project-relative, forward slashes. */
  file: string;
  /** 1-based line of the first conflict marker. */
  line: number;
}

export interface DataTypeAliasFile {
  name: string;
  /** Project-relative, forward slashes. */
  file: string;
  /**
   * The columns whose type is read from `data_type`, in file order: the next
   * write of this file renames each key to `dataType`, which clears them.
   */
  columns: string[];
  /**
   * The columns that have both keys, in file order: `dataType` wins, and the
   * `data_type` beside it is ignored and kept as written, so only deleting it
   * clears them.
   */
  ignored: string[];
  /**
   * The columns whose type is read from `data_type` but whose keys a write
   * keeps as written, in file order: the empty `dataType` beside it (or the
   * `data_type` key) carries a YAML anchor, and renaming would break or
   * change what refers to it. Only a hand edit of the anchor clears them.
   */
  anchored: string[];
}

export interface DoctorOptions {
  project?: string;
  semanticDir: string;
  noDbt?: boolean;
  /** `--dbt <path>`: tried before anything else. */
  dbt?: string;
  /** `--trust-venv`: also run a dbt inside the project's own venv (see `isUntrustedProjectExecutable`). */
  trustVenv?: boolean;
  cwd?: string;
  /** Test seams. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runVersion?: (executable: string) => Promise<DbtVersionRun>;
}

export function runtimeInfo(): DoctorResult['runtime'] {
  return process.versions.electron
    ? { kind: 'electron', version: process.versions.electron }
    : { kind: 'node', version: process.versions.node };
}

/**
 * doctor's harness block: the Claude skill states as before, plus every
 * target whose files are older (`update-harness`) or newer (a teammate on a
 * later ERD Studio: never replaced) than this build's.
 */
export function harnessSummary(status: HarnessStatus): DoctorResult['harness'] {
  const targets: Array<[string, FileState[]]> = [
    ['.claude/skills (Claude Code)', [status.claude.schemaSkill, status.claude.setupSkill]],
    ['.agents/skills (Copilot, Codex, Gemini CLI, Cursor)', [status.agents.schemaSkill, status.agents.setupSkill]],
    ['.github/instructions/erd-studio.instructions.md (GitHub Copilot)', [status.copilot]],
    ['.gemini/styleguide.md (Gemini)', [status.gemini]],
    ['AGENTS.md (Codex)', [status.codex]],
  ];
  return {
    schemaSkill: status.claude.schemaSkill,
    setupSkill: status.claude.setupSkill,
    version: HARNESS_VERSION,
    outdated: targets.filter(([, states]) => states.includes('outdated')).map(([name]) => name),
    newer: targets.filter(([, states]) => states.includes('newer')).map(([name]) => name),
  };
}

/** Folder of a venv executable (`<venv>/bin/dbt`, `<venv>\Scripts\dbt.exe`), project-relative. */
function venvDirOf(candidate: DbtCandidate, root: string): string | null {
  if (candidate.source !== 'venv') { return null; }
  return relPath(root, path.dirname(path.dirname(candidate.executable)));
}

function firstLines(text: string, n: number): string {
  return text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '').slice(0, n).join('\n');
}

async function probe(
  root: string,
  opts: DoctorOptions,
): Promise<{ result: DbtProbeResult | null; checked: boolean; untrusted: DbtCandidate | null }> {
  if (opts.noDbt) { return { result: null, checked: false, untrusted: null }; }
  const all = dbtExecutableCandidates(root, { env: opts.env, homeDir: opts.homeDir, override: opts.dbt ?? null });
  // doctor is pre-approved in the skill's allowed-tools, so nothing the
  // project ships may run through it without the user having seen the path.
  const untrusted = opts.trustVenv ? null : all.find(isUntrustedProjectExecutable) ?? null;
  const candidates = opts.trustVenv ? all : all.filter((c) => !isUntrustedProjectExecutable(c));
  const run = opts.runVersion ?? undefined;
  return { result: await probeDbt(candidates, run), checked: true, untrusted };
}

/**
 * Where `turn-round-relationships` says to rewrite a backwards relationship:
 * the relationships file of that column's table when it is DBML, its own
 * file when it is YAML (undefined keeps the YAML wording). The rewritten
 * relationship starts at the column that is not a key, the stored `toModel`.
 */
function backwardsHomeOf(ctx: CliContext, erd: DoctorResult['erd']): string | undefined {
  const homes = new Set<string>();
  let yaml = false;
  for (const b of erd.backwardsRelationships) {
    const file = ctx.tableLibraryService.relationshipsFileFor(b.toModel);
    if (file === undefined) { yaml = true; continue; }
    homes.add(ctx.tableLibraryService.libraryRelativePath(file));
  }
  if (homes.size === 0) return undefined;
  const list = [...homes].sort().join(', ');
  return `in the relationships file of that column's table (${list})${yaml ? ", or in that column's table file for a YAML table" : ''}`;
}

/** The naming migration's plan (#182), as doctor reports it. */
function namingMigrationPreview(ctx: CliContext): NonNullable<DoctorResult['erd']['namingMigration']> {
  const plan = planNamingMigration(readNamingMigrationInput(ctx.root, ctx.semanticDir, ctx.subjectAreaService, ctx.tableLibraryService));
  return { moves: plan.moves.length, rewrites: plan.rewrites.length, refusals: [...plan.refusals], preview: describeNamingMigration(plan) };
}

/**
 * Convert Project to DBML's plan (§6.5), as doctor reports it; whether a run
 * stopped part way; and the files (relative to the semantic dir, lower case)
 * of each source beside its converted target that finishing settles.
 */
async function dbmlConversionPreview(ctx: CliContext, storage: ProjectStorage): Promise<{ preview: NonNullable<DoctorResult['erd']['dbmlConversion']>; unfinished: boolean; settled: string[]; leftAsIs: DbmlConversionPlan['leftAsIs'] }> {
  const input = readDbmlConversionInput(ctx.root, ctx.semanticDir);
  const plan = await planDbmlConversion(input);
  // A source beside its converted target: a run that stopped part way, or a file an older helper (or a
  // 1.x teammate) wrote since. Only a pair the plan resumes (its target holds exactly what Convert writes)
  // is one finishing settles. Convert refuses a target with other contents, and any refusal empties
  // `resumed`: such a pair is a format conflict for the user to settle, and nothing is unfinished until
  // the plan can run.
  const paths = new Map(input.files.map((f) => [f.path.toLowerCase(), f.path]));
  const resumed = new Set(plan.resumed.map((p) => p.toLowerCase()));
  const settled: string[] = [];
  for (const f of input.files) {
    let target: string | undefined;
    if (f.kind === 'table' && f.storage === 'yaml') {
      const at = f.path.indexOf('/');
      target = `tables/${f.path.slice(at + 1).replace(/\.yml$/i, '.dbml')}`;
    } else if (f.kind === 'diagram' && f.storage === 'json') {
      target = f.path.replace(/\.json$/i, '.dbml');
    }
    const existing = target === undefined ? undefined : paths.get(target.toLowerCase());
    if (existing !== undefined && resumed.has(existing.toLowerCase())) settled.push(f.path.toLowerCase(), existing.toLowerCase());
  }
  return {
    settled,
    preview: {
      ...plan.summary,
      v4SubjectAreas: plan.v4SubjectAreas,
      movedRelationships: plan.movedRelationships,
      refusals: plan.refusals,
      notes: plan.notes,
      resumed: plan.resumed,
      handled: plan.handled,
      leftAsIs: plan.leftAsIs,
      keptMissing: plan.keptMissing,
      preview: describeDbmlConversion(plan),
    },
    // A run that stopped part way, or a project Convert left mixed: files it left as they are (D26/D27).
    // And a DBML project with pending relationships or unlinked members Convert settles now (D26/D27).
    unfinished: plan.resumed.length > 0 || (storage === 'mixed' && plan.refusals.length === 0 && plan.leftAsIs.length > 0)
      || (storage === 'dbml' && plan.refusals.length === 0 && !dbmlConversionIsEmpty(plan)),
    leftAsIs: plan.leftAsIs,
  };
}

/**
 * The erd summary with Convert's preview when storage is not `dbml`, or when a
 * DBML project has pending relationships or unlinked members (D26/D27), which
 * Convert settles once their tables have files.
 */
async function withDbmlConversion(ctx: CliContext, erd: DoctorResult['erd']): Promise<{ erd: DoctorResult['erd']; unfinished: boolean; settled: string[]; leftAsIs?: DbmlConversionPlan['leftAsIs'] }> {
  const settles = erd.dbmlProblems.some((p) => p.code === 'pendingRelationship' || p.code === 'unlinkedTable');
  if (!erd.semanticDirExists || (erd.storage === 'dbml' && !settles)) return { erd, unfinished: false, settled: [] };
  try {
    const { preview, unfinished, settled, leftAsIs } = await dbmlConversionPreview(ctx, erd.storage);
    return { erd: { ...erd, dbmlConversion: preview }, unfinished, settled, leftAsIs };
  } catch {
    // ERD Studio's own failure while planning: a refusal in the preview, never a failed doctor run.
    const refusal = 'ERD Studio could not plan the conversion of this project (an error in ERD Studio, not in your files). Please report it, with this doctor output.';
    return {
      erd: {
        ...erd,
        dbmlConversion: {
          tables: 0, diagrams: 0, relationshipsFiles: 0, relationships: 0,
          v4SubjectAreas: [], movedRelationships: [], refusals: [refusal], notes: [], resumed: [],
          preview: `Can't convert yet:\n• ${refusal}`,
        },
      },
      unfinished: false,
      settled: [],
    };
  }
}

/** A DBML diagram's layout file text, or null when there is none. */
function readLayoutFile(diagramPath: string): string | null {
  try {
    return fs.readFileSync(layoutFilePathOf(diagramPath), 'utf-8');
  } catch {
    return null;
  }
}

function erdSummary(ctx: CliContext): DoctorResult['erd'] {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  const exists = fs.existsSync(semanticRoot);
  if (!exists) {
    return {
      semanticDirExists: false, layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [],
      conflictedDomainFiles: [], dataTypeAliasFiles: [], backwardsRelationships: [],
      naming: 'v6', storage: 'dbml', diagrams: [], dbmlProblems: [], tablesFolderIsLayer: false, namingConflicts: [],
    };
  }
  const domains = ctx.subjectAreaService.listSubjectAreas(ctx.root, ctx.semanticDir);
  const issues: DoctorResult['erd']['domainFormatIssues'] = [];
  const conflicted: ConflictedSubjectAreaFile[] = [];
  for (const d of domains) {
    try {
      // A `.dbml` diagram is read through core's DBML reader (a v5 object, D8):
      // its format is never a v4 / hybrid / legacy issue, and a conflict
      // throws like a JSON one.
      if (subjectAreaStorageOf(d.filePath) === 'dbml') {
        parseSubjectAreaDbml(fs.readFileSync(d.filePath, 'utf-8'), d.filePath, readLayoutFile(d.filePath));
        continue;
      }
      const raw = parseSubjectAreaJson(fs.readFileSync(d.filePath, 'utf-8'), d.filePath);
      const format = detectSubjectAreaFormat(raw);
      // A file mixing the v5 and v6 names (#162) is a hand-edit to undo, not one the migration repairs.
      const namingMix = format === 'hybrid' && mixesTableNaming(raw);
      if (!usesTableLibrary(format)) { issues.push({ file: relPath(ctx.root, d.filePath), format, ...(namingMix ? { namingMix: true as const } : {}) }); }
    } catch (err) {
      // A conflicted diagram cannot load at all, and git's own wording is the
      // fix (#145). Any other unreadable / invalid JSON is not a format issue;
      // `diff --all` names it.
      if (err instanceof SubjectAreaFileError && err.mergeConflict && err.line !== undefined) {
        conflicted.push({ file: relPath(ctx.root, d.filePath), line: err.line });
      }
    }
  }
  const unreadable: UnreadableTableFile[] = [];
  const aliased: DataTypeAliasFile[] = [];
  for (const entry of ctx.tableLibraryService.listTableFiles()) {
    if (entry.shadowedBy) { continue; }
    const err = ctx.tableLibraryService.getTableFileError(entry.name);
    if (err) { unreadable.push(toUnreadableTableFile(ctx.root, err)); continue; }
    const { columns, ignored, anchored } = ctx.tableLibraryService.dataTypeAliasColumns(entry.name);
    if (columns.length + ignored.length + anchored.length > 0) {
      aliased.push({ name: entry.name, file: relPath(ctx.root, entry.filePath), columns, ignored, anchored });
    }
  }
  // The extension's own answer (#182), so doctor and the canvas never disagree.
  const naming = projectNamingOf(semanticRoot, ctx.tableLibraryService);
  const storage = projectStorageOf(ctx.tableLibraryService);
  return {
    backwardsRelationships: backwardsRelationshipsOf(ctx, domains.map((d) => d.filePath).filter((f) => !issues.some((i) => i.file === relPath(ctx.root, f)))),
    semanticDirExists: true,
    layers: ctx.layerService.getValidLayerIds(),
    domains: domains.length,
    logicalModels: ctx.tableLibraryService.listTableNames().length,
    naming,
    storage,
    diagrams: domains.map((d) => ({ file: relPath(ctx.root, d.filePath), format: d.storage ?? 'json' })),
    dbmlProblems: collectDbmlProblems(ctx, storage),
    // The YAML naming migration is offered only to a YAML project (§6.5).
    ...(naming === 'v6' || storage !== 'yaml' ? {} : { namingMigration: namingMigrationPreview(ctx) }),
    tablesFolderIsLayer: fs.existsSync(path.join(semanticRoot, TABLES_DIR)) && tablesDirIsLayer(semanticRoot),
    namingConflicts: ctx.tableLibraryService.tableNamingConflicts()
      .map((c) => ({ name: c.name, kept: relPath(ctx.root, c.kept), ignored: relPath(ctx.root, c.ignored) })),
    domainFormatIssues: issues,
    unreadableModelFiles: unreadable,
    conflictedDomainFiles: conflicted,
    dataTypeAliasFiles: aliased,
  };
}

/**
 * The relationships the canvas flags as drawn backwards (#163), across every
 * v5 diagram: core's `keysContradictedRelationships` on each logical stage,
 * read with dbt's key evidence as the canvas reads it. A diagram that does
 * not load is skipped (`diff --all` names it).
 */
function backwardsRelationshipsOf(ctx: CliContext, domainFiles: string[]): BackwardsRelationship[] {
  const dbtKeyIndex = dbtKeyIndexOf(ctx.ymlData, ctx.manifest);
  const byLink = new Map<string, BackwardsRelationship>();
  for (const file of domainFiles) {
    let relationships: Relationship[];
    let flagged: Set<Relationship>;
    try {
      const domain = ctx.subjectAreaService.getSubjectAreaStage(file, { dbtKeyIndex });
      const byName = new Map(domain.models.map((m) => [m.name.toLowerCase(), m]));
      relationships = domain.relationships;
      flagged = keysContradictedRelationships(relationships, (name) => byName.get(name.toLowerCase()), dbtKeyIndex);
    } catch {
      continue;
    }
    // A composite's members are one relationship.
    const groups = new Map<string, Relationship[]>();
    for (const rel of relationships) {
      if (!flagged.has(rel)) continue;
      const id = rel.compositeKey ? [rel.fromModel, rel.toModel, rel.compositeKey].join('\u0000').toLowerCase() : `\u0001${groups.size}`;
      groups.set(id, [...(groups.get(id) ?? []), rel]);
    }
    for (const members of groups.values()) {
      const key = members.map(linkKey).sort().join('\u0001');
      const held = byLink.get(key) ?? {
        fromModel: members[0].fromModel,
        fromColumns: members.map((m) => m.fromColumn),
        toModel: members[0].toModel,
        toColumns: members.map((m) => m.toColumn),
        cardinality: members[0].cardinality,
        domains: [],
      };
      held.domains.push(relPath(ctx.root, file));
      byLink.set(key, held);
    }
  }
  return [...byLink.values()];
}

interface NextStepDeps {
  needsDeps: boolean;
  installPath: string;
  invocation: string | null;
  unfinishedDbmlConversion?: boolean;
  /** Files Convert leaves as they are until fixed (relative to the semantic dir), listed in finish-dbml-conversion. */
  leftByConversion?: ReadonlyArray<{ path: string; line?: number; problem: string }>;
  /**
   * The files (relative to the semantic dir, lower case) of each source beside its converted target that
   * finishing the conversion settles: their format conflict is not raised while it is unfinished.
   */
  settledByConversion?: readonly string[];
  /** Where a backwards relationship is rewritten, when its table is DBML (`in the relationships file of …`). */
  backwardsHome?: string;
}

function nextStepsFor(r: Omit<DoctorResult, 'nextSteps'>, deps: NextStepDeps): NextStep[] {
  const steps: NextStep[] = [];
  const { dbt, profiles, artifacts } = r;
  // Logical-only: no dbt step at all — never tell someone without dbt to install it.
  const dbtChecked = !r.skippedChecks;

  if (dbt.untrustedVenvDbt) {
    steps.push({
      id: 'confirm-venv',
      title: "Confirm the project's own dbt",
      why: `This project has its own dbt at ${dbt.untrustedVenvDbt}. It was not run, because a program inside a project `
        + 'folder could be anything. Show the user that path; only if they say it is theirs, re-run doctor with --trust-venv.',
      command: null,
    });
  }
  // Straight after the venv question and before every dbt step: a conflicted
  // diagram cannot load whatever state dbt is in, and only the user can say
  // which side to keep — an assistant working down this list must raise it
  // before it installs dbt or runs anything against the warehouse.
  // Every conflicted DBML or layout file (table, relationships, diagram,
  // .dbdiagram) joins the conflicted diagrams here, never fix-dbml-file.
  const conflictedFiles = [...r.erd.conflictedDomainFiles];
  for (const p of r.erd.dbmlProblems) {
    if (p.mergeConflict && p.line !== undefined && !conflictedFiles.some((c) => c.file === p.file)) {
      conflictedFiles.push({ file: p.file, line: p.line });
    }
  }
  if (conflictedFiles.length > 0) {
    const n = conflictedFiles.length;
    const onlyDiagrams = conflictedFiles.every((c) => r.erd.conflictedDomainFiles.includes(c));
    const noun = onlyDiagrams ? 'diagram' : 'file';
    steps.push({
      id: 'resolve-merge-conflicts',
      title: `Resolve the git merge conflict${n === 1 ? ` in a ${noun}` : `s in ${n} ${noun}s`}`,
      why: `${conflictedFiles.map((c) => `${c.file}:${c.line}`).join('; ')}. `
        + `${n === 1 ? 'This file still holds' : 'Each of these files still holds'} git conflict markers `
        + `(<<<<<<< … ======= … >>>>>>>), so ${onlyDiagrams ? 'the diagram cannot load' : 'ERD Studio cannot read it'}. `
        + `Show the user ${n === 1 ? 'the file and line' : 'each file and line'}: git left two versions there. `
        + 'If only positions differ, tell them either side is safe to keep; otherwise ask the user which side to keep. '
        + "Don't pick a side or run git commands yourself; "
        + `once ${n === 1 ? 'the file is' : 'every file is'} saved and resolved, re-run doctor.`,
      command: null,
    });
  }
  // A model file that does not parse renders as an empty model whatever
  // state dbt is in, so it comes before the dbt steps too — as the step's
  // own why says, it is to be fixed before anything else.
  // DBML table files are fix-dbml-file's (or, conflicted, resolve-merge-conflicts').
  const unreadableYaml = r.erd.unreadableModelFiles.filter((u) => !u.file.toLowerCase().endsWith('.dbml'));
  if (unreadableYaml.length > 0) {
    const list = unreadableYaml.map((u) =>
      `${u.file}${u.line !== undefined ? `:${u.line}` : ''}${u.code ? ` (${u.code})` : ''} — ${unreadableHint(u)}`);
    steps.push({
      id: 'fix-model-yaml',
      title: `Fix ${unreadableYaml.length === 1 ? 'a table file that does' : `${unreadableYaml.length} table files that do`} not parse`,
      why: `${list.join('; ')}. `
        + (unreadableYaml.every((u) => u.readable)
          ? 'ERD Studio loads these with the last copy of each repeated key but will not change the files until one copy is removed; fix them before anything else.'
          : 'ERD Studio shows these tables as empty until they parse; fix them before anything else.')
        + (unreadableYaml.some((u) => u.mergeConflict)
          ? " A merge conflict is the user's to resolve; once they have saved the file, re-run doctor."
          : ''),
      command: null,
    });
  }
  // A DBML file that does not parse, or breaks every other DBML tool: like a
  // YAML file that does not parse, it is fixed before anything else.
  const dbmlErrors = r.erd.dbmlProblems.filter((p) => p.severity === 'error' && !p.mergeConflict && p.code !== FORMAT_CONFLICT_CODE);
  if (dbmlErrors.length > 0) {
    const files = new Set(dbmlErrors.map((p) => p.file));
    steps.push({
      id: 'fix-dbml-file',
      title: `Fix ${files.size === 1 ? 'a DBML file' : `${files.size} DBML files`} that ERD Studio or other DBML tools cannot read`,
      why: `${dbmlErrors.map((p) => `${p.file}${p.line !== undefined ? `:${p.line}` : ''} (${p.code}) — ${p.message}`).join('; ')}. `
        // The quoting hint only when a problem is a quoting one (its message carries "Quote the value").
        + (dbmlErrors.some((p) => p.message.includes('Quote the value'))
          ? 'Fix these lines before anything else (a value to quote is the usual one), then re-run doctor.'
          : 'Fix these lines before anything else, then re-run doctor.'),
      command: null,
    });
  }
  // A table in both libraries (#162) is drawn from the logical-models/ copy
  // only; which copy is right is the user's call, so it is raised early.
  // A YAML source beside the DBML file an unfinished conversion already wrote
  // for it is no conflict to settle by hand: finishing the conversion does it.
  const resumed = r.erd.dbmlConversion?.resumed ?? [];
  const isResumed = (file: string): boolean => resumed.some((p) => file.endsWith(`/${p}`));
  // A YAML file beside a DBML one of the same name is a format conflict (below), not a naming one.
  const sameFormat = (c: { kept: string; ignored: string }): boolean => c.kept.toLowerCase().endsWith('.dbml') === c.ignored.toLowerCase().endsWith('.dbml');
  const namingConflicts = r.erd.namingConflicts.filter((c) => sameFormat(c) && !isResumed(c.kept) && !isResumed(c.ignored));
  if (namingConflicts.length > 0) {
    const n = namingConflicts.length;
    steps.push({
      id: 'resolve-naming-conflicts',
      title: `Keep one file for ${n === 1 ? 'a table' : `${n} tables`} found in both logical-models/ and tables/`,
      why: `${namingConflicts.map((c) => `${c.name}: ${c.kept} is used, ${c.ignored} is ignored`).join('; ')}. `
        + 'The project is half-way between the old (logical-models/) and new (tables/) file naming. Show the user both files '
        + "and ask which to keep; don't delete either yourself.",
      command: null,
    });
  }
  // The same table or diagram in both formats: only one is read, and which is
  // right is the user's call. Finishing an unfinished conversion settles a
  // source beside a converted file that holds what Convert writes, so only
  // those pairs are left out; a pair with other contents (Convert refuses it)
  // or in two folders is raised here.
  const settled = deps.settledByConversion ?? [];
  const settledHere = (file: string): boolean => settled.some((p) => file.toLowerCase().endsWith(`/${p}`));
  const formatConflicts = r.erd.dbmlProblems.filter((p) => p.code === FORMAT_CONFLICT_CODE && !settledHere(p.file));
  if (formatConflicts.length > 0) {
    const n = formatConflicts.length;
    steps.push({
      id: 'resolve-format-conflicts',
      title: `Keep one file for ${n === 1 ? 'a table or diagram' : `${n} tables or diagrams`} found as both YAML/JSON and DBML`,
      why: `${formatConflicts.map((p) => p.message).join(' ')} `
        + 'Never convert or delete one by hand to settle it; once the user has chosen, re-run doctor.',
      command: null,
    });
  }
  if (dbtChecked && dbt.checked && !dbt.found && !dbt.untrustedVenvDbt) {
    steps.push({
      id: 'install-dbt',
      title: 'Install dbt (optional)',
      why: 'dbt was not found. ERD Studio works from your .sql and .yml files alone; dbt adds exact columns and types.',
      command: null,
    });
  }
  if (dbt.found && profiles.required && (!profiles.found || profiles.profileDefined === false)) {
    steps.push({
      id: 'create-profile',
      title: profiles.found ? `Add the "${r.project.profile}" profile to profiles.yml` : 'Create profiles.yml',
      why: 'dbt reads profiles.yml to know which warehouse to use; `dbt parse` needs a profile even though it does not connect.',
      command: null,
    });
  }
  if (deps.needsDeps) {
    steps.push({
      id: 'run-deps',
      title: 'Install dbt packages',
      why: `The project declares dbt packages that are not installed in ${deps.installPath}/ yet; dbt parse fails without them.`,
      command: deps.invocation ? `${deps.invocation} deps` : null,
    });
  }
  if (!dbtChecked) {
    // Nothing dbt to build or refresh.
  } else if (artifacts.manifest.status === 'missing' || artifacts.manifest.status === 'unreadable') {
    steps.push({
      id: 'run-parse',
      title: 'Build the manifest',
      why: artifacts.manifest.status === 'missing'
        ? 'There is no manifest.json yet — dbt parse writes it (no warehouse connection needed).'
        : 'manifest.json could not be read — re-running dbt parse rewrites it.',
      command: dbt.commands.parse,
    });
  } else if (artifacts.manifest.status === 'stale') {
    steps.push({
      id: 'refresh-parse',
      title: 'Refresh the manifest',
      why: 'dbt files changed after manifest.json was written — dbt parse brings it up to date.',
      command: dbt.commands.parse,
    });
  }
  if (dbtChecked && artifacts.catalog.status !== 'ok') {
    const cloud = dbt.flavour === 'cloud-cli';
    steps.push({
      id: 'run-catalog',
      title: artifacts.catalog.status === 'missing' ? 'Generate the catalog (optional)' : 'Refresh the catalog (optional)',
      why: (artifacts.catalog.status === 'older-than-manifest'
        ? 'catalog.json is older than the manifest. '
        : artifacts.catalog.status === 'unreadable' ? 'catalog.json could not be read. ' : '')
        + 'The catalog holds the real column types from your warehouse; it needs a live connection.'
        + (cloud ? ' With the dbt Cloud CLI the catalog is built remotely, so local output is not guaranteed.' : ''),
      command: dbt.commands.catalog,
    });
  }
  const namingMix = r.erd.domainFormatIssues.filter((i) => i.namingMix);
  const older = r.erd.domainFormatIssues.length - namingMix.length;
  if (namingMix.length > 0) {
    steps.push({
      id: 'fix-subject-area-naming',
      title: `Fix ${namingMix.length === 1 ? 'a subject area file that mixes' : `${namingMix.length} subject area files that mix`} the old and new key names`,
      why: `${namingMix.map((i) => i.file).join(', ')}: ${namingMix.length === 1 ? 'it uses' : 'each uses'} the v6 names ("logical.tables", "subjectArea") `
        + 'without "schemaVersion": 6, or beside the v5 names, so it cannot load. Use one set: the v5 names with schemaVersion 5, '
        + 'or the v6 names with schemaVersion 6. '
        // diff needs a dbt project; export reads the file the same way and names the problem anywhere.
        + (dbtChecked
          ? '`erd-studio diff` names what is wrong in each.'
          : '`erd-studio export --domain <file> --format dbml` names what is wrong in each.'),
      command: null,
    });
  }
  if (older > 0) {
    steps.push({
      id: 'migrate-v5',
      title: 'Migrate older subject area files',
      why: `${older} subject area file(s) use an older format; run "ERD Studio: Migrate Subject Areas to the Central Table Library" in VS Code before changing them.`,
      command: null,
    });
  }
  // A file Convert leaves because it clashes with its DBML twin is a format conflict (above), for the user to settle.
  const left = (deps.leftByConversion ?? []).filter((l) => !formatConflicts.some((p) => p.message.includes(l.path)));
  const unfinished = deps.unfinishedDbmlConversion === true
    && (left.length > 0 || (deps.leftByConversion ?? []).length === 0 || (r.erd.dbmlConversion?.resumed ?? []).length > 0);
  if (unfinished) {
    steps.push({
      id: 'finish-dbml-conversion',
      title: 'Finish the conversion to DBML',
      why: left.length > 0
        ? `The conversion to DBML left ${left.length === 1 ? 'a file' : `${left.length} files`} as ${left.length === 1 ? 'it is' : 'they are'} until fixed: `
          + `${left.map((l) => `${l.path}${l.line !== undefined ? `:${l.line}` : ''} (${l.problem.replace(/\.$/, '')})`).join('; ')}. `
          + 'Fix them, then run ERD Studio: Convert Project to DBML again to finish it; it checks every file first.'
        : r.erd.storage === 'dbml'
          ? 'Some pending relationships or diagram members are ready to settle: their tables have files now. Run ERD Studio: Convert Project to DBML to make them live Refs and use lines; it checks every file first.'
          : 'A conversion to DBML stopped part way. Run ERD Studio: Convert Project to DBML again to finish it; it checks every file first.',
      command: null,
    });
  }
  for (const p of r.erd.dbmlProblems.filter((q) => q.code === 'declaresOwnTables')) {
    steps.push({
      id: 'import-dbml-file',
      title: `Import ${p.file.split('/').pop()}`,
      why: `Run ERD Studio: Import DBML… on ${p.file}; it is a single-file DBML, not an ERD Studio diagram.`,
      command: null,
    });
  }
  const backwards = r.erd.backwardsRelationships.length;
  if (backwards > 0) {
    steps.push({
      id: 'turn-round-relationships',
      title: 'Turn round relationships drawn backwards',
      why: `${backwards === 1 ? '1 relationship looks' : `${backwards} relationships look`} drawn backwards: ${backwards === 1 ? 'it starts' : 'each starts'} at a table's key `
        + 'and points at a column that is not the other table\'s key. Turn it round on the canvas (the ⚠ on the line → Turn round), '
        + `or rewrite it as a many-to-one from the column that is not a key to the key, ${deps.backwardsHome ?? "in that column's table file"}. `
        + 'Leave one that was drawn this way on purpose.',
      command: null,
    });
  }
  // Any helper target with an older marker, in every project; a newer one
  // (a teammate on a later ERD Studio) is never offered for replacement.
  if (r.harness.outdated.length > 0) {
    steps.push({
      id: 'update-harness',
      title: 'Update the ERD Studio AI helper files',
      why: `The installed AI helper files come from an older ERD Studio: ${r.harness.outdated.join(', ')}. `
        + 'Run "ERD Studio: Set Up My AI Helper" in VS Code (or Update All when it offers).'
        + (r.erd.storage !== 'yaml' ? ' An AI helper set up with an older ERD Studio may write YAML into this DBML project.' : ''),
      command: null,
    });
  }
  if (steps.length === 0) {
    steps.push({
      id: 'ready',
      title: 'Ready',
      why: dbtChecked
        ? 'Everything ERD Studio uses is in place.'
        : 'Your ERD Studio files are in place. This folder is not a dbt project, so the dbt checks were skipped.',
      command: null,
    });
  }
  return steps;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const root = resolveProjectRoot(opts.project, opts.cwd, opts.semanticDir);
  const harnessVersion = HARNESS_VERSION;

  if (!root) {
    // Not an error for doctor: saying so is its job. inventory/diff exit 3 instead.
    const cwdRoot = path.resolve(opts.cwd ?? process.cwd(), opts.project ?? '.');
    const base: Omit<DoctorResult, 'nextSteps'> = {
      ...makeEnvelope(cwdRoot, opts.semanticDir, false),
      runtime: runtimeInfo(),
      project: { found: false, name: null, profile: null, modelPaths: [], targetPath: 'target' },
      dbt: {
        found: false, source: null, executable: null, venvDir: null, flavour: null, version: null,
        rawVersionOutput: null, commands: { parse: null, catalog: null, debug: null }, checked: false,
        untrustedVenvDbt: null,
      },
      profiles: { required: true, found: false, path: null, searched: [], profileDefined: null },
      artifacts: {
        manifest: { status: 'missing', path: 'target/manifest.json', modifiedAt: null, models: null, newestSourceChange: null },
        catalog: { status: 'missing', path: 'target/catalog.json', modifiedAt: null, nodes: null },
      },
      projectFiles: { schemaYmlFiles: 0, sourceFiles: 0, modelsDiscovered: 0 },
      erd: {
        semanticDirExists: false, layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [],
        conflictedDomainFiles: [], dataTypeAliasFiles: [], backwardsRelationships: [],
        naming: 'v6', storage: 'dbml', diagrams: [], dbmlProblems: [], tablesFolderIsLayer: false, namingConflicts: [],
      },
      harness: { schemaSkill: 'missing', setupSkill: 'missing', version: harnessVersion, outdated: [], newer: [] },
    };
    return { ...base, nextSteps: [] };
  }

  // Logical-only (no dbt_project.yml): dbt is never probed.
  const [ctx, probed] = await Promise.all([
    buildCliContext({ project: root, semanticDir: opts.semanticDir, cwd: opts.cwd }),
    hasDbtProjectFile(root) ? probe(root, opts) : Promise.resolve(null),
  ]);
  if (!ctx.hasDbt || !probed) { return await logicalOnlyDoctor(ctx, opts); }
  const identity = readDbtProjectIdentity(root);
  const found = probed.result;
  const invocation = found ? dbtInvocation(found.candidate, root) : null;

  const profiles = findProfiles(root, {
    flavour: found?.flavour ?? null,
    profileName: identity.profile,
    env: opts.env,
    homeDir: opts.homeDir,
  });

  const harness = new HarnessService(opts.semanticDir).harnessStatus(root);
  const conversion = await withDbmlConversion(ctx, erdSummary(ctx));
  const ymlFiles = new Set([...ctx.ymlData.models.values()].map((m) => m.filePath));
  const discovered = new Set<string>();
  for (const n of ctx.ymlData.models.keys()) { discovered.add(normaliseName(n)); }
  for (const n of ctx.manifest.models.keys()) { discovered.add(normaliseName(n)); }
  for (const n of ctx.catalog?.byName.keys() ?? []) { discovered.add(n); }
  for (const n of ctx.ymlData.sourceFiles?.keys() ?? []) {
    if (!ctx.manifest.disabledModels.has(n)) { discovered.add(n); }
  }

  const base: Omit<DoctorResult, 'nextSteps'> = {
    ...ctx.envelope,
    runtime: runtimeInfo(),
    project: {
      found: true,
      name: identity.name,
      profile: identity.profile,
      modelPaths: ctx.dbtConfig.modelPaths,
      // An absolute target-path (or DBT_TARGET_PATH) is shown relative to the
      // project when inside it, else as its redacted shape — never a home path.
      targetPath: path.isAbsolute(ctx.dbtConfig.targetPath)
        ? (relPath(ctx.root, ctx.dbtConfig.targetPath).startsWith('..')
          ? redactPaths(ctx.dbtConfig.targetPath)
          : relPath(ctx.root, ctx.dbtConfig.targetPath))
        : ctx.dbtConfig.targetPath,
    },
    dbt: {
      found: found !== null,
      source: found?.candidate.source ?? null,
      executable: found?.candidate.executable ?? null,
      venvDir: found ? venvDirOf(found.candidate, root) : null,
      flavour: found?.flavour ?? null,
      version: found?.version ?? null,
      rawVersionOutput: found ? redactPaths(firstLines(found.rawOutput, 5)) : null,
      commands: dbtCommands(found?.flavour ?? null, invocation ?? 'dbt'),
      checked: probed.checked,
      untrustedVenvDbt: probed.untrusted ? relPath(root, probed.untrusted.executable) : null,
    },
    profiles,
    artifacts: {
      manifest: { ...ctx.manifestInfo, path: displayPath(ctx.manifestInfo.path, root, opts.homeDir) },
      catalog: { ...ctx.catalogInfo, path: displayPath(ctx.catalogInfo.path, root, opts.homeDir) },
    },
    projectFiles: {
      schemaYmlFiles: ymlFiles.size,
      sourceFiles: ctx.ymlData.sourceFiles?.size ?? 0,
      modelsDiscovered: discovered.size,
    },
    erd: conversion.erd,
    harness: harnessSummary(harness),
  };

  const deps = detectDepsStatus(root, identity.packagesInstallPath);
  return {
    ...base,
    nextSteps: nextStepsFor(base, { needsDeps: deps.needsDeps, installPath: deps.installPath, invocation, unfinishedDbmlConversion: conversion.unfinished, settledByConversion: conversion.settled, ...(conversion.leftAsIs ? { leftByConversion: conversion.leftAsIs.map((l) => ({ ...l, path: `${ctx.semanticDir}/${l.path}` })) } : {}), backwardsHome: backwardsHomeOf(ctx, base.erd) }),
  };
}

/**
 * doctor in a logical-only folder: the ERD Studio checks and the skills, as
 * in a dbt project; every dbt check skipped (`skippedChecks`) — dbt is never
 * probed, not even without `--no-dbt` — with its block holding the "nothing
 * found" values, so the JSON keeps one shape.
 */
async function logicalOnlyDoctor(ctx: CliContext, opts: DoctorOptions): Promise<DoctorResult> {
  const harness = new HarnessService(opts.semanticDir).harnessStatus(ctx.root);
  const conversion = await withDbmlConversion(ctx, erdSummary(ctx));
  const base: Omit<DoctorResult, 'nextSteps'> = {
    ...ctx.envelope,
    runtime: runtimeInfo(),
    skippedChecks: { reason: 'not-dbt-project', checks: [...DBT_CHECK_IDS] },
    project: { found: false, name: null, profile: null, modelPaths: [], targetPath: 'target' },
    dbt: {
      found: false, source: null, executable: null, venvDir: null, flavour: null, version: null,
      rawVersionOutput: null, commands: { parse: null, catalog: null, debug: null }, checked: false,
      untrustedVenvDbt: null,
    },
    profiles: { required: false, found: false, path: null, searched: [], profileDefined: null },
    artifacts: {
      manifest: { ...ctx.manifestInfo, path: displayPath(ctx.manifestInfo.path, ctx.root, opts.homeDir) },
      catalog: { ...ctx.catalogInfo, path: displayPath(ctx.catalogInfo.path, ctx.root, opts.homeDir) },
    },
    projectFiles: { schemaYmlFiles: 0, sourceFiles: 0, modelsDiscovered: 0 },
    erd: conversion.erd,
    harness: harnessSummary(harness),
  };
  return { ...base, nextSteps: nextStepsFor(base, { needsDeps: false, installPath: '', invocation: null, unfinishedDbmlConversion: conversion.unfinished, settledByConversion: conversion.settled, ...(conversion.leftAsIs ? { leftByConversion: conversion.leftAsIs.map((l) => ({ ...l, path: `${ctx.semanticDir}/${l.path}` })) } : {}), backwardsHome: backwardsHomeOf(ctx, base.erd) }) };
}
