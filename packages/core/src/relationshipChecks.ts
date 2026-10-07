/**
 * Project-wide relationship checks with stable codes (issue #133).
 *
 * `normaliseRelationships` interprets one domain; `checkRelationships` looks
 * at everything a host has loaded — every library model file and every domain
 * file — and reports what needs attention, each finding with a code from
 * `RelationshipIssueCode`, the files involved and enough about the records
 * for a repair planner to find them. It is pure: listing and reading files is
 * the host's job, so a host that cannot list directories (the read-only
 * viewer) reports only what it loaded.
 */

import type { Relationship, RelationshipReadIssue, SemanticModel } from './types/semantic.js';
import {
  canonicalRelationship,
  linkKey,
  relationshipEnds,
  relationshipFilePositions,
  sameRelationshipMeaning,
  type RelationshipEnds,
  type RelationshipIssueCode,
  type RelationshipSeverity,
  type RelationshipSource,
} from './relationships.js';
import { keyEvidenceContradiction } from './normaliseRelationships.js';

/** A model file in the library, as read. */
export interface CheckLibraryModel {
  /** The model as parsed, including `relationships` and `relationshipIssues`. */
  model: SemanticModel;
  /** How its file is named in findings (e.g. project-relative `.erd-studio/logical-models/gold/fct_order.yml`). */
  file: string;
}

/** A domain file, as read. */
export interface CheckDomain {
  /** How the domain is named in messages, e.g. `silver/orders`. */
  label: string;
  /** How its file is named in findings. */
  filePath: string;
  /** `logical.models`: names of library models (v5), or inline model objects (v4). */
  models: ReadonlyArray<string | SemanticModel>;
  /** The domain file's own `logical.relationships`, as parsed. */
  relationships: readonly Relationship[];
  /** Where the project keeps relationships (`usesLibraryRelationships`). */
  mode: 'library' | 'domain';
  /**
   * A domain file in the older (v4, inline-model) format. Its reader never
   * draws the model library's relationships (`parseStageData` strips them
   * from inline models), so its own records are never compared with the
   * library's. Also assumed when `models` holds inline model objects.
   */
  olderFormat?: boolean;
  /** Models the domain shows as stubs: a column missing from one is not a finding. */
  stubColumns?: readonly string[];
  /**
   * Entries of the domain file's own list that were skipped or read with a
   * default (`readDomainRelationshipEntries`): each is a REL008, as a model
   * file's are. `relationships` holds only the entries that were read.
   */
  readIssues?: readonly RelationshipReadIssue[];
}

/** A model file that exists but could not be read. */
export interface CheckUnreadableModel {
  name: string;
  file: string;
  line?: number;
}

export interface CheckRelationshipsInput {
  libraryModels: readonly CheckLibraryModel[];
  domains: readonly CheckDomain[];
  unreadableModels?: readonly CheckUnreadableModel[];
}

/** What a repair would do about a finding (a hint; the planner decides). */
export type RelationshipFixKind =
  /** Store the relationship turned round, in its canonical home. */
  | 'rehome'
  /** Respell the endpoints to the real names. */
  | 'respell'
  /** Remove the copies that say the same as the kept one. */
  | 'remove-duplicates'
  /** The copies disagree: the user picks one. */
  | 'choose'
  /** The endpoint is missing: point it somewhere else, remove it, or leave it. */
  | 'repoint'
  /** The direction contradicts key evidence: swap the ends, or leave it. */
  | 'swap'
  /** The entry could not be read: open the file at the line. */
  | 'open-file'
  /** A domain-file copy the library also holds: remove the domain copy. */
  | 'remove-domain-copy';

/** One stored record a finding is about. */
export interface RelationshipRecordRef {
  /** The file the record is in. */
  file: string;
  source: RelationshipSource;
  /** The record's ends exactly as on disk. */
  stored: RelationshipEnds;
  /** Its cardinality as on disk (a library `one-to-many` stays `one-to-many` here). */
  cardinality: Relationship['cardinality'];
  role?: string;
}

export interface RelationshipFinding {
  code: RelationshipIssueCode;
  severity: RelationshipSeverity;
  message: string;
  /** Every file involved, without repeats. */
  files: string[];
  /** 1-based line in the first file, when known. */
  line?: number;
  /** The `linkKey` the finding is about. */
  link?: string;
  fix?: RelationshipFixKind;
  /** The records involved, the one a reader draws first where that applies. */
  records?: RelationshipRecordRef[];
}

/** A stored record with everything the checks need. */
interface Rec {
  rel: Relationship;
  ref: RelationshipRecordRef;
  /** 0-based position of the entry in its file's own list (skipped entries counted), for "entry N". */
  position: number;
  /** Domain label, for domain records. */
  domain?: CheckDomain;
  /** Library only: stored in the file of its canonical from-model. */
  atHome: boolean;
}

const SEVERITY_ORDER: Record<RelationshipSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Check every relationship the host loaded. Findings:
 *
 * - REL001 the same link stored more than once — within the library, within
 *   one domain file, across domain files of a library project, or as a
 *   domain copy that disagrees with the library. An error when the copies
 *   differ in cardinality, role or one-to-one direction, else a warning. In a
 *   per-domain project each domain file keeps its own copy, so copies in
 *   different domain files are not a finding.
 * - REL002 a `one-to-many` stored in a model file (warning).
 * - REL003 an endpoint model missing from the library (error; not when that
 *   model's file is unreadable or the domain lists it as a stub), or — for a
 *   domain file's own record — a model that is not one of that domain's
 *   models, so the diagram has nothing to draw it between.
 * - REL004 an endpoint column missing from its model (error; not for an
 *   unreadable model, a stub, or a model with no columns yet).
 * - REL005 an endpoint that matches only when case is ignored (warning).
 * - REL006 the stored direction contradicts certain key evidence (info).
 * - REL008 a model file or domain file entry skipped or defaulted on read
 *   (error, with the line where known).
 * - REL009 a domain-file copy of a link the library also holds, in a library
 *   project, saying the same thing (info).
 *
 * Findings are sorted errors first, then by code, file and line.
 */
export function checkRelationships(input: CheckRelationshipsInput): RelationshipFinding[] {
  const findings: RelationshipFinding[] = [];
  const unreadable = new Map((input.unreadableModels ?? []).map((u) => [u.name.toLowerCase(), u]));

  // Library lookup: exact name first, then without case (alphabetically first variant).
  const libByExact = new Map<string, CheckLibraryModel>();
  for (const entry of input.libraryModels) {
    if (!libByExact.has(entry.model.name)) libByExact.set(entry.model.name, entry);
  }
  const libByLower = new Map<string, CheckLibraryModel>();
  for (const name of [...libByExact.keys()].sort()) {
    if (!libByLower.has(name.toLowerCase())) libByLower.set(name.toLowerCase(), libByExact.get(name)!);
  }

  const push = (f: RelationshipFinding): void => {
    findings.push({ ...f, files: [...new Set(f.files)] });
  };

  // --- REL008: entries the reader skipped or defaulted -----------------------
  for (const { model, file } of input.libraryModels) {
    for (const issue of model.relationshipIssues ?? []) {
      push({
        code: 'REL008',
        severity: 'error',
        message: `${file}: ${issue.message}`,
        files: [file],
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        fix: 'open-file',
      });
    }
  }

  for (const domain of input.domains) {
    for (const issue of domain.readIssues ?? []) {
      push({
        code: 'REL008',
        severity: 'error',
        message: `${domain.filePath}: ${issue.message}`,
        files: [domain.filePath],
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        fix: 'open-file',
      });
    }
  }

  // --- Collect every stored record -------------------------------------------
  const records: Rec[] = [];
  for (const { model, file } of input.libraryModels) {
    const positions = relationshipFilePositions(model.relationships?.length ?? 0, model.relationshipIssues);
    (model.relationships ?? []).forEach((entry, index) => {
      const rel: Relationship = { ...stripRuntime(entry), fromModel: model.name };
      records.push({
        rel,
        position: positions[index],
        ref: { file, source: { kind: 'library', model: model.name, index }, stored: relationshipEnds(rel), cardinality: rel.cardinality, ...(rel.role ? { role: rel.role } : {}) },
        atHome: canonicalRelationship(rel).fromModel.toLowerCase() === model.name.toLowerCase(),
      });
    });
  }
  for (const domain of input.domains) {
    const positions = relationshipFilePositions(domain.relationships.length, domain.readIssues);
    domain.relationships.forEach((entry, index) => {
      const rel = stripRuntime(entry);
      records.push({
        rel,
        position: positions[index],
        ref: { file: domain.filePath, source: { kind: 'domain', index }, stored: relationshipEnds(rel), cardinality: rel.cardinality, ...(rel.role ? { role: rel.role } : {}) },
        domain,
        atHome: false,
      });
    });
  }

  // --- Per-record checks: REL002, REL003, REL004, REL005, REL006 -------------
  for (const r of records) {
    const resolve = modelResolver(r.domain, libByExact, libByLower);
    const describe = `${r.rel.fromModel}.${r.rel.fromColumn} → ${r.rel.toModel}.${r.rel.toColumn}`;
    const where = r.ref.file;
    const stubs = new Set((r.domain?.stubColumns ?? []).map((s) => s.toLowerCase()));
    // A domain file's own record is drawn only between the domain's own models.
    const inDiagram = r.domain
      ? new Set(r.domain.models.map((m) => (typeof m === 'string' ? m : m.name).toLowerCase()))
      : undefined;

    if (r.ref.source.kind === 'library' && r.rel.cardinality === 'one-to-many') {
      const home = canonicalRelationship(r.rel).fromModel;
      push({
        code: 'REL002',
        severity: 'warning',
        message: `${where}: relationship ${describe} is stored as one-to-many; it belongs in ${home}'s model file as many-to-one`,
        files: [r.ref.file, ...(resolve(home)?.file ? [resolve(home)!.file!] : [])],
        link: linkKey(r.rel),
        fix: 'rehome',
        records: [r.ref],
      });
    }

    const respelled: string[] = [];
    for (const side of ['from', 'to'] as const) {
      const modelName = side === 'from' ? r.rel.fromModel : r.rel.toModel;
      const columnName = side === 'from' ? r.rel.fromColumn : r.rel.toColumn;
      const found = resolve(modelName);
      const lower = modelName.toLowerCase();
      if (!found) {
        if (unreadable.has(lower) || stubs.has(lower)) continue;
        push({
          code: 'REL003',
          severity: 'error',
          message: `${where}: relationship ${describe} points at model ${modelName}, which is not in the model library`,
          files: [r.ref.file],
          link: linkKey(r.rel),
          fix: 'repoint',
          records: [r.ref],
        });
        continue;
      }
      if (inDiagram && !inDiagram.has(lower) && !stubs.has(lower)) {
        push({
          code: 'REL003',
          severity: 'error',
          message: `${where}: relationship ${describe} points at model ${found.model.name}, which is not one of this diagram's models, so the diagram does not draw it`,
          files: [r.ref.file],
          link: linkKey(r.rel),
          fix: 'repoint',
          records: [r.ref],
        });
        continue;
      }
      if (found.model.name !== modelName) respelled.push(`${modelName} → ${found.model.name}`);
      const columns = found.model.columns ?? [];
      const exact = columns.some((c) => c.name === columnName);
      const loose = columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
      if (!exact && loose) respelled.push(`${columnName} → ${loose.name}`);
      if (!exact && !loose && columns.length > 0 && !stubs.has(lower) && !unreadable.has(lower)) {
        push({
          code: 'REL004',
          severity: 'error',
          message: `${where}: relationship ${describe} uses column ${found.model.name}.${columnName}, which ${found.model.name} does not have`,
          files: [r.ref.file, ...(found.file ? [found.file] : [])],
          link: linkKey(r.rel),
          fix: 'repoint',
          records: [r.ref],
        });
      }
    }
    if (respelled.length > 0) {
      push({
        code: 'REL005',
        severity: 'warning',
        message: `${where}: relationship ${describe} names ${respelled.join(', ')} only when case is ignored`,
        files: [r.ref.file],
        link: linkKey(r.rel),
        fix: 'respell',
        records: [r.ref],
      });
    }

    const contradiction = keyEvidenceContradiction(r.rel, (name) => resolve(name)?.model);
    if (contradiction) {
      push({
        code: 'REL006',
        severity: 'info',
        message: `${where}: ${contradiction}`,
        files: [r.ref.file],
        link: linkKey(r.rel),
        fix: 'swap',
        records: [r.ref],
      });
    }
  }

  // --- Duplicates: REL001 and REL009 -----------------------------------------
  const byLink = new Map<string, Rec[]>();
  for (const r of records) {
    const key = linkKey(r.rel);
    const list = byLink.get(key);
    if (list) list.push(r);
    else byLink.set(key, [r]);
  }
  for (const [key, group] of byLink) {
    if (group.length < 2) continue;
    const library = group.filter((r) => r.ref.source.kind === 'library').sort(libraryRank);
    const domains = new Map<CheckDomain, Rec[]>();
    for (const r of group) {
      if (!r.domain) continue;
      const list = domains.get(r.domain);
      if (list) list.push(r);
      else domains.set(r.domain, [r]);
    }

    // The library's copies, against each other.
    if (library.length > 1) duplicate(key, library, push);
    // Each domain file's copies, against each other.
    for (const list of domains.values()) {
      if (list.length > 1) duplicate(key, list, push);
    }
    // Copies across domain files: only a finding in a library project.
    const libraryProjectDomains = [...domains.entries()].filter(([d]) => d.mode === 'library');
    if (library.length === 0 && libraryProjectDomains.length > 1) {
      duplicate(key, libraryProjectDomains.map(([, list]) => list[0]), push);
    }
    // Domain copies of a library link. A v4 diagram is not one: it draws
    // only its own records, never the library's, so the two never meet on
    // any canvas and cannot disagree (its own duplicates are checked above).
    if (library.length > 0) {
      const kept = library[0];
      for (const [domain, list] of domains) {
        if (isOlderFormat(domain)) continue;
        const first = list[0];
        if (!sameRelationshipMeaning(first.rel, kept.rel)) {
          duplicate(key, [kept, first], push);
        } else if (domain.mode === 'library') {
          push({
            code: 'REL009',
            severity: 'info',
            message: `${domain.filePath}: relationship ${describeLink(kept.rel)} is also in ${kept.ref.file}; the domain file copy is not needed`,
            files: [domain.filePath, kept.ref.file],
            link: key,
            fix: 'remove-domain-copy',
            records: [kept.ref, first.ref],
          });
        }
      }
    }
  }

  return findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.code.localeCompare(b.code)
    || (a.files[0] ?? '').localeCompare(b.files[0] ?? '')
    || (a.line ?? 0) - (b.line ?? 0)
    || a.message.localeCompare(b.message));
}

/** Whether a domain is in the older (v4, inline-model) format. */
function isOlderFormat(domain: CheckDomain): boolean {
  return domain.olderFormat === true || domain.models.some((m) => typeof m !== 'string');
}

/** A REL001 finding over records of one link, the first of which a reader draws. */
function duplicate(key: string, list: readonly Rec[], push: (f: RelationshipFinding) => void): void {
  const [kept, ...others] = list;
  const differs = others.some((r) => !sameRelationshipMeaning(r.rel, kept.rel));
  // Two copies in one file are told apart by their entry number rather than naming the file twice.
  const repeated = new Set(list.map((r) => r.ref.file).filter((f, i, all) => all.indexOf(f) !== i));
  const where = (r: Rec): string => repeated.has(r.ref.file)
    ? `${r.ref.file} entry ${r.position + 1}`
    : r.ref.file;
  const sites = list.map((r) => `${r.ref.cardinality}${r.ref.role ? ` "${r.ref.role}"` : ''} in ${where(r)}`);
  push({
    code: 'REL001',
    severity: differs ? 'error' : 'warning',
    message: differs
      ? `Relationship ${describeLink(kept.rel)} is stored ${list.length} times and the copies disagree (${sites.join('; ')})`
      : `Relationship ${describeLink(kept.rel)} is stored ${list.length} times (${list.map(where).join(', ')})`,
    files: [...new Set(list.map((r) => r.ref.file))],
    link: key,
    fix: differs ? 'choose' : 'remove-duplicates',
    records: list.map((r) => r.ref),
  });
}

/** Library records in the order a reader prefers them (see `normaliseRelationships`). */
function libraryRank(a: Rec, b: Rec): number {
  if (a.atHome !== b.atHome) return a.atHome ? -1 : 1;
  const ma = (a.ref.source as { model: string }).model.toLowerCase();
  const mb = (b.ref.source as { model: string }).model.toLowerCase();
  if (ma !== mb) return ma < mb ? -1 : 1;
  // Case-only variants (`Dd`, `DD`): the exact name, as the reader ranks them.
  const ea = (a.ref.source as { model: string }).model;
  const eb = (b.ref.source as { model: string }).model;
  if (ea !== eb) return ea < eb ? -1 : 1;
  return (a.ref.source as { index: number }).index - (b.ref.source as { index: number }).index;
}

function describeLink(rel: Relationship): string {
  const c = canonicalRelationship(rel);
  return `${c.fromModel}.${c.fromColumn} → ${c.toModel}.${c.toColumn}`;
}

/** A stored record without the runtime-only fields a reader may have added. */
function stripRuntime<T extends { source?: unknown; stored?: unknown; issues?: unknown }>(rel: T): Omit<T, 'source' | 'stored' | 'issues'> {
  const { source: _s, stored: _st, issues: _i, ...rest } = rel;
  return rest;
}

/**
 * How a record's model names resolve: a domain's inline (v4) models first,
 * then the library — exact name, then without case.
 */
function modelResolver(
  domain: CheckDomain | undefined,
  libByExact: ReadonlyMap<string, CheckLibraryModel>,
  libByLower: ReadonlyMap<string, CheckLibraryModel>,
): (name: string) => { model: SemanticModel; file?: string } | undefined {
  const inline = (domain?.models ?? []).filter((m): m is SemanticModel => typeof m !== 'string');
  return (name) => {
    const exactInline = inline.find((m) => m.name === name) ?? inline.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (exactInline) return { model: exactInline };
    const lib = libByExact.get(name) ?? libByLower.get(name.toLowerCase());
    return lib ? { model: lib.model, file: lib.file } : undefined;
  };
}
