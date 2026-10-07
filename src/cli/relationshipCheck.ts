/**
 * The project's relationship checks, as the CLI sees them (issue #133) —
 * `erd-studio check`, doctor's `relationships` block and diff's advisory
 * `integrity` list all come from here.
 *
 * Nothing is compared in this file: it only reads what the canvas reads and
 * hands it to `@erd-studio/core`'s `checkRelationships`, the same function the
 * extension's banner, notification and Repair Relationships… use, so the CLI
 * and the canvas report the same codes for the same files. The inputs mirror
 * the extension's lookup: every model file through
 * `LogicalModelService.relationshipCheckModels` (shadowed duplicates skipped,
 * unreadable files listed so they are not also reported as missing), every
 * domain file's own `logical.relationships`, and the mode the project is in
 * (`usesLibraryRelationships`). Read-only, and free of `vscode`.
 */

import * as fs from 'fs';

import {
  checkRelationships,
  normaliseRelationshipRole,
  VALID_CARDINALITIES,
  type CheckDomain,
  type RelationshipFinding,
  type RelationshipIssueCode,
  type RelationshipSeverity,
} from '@erd-studio/core';
import { redactPaths } from '../types/feedback';
import { detectDomainFormat, type Relationship, type SemanticModel } from '../types/semantic';
import type { DomainService } from '../services/domainService';
import type { LogicalModelService } from '../services/logicalModelService';
import { usesLibraryRelationships, type RelationshipMode } from '../services/libraryRelationships';
import { relPath } from './context';

/** What the checks need from a CLI context (also satisfied by the full `CliContext`). */
export interface RelationshipCheckSources {
  root: string;
  semanticDir: string;
  logicalModelService: LogicalModelService;
  domainService: DomainService;
}

export interface ProjectRelationshipCheck {
  /** Where the project keeps relationships: model files (`library`) or each domain file (`domain`). */
  mode: RelationshipMode;
  /** `checkRelationships`' findings, files project-relative, errors first. */
  findings: RelationshipFinding[];
  checked: {
    /** Readable model files (shadowed duplicates are never read). */
    modelFiles: number;
    /** Domain files read (v5 and v4). */
    domains: number;
    /** Relationship entries stored on disk: model-file entries plus domain-file entries. */
    relationships: number;
  };
}

export type SeverityCounts = Record<RelationshipSeverity, number>;

/** How many findings of each severity, and of each code. */
export function countFindings(findings: readonly RelationshipFinding[]): SeverityCounts & { byCode: Partial<Record<RelationshipIssueCode, number>> } {
  const counts: SeverityCounts & { byCode: Partial<Record<RelationshipIssueCode, number>> } = { error: 0, warning: 0, info: 0, byCode: {} };
  for (const f of findings) {
    counts[f.severity] += 1;
    counts.byCode[f.code] = (counts.byCode[f.code] ?? 0) + 1;
  }
  return counts;
}

function isWellFormed(value: unknown): value is Relationship {
  return !!value && typeof value === 'object'
    && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (value as Record<string, unknown>)[k] === 'string');
}

/**
 * A domain file's own relationships as the canvas draws them: entries without
 * four text ends are left out (the reader skips them too), an unrecognised
 * cardinality reads as many-to-one, and a role is trimmed to its label.
 */
function readOwnRelationships(raw: unknown): Relationship[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(isWellFormed)
    .map((r) => (VALID_CARDINALITIES.has(r.cardinality) ? r : { ...r, cardinality: 'many-to-one' as const }))
    .map(({ role, ...r }) => {
      const label = normaliseRelationshipRole(role);
      return label ? { ...r, role: label } : r;
    });
}

/** Every v5 and v4 domain file, as `checkRelationships` takes it. Unreadable and older-format files are skipped. */
function readDomains(src: RelationshipCheckSources, mode: RelationshipMode): CheckDomain[] {
  const domains: CheckDomain[] = [];
  for (const summary of src.domainService.listDomains(src.root, src.semanticDir)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as Record<string, unknown>;
      const format = detectDomainFormat(raw);
      if (format !== 'v5' && format !== 'v4') continue;
      const logical = raw.logical as { models?: unknown; relationships?: unknown } | undefined;
      const stubColumns = (Array.isArray(raw.stubColumns) ? raw.stubColumns : []).filter((s): s is string => typeof s === 'string');
      let models: Array<string | SemanticModel>;
      if (format === 'v5') {
        models = (Array.isArray(logical?.models) ? logical!.models : []).filter((m): m is string => typeof m === 'string');
      } else {
        // A v4 domain carries its models inline; they hold no library relationships.
        models = src.domainService.getDomain(summary.filePath).logical.models
          .map(({ relationships: _r, relationshipIssues: _i, ...m }) => m as SemanticModel);
      }
      domains.push({
        label: `${summary.layer}/${summary.domain}`,
        filePath: relPath(src.root, summary.filePath),
        models,
        relationships: readOwnRelationships(logical?.relationships),
        // A v4 domain always keeps its own relationships.
        mode: format === 'v4' ? 'domain' : mode,
        ...(stubColumns.length > 0 ? { stubColumns } : {}),
      });
    } catch {
      // A domain that cannot be read is diff's to report (`--all` names it).
    }
  }
  return domains;
}

/** Run the project's relationship checks. Never writes; throws only on a programming error. */
export function checkProjectRelationships(src: RelationshipCheckSources): ProjectRelationshipCheck {
  const fileName = (filePath: string): string => relPath(src.root, filePath);
  const { libraryModels, unreadableModels } = src.logicalModelService.relationshipCheckModels(fileName);
  const mode: RelationshipMode = usesLibraryRelationships(
    libraryModels.map((m) => m.model),
    src.domainService.countDomainFileRelationships(src.root, src.semanticDir),
  ) ? 'library' : 'domain';
  const domains = readDomains(src, mode);
  const findings = checkRelationships({ libraryModels, domains, unreadableModels })
    .map((f) => ({ ...f, message: redactPaths(f.message) }));
  const relationships = libraryModels.reduce((n, m) => n + (m.model.relationships?.length ?? 0), 0)
    + domains.reduce((n, d) => n + d.relationships.length, 0);
  return {
    mode,
    findings,
    checked: { modelFiles: libraryModels.length, domains: domains.length, relationships },
  };
}
