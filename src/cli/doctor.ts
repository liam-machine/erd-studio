/**
 * `erd-studio doctor` — one report on everything the setup skill needs to
 * know before it starts: is there a dbt project, does dbt run, where is
 * profiles.yml, how fresh are manifest.json and catalog.json, what is
 * already in the ERD Studio folder, and is the Claude harness current.
 *
 * Runs `dbt --version` at most (never `dbt parse` or `docs generate`), and
 * writes nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FileState } from '../types/harness';
import { redactPaths } from '../types/feedback';
import { detectSubjectAreaFormat, mixesTableNaming, usesTableLibrary } from '../types/semantic';
import type { ProjectNaming } from '../types/semantic';
import { projectNamingOf } from '../services/projectNaming';
import { describeNamingMigration, planNamingMigration } from '../services/namingMigration';
import { readNamingMigrationInput } from '../services/namingMigrationFiles';
import { tablesDirIsLayer, TABLES_DIR } from '../services/logicalModelService';
import { normaliseName } from '../services/nameUtils';
import { SubjectAreaFileError } from '../services/domainService';
import { keysContradictedRelationships, linkKey, parseSubjectAreaJson } from '@erd-studio/core';
import type { Relationship } from '@erd-studio/core';
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
import { DBML_STORAGE_MESSAGE, detectDbmlStorage } from '../services/dbmlStorageGuard';
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

export type NextStepId =
  | 'update-erd-studio'
  | 'install-dbt' | 'confirm-venv' | 'create-profile' | 'run-deps' | 'run-parse' | 'refresh-parse' | 'run-catalog'
  | 'resolve-merge-conflicts' | 'fix-model-yaml' | 'resolve-naming-conflicts' | 'fix-subject-area-naming' | 'migrate-v5' | 'turn-round-relationships' | 'update-harness' | 'ready';

export interface NextStep {
  id: NextStepId;
  title: string;
  why: string;
  /** Ready to run from the project root, or null when it is not a shell command. */
  command: string | null;
}

export interface DoctorResult extends Envelope {
  runtime: { kind: 'node' | 'electron'; version: string };
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
    /**
     * Set when a newer ERD Studio (the 1.9 pre-release or 2.0) stored this
     * project as DBML, which this version cannot read: the first file that
     * shows it, project-relative. Absent otherwise. Nothing else in `erd`
     * describes such a project, and nothing may be written to its ERD Studio
     * folder by this version's conventions.
     */
    dbmlStorage?: { file: string };
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
     * What "ERD Studio: Migrate to the New File Naming" would change (#182),
     * when the project is not already v6. The CLI only describes it: the
     * migration runs in VS Code, as one undoable edit.
     */
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
  harness: { schemaSkill: FileState; setupSkill: FileState; version: string };
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

/** The naming migration's plan (#182), as doctor reports it. */
function namingMigrationPreview(ctx: CliContext): NonNullable<DoctorResult['erd']['namingMigration']> {
  const plan = planNamingMigration(readNamingMigrationInput(ctx.root, ctx.semanticDir, ctx.subjectAreaService, ctx.tableLibraryService));
  return { moves: plan.moves.length, rewrites: plan.rewrites.length, refusals: [...plan.refusals], preview: describeNamingMigration(plan) };
}

function erdSummary(ctx: CliContext): DoctorResult['erd'] {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  const exists = fs.existsSync(semanticRoot);
  if (!exists) {
    return {
      semanticDirExists: false, layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [],
      conflictedDomainFiles: [], dataTypeAliasFiles: [], backwardsRelationships: [],
      naming: 'v6', tablesFolderIsLayer: false, namingConflicts: [],
    };
  }
  const domains = ctx.subjectAreaService.listSubjectAreas(ctx.root, ctx.semanticDir);
  const issues: DoctorResult['erd']['domainFormatIssues'] = [];
  const conflicted: ConflictedSubjectAreaFile[] = [];
  for (const d of domains) {
    try {
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
  return {
    backwardsRelationships: backwardsRelationshipsOf(ctx, domains.map((d) => d.filePath).filter((f) => !issues.some((i) => i.file === relPath(ctx.root, f)))),
    semanticDirExists: true,
    ...dbmlStorageOf(ctx.root, ctx.semanticDir),
    layers: ctx.layerService.getValidLayerIds(),
    domains: domains.length,
    logicalModels: ctx.tableLibraryService.listTableNames().length,
    naming,
    ...(naming === 'v6' ? {} : { namingMigration: namingMigrationPreview(ctx) }),
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

/**
 * The step for a project a newer ERD Studio stored as DBML. Nothing else in
 * this report describes such a project, and writing YAML / JSON files into it
 * would put them beside the DBML ones.
 */
function dbmlStorageStep(file: string, semanticDir: string): NextStep {
  return {
    id: 'update-erd-studio',
    title: 'Open this project with a newer ERD Studio',
    why: `${DBML_STORAGE_MESSAGE} (${file} is a DBML file.) Until then, don't create or change files in `
      + `${semanticDir}/ by this version's conventions: they would sit beside the DBML files, and the newer version would `
      + "report them as conflicts. Leave the AI helper's skill files as they are too: this version's describe YAML / JSON. "
      + 'In VS Code: Extensions view → ERD Studio → Switch to Pre-Release Version (or Update, once 2.0 is released).',
    command: null,
  };
}

/** `erd.dbmlStorage` for the ERD Studio folder under `root`, or nothing. */
function dbmlStorageOf(root: string, semanticDir: string): { dbmlStorage?: { file: string } } {
  const semanticRoot = path.join(root, semanticDir);
  const evidence = detectDbmlStorage(semanticRoot);
  return evidence ? { dbmlStorage: { file: relPath(root, path.join(semanticRoot, evidence.file)) } } : {};
}

function nextStepsFor(r: Omit<DoctorResult, 'nextSteps'>, deps: { needsDeps: boolean; installPath: string; invocation: string | null }): NextStep[] {
  const steps: NextStep[] = [];
  const { dbt, profiles, artifacts } = r;
  // In a DBML project the format, naming and skill checks below read only
  // what this version understands: their advice would write YAML / JSON into
  // it, or replace the newer version's skills with older ones.
  const dbml = r.erd.dbmlStorage !== undefined;

  if (r.erd.dbmlStorage) {
    steps.push(dbmlStorageStep(r.erd.dbmlStorage.file, r.semanticDir));
  }

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
  if (r.erd.conflictedDomainFiles.length > 0) {
    const n = r.erd.conflictedDomainFiles.length;
    steps.push({
      id: 'resolve-merge-conflicts',
      title: `Resolve the git merge conflict${n === 1 ? ' in a diagram' : `s in ${n} diagrams`}`,
      why: `${r.erd.conflictedDomainFiles.map((c) => `${c.file}:${c.line}`).join('; ')}. `
        + `${n === 1 ? 'This file still holds' : 'Each of these files still holds'} git conflict markers `
        + '(<<<<<<< … ======= … >>>>>>>), so the diagram cannot load. '
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
  if (r.erd.unreadableModelFiles.length > 0) {
    const list = r.erd.unreadableModelFiles.map((u) =>
      `${u.file}${u.line !== undefined ? `:${u.line}` : ''}${u.code ? ` (${u.code})` : ''} — ${unreadableHint(u)}`);
    steps.push({
      id: 'fix-model-yaml',
      title: `Fix ${r.erd.unreadableModelFiles.length === 1 ? 'a table file that does' : `${r.erd.unreadableModelFiles.length} table files that do`} not parse`,
      why: `${list.join('; ')}. `
        + (r.erd.unreadableModelFiles.every((u) => u.readable)
          ? 'ERD Studio loads these with the last copy of each repeated key but will not change the files until one copy is removed; fix them before anything else.'
          : 'ERD Studio shows these tables as empty until they parse; fix them before anything else.')
        + (r.erd.unreadableModelFiles.some((u) => u.mergeConflict)
          ? " A merge conflict is the user's to resolve; once they have saved the file, re-run doctor."
          : ''),
      command: null,
    });
  }
  // A table in both libraries (#162) is drawn from the logical-models/ copy
  // only; which copy is right is the user's call, so it is raised early.
  if (r.erd.namingConflicts.length > 0) {
    const n = r.erd.namingConflicts.length;
    steps.push({
      id: 'resolve-naming-conflicts',
      title: `Keep one file for ${n === 1 ? 'a table' : `${n} tables`} found in both logical-models/ and tables/`,
      why: `${r.erd.namingConflicts.map((c) => `${c.name}: ${c.kept} is used, ${c.ignored} is ignored`).join('; ')}. `
        + 'The project is half-way between the old (logical-models/) and new (tables/) file naming. Show the user both files '
        + "and ask which to keep; don't delete either yourself.",
      command: null,
    });
  }
  if (dbt.checked && !dbt.found && !dbt.untrustedVenvDbt) {
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
  if (artifacts.manifest.status === 'missing' || artifacts.manifest.status === 'unreadable') {
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
  if (artifacts.catalog.status !== 'ok') {
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
  if (!dbml && namingMix.length > 0) {
    steps.push({
      id: 'fix-subject-area-naming',
      title: `Fix ${namingMix.length === 1 ? 'a subject area file that mixes' : `${namingMix.length} subject area files that mix`} the old and new key names`,
      why: `${namingMix.map((i) => i.file).join(', ')}: ${namingMix.length === 1 ? 'it uses' : 'each uses'} the v6 names ("logical.tables", "subjectArea") `
        + 'without "schemaVersion": 6, or beside the v5 names, so it cannot load. Use one set: the v5 names with schemaVersion 5, '
        + 'or the v6 names with schemaVersion 6. `erd-studio diff` names what is wrong in each.',
      command: null,
    });
  }
  if (!dbml && older > 0) {
    steps.push({
      id: 'migrate-v5',
      title: 'Migrate older subject area files',
      why: `${older} subject area file(s) use an older format; run "ERD Studio: Migrate Subject Areas to the Central Table Library" in VS Code before changing them.`,
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
        + 'or rewrite it as a many-to-one from the column that is not a key to the key, in that column\'s table file. '
        + 'Leave one that was drawn this way on purpose.',
      command: null,
    });
  }
  if (!dbml && (r.harness.schemaSkill === 'outdated' || r.harness.setupSkill === 'outdated')) {
    steps.push({
      id: 'update-harness',
      title: 'Update the ERD Studio skills',
      why: 'The installed Claude skill files come from an older ERD Studio; run "ERD Studio: Set Up My AI Helper" in VS Code.',
      command: null,
    });
  }
  if (steps.length === 0) {
    steps.push({ id: 'ready', title: 'Ready', why: 'Everything ERD Studio uses is in place.', command: null });
  }
  return steps;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const root = resolveProjectRoot(opts.project, opts.cwd);
  const harnessVersion = HARNESS_VERSION;

  if (!root) {
    // Not an error for doctor: saying so is its job. inventory/diff exit 3 instead.
    const cwdRoot = path.resolve(opts.cwd ?? process.cwd(), opts.project ?? '.');
    // The 1.9 pre-release and 2.0 work without dbt, so a folder they stored
    // as DBML is reported even here.
    const dbml = dbmlStorageOf(cwdRoot, opts.semanticDir);
    const base: Omit<DoctorResult, 'nextSteps'> = {
      ...makeEnvelope(cwdRoot, opts.semanticDir),
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
        semanticDirExists: dbml.dbmlStorage !== undefined, ...dbml,
        layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [],
        conflictedDomainFiles: [], dataTypeAliasFiles: [], backwardsRelationships: [],
        naming: 'v6', tablesFolderIsLayer: false, namingConflicts: [],
      },
      harness: { schemaSkill: 'missing', setupSkill: 'missing', version: harnessVersion },
    };
    return { ...base, nextSteps: dbml.dbmlStorage ? [dbmlStorageStep(dbml.dbmlStorage.file, opts.semanticDir)] : [] };
  }

  const [ctx, probed] = await Promise.all([
    buildCliContext({ project: root, semanticDir: opts.semanticDir, cwd: opts.cwd }),
    probe(root, opts),
  ]);
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
    erd: erdSummary(ctx),
    harness: { schemaSkill: harness.claude.schemaSkill, setupSkill: harness.claude.setupSkill, version: harnessVersion },
  };

  const deps = detectDepsStatus(root, identity.packagesInstallPath);
  return { ...base, nextSteps: nextStepsFor(base, { needsDeps: deps.needsDeps, installPath: deps.installPath, invocation }) };
}
