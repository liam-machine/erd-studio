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
 * domain file through `scanDomainFiles` (the reader the canvas and Repair
 * Relationships… use), and the mode the project is in
 * (`usesLibraryRelationships`). Read-only, and free of `vscode`.
 */


import {
  checkRelationships,
  relationshipFilePositions,
  type RelationshipFinding,
  type RelationshipIssueCode,
  type RelationshipSeverity,
} from '@erd-studio/core';
import { redactPaths } from '../types/feedback';
import type { DomainService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import type { LogicalModelService } from '../services/logicalModelService';
import { usesLibraryRelationships, type RelationshipMode } from '../services/libraryRelationships';
import { scanDomainFiles, toCheckDomains } from '../services/relationshipRepair';
import { relPath } from './context';

/** What the checks need from a CLI context (also satisfied by the full `CliContext`). */
export interface RelationshipCheckSources {
  root: string;
  semanticDir: string;
  logicalModelService: LogicalModelService;
  domainService: DomainService;
  /** When given, a layers.json that could not be used makes the check incomplete (its layer folders may have been skipped). */
  layerService?: Pick<LayerService, 'getLoadError'>;
}

/** A file whose relationships were not looked at, and why. */
export interface UncheckedFile {
  file: string;
  reason: string;
  /** A domain file, a model file, or the layer config (layers.json) that says where domain files are. */
  kind: 'domain' | 'model' | 'layers';
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
    /** Relationship entries read: model-file entries plus domain-file entries (skipped entries are REL008 findings). */
    relationships: number;
  };
  /**
   * Files whose relationships could not be checked at all, project-relative,
   * each with why: a domain file that is not JSON, unreadable or in a layout
   * ERD Studio cannot load; a model file that does not parse (its
   * relationships were never read); a shadowed duplicate model file (a name
   * the library already has elsewhere: ignored, its relationships never
   * read or drawn); a layers.json that could not be used (a domain file in a
   * layer folder it names may have been skipped). A check that skipped one
   * is never clean.
   */
  unchecked: UncheckedFile[];
  /** Domain files still in the older (v4) format, project-relative: Repair Relationships… does not change them. */
  olderFormat: string[];
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

/** layers.json, when it could not be used: the domain files in layer folders it names may have been skipped. */
function layersUnchecked(src: RelationshipCheckSources): UncheckedFile[] {
  const error = src.layerService?.getLoadError();
  if (!error) return [];
  return [{
    file: `${src.semanticDir}/layers.json`.replace(/\\/g, '/'),
    reason: `it could not be used (${redactPaths(error)}), so diagrams in layer folders it names may not have been checked — fix it, then check again`,
    kind: 'layers',
  }];
}

/** Run the project's relationship checks. Never writes; throws only on a programming error. */
export function checkProjectRelationships(src: RelationshipCheckSources): ProjectRelationshipCheck {
  const fileName = (filePath: string): string => relPath(src.root, filePath);
  const { libraryModels, unreadableModels } = src.logicalModelService.relationshipCheckModels(fileName);
  // The one domain reader every relationship check uses (the canvas and
  // Repair Relationships… too): v5 and v4, stubs, entries it could not read.
  const scan = scanDomainFiles(src.domainService, src.root, src.semanticDir);
  const mode: RelationshipMode = usesLibraryRelationships(
    libraryModels.map((m) => m.model),
    scan.domainFileRelationshipCount,
    unreadableModels.filter((u) => u.holdsRelationships).length,
  ) ? 'library' : 'domain';
  const domains = toCheckDomains(scan, mode, fileName);
  // A record's `source.index` counts the entries that were read; in the
  // CLI's JSON it names the entry's position in the file's own list (skipped
  // entries counted), for a model file and a domain file alike — the same
  // "entry N" the messages use.
  const rawIndexes = new Map([...scan.v5, ...scan.v4].map((d) => [fileName(d.filePath), d.rawIndexes]));
  const libraryPositions = new Map(libraryModels.map((m) => [
    `${m.file}\u0000${m.model.name}`,
    relationshipFilePositions(m.model.relationships?.length ?? 0, m.model.relationshipIssues),
  ]));
  const findings = checkRelationships({ libraryModels, domains, unreadableModels })
    .map((f) => ({
      ...f,
      message: redactPaths(f.message),
      ...(f.records ? {
        records: f.records.map((r) => {
          if (r.source.kind === 'domain') {
            const raw = rawIndexes.get(r.file)?.[r.source.index];
            return raw === undefined ? r : { ...r, source: { kind: 'domain' as const, index: raw } };
          }
          const raw = libraryPositions.get(`${r.file}\u0000${r.source.model}`)?.[r.source.index];
          return raw === undefined ? r : { ...r, source: { ...r.source, index: raw } };
        }),
      } : {}),
    }));
  const relationships = libraryModels.reduce((n, m) => n + (m.model.relationships?.length ?? 0), 0)
    + domains.reduce((n, d) => n + d.relationships.length, 0);
  return {
    mode,
    findings,
    checked: { modelFiles: libraryModels.length, domains: domains.length, relationships },
    unchecked: [
      ...layersUnchecked(src),
      ...unreadableModels.map((u): UncheckedFile => ({
        file: u.file,
        reason: `${u.noModel
          ? 'it holds no model (it is empty, not a mapping, or has no `name:`)'
          : u.line !== undefined ? `it has a YAML error on line ${u.line}` : 'it could not be read'}, so the relationships in it were not checked`,
        kind: 'model',
      })),
      // A second file with a name the library already has is ignored
      // everywhere (shadowed): its relationships are never read or drawn, so
      // a check that passed over it in silence would be a false all-clear.
      ...src.logicalModelService.listModelFiles()
        .filter((e) => e.shadowedBy)
        .map((e): UncheckedFile => ({
          file: fileName(e.filePath),
          reason: `a model named ${e.name} is already in ${fileName(e.shadowedBy!)}, so ERD Studio ignores this file and ` +
            'never draws its relationships — merge it into that file, or give it its own name ("ERD Studio: Give Duplicate Model Its Own Name…")',
          kind: 'model',
        })),
      ...scan.unchecked.map((d): UncheckedFile => ({ file: fileName(d.filePath), reason: redactPaths(d.reason), kind: 'domain' })),
    ],
    olderFormat: scan.v4.map((d) => fileName(d.filePath)),
  };
}
