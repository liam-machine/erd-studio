/**
 * `erd-studio doctor` — one report on everything the setup skill needs to
 * know before it starts: is there a dbt project, does dbt run, where is
 * profiles.yml, how fresh are manifest.json and catalog.json, what is
 * already in the ERD Studio folder, are its relationships sound (the same
 * checks as `erd-studio check`, counted), and is the Claude harness current.
 *
 * Runs `dbt --version` at most (never `dbt parse` or `docs generate`), and
 * writes nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FileState } from '../types/harness';
import { redactPaths } from '../types/feedback';
import { detectDomainFormat } from '../types/semantic';
import { normaliseName } from '../services/nameUtils';
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
import type { RelationshipMode } from '../services/libraryRelationships';
import type { RelationshipIssueCode } from '@erd-studio/core';
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
import { MODEL_YAML_HINTS, toUnreadableModelFile, type UnreadableModelFile } from './diff';
import { checkProjectRelationships, countFindings, type UncheckedFile } from './relationshipCheck';

export type NextStepId =
  | 'install-dbt' | 'confirm-venv' | 'create-profile' | 'run-deps' | 'run-parse' | 'refresh-parse' | 'run-catalog'
  | 'fix-model-yaml' | 'migrate-v5' | 'fix-relationships' | 'check-relationships' | 'update-harness' | 'ready';

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
    layers: string[];
    domains: number;
    logicalModels: number;
    domainFormatIssues: Array<{ file: string; format: 'v4' | 'hybrid' | 'legacy' }>;
    /** Library model files that exist but do not parse (shadowed duplicates are never read, so never listed). */
    unreadableModelFiles: UnreadableModelFile[];
  };
  /**
   * The relationship checks (`erd-studio check`), counted. Doctor never fails
   * on them; `fix-relationships` in `nextSteps` says what to do.
   */
  relationships: DoctorRelationships;
  harness: { schemaSkill: FileState; setupSkill: FileState; version: string };
  nextSteps: NextStep[];
}

export interface DoctorRelationships {
  /** False when there was nothing to check (no ERD Studio folder) or the checks could not run. */
  checked: boolean;
  /** Where the project keeps relationships; null when not checked. */
  mode: RelationshipMode | null;
  /** Relationship entries stored on disk (model files plus domain files). */
  stored: number;
  errors: number;
  warnings: number;
  info: number;
  byCode: Partial<Record<RelationshipIssueCode, number>>;
  /** Files whose relationships could not be checked at all (domain files, model files that do not parse, an unusable layers.json). */
  unchecked: number;
  /** Those files, project-relative, each with why. */
  uncheckedFiles: UncheckedFile[];
  /** Set when the checks themselves failed: why, in one sentence. Absent when they ran or there was nothing to check. */
  failed?: string;
}

const NO_RELATIONSHIP_CHECK: DoctorRelationships = { checked: false, mode: null, stored: 0, errors: 0, warnings: 0, info: 0, byCode: {}, unchecked: 0, uncheckedFiles: [] };

/** Plain words per code, for the `fix-relationships` step. */
const RELATIONSHIP_REASONS: Array<[RelationshipIssueCode, string]> = [
  ['REL001', 'stored more than once'],
  ['REL002', 'saved in the file of the model it points at'],
  ['REL003', 'pointing at a model that is not in the model library'],
  ['REL004', 'pointing at a column its model does not have'],
  ['REL005', 'naming a model or column with different capital letters'],
  ['REL008', 'could not be read'],
];

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

function erdSummary(ctx: CliContext): DoctorResult['erd'] {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  const exists = fs.existsSync(semanticRoot);
  if (!exists) {
    return { semanticDirExists: false, layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [] };
  }
  const domains = ctx.domainService.listDomains(ctx.root, ctx.semanticDir);
  const issues: DoctorResult['erd']['domainFormatIssues'] = [];
  for (const d of domains) {
    try {
      const format = detectDomainFormat(JSON.parse(fs.readFileSync(d.filePath, 'utf-8')));
      if (format !== 'v5') { issues.push({ file: relPath(ctx.root, d.filePath), format }); }
    } catch {
      // Unreadable / invalid JSON is not a format issue; `diff --all` names it.
    }
  }
  const unreadable: UnreadableModelFile[] = [];
  for (const entry of ctx.logicalModelService.listModelFiles()) {
    if (entry.shadowedBy) { continue; }
    const err = ctx.logicalModelService.getModelFileError(entry.name);
    if (err) { unreadable.push(toUnreadableModelFile(ctx.root, err)); }
  }
  return {
    semanticDirExists: true,
    layers: ctx.layerService.getValidLayerIds(),
    domains: domains.length,
    logicalModels: ctx.logicalModelService.listModelNames().length,
    domainFormatIssues: issues,
    unreadableModelFiles: unreadable,
  };
}

function relationshipSummary(ctx: CliContext, semanticDirExists: boolean): DoctorRelationships {
  if (!semanticDirExists) { return NO_RELATIONSHIP_CHECK; }
  try {
    const project = checkProjectRelationships(ctx);
    const { error, warning, info, byCode } = countFindings(project.findings);
    return {
      checked: true, mode: project.mode, stored: project.checked.relationships, errors: error, warnings: warning, info, byCode,
      unchecked: project.unchecked.length,
      uncheckedFiles: project.unchecked,
    };
  } catch (err) {
    // Doctor reports; it never fails — but a check that could not run is
    // said, never shown as if there were nothing to check.
    return { ...NO_RELATIONSHIP_CHECK, failed: redactPaths(err instanceof Error ? err.message : String(err)) };
  }
}

function nextStepsFor(r: Omit<DoctorResult, 'nextSteps'>, deps: { needsDeps: boolean; installPath: string; invocation: string | null }): NextStep[] {
  const steps: NextStep[] = [];
  const { dbt, profiles, artifacts } = r;

  if (dbt.untrustedVenvDbt) {
    steps.push({
      id: 'confirm-venv',
      title: "Confirm the project's own dbt",
      why: `This project has its own dbt at ${dbt.untrustedVenvDbt}. It was not run, because a program inside a project `
        + 'folder could be anything. Show the user that path; only if they say it is theirs, re-run doctor with --trust-venv.',
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
  if (r.erd.unreadableModelFiles.length > 0) {
    const list = r.erd.unreadableModelFiles.map((u) =>
      `${u.file}${u.line !== undefined ? `:${u.line}` : ''}${u.code ? ` (${u.code})` : ''} — ${MODEL_YAML_HINTS[u.kind]}`);
    steps.push({
      id: 'fix-model-yaml',
      title: `Fix ${r.erd.unreadableModelFiles.length === 1 ? 'a model file that does' : `${r.erd.unreadableModelFiles.length} model files that do`} not parse`,
      why: `${list.join('; ')}. `
        + 'ERD Studio shows these models as empty until they parse; fix them before anything else.',
      command: null,
    });
  }
  if (r.erd.domainFormatIssues.length > 0) {
    steps.push({
      id: 'migrate-v5',
      title: 'Migrate older domain files',
      why: `${r.erd.domainFormatIssues.length} domain file(s) use an older format; run "ERD Studio: Migrate to v5" in VS Code before changing them.`,
      command: null,
    });
  }
  const problems = r.relationships.errors + r.relationships.warnings;
  if (problems > 0) {
    const reasons = RELATIONSHIP_REASONS
      .map(([code, words]) => [r.relationships.byCode[code] ?? 0, words] as const)
      .filter(([n]) => n > 0)
      .map(([n, words]) => `${n} ${words}`);
    steps.push({
      id: 'fix-relationships',
      title: `Fix ${problems === 1 ? '1 relationship problem' : `${problems} relationship problems`}`,
      why: `${reasons.length > 0 ? `${reasons.join('; ')}. ` : ''}`
        + 'Run `erd-studio check` for the list with files and lines. In VS Code, "ERD Studio: Repair Relationships…" '
        + 'fixes most of them, showing every change before it writes anything.',
      command: null,
    });
  }
  // A check that could not run, or skipped a file, is never followed by
  // "Ready": the model files that do not parse have their own step above;
  // every other file it skipped — a model file that holds no model (empty,
  // or no `name:`) included — and a check that failed outright get this.
  const parseStep = new Set(r.erd.unreadableModelFiles.map((u) => u.file));
  const skipped = r.relationships.uncheckedFiles.filter((u) => u.kind !== 'model' || !parseStep.has(u.file));
  if (r.relationships.failed || skipped.length > 0) {
    steps.push({
      id: 'check-relationships',
      title: r.relationships.failed ? 'Run the relationship checks' : `Fix ${skipped.length === 1 ? 'a file' : `${skipped.length} files`} the relationship checks could not read`,
      why: r.relationships.failed
        ? `The relationship checks could not run (${r.relationships.failed}), so nothing says the relationships are fine. Run \`erd-studio check\` to see why.`
        : `${skipped.map((u) => `${u.file}: ${u.reason}`).join('; ')}. Its relationships were not looked at; run \`erd-studio check\` again once it is fixed.`,
      command: null,
    });
  }
  if (r.harness.schemaSkill === 'outdated' || r.harness.setupSkill === 'outdated') {
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
      erd: { semanticDirExists: false, layers: [], domains: 0, logicalModels: 0, domainFormatIssues: [], unreadableModelFiles: [] },
      relationships: NO_RELATIONSHIP_CHECK,
      harness: { schemaSkill: 'missing', setupSkill: 'missing', version: harnessVersion },
    };
    return { ...base, nextSteps: [] };
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

  const erd = erdSummary(ctx);
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
    erd,
    relationships: relationshipSummary(ctx, erd.semanticDirExists),
    harness: { schemaSkill: harness.claude.schemaSkill, setupSkill: harness.claude.setupSkill, version: harnessVersion },
  };

  const deps = detectDepsStatus(root, identity.packagesInstallPath);
  return { ...base, nextSteps: nextStepsFor(base, { needsDeps: deps.needsDeps, installPath: deps.installPath, invocation }) };
}
