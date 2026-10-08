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
  relationshipDifferences,
  relationshipFilePositions,
  sameRelationshipMeaning,
  type RelationshipEnds,
  type RelationshipIssueCode,
  type RelationshipSeverity,
  type RelationshipSource,
} from './relationships.js';
import { isStoredBackwards, keyEvidenceContradiction } from './normaliseRelationships.js';

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
  /** The direction contradicts key evidence: the user swaps the ends (⇄), makes it one-to-one, or leaves it. */
  | 'swap'
  /** The entry could not be read: open the file at the line. */
  | 'open-file'
  /** A domain-file copy saying what the library's says: remove the domain copy. */
  | 'remove-domain-copy'
  /**
   * A domain-file copy that says something else than the library's: diagrams
   * draw the library's and ignore it; never removed automatically — the user
   * deletes it if it is wrong.
   */
  | 'ignored-domain-copy';

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
  /** The key flags contradict its direction (REL006). */
  contradicted?: boolean;
  /** A model-library record in the 1.6.7 shape (`isStoredBackwards`): Repair Relationships… turns it round. */
  backwards?: boolean;
}

const SEVERITY_ORDER: Record<RelationshipSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Check every relationship the host loaded. Findings:
 *
 * - REL001 the same link stored more than once — within the library, or,
 *   for a link the library does not hold, within one domain file or across
 *   domain files of a library project. An error when the copies differ in
 *   cardinality, role or one-to-one direction, else a warning. In a
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
 * - REL006 the stored direction contradicts certain key evidence (info);
 *   `fix: 'rehome'` for a model-library record in the 1.6.7 shape
 *   (`isStoredBackwards`), which Repair Relationships… turns round, else
 *   `fix: 'swap'` (the user's to judge).
 * - REL008 a model file or domain file entry skipped or defaulted on read
 *   (error, with the line where known).
 * - REL009 a domain-file copy of a link the library also holds, in a library
 *   project (info) — one per domain file, whatever its copies say: every
 *   diagram draws the library's copy, so the domain file's is ignored. The
 *   message says whether it differs (and on what); Repair Relationships…
 *   removes only the copies that say the same (`fix: 'remove-domain-copy'`).
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
  // What each record needs from its domain is built once per domain, not once
  // per record, so the check stays linear in records + models.
  interface DomainView {
    resolve: ReturnType<typeof modelResolver>;
    stubs: ReadonlySet<string>;
    inDiagram?: ReadonlySet<string>;
  }
  const libraryView: DomainView = { resolve: modelResolver(undefined, libByExact, libByLower), stubs: new Set() };
  const domainViews = new Map<CheckDomain, DomainView>();
  const viewOf = (domain: CheckDomain | undefined): DomainView => {
    if (!domain) return libraryView;
    let view = domainViews.get(domain);
    if (!view) {
      const models = domain.models;
      view = {
        resolve: modelResolver(domain, libByExact, libByLower),
        stubs: new Set((domain.stubColumns ?? []).map((s) => s.toLowerCase())),
        // A domain file's own record is drawn only between the domain's own models.
        inDiagram: new Set(models.map((m) => (typeof m === 'string' ? m : m.name).toLowerCase())),
      };
      domainViews.set(domain, view);
    }
    return view;
  };
  for (const r of records) {
    const { resolve, stubs, inDiagram } = viewOf(r.domain);
    const describe = `${r.rel.fromModel}.${r.rel.fromColumn} → ${r.rel.toModel}.${r.rel.toColumn}`;
    const where = r.ref.file;

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
      // A domain file's own record is drawn only between that domain's own
      // models. This is asked first: a model whose file cannot be read — or
      // a name in `stubColumns`, which only excuses missing columns and never
      // puts a model on the diagram — is no reason to stay quiet about a
      // record the canvas does not draw (`normaliseRelationships` marks it
      // REL003 whatever the model file holds), so the canvas, `check` and the
      // banner always agree.
      if (inDiagram && !inDiagram.has(lower)) {
        push({
          code: 'REL003',
          severity: 'error',
          message: `${where}: relationship ${describe} points at model ${found?.model.name ?? modelName}, which is not one of this diagram's models, so the diagram does not draw it`,
          files: [r.ref.file],
          link: linkKey(r.rel),
          fix: 'repoint',
          records: [r.ref],
        });
        continue;
      }
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
      r.contradicted = true;
      // Only a model-library record is turned round by Repair Relationships…,
      // and only when the keys leave no other reading; anything else is the
      // user's to judge (⇄ on the line, or one-to-one).
      r.backwards = r.ref.source.kind === 'library' && isStoredBackwards(r.rel, (name) => resolve(name)?.model);
      push({
        code: 'REL006',
        severity: 'info',
        message: r.backwards
          ? `${where}: ${contradiction}. It is the shape ERD Studio 1.6.7 saved for a line drawn from a dimension to a fact — ` +
            'Repair Relationships… turns it round'
          : `${where}: ${contradiction}`,
        files: [r.ref.file],
        link: linkKey(r.rel),
        fix: r.backwards ? 'rehome' : 'swap',
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

    // A library project's diagram file copies of a link the library holds
    // are ignored for drawing (the library's copy wins on every canvas): they
    // are REL009, never a duplicate of the library's or of each other.
    const ignoredHere = (d: CheckDomain): boolean => library.length > 0 && d.mode === 'library' && !isOlderFormat(d);
    // The library's copies, against each other.
    if (library.length > 1) duplicate(key, library, push);
    // Each domain file's copies, against each other.
    for (const [d, list] of domains) {
      if (list.length > 1 && !ignoredHere(d)) duplicate(key, list, push);
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
        if (!ignoredHere(domain)) {
          // A per-domain project holds no library copies (`usesLibraryRelationships`);
          // should one meet a domain copy anyway, a disagreement is still said.
          if (!sameRelationshipMeaning(list[0].rel, kept.rel)) duplicate(key, [kept, list[0]], push);
          continue;
        }
        push(ignoredDomainCopy(key, kept, domain, list));
      }
    }
  }

  // Code-unit order, never `localeCompare`: the default collation follows the
  // machine's locale (LANG / LC_ALL), so a teammate and CI would list the
  // same findings in a different order.
  return findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || codeUnitOrder(a.code, b.code)
    || codeUnitOrder(a.files[0] ?? '', b.files[0] ?? '')
    || (a.line ?? 0) - (b.line ?? 0)
    || codeUnitOrder(a.message, b.message));
}

/** Plain code-unit comparison, the same on every machine whatever its locale. */
function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a domain is in the older (v4, inline-model) format. */
function isOlderFormat(domain: CheckDomain): boolean {
  return domain.olderFormat === true || domain.models.some((m) => typeof m !== 'string');
}

/**
 * REL009: a library project's domain file holding its own copies (`list`) of
 * a link the library also holds (`kept`, the copy every diagram draws). Says
 * whether they differ, and on what; only copies that say the same are for
 * Repair Relationships… to remove.
 */
function ignoredDomainCopy(key: string, kept: Rec, domain: CheckDomain, list: readonly Rec[]): RelationshipFinding {
  const differences = [...new Set(list.flatMap((r) => relationshipDifferences(r.rel, kept.rel)))];
  const copies = list.length === 1 ? 'copy' : `${list.length} copies`;
  const own = list.length === 1 ? 'its own copy' : `its own ${list.length} copies`;
  const says = (r: Rec): string => {
    const c = canonicalRelationship(r.rel);
    return `${c.cardinality}${r.ref.role ? ` "${r.ref.role}"` : ''}`;
  };
  const differing = list.filter((r) => !sameRelationshipMeaning(r.rel, kept.rel));
  const named = canonicalRelationship(kept.rel);
  const namedFrom = `${named.fromModel}.${named.fromColumn}`.toLowerCase();
  const sayDomain = differing.map((r) => {
    const c = canonicalRelationship(r.rel);
    const turned = c.cardinality !== 'many-to-many' && `${c.fromModel}.${c.fromColumn}`.toLowerCase() !== namedFrom
      ? ` ${c.fromModel}.${c.fromColumn} → ${c.toModel}.${c.toColumn}` : '';
    return `${says(r)}${turned}`;
  });
  return {
    code: 'REL009',
    severity: 'info',
    message: differences.length === 0
      ? `${domain.filePath}: relationship ${describeLink(kept.rel)} is also in ${kept.ref.file}; diagrams draw the model library's copy, ` +
        `so this diagram file's ${copies} ${list.length === 1 ? 'is' : 'are'} not needed — Repair Relationships… removes ${list.length === 1 ? 'it' : 'them'}`
      : `${domain.filePath}: relationship ${describeLink(kept.rel)} is also in ${kept.ref.file}, and this diagram file keeps ${own}, ` +
        `which differs on ${differences.join(' and ')} (model library: ${says(kept)}; here: ${sayDomain.join(', ')}); ` +
        "diagrams draw the model library's copy and ignore this one — delete it if it is wrong",
    files: [domain.filePath, kept.ref.file],
    link: key,
    fix: differing.length === 0 ? 'remove-domain-copy' : 'ignored-domain-copy',
    records: [kept.ref, ...list.map((r) => r.ref)],
  };
}

/** A REL001 finding over records of one link, the first of which a reader draws. */
function duplicate(key: string, list: readonly Rec[], push: (f: RelationshipFinding) => void): void {
  const [kept, ...others] = list;
  // A model-library copy in the 1.6.7 shape of the kept one says the same
  // thing turned round: Repair Relationships… removes it on its own.
  const backwardsCopy = (r: Rec): boolean => r.backwards === true && kept.ref.source.kind === 'library'
    && !sameRelationshipMeaning(r.rel, kept.rel)
    && sameRelationshipMeaning(turnedRound(r.rel), kept.rel);
  const differs = others.some((r) => !sameRelationshipMeaning(r.rel, kept.rel) && !backwardsCopy(r));
  const backwards = differs ? [] : others.filter(backwardsCopy);
  // Two copies in one file are told apart by their entry number rather than naming the file twice.
  const repeated = new Set(list.map((r) => r.ref.file).filter((f, i, all) => all.indexOf(f) !== i));
  const where = (r: Rec): string => repeated.has(r.ref.file)
    ? `${r.ref.file} entry ${r.position + 1}`
    : r.ref.file;
  // Each copy is described in the direction the link is named in (the kept
  // record's canonical one), never as stored: a reversed `one-to-many` copy
  // says the same as a `many-to-one` one, and listing it as "one-to-many"
  // against a link named the other way would read as a cardinality conflict
  // that is not there. A copy whose canonical direction differs from the
  // named one is shown with its own ends.
  const named = canonicalRelationship(kept.rel);
  const namedFrom = `${named.fromModel}.${named.fromColumn}`.toLowerCase();
  const runsAsNamed = (c: Relationship): boolean =>
    c.cardinality === 'many-to-many' || `${c.fromModel}.${c.fromColumn}`.toLowerCase() === namedFrom;
  const sites = list.map((r) => {
    const c = canonicalRelationship(r.rel);
    const ends = runsAsNamed(c) ? '' : ` ${c.fromModel}.${c.fromColumn} → ${c.toModel}.${c.toColumn}`;
    return `${c.cardinality}${ends}${r.ref.role ? ` "${r.ref.role}"` : ''} in ${where(r)}`;
  });
  // What actually differs, so the reader is never asked to choose between two
  // spellings of the same cardinality.
  const differences: string[] = [];
  if (differs) {
    const canon = list.map((r) => canonicalRelationship(r.rel));
    if (new Set(canon.map((c) => c.cardinality)).size > 1) differences.push('cardinality');
    if (canon.some((c) => c.cardinality !== 'many-to-many' && !runsAsNamed(c))
      && new Set(canon.map((c) => c.cardinality)).size === 1) differences.push('direction');
    if (new Set(list.map((r) => r.ref.role ?? '')).size > 1) differences.push('role');
  }
  const onWhat = differences.length > 0 ? ` on ${differences.join(' and ')}` : '';
  push({
    code: 'REL001',
    severity: differs ? 'error' : 'warning',
    message: differs
      ? `Relationship ${describeLink(kept.rel)} is stored ${list.length} times and the copies disagree${onWhat} (${sites.join('; ')})`
      : `Relationship ${describeLink(kept.rel)} is stored ${list.length} times (${list.map(where).join(', ')})` +
        (backwards.length > 0
          ? `; the copy in ${backwards.map(where).join(' and ')} is the same relationship saved backwards ` +
            '(the shape ERD Studio 1.6.7 saved for a line drawn from a dimension to a fact) — Repair Relationships… removes it'
          : ''),
    files: [...new Set(list.map((r) => r.ref.file))],
    link: key,
    fix: differs ? 'choose' : 'remove-duplicates',
    records: list.map((r) => r.ref),
  });
}

/** Library records in the order a reader prefers them (see `normaliseRelationships`). */
function libraryRank(a: Rec, b: Rec): number {
  if (a.atHome !== b.atHome) return a.atHome ? -1 : 1;
  if ((a.contradicted === true) !== (b.contradicted === true)) return a.contradicted ? 1 : -1;
  const ma = (a.ref.source as { model: string }).model.toLowerCase();
  const mb = (b.ref.source as { model: string }).model.toLowerCase();
  if (ma !== mb) return ma < mb ? -1 : 1;
  // Case-only variants (`Dd`, `DD`): the exact name, as the reader ranks them.
  const ea = (a.ref.source as { model: string }).model;
  const eb = (b.ref.source as { model: string }).model;
  if (ea !== eb) return ea < eb ? -1 : 1;
  return (a.ref.source as { index: number }).index - (b.ref.source as { index: number }).index;
}

/** `rel` with its two ends swapped (cardinality and role kept). */
function turnedRound(rel: Relationship): Relationship {
  return { ...rel, fromModel: rel.toModel, fromColumn: rel.toColumn, toModel: rel.fromModel, toColumn: rel.fromColumn };
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
  const inlineByExact = new Map<string, SemanticModel>();
  const inlineByLower = new Map<string, SemanticModel>();
  for (const m of domain?.models ?? []) {
    if (typeof m === 'string') continue;
    if (!inlineByExact.has(m.name)) inlineByExact.set(m.name, m);
    if (!inlineByLower.has(m.name.toLowerCase())) inlineByLower.set(m.name.toLowerCase(), m);
  }
  return (name) => {
    const exactInline = inlineByExact.get(name) ?? inlineByLower.get(name.toLowerCase());
    if (exactInline) return { model: exactInline };
    const lib = libByExact.get(name) ?? libByLower.get(name.toLowerCase());
    return lib ? { model: lib.model, file: lib.file } : undefined;
  };
}
