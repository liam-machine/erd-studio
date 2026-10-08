/**
 * `erd-studio check` — the project's relationship checks (issue #133), for an
 * assistant to run after it edits relationships, and for CI.
 *
 * Every finding comes from `@erd-studio/core`'s `checkRelationships` (through
 * `checkProjectRelationships`), with a stable code — REL001 stored twice,
 * REL002 saved on its "one" side, REL003 / REL004 a missing model / column,
 * REL005 a case-only name match, REL006 a direction the keys contradict,
 * REL008 an entry that could not be read, REL009 a domain copy the library
 * also holds (a note: the library's copy is drawn, whatever the domain's
 * says). It reads only ERD Studio's own files — no manifest, no dbt —
 * and writes nothing: the fixes are the user's, through "ERD Studio: Repair
 * Relationships…" or by hand.
 *
 * Exit codes: 0 no errors · 1 errors (or, with `--strict`, warnings), or a
 * file that could not be checked at all (a domain file or model file that does
 * not parse, a layers.json that could not be used) · 3 no project or no ERD
 * Studio folder. `info` findings never fail a run.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { RelationshipFinding } from '@erd-studio/core';
import { DomainService } from '../services/domainService';
import { LayerService } from '../services/layerService';
import { LogicalModelService } from '../services/logicalModelService';
import type { RelationshipMode } from '../services/libraryRelationships';
import { redactPaths } from '../types/feedback';
import { CliEnvError, makeEnvelope, relPath, resolveProjectRoot, type Envelope } from './context';
import { checkProjectRelationships, countFindings, type ProjectRelationshipCheck, type RelationshipCheckSources } from './relationshipCheck';

export interface CheckResult extends Envelope {
  /** No errors (and, with `--strict`, no warnings). */
  clean: boolean;
  strict: boolean;
  /** Where the project keeps relationships: the model files (`library`) or each domain file (`domain`). */
  mode: RelationshipMode;
  counts: {
    errors: number;
    warnings: number;
    info: number;
    /** Findings per code, e.g. `{ "REL001": 2 }`. */
    byCode: Partial<Record<RelationshipFinding['code'], number>>;
  };
  checked: ProjectRelationshipCheck['checked'];
  /** Files whose relationships could not be checked at all (domain files, model files, layers.json); any one makes the run not clean. */
  unchecked: ProjectRelationshipCheck['unchecked'];
  /** Domain files still in the older (v4) format: checked, but Repair Relationships… does not change them. */
  olderFormat: string[];
  /** Errors first, then warnings, then info. Paths are project-relative. */
  findings: RelationshipFinding[];
}

export interface CheckOptions {
  project?: string;
  semanticDir: string;
  strict?: boolean;
  cwd?: string;
}

/**
 * Only what the checks read: the layer config, the model library and the
 * domain files. Unlike `buildCliContext` it never loads the manifest, so a
 * check is quick on a project with a 40 MB one.
 */
function checkSources(opts: CheckOptions): RelationshipCheckSources {
  const root = checkRoot(opts);
  const layerService = new LayerService(root, opts.semanticDir);
  const logicalModelService = new LogicalModelService(root, opts.semanticDir);
  const domainService = new DomainService(layerService);
  domainService.setLogicalModelService(logicalModelService);
  return { root, semanticDir: opts.semanticDir, logicalModelService, domainService, layerService };
}

/**
 * The folder to check. A dbt project when there is one (`resolveProjectRoot`);
 * otherwise — ERD Studio also runs without dbt (`erdStudio.projectPath` may
 * name any folder, #111) and the checks read no dbt file — the folder that
 * holds the ERD Studio folder: `--project` itself, or the current folder or
 * the nearest one above it.
 */
function checkRoot(opts: CheckOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  const dbtRoot = resolveProjectRoot(opts.project, cwd);
  if (dbtRoot) return dbtRoot;
  const holdsErdData = (dir: string): boolean => {
    try {
      return fs.statSync(path.join(dir, opts.semanticDir)).isDirectory();
    } catch {
      return false;
    }
  };
  if (opts.project) {
    const dir = path.resolve(cwd, opts.project);
    if (holdsErdData(dir)) return dir;
  } else {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      if (holdsErdData(dir)) return dir;
      if (path.dirname(dir) === dir) break;
    }
  }
  throw new CliEnvError(
    'no-project',
    opts.project
      ? `No dbt_project.yml or ${opts.semanticDir}/ folder in ${redactPaths(relPath(cwd, path.resolve(cwd, opts.project)))} (--project must be the folder that holds one of them).`
      : `No dbt_project.yml or ${opts.semanticDir}/ folder found here or above. Run this from your project folder, or pass --project <dir>.`,
  );
}

/** Run the checks. A missing project or ERD Studio folder is a `CliEnvError` (exit 3). */
export function runCheck(opts: CheckOptions): { result: CheckResult; exitCode: 0 | 1 } {
  const src = checkSources(opts);
  // A check over nothing must never read as "no problems": a wrong
  // `--semantic-dir` (the CLI cannot see VS Code settings) would otherwise
  // pass every time.
  if (!fs.existsSync(path.join(src.root, src.semanticDir))) {
    throw new CliEnvError(
      'no-semantic-dir',
      `No ${src.semanticDir}/ folder in this project — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
    );
  }
  const project = checkProjectRelationships(src);
  // A file that exists but could not be checked is something, not nothing:
  // it is reported in `unchecked` (exit 1), never as a wrong --semantic-dir.
  if (project.checked.modelFiles === 0 && project.checked.domains === 0 && project.unchecked.length === 0
    && src.logicalModelService.listModelFiles().length === 0) {
    throw new CliEnvError(
      'nothing-to-check',
      `No model files or domain files under ${src.semanticDir}/ — check --semantic-dir (it must match the erdStudio.semanticDir setting).`,
    );
  }
  const { error, warning, info, byCode } = countFindings(project.findings);
  const strict = opts.strict === true;
  // A domain file that could not be checked is never a clean pass: its
  // relationships were not looked at.
  const clean = error === 0 && (!strict || warning === 0) && project.unchecked.length === 0;
  return {
    result: {
      ...makeEnvelope(src.root, src.semanticDir),
      clean,
      strict,
      mode: project.mode,
      counts: { errors: error, warnings: warning, info, byCode },
      checked: project.checked,
      unchecked: project.unchecked,
      olderFormat: project.olderFormat,
      findings: project.findings,
    },
    exitCode: clean ? 0 : 1,
  };
}
