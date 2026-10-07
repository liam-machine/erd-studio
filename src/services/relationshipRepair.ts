/**
 * Repair Relationships… and Move Relationships to Model Library — the engine
 * (issue #133, R10). No `vscode`: the command runners in `src/commands/` own
 * the dialogs, the writes and the rollback; this file reads, plans and checks.
 *
 * - `readRepairSnapshot` reads every model file (`LogicalModelService.
 *   relationshipCheckModels`, the lookup the canvas and its notification use,
 *   so all three agree — D11) and every v5 domain file, decides the project's
 *   mode (`usesLibraryRelationships`) and runs core's `checkRelationships`.
 * - `analyseRepair` groups every stored record by link (`linkKey`) and works
 *   out what can be fixed without asking — a `one-to-many` saved on its one
 *   side (REL002) is turned round into its many side's file, an endpoint
 *   spelled in another case (REL005) is respelled, identical copies (REL001,
 *   and REL009's domain copies of a library link) are reduced to the one in
 *   its canonical home — and what only the user can decide: copies that
 *   disagree (REL001, never silently dropped — D12), a missing model or
 *   column (REL003 / REL004) and a direction the keys contradict (REL006).
 *   An entry the reader could not read (REL008) is never touched, nor is any
 *   other copy of its link.
 * - `planRelationshipRepair` asks those questions through an injected `ask`
 *   (one per question, always with "Leave as is"; `undefined` — Esc — cancels
 *   everything) and computes each file's new text from its bytes as read:
 *   only the `relationships:` list of a model file and `logical.relationships`
 *   of a domain file change, entry by entry, so comments, unknown keys and
 *   unreadable entries survive.
 * - `verifyRepair` re-reads the project after the writes and says what is
 *   wrong with the result, if anything — any byte outside the relationships
 *   changed, a planned finding still there, a new one, or a diagram drawing
 *   something other than it did (except where the user chose) — so the runner
 *   can put every file back.
 *
 * "Move Relationships to Model Library" is this engine with
 * `moveDomainsToLibrary`: every relationship a domain file holds goes to its
 * home model's file, and the domain copies go.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isMap, isPair, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { Node, Pair, YAMLMap } from 'yaml';

import {
  VALID_CARDINALITIES,
  canonicalRelationship,
  checkRelationships,
  linkKey,
  normaliseRelationshipRole,
  normaliseRelationships,
  parseLogicalModelText,
  sameRelationshipMeaning,
  type CheckUnreadableModel,
  type RelationshipEnds,
  type RelationshipFinding,
  type RelationshipIssueCode,
} from '@erd-studio/core';
import { setDomainRelationships, setYamlRelationships } from './minimalEdits';
import { usesLibraryRelationships } from './libraryRelationships';
import { detectDomainFormat } from '../types/semantic';
import type { ModelRelationship, Relationship, SemanticModel } from '../types/semantic';
import type { DomainService } from './domainService';
import type { LogicalModelService } from './logicalModelService';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A v5 domain file's models and own relationships, as read from disk. */
export interface DomainRelationships {
  /** `{layer}/{domain}`, as the user knows it. */
  label: string;
  filePath: string;
  models: string[];
  /**
   * Its `logical.relationships` entries with four text ends, as the canvas
   * draws them: an unrecognised cardinality reads as many-to-one, a role is
   * normalised. Entries without four text ends are left out (and never
   * touched by a writer).
   */
  relationships: Relationship[];
  /** Position of each of `relationships` in the file's `logical.relationships` array. */
  rawIndexes: number[];
  /** Whether each of `relationships` was read with a default cardinality (an unrecognised one on disk). */
  defaulted: boolean[];
  /** The domain's `stubColumns` (models whose missing columns are not findings). */
  stubColumns: string[];
  /** The file's text as read. */
  text: string;
}

const isWellFormed = (r: unknown): r is Relationship => !!r && typeof r === 'object'
  && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string');

/** Every readable v5 domain file's models and `logical.relationships`. */
export function readDomainRelationships(
  domainService: Pick<DomainService, 'listDomains'>,
  workspaceRoot: string,
  semanticDir: string,
): DomainRelationships[] {
  const domains: DomainRelationships[] = [];
  for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
    try {
      const text = fs.readFileSync(summary.filePath, 'utf-8');
      const raw = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
      if (detectDomainFormat(raw) !== 'v5') continue;
      const logical = raw.logical as { models?: unknown; relationships?: unknown } | undefined;
      const models = (Array.isArray(logical?.models) ? logical!.models : []).filter((m): m is string => typeof m === 'string');
      const relationships: Relationship[] = [];
      const rawIndexes: number[] = [];
      const defaulted: boolean[] = [];
      (Array.isArray(logical?.relationships) ? logical!.relationships as unknown[] : []).forEach((entry, index) => {
        if (!isWellFormed(entry)) return;
        // An unrecognised cardinality is drawn as many-to-one (core's
        // parseRelationships); a writer stores what the diagram shows, never the typo.
        const known = VALID_CARDINALITIES.has(entry.cardinality);
        const { role, ...rest } = entry;
        const label = normaliseRelationshipRole(role);
        relationships.push({
          ...rest,
          cardinality: known ? entry.cardinality : 'many-to-one',
          ...(label ? { role: label } : {}),
        });
        rawIndexes.push(index);
        defaulted.push(!known);
      });
      const stubColumns = (Array.isArray(raw.stubColumns) ? raw.stubColumns as unknown[] : [])
        .filter((s): s is string => typeof s === 'string');
      domains.push({
        label: `${summary.layer}/${summary.domain}`,
        filePath: summary.filePath,
        models,
        relationships,
        rawIndexes,
        defaulted,
        stubColumns,
        text,
      });
    } catch {
      // An unreadable domain keeps its relationships.
    }
  }
  return domains;
}

/** A model file in the library, as the engine read it. */
export interface RepairModelFile {
  /** The model's name (its `name:`). */
  name: string;
  filePath: string;
  /** How messages name the file: relative to the ERD data directory (`logical-models/gold/fct_order.yml`). */
  file: string;
  text: string;
  /** Parsed from `text`, with `relationshipIssues`. */
  model: SemanticModel;
  /** Position in the file's `relationships:` list of each of `model.relationships`. */
  rawIndexes: number[];
  /** Positions of entries the reader skipped or read with a default (REL008): never touched. */
  untouchable: Set<number>;
}

/** A v5 domain file, as the engine read it. */
export interface RepairDomainFile extends DomainRelationships {
  /** How messages name the file: relative to the ERD data directory (`silver/orders.json`). */
  file: string;
}

/** Everything the engine reads before planning, and again to verify. */
export interface RepairSnapshot {
  /** Where the project keeps relationships, before anything changes. */
  mode: 'library' | 'domain';
  modelFiles: RepairModelFile[];
  domains: RepairDomainFile[];
  unreadable: CheckUnreadableModel[];
  /** `checkRelationships` over all of it, files named as `file`. */
  findings: RelationshipFinding[];
}

export interface RepairSnapshotDeps {
  workspaceRoot: string;
  semanticDir: string;
  domainService: Pick<DomainService, 'listDomains' | 'countDomainFileRelationships'>;
  logicalModelService: Pick<LogicalModelService, 'relationshipCheckModels' | 'invalidateCache' | 'getModelsDir'>;
}

/** A file named relative to the ERD data directory (the parent of `logical-models/`), with forward slashes. */
export function repairFileLabel(modelsDir: string, filePath: string): string {
  return path.relative(path.dirname(modelsDir), filePath).split(path.sep).join('/');
}

/**
 * Read the project fresh (the model cache is dropped first: a cached copy
 * may predate an edit made on disk) and check it.
 */
export function readRepairSnapshot(deps: RepairSnapshotDeps): RepairSnapshot {
  const { workspaceRoot, semanticDir, domainService, logicalModelService } = deps;
  logicalModelService.invalidateCache();
  const modelsDir = logicalModelService.getModelsDir();
  const label = (filePath: string): string => repairFileLabel(modelsDir, filePath);

  const { libraryModels, unreadableModels } = logicalModelService.relationshipCheckModels((p) => p);
  const unreadable: CheckUnreadableModel[] = unreadableModels.map((u) => ({ ...u, file: label(u.file) }));
  const modelFiles: RepairModelFile[] = [];
  for (const { file: filePath } of libraryModels) {
    const stem = path.basename(filePath).replace(/\.ya?ml$/i, '');
    let text: string;
    let model: SemanticModel | null;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
      model = parseLogicalModelText(text, stem);
    } catch {
      model = null;
      text = '';
    }
    if (!model) {
      // Changed under us between the two reads: treat it as the checks treat an unreadable file.
      unreadable.push({ name: stem, file: label(filePath) });
      continue;
    }
    const issues = model.relationshipIssues ?? [];
    const skipped = new Set(issues.filter((i) => i.skipped).map((i) => i.index));
    const rawIndexes: number[] = [];
    for (let raw = 0; rawIndexes.length < (model.relationships?.length ?? 0); raw++) {
      if (!skipped.has(raw)) rawIndexes.push(raw);
    }
    modelFiles.push({
      name: model.name,
      filePath,
      file: label(filePath),
      text,
      model,
      rawIndexes,
      untouchable: new Set(issues.map((i) => i.index)),
    });
  }

  const domains: RepairDomainFile[] = readDomainRelationships(domainService, workspaceRoot, semanticDir)
    .map((d) => ({ ...d, file: label(d.filePath) }));
  const mode = usesLibraryRelationships(
    modelFiles.map((m) => m.model),
    domainService.countDomainFileRelationships(workspaceRoot, semanticDir),
  ) ? 'library' : 'domain';
  const findings = checkRelationships({
    libraryModels: modelFiles.map((m) => ({ model: m.model, file: m.file })),
    domains: domains.map((d) => ({
      label: d.label,
      filePath: d.file,
      models: d.models,
      relationships: d.relationships,
      mode,
      ...(d.stubColumns.length > 0 ? { stubColumns: d.stubColumns } : {}),
    })),
    unreadableModels: unreadable,
  });
  return { mode, modelFiles, domains, unreadable, findings };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** The option id that leaves a relationship as it is. Every question has it, last. */
export const LEAVE_AS_IS = 'leave';

export interface RepairOption {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** One decision only the user can make. */
export interface RepairQuestion {
  code: RelationshipIssueCode;
  kind: 'conflict' | 'endpoint' | 'direction';
  /** The relationship, as the user reads it. */
  subject: string;
  /** What is being asked. */
  prompt: string;
  /** The choices; the last is always {@link LEAVE_AS_IS}. */
  options: RepairOption[];
}

/**
 * Ask the user one question; resolve with the picked option's id, or
 * `undefined` to cancel everything (Esc). `position` counts relationships
 * that need a decision, not questions (one relationship may need two).
 */
export type RepairAsk = (question: RepairQuestion, position: { index: number; total: number }) => Promise<string | undefined>;

export interface RepairOptions {
  /** "Move Relationships to Model Library": every domain-file relationship goes to its home model's file. */
  moveDomainsToLibrary?: boolean;
}

/** One stored relationship record. */
interface Rec {
  where: 'library' | 'domain';
  modelFile?: RepairModelFile;
  domain?: RepairDomainFile;
  /** Index in `model.relationships` / `domain.relationships` (what findings count). */
  readIndex: number;
  /** Position in the file's own list. */
  rawIndex: number;
  /** As stored, with `fromModel` (a library entry's is its file's model). */
  rel: Relationship;
  /** A model file entry the reader defaulted something about (REL008): never touched. */
  untouchable: boolean;
  /** The file it is in, as messages name it. */
  file: string;
}

/** One link (`linkKey`), and the records of it one repair settles together. */
interface LinkTask {
  key: string;
  /** `library`: settled into one record in the home model's file. `domain`: settled within one domain file. */
  scope: 'library' | 'domain';
  domain?: RepairDomainFile;
  records: Rec[];
  /** REL003 / REL004 / REL006 findings about these records. */
  findings: RelationshipFinding[];
  /** Whether the link had a library record before. */
  hadLibraryRecord: boolean;
  /** Whether any domain record here is being moved into the library by the move. */
  moving: boolean;
  /**
   * Other records of the link are settled separately (another domain file's
   * copies, in a per-domain project), so REL001 / REL009 about the link may
   * remain.
   */
  partialLeft: boolean;
}

export interface RepairAnalysis {
  tasks: LinkTask[];
  /** Relationships with something to fix but an unreadable copy, left as they are. */
  blocked: string[];
  /** REL008 findings: entries the reader could not read in full, left for the user (with their line). */
  unreadableEntries: RelationshipFinding[];
  /** Absolute paths of every file a repair might write — checked for unsaved edits before asking anything. */
  involvedFiles: string[];
  /** How many relationships need a decision. */
  questionCount: number;
}

/** What changes in one file. */
export interface RepairFileChange {
  filePath: string;
  file: string;
  kind: 'model' | 'domain';
  original: string;
  text: string;
  /** One line per change, for the preview. */
  notes: string[];
}

/** How many relationships each kind of fix touched. */
export interface RepairCounts {
  /** REL002: stored on their one side, moved to the many side's file. */
  rehomed: number;
  /** REL005: endpoint spelling fixed. */
  respelled: number;
  /** REL001: extra identical copies removed. */
  deduplicated: number;
  /** REL009: a domain-file copy of a library relationship removed. */
  domainCopiesRemoved: number;
  /** Move: domain-file relationships stored in the model library. */
  moved: number;
  /** REL001: disagreeing copies settled the way the user picked. */
  settled: number;
  /** REL003 / REL004: removed on the user's say-so. */
  removed: number;
  /** REL003 / REL004: pointed at another model or column. */
  repointed: number;
  /** REL006: ends swapped. */
  swapped: number;
  /** Left as they are: the user's "Leave as is", or nowhere to store them. */
  left: number;
  /** Move: left in the domain files because their home model has no readable file. */
  noHome: number;
}

export interface RepairPlan {
  changes: RepairFileChange[];
  counts: RepairCounts;
  /** Why some relationships were left as they are, one line each. */
  left: string[];
  unreadableEntries: RelationshipFinding[];
  /** What `verifyRepair` holds the result to. */
  expect: {
    /** Findings that must be gone: no finding with this `code` and `link` may name any of `files`. */
    gone: Array<{ code: RelationshipIssueCode; link: string; files: string[] }>;
    /** Links whose drawing the user chose to change (old and new keys). */
    userChanged: Set<string>;
    /** Links now stored in the model library that were not before: every diagram with both models draws them. */
    consolidated: Set<string>;
  };
}

/** A file whose relationships cannot be edited safely; the message names it. */
export class RepairEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairEditError';
  }
}

const describeEnds = (r: RelationshipEnds): string => `${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn}`;
const lower = (s: string): string => s.toLowerCase();
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Model lookup as `checkRelationships` does it: exact name, then without case (alphabetically first). */
function libraryIndex(modelFiles: readonly RepairModelFile[]): (name: string) => RepairModelFile | undefined {
  const exact = new Map<string, RepairModelFile>();
  for (const m of modelFiles) if (!exact.has(m.name)) exact.set(m.name, m);
  const loose = new Map<string, RepairModelFile>();
  for (const name of [...exact.keys()].sort()) {
    if (!loose.has(lower(name))) loose.set(lower(name), exact.get(name)!);
  }
  return (name) => exact.get(name) ?? loose.get(lower(name));
}

/** `rel` with each end spelled as the library spells it (REL005 is never written). */
function respellWith(find: (name: string) => RepairModelFile | undefined, rel: Relationship): Relationship {
  const fix = (modelName: string, column: string): [string, string] => {
    const found = find(modelName);
    if (!found) return [modelName, column];
    const columns = found.model.columns ?? [];
    const real = columns.find((c) => c.name === column) ?? columns.find((c) => lower(c.name) === lower(column));
    return [found.name, real?.name ?? column];
  };
  const [fromModel, fromColumn] = fix(rel.fromModel, rel.fromColumn);
  const [toModel, toColumn] = fix(rel.toModel, rel.toColumn);
  return { ...rel, fromModel, fromColumn, toModel, toColumn };
}

/** Just what is stored: ends, cardinality and role. */
function plain(rel: Relationship): Relationship {
  const role = normaliseRelationshipRole(rel.role);
  return {
    fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn,
    cardinality: rel.cardinality, ...(role ? { role } : {}),
  };
}

/** The relationship a record means: respelled, turned canonical. */
function meaningOf(find: (name: string) => RepairModelFile | undefined, rel: Relationship): Relationship {
  return plain(canonicalRelationship(respellWith(find, rel)));
}

/**
 * The stored fields of a record, spelling and all — not a link identity
 * (that is `linkKey`): two records that differ only in case differ here,
 * which is how a respelling is detected.
 */
const storedFields = (r: Relationship): string =>
  [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? ''].join('\u0000');

/** Whether the stored fields of two records are exactly alike. */
function sameStoredFields(a: Relationship, b: Relationship): boolean {
  return storedFields(a) === storedFields(b);
}

/** The order a reader prefers records in (core's `normaliseRelationships`): library at home, by holder, by index. */
function rankRecords(a: Rec, b: Rec): number {
  if (a.where !== b.where) return a.where === 'library' ? -1 : 1;
  if (a.where === 'library') {
    const aHome = lower(canonicalRelationship(a.rel).fromModel) === lower(a.modelFile!.name);
    const bHome = lower(canonicalRelationship(b.rel).fromModel) === lower(b.modelFile!.name);
    if (aHome !== bHome) return aHome ? -1 : 1;
    const ma = lower(a.modelFile!.name);
    const mb = lower(b.modelFile!.name);
    if (ma !== mb) return ma < mb ? -1 : 1;
  } else if (a.domain !== b.domain) {
    return a.domain!.file < b.domain!.file ? -1 : 1;
  }
  return a.readIndex - b.readIndex;
}

/** Every record, in a stable order. */
function collectRecords(snapshot: RepairSnapshot): Rec[] {
  const records: Rec[] = [];
  for (const modelFile of snapshot.modelFiles) {
    (modelFile.model.relationships ?? []).forEach((entry, readIndex) => {
      const rawIndex = modelFile.rawIndexes[readIndex];
      records.push({
        where: 'library',
        modelFile,
        readIndex,
        rawIndex,
        rel: plain({ ...entry, fromModel: modelFile.name }),
        untouchable: modelFile.untouchable.has(rawIndex),
        file: modelFile.file,
      });
    });
  }
  for (const domain of snapshot.domains) {
    domain.relationships.forEach((rel, readIndex) => {
      records.push({
        where: 'domain',
        domain,
        readIndex,
        rawIndex: domain.rawIndexes[readIndex],
        rel: plain(rel),
        // A domain file's unrecognised cardinality is drawn as many-to-one;
        // storing that loses nothing the diagram shows (the move always did).
        untouchable: false,
        file: domain.file,
      });
    });
  }
  return records;
}

/** Findings by the record they are about. */
function findingsByRecord(snapshot: RepairSnapshot): Map<string, RelationshipFinding[]> {
  const byRecord = new Map<string, RelationshipFinding[]>();
  for (const finding of snapshot.findings) {
    if (finding.code !== 'REL003' && finding.code !== 'REL004' && finding.code !== 'REL006') continue;
    for (const ref of finding.records ?? []) {
      const id = ref.source.kind === 'library'
        ? `library\u0000${lower(ref.source.model)}\u0000${ref.source.index}`
        : `domain\u0000${ref.file}\u0000${ref.source.index}`;
      byRecord.set(id, [...(byRecord.get(id) ?? []), finding]);
    }
  }
  return byRecord;
}

const recordId = (r: Rec): string => (r.where === 'library'
  ? `library\u0000${lower(r.modelFile!.name)}\u0000${r.readIndex}`
  : `domain\u0000${r.file}\u0000${r.readIndex}`);

/**
 * Group the project's relationship records into the repairs that could be
 * made, and say which need a decision. Pure; reads only the snapshot.
 */
export function analyseRepair(snapshot: RepairSnapshot, options: RepairOptions = {}): RepairAnalysis {
  const move = options.moveDomainsToLibrary === true;
  const find = libraryIndex(snapshot.modelFiles);
  const byRecord = findingsByRecord(snapshot);
  const groups = new Map<string, Rec[]>();
  for (const r of collectRecords(snapshot)) {
    const key = linkKey(r.rel);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const candidates: LinkTask[] = [];
  for (const [key, records] of groups) {
    const library = records.filter((r) => r.where === 'library');
    const domainRecs = records.filter((r) => r.where === 'domain');
    // The move asks only what moving needs settled (copies that disagree);
    // a missing endpoint or a doubtful direction is Repair Relationships…' to ask.
    const findingsOf = (recs: readonly Rec[]): RelationshipFinding[] =>
      (move ? [] : [...new Set(recs.flatMap((r) => byRecord.get(recordId(r)) ?? []))]);
    const domainFiles = new Set(domainRecs.map((r) => r.domain!));
    const libraryScope = library.length > 0
      || (domainRecs.length > 0 && (move || (snapshot.mode === 'library' && domainFiles.size > 1)));
    let perDomain = domainRecs;
    if (libraryScope) {
      const recs = [...records].sort(rankRecords);
      perDomain = [];
      candidates.push({
        key, scope: 'library', records: recs, findings: findingsOf(recs),
        hadLibraryRecord: library.length > 0, moving: domainRecs.length > 0, partialLeft: false,
      });
    }
    for (const domain of new Set(perDomain.map((r) => r.domain!))) {
      const recs = perDomain.filter((r) => r.domain === domain).sort(rankRecords);
      candidates.push({
        key, scope: 'domain', domain, records: recs, findings: findingsOf(recs),
        hadLibraryRecord: false, moving: false, partialLeft: recs.length < records.length,
      });
    }
  }

  const tasks: LinkTask[] = [];
  const blocked: string[] = [];
  const involved = new Set<string>();
  let questionCount = 0;
  for (const task of candidates) {
    const meanings = distinctMeanings(find, task.records);
    const r = meanings[0].rel;
    const needsQuestion = meanings.length > 1 || task.findings.length > 0;
    const autoChange = needsQuestion ? false : wouldChange(find, task, r);
    if (!needsQuestion && !autoChange) continue;
    if (task.records.some((rec) => rec.untouchable)) {
      const unreadable = task.records.find((rec) => rec.untouchable)!;
      blocked.push(`${describeEnds(r)}: an entry of it in ${unreadable.file} could not be read in full, so every copy is left as it is — fix that entry first.`);
      continue;
    }
    tasks.push(task);
    if (needsQuestion) questionCount++;
    for (const rec of task.records) {
      involved.add(rec.where === 'library' ? rec.modelFile!.filePath : rec.domain!.filePath);
    }
    if (task.scope === 'library') {
      for (const m of meanings) {
        const home = find(m.rel.fromModel);
        if (home) involved.add(home.filePath);
      }
    }
  }
  return {
    tasks,
    blocked,
    unreadableEntries: snapshot.findings.filter((f) => f.code === 'REL008'),
    involvedFiles: [...involved],
    questionCount,
  };
}

interface Meaning {
  rel: Relationship;
  records: Rec[];
}

/** The distinct things a link's records say, the reader's first choice first. */
function distinctMeanings(find: (name: string) => RepairModelFile | undefined, records: readonly Rec[]): Meaning[] {
  const meanings: Meaning[] = [];
  for (const rec of records) {
    const rel = meaningOf(find, rec.rel);
    const same = meanings.find((m) => sameRelationshipMeaning(m.rel, rel));
    if (same) same.records.push(rec);
    else meanings.push({ rel, records: [rec] });
  }
  return meanings;
}

/** Whether settling `task` on `r` would change any file (no questions involved). */
function wouldChange(find: (name: string) => RepairModelFile | undefined, task: LinkTask, r: Relationship): boolean {
  if (task.records.length > 1) return true;
  const only = task.records[0];
  if (task.scope === 'library') {
    const home = find(r.fromModel);
    if (!home) return false;
    if (only.where === 'domain') return true;
    if (only.modelFile !== home) return true;
    return !sameStoredFields(only.rel, { ...r, fromModel: home.name });
  }
  return !sameStoredFields(only.rel, respellWith(find, only.rel));
}

/** Edits to one file, by position in its own list. */
interface FileEdits {
  remove: Set<number>;
  update: Map<number, Relationship>;
  append: Relationship[];
  notes: string[];
}

const newEdits = (): FileEdits => ({ remove: new Set(), update: new Map(), append: [], notes: [] });

/**
 * Plan a repair: ask every question `analyseRepair` found (through `ask`),
 * then compute each file's new text. Resolves `null` when the user cancels.
 * Throws `RepairEditError` when a file cannot be edited safely.
 */
export async function planRelationshipRepair(
  snapshot: RepairSnapshot,
  options: RepairOptions,
  ask: RepairAsk,
  analysis: RepairAnalysis = analyseRepair(snapshot, options),
): Promise<RepairPlan | null> {
  const find = libraryIndex(snapshot.modelFiles);
  const allLinks = new Set(collectRecords(snapshot).map((r) => linkKey(r.rel)));
  const modelEdits = new Map<RepairModelFile, FileEdits>();
  const domainEdits = new Map<RepairDomainFile, FileEdits>();
  const editsFor = (rec: { modelFile?: RepairModelFile; domain?: RepairDomainFile }): FileEdits => {
    if (rec.modelFile) {
      if (!modelEdits.has(rec.modelFile)) modelEdits.set(rec.modelFile, newEdits());
      return modelEdits.get(rec.modelFile)!;
    }
    if (!domainEdits.has(rec.domain!)) domainEdits.set(rec.domain!, newEdits());
    return domainEdits.get(rec.domain!)!;
  };
  const counts: RepairCounts = {
    rehomed: 0, respelled: 0, deduplicated: 0, domainCopiesRemoved: 0, moved: 0, settled: 0,
    removed: 0, repointed: 0, swapped: 0, left: 0, noHome: 0,
  };
  const left: string[] = [...analysis.blocked];
  counts.left += analysis.blocked.length;
  const gone: RepairPlan['expect']['gone'] = [];
  const userChanged = new Set<string>();
  const consolidated = new Set<string>();

  let asked = 0;
  for (const task of analysis.tasks) {
    const meanings = distinctMeanings(find, task.records);
    const subject = describeEnds(meanings[0].rel);
    let numbered = false;
    const position = (): { index: number; total: number } => {
      if (!numbered) { asked++; numbered = true; }
      return { index: asked, total: analysis.questionCount };
    };
    const taskFiles = [...new Set(task.records.map((rec) => rec.file))];
    const expectGone = (code: RelationshipIssueCode, link = task.key): void => {
      if ((code === 'REL001' || code === 'REL009') && task.partialLeft) return;
      gone.push({ code, link, files: taskFiles });
    };

    // --- 1. Which meaning (REL001, copies that disagree) --------------------
    let r = meanings[0].rel;
    let userPicked = false;
    if (meanings.length > 1) {
      const answer = await ask(conflictQuestion(task, meanings, find), position());
      if (answer === undefined) return null;
      if (answer === LEAVE_AS_IS) {
        left.push(`${subject}: its copies disagree — left as they are.`);
        counts.left++;
        continue;
      }
      r = meanings[Number(answer.slice('meaning:'.length))].rel;
      userPicked = true;
      userChanged.add(task.key);
      counts.settled++;
    }

    // --- 2. A missing model or column (REL003 / REL004) ---------------------
    const endpointFinding = task.findings.find((f) => f.code === 'REL003' || f.code === 'REL004');
    const problem = endpointFinding ? missingEnd(find, r) : null;
    if (endpointFinding && problem) {
      const question = endpointQuestion(task, r, problem, endpointFinding, find, snapshot.modelFiles, allLinks);
      const answer = await ask(question, position());
      if (answer === undefined) return null;
      if (answer === 'remove') {
        for (const rec of task.records) {
          const edits = editsFor(rec);
          edits.remove.add(rec.rawIndex);
          edits.notes.push(`removes ${describeEnds(rec.rel)} (${problem.what})`);
        }
        userChanged.add(task.key);
        expectGone(endpointFinding.code);
        if (task.records.length > 1) expectGone('REL001');
        counts.removed++;
        continue;
      }
      if (answer.startsWith('repoint:')) {
        const [, model, column] = answer.split('\u0000');
        r = problem.side === 'from'
          ? { ...r, fromModel: model, fromColumn: column }
          : { ...r, toModel: model, toColumn: column };
        userChanged.add(task.key);
        userChanged.add(linkKey(r));
        userPicked = true;
        expectGone(endpointFinding.code, task.key);
        counts.repointed++;
      } else {
        left.push(`${describeEnds(r)}: ${problem.what} — left as it is.`);
        counts.left++;
      }
    }

    // --- 3. A direction the keys contradict (REL006) ------------------------
    const directionFinding = task.findings.find((f) => f.code === 'REL006');
    if (directionFinding && !userPicked && r.cardinality !== 'many-to-many') {
      const answer = await ask(directionQuestion(r, directionFinding), position());
      if (answer === undefined) return null;
      if (answer === 'swap') {
        r = { ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn };
        userChanged.add(task.key);
        expectGone('REL006');
        counts.swapped++;
      } else {
        left.push(`${describeEnds(r)}: the keys suggest the other direction — left as it is.`);
        counts.left++;
      }
    }

    // --- 4. One record, at its home ----------------------------------------
    const respelledAny = task.records.some((rec) => !sameStoredFields(rec.rel, respellWith(find, rec.rel)));
    const oneSided = task.records.some((rec) => rec.where === 'library' && rec.rel.cardinality === 'one-to-many');
    if (task.scope === 'library') {
      const home = find(r.fromModel);
      if (!home) {
        const reason = `${r.fromModel} has no readable file in logical-models/, so it stays where it is.`;
        left.push(`${describeEnds(r)}: ${reason}`);
        counts.left++;
        if (task.moving && !task.hadLibraryRecord) counts.noHome++;
        continue;
      }
      const record: Relationship = { ...r, fromModel: home.name };
      // A library record's fromModel is its file's model name, so any record in the home file will do.
      const keep = task.records
        .filter((rec) => rec.where === 'library' && rec.modelFile === home)
        .sort((a, b) => a.rawIndex - b.rawIndex)[0];
      for (const rec of task.records) {
        if (rec === keep) continue;
        const edits = editsFor(rec);
        edits.remove.add(rec.rawIndex);
        edits.notes.push(rec.where === 'domain'
          ? `removes its copy of ${describeEnds(record)} (now defined once, in ${home.file})`
          : `removes ${describeEnds(rec.rel)} (stored once, in ${home.file})`);
      }
      const homeEdits = editsFor({ modelFile: home });
      if (keep) {
        if (!sameStoredFields(keep.rel, record)) {
          homeEdits.update.set(keep.rawIndex, record);
          homeEdits.notes.push(`changes ${describeEnds(keep.rel)} to ${describeRecord(record)}`);
        }
      } else {
        homeEdits.append.push(record);
        homeEdits.notes.push(`adds ${describeRecord(record)}`);
      }
      // Counted once each, by what was wrong.
      const libraryRecs = task.records.filter((rec) => rec.where === 'library');
      const domainRecs = task.records.filter((rec) => rec.where === 'domain');
      if (task.records.length > 1) expectGone('REL001');
      if (oneSided) { counts.rehomed++; expectGone('REL002'); }
      if (respelledAny) { counts.respelled++; expectGone('REL005'); }
      if (libraryRecs.length > 1 && meanings.length === 1) counts.deduplicated++;
      if (domainRecs.length > 0) {
        if (task.hadLibraryRecord) {
          counts.domainCopiesRemoved++;
          expectGone('REL009');
        } else {
          counts.moved++;
          consolidated.add(linkKey(record));
        }
      }
    } else {
      const keep = task.records[0];
      const record = r;
      for (const rec of task.records.slice(1)) {
        const edits = editsFor(rec);
        edits.remove.add(rec.rawIndex);
        edits.notes.push(`removes another copy of ${describeEnds(record)}`);
      }
      if (!sameRelationshipMeaning(keep.rel, record) || !sameStoredFields(keep.rel, respellWith(find, keep.rel))
        || linkKey(keep.rel) !== linkKey(record)) {
        const edits = editsFor(keep);
        edits.update.set(keep.rawIndex, record);
        edits.notes.push(`changes ${describeEnds(keep.rel)} to ${describeRecord(record)}`);
      }
      if (respelledAny) { counts.respelled++; expectGone('REL005'); }
      if (task.records.length > 1) {
        if (meanings.length === 1) counts.deduplicated++;
        expectGone('REL001');
      }
    }
  }

  // --- Each file's new text ---------------------------------------------------
  const changes: RepairFileChange[] = [];
  for (const [modelFile, edits] of modelEdits) {
    const text = editYamlRelationships(modelFile.text, {
      remove: edits.remove,
      update: new Map([...edits.update].map(([i, rel]) => [i, toModelEntry(rel)])),
      append: edits.append.map(toModelEntry),
    }, modelFile.file);
    if (text !== modelFile.text) {
      changes.push({ filePath: modelFile.filePath, file: modelFile.file, kind: 'model', original: modelFile.text, text, notes: edits.notes });
    }
  }
  for (const [domain, edits] of domainEdits) {
    const text = editDomainRelationships(domain.text, edits, domain.file);
    if (text !== domain.text) {
      changes.push({ filePath: domain.filePath, file: domain.file, kind: 'domain', original: domain.text, text, notes: edits.notes });
    }
  }
  changes.sort((a, b) => (a.kind === b.kind ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.kind === 'model' ? -1 : 1));
  return {
    changes,
    counts,
    left,
    unreadableEntries: analysis.unreadableEntries,
    expect: { gone, userChanged, consolidated },
  };
}

function describeRecord(r: Relationship): string {
  return `${describeEnds(r)} (${r.cardinality}${r.role ? `, "${r.role}"` : ''})`;
}

function toModelEntry(rel: Relationship): ModelRelationship {
  return {
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
    ...(rel.role ? { role: rel.role } : {}),
  };
}

function conflictQuestion(
  task: LinkTask,
  meanings: readonly Meaning[],
  find: (name: string) => RepairModelFile | undefined,
): RepairQuestion {
  const files = (m: Meaning): string => [...new Set(m.records.map((rec) => (rec.domain ? rec.domain.label : rec.file)))].join(', ');
  return {
    code: 'REL001',
    kind: 'conflict',
    subject: describeEnds(meanings[0].rel),
    prompt: 'The copies of this relationship disagree. Which one should every diagram draw? (Esc cancels everything)',
    options: [
      ...meanings.map((m, i) => {
        const home = task.scope === 'library' ? find(m.rel.fromModel) : undefined;
        return {
          id: `meaning:${i}`,
          label: describeRecord(m.rel),
          description: `as in ${files(m)}`,
          detail: task.scope === 'library'
            ? (home ? `Saved once, in ${home.file}; every other copy is removed.` : `${m.rel.fromModel} has no model file, so nothing changes.`)
            : `Kept once in ${task.domain!.file}; the other copies there are removed.`,
        };
      }),
      leaveOption('Every copy stays as it is. Run this command again to settle it.'),
    ],
  };
}

function leaveOption(detail: string): RepairOption {
  return { id: LEAVE_AS_IS, label: 'Leave as is', description: 'decide later', detail };
}

interface MissingEnd {
  side: 'from' | 'to';
  kind: 'model' | 'column';
  model: string;
  column: string;
  /** e.g. "model dim_x is not in the model library". */
  what: string;
}

/** The end of `r` whose model or column the library does not have, if any. */
function missingEnd(find: (name: string) => RepairModelFile | undefined, r: Relationship): MissingEnd | null {
  for (const side of ['from', 'to'] as const) {
    const model = side === 'from' ? r.fromModel : r.toModel;
    const column = side === 'from' ? r.fromColumn : r.toColumn;
    const found = find(model);
    if (!found) return { side, kind: 'model', model, column, what: `model ${model} is not in the model library` };
    const columns = found.model.columns ?? [];
    if (columns.length > 0 && !columns.some((c) => lower(c.name) === lower(column))) {
      return { side, kind: 'column', model: found.name, column, what: `${found.name} has no column ${column}` };
    }
  }
  return null;
}

/** Up to this many "Point it at …" choices. */
const MAX_REPOINT_CHOICES = 40;

function endpointQuestion(
  task: LinkTask,
  r: Relationship,
  problem: MissingEnd,
  finding: RelationshipFinding,
  find: (name: string) => RepairModelFile | undefined,
  modelFiles: readonly RepairModelFile[],
  allLinks: ReadonlySet<string>,
): RepairQuestion {
  const where = [...new Set(task.records.map((rec) => rec.file))].join(', ');
  const targets: Array<{ model: string; column: string }> = [];
  if (problem.kind === 'column') {
    const columns = (find(problem.model)?.model.columns ?? []).map((c) => c.name);
    const near = (c: string): number => (lower(c).includes(lower(problem.column)) || lower(problem.column).includes(lower(c)) ? 0 : 1);
    for (const column of [...columns].sort((a, b) => near(a) - near(b) || a.localeCompare(b))) {
      targets.push({ model: problem.model, column });
    }
  } else {
    // Another model with a column of that name (a renamed model, typically).
    for (const m of [...modelFiles].sort((a, b) => a.name.localeCompare(b.name))) {
      const column = (m.model.columns ?? []).find((c) => lower(c.name) === lower(problem.column));
      if (column) targets.push({ model: m.name, column: column.name });
    }
  }
  return {
    code: finding.code,
    kind: 'endpoint',
    subject: describeEnds(r),
    prompt: `${capitalise(problem.what)}. What should happen to this relationship? (Esc cancels everything)`,
    options: [
      {
        id: 'remove',
        label: 'Remove this relationship',
        description: `from ${where}`,
        detail: 'No diagram draws it any more.',
      },
      ...repointOptions(r, problem, targets, allLinks),
      leaveOption('It stays as it is, pointing at nothing. Run this command again to settle it.'),
    ],
  };
}

function repointOptions(
  r: Relationship,
  problem: MissingEnd,
  targets: ReadonlyArray<{ model: string; column: string }>,
  allLinks: ReadonlySet<string>,
): RepairOption[] {
  const options: RepairOption[] = [];
  for (const target of targets) {
    const next = problem.side === 'from'
      ? { ...r, fromModel: target.model, fromColumn: target.column }
      : { ...r, toModel: target.model, toColumn: target.column };
    // Never onto a link that is already stored (a duplicate), nor onto itself.
    if (allLinks.has(linkKey(next))) continue;
    if (lower(next.fromModel) === lower(next.toModel) && lower(next.fromColumn) === lower(next.toColumn)) continue;
    options.push({
      id: `repoint:\u0000${target.model}\u0000${target.column}`,
      label: `Point it at ${target.model}.${target.column}`,
      description: describeEnds(next),
    });
    if (options.length >= MAX_REPOINT_CHOICES) break;
  }
  return options;
}

function directionQuestion(r: Relationship, finding: RelationshipFinding): RepairQuestion {
  const side = r.cardinality === 'one-to-one' ? 'the side holding the foreign key' : 'the many side';
  return {
    code: 'REL006',
    kind: 'direction',
    subject: describeEnds(r),
    prompt: 'The keys suggest this relationship runs the other way. Swap its ends? (Esc cancels everything)',
    options: [
      {
        id: 'swap',
        label: `Swap ends — make ${r.toModel} ${side}`,
        description: describeEnds({ fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn }),
        detail: finding.message,
      },
      leaveOption('Its direction stays as it is.'),
    ],
  };
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The preview's detail: every file and what changes in it, what is left as
 * it is and why, and entries that could not be read.
 */
export function describeRepairPlan(plan: RepairPlan, maxFiles = 12, maxNotes = 4): string {
  const lines: string[] = [];
  for (const change of plan.changes.slice(0, maxFiles)) {
    lines.push(`• ${change.file}`);
    for (const note of change.notes.slice(0, maxNotes)) lines.push(`    – ${note}`);
    if (change.notes.length > maxNotes) lines.push(`    – …and ${change.notes.length - maxNotes} more`);
  }
  if (plan.changes.length > maxFiles) lines.push(`• …and ${plan.changes.length - maxFiles} more files`);
  if (plan.left.length > 0) {
    lines.push('', 'Left as it is:');
    for (const note of plan.left.slice(0, 5)) lines.push(`• ${note}`);
    if (plan.left.length > 5) lines.push(`• …and ${plan.left.length - 5} more`);
  }
  if (plan.unreadableEntries.length > 0) {
    lines.push('', describeUnreadableEntries(plan.unreadableEntries));
  }
  return lines.join('\n');
}

/** One sentence about REL008 entries, which no repair touches. */
export function describeUnreadableEntries(entries: readonly RelationshipFinding[]): string {
  const where = entries.slice(0, 3).map((f) => `${f.files[0]}${f.line !== undefined ? `:${f.line}` : ''}`);
  return `${plural(entries.length, 'relationship entry', 'relationship entries')} in the model library could not be read ` +
    `and ${entries.length === 1 ? 'is' : 'are'} left untouched — fix ${entries.length === 1 ? 'it' : 'them'} by hand: ` +
    `${where.join(', ')}${entries.length > 3 ? ` and ${entries.length - 3} more` : ''}.`;
}

// ---------------------------------------------------------------------------
// Text edits
// ---------------------------------------------------------------------------

const BOM = '﻿';

/** A string as a YAML scalar on one line: plain when YAML allows it, quoted otherwise. */
function yamlScalar(value: string): string {
  if (/^(?:y|n|yes|no|on|off)$/i.test(value)) return JSON.stringify(value);
  const out = stringify(value, { lineWidth: 0 }).replace(/\n$/, '');
  return out.includes('\n') ? JSON.stringify(value) : out;
}

const lineStart = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
const afterLineEnd = (text: string, offset: number): number => {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
};
/** `end` when the text before it ends a line, else the end of that line. */
const toLineEnd = (text: string, end: number): number => (end > 0 && text[end - 1] === '\n' ? end : afterLineEnd(text, end));

/** Where an item's `- ` marker is (it may sit on the line before the item's first key). */
function markerOffset(text: string, item: Node): number {
  let i = item.range![0] - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i--;
  return i >= 0 && text[i] === '-' ? i : item.range![0];
}

/** An item's lines: from its marker's line to the end of its last line (comments after it stay with what follows). */
function itemSpan(text: string, item: Node): [number, number] {
  return [lineStart(text, markerOffset(text, item)), toLineEnd(text, item.range![1])];
}

interface Splice {
  start: number;
  end: number;
  text: string;
  /** Order among insertions at the same place: lower is applied first, so ends up later. */
  rank: number;
}

function applySplices(text: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end || a.rank - b.rank);
  let out = text;
  for (const s of ordered) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

const ENTRY_FIELDS = ['fromColumn', 'toModel', 'toColumn', 'cardinality'] as const;

function renderEntry(r: ModelRelationship, indent: number, eol: string): string {
  const dash = ' '.repeat(indent);
  const body = ' '.repeat(indent + 2);
  return [
    `${dash}- fromColumn: ${yamlScalar(r.fromColumn)}`,
    `${body}toModel: ${yamlScalar(r.toModel)}`,
    `${body}toColumn: ${yamlScalar(r.toColumn)}`,
    `${body}cardinality: ${yamlScalar(r.cardinality)}`,
    ...(r.role ? [`${body}role: ${yamlScalar(r.role)}`] : []),
  ].join(eol);
}

/**
 * Return `text` (a model yml) with entries of its top-level `relationships:`
 * list removed, changed or added — `remove` and `update` by position in the
 * list as written (every entry counted) — and every other byte unchanged: an
 * entry that is not touched keeps its comments, quoting, unknown keys and
 * anything the reader could not read; a changed entry keeps them too, only its
 * changed values are rewritten. A file without the list gains one at its end;
 * a list whose every entry is removed goes. Throws `RepairEditError` (naming
 * `file`) for a list or entry it cannot edit in place.
 */
export function editYamlRelationships(
  text: string,
  edits: { remove: ReadonlySet<number>; update: ReadonlyMap<number, ModelRelationship>; append: readonly ModelRelationship[] },
  file = 'the model file',
): string {
  if (edits.remove.size === 0 && edits.update.size === 0 && edits.append.length === 0) return text;
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const doc = parseDocument(body);
  if (doc.errors.length > 0) throw new RepairEditError(`${file} could not be read as YAML: ${doc.errors[0].message}`);
  const root = doc.contents;
  if (!isMap(root)) throw new RepairEditError(`${file} is not a YAML mapping.`);
  const pair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'relationships');
  const seq = pair?.value as Node | null | undefined;
  const items = isSeq(seq) ? (seq.items as Node[]) : [];

  if (!pair || seq === null || seq === undefined || (isSeq(seq) && items.length === 0)) {
    if (edits.remove.size > 0 || edits.update.size > 0) throw new RepairEditError(`${file} has no relationships to change.`);
    return setYamlRelationships(text, edits.append);
  }
  if (root.flow) throw new RepairEditError(`${file} is written on one line ({ … }); change its relationships by hand.`);
  if (!isSeq(seq) || seq.flow) {
    throw new RepairEditError(`${file}: "relationships:" is not a list with one "- " entry per line; change it by hand.`);
  }
  for (const i of [...edits.remove, ...edits.update.keys()]) {
    if (i < 0 || i >= items.length) throw new RepairEditError(`${file}: relationship entry ${i + 1} is not there any more.`);
  }
  if (items.every((_, i) => edits.remove.has(i)) && edits.append.length === 0) return setYamlRelationships(text, []);

  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const splices: Splice[] = [];
  items.forEach((item, i) => {
    if (edits.remove.has(i)) {
      const [start, end] = itemSpan(body, item);
      splices.push({ start, end, text: '', rank: 0 });
      return;
    }
    const next = edits.update.get(i);
    if (next) splices.push(...updateEntrySplices(body, item, next, eol, `${file}: relationship entry ${i + 1}`));
  });
  if (edits.append.length > 0) {
    const [, end] = itemSpan(body, items[items.length - 1]);
    const marker = markerOffset(body, items[0]);
    const indent = marker - lineStart(body, marker);
    const rendered = edits.append.map((r) => renderEntry(r, indent, eol)).join(eol);
    splices.push({ start: end, end, text: body[end - 1] === '\n' ? rendered + eol : eol + rendered, rank: 0 });
  }
  return bom + applySplices(body, splices);
}

/** The splices that turn one block-map entry into `next`, value by value. */
function updateEntrySplices(body: string, item: Node, next: ModelRelationship, eol: string, where: string): Splice[] {
  if (!isMap(item) || (item as YAMLMap).flow) throw new RepairEditError(`${where} is not written one key per line; change it by hand.`);
  const pairs = (item as YAMLMap).items.filter(isPair) as Pair[];
  const find = (key: string): Pair | undefined => pairs.find((p) => isScalar(p.key) && p.key.value === key);
  const splices: Splice[] = [];
  const replaceValue = (p: Pair, value: string): void => {
    const node = p.value as Node | null;
    if (!isScalar(node) || !node.range) throw new RepairEditError(`${where}: "${String((p.key as { value?: unknown }).value)}" is not a plain value; change it by hand.`);
    if (String(node.value) === value) return;
    splices.push({ start: node.range[0], end: node.range[1], text: yamlScalar(value), rank: 0 });
  };
  for (const field of ENTRY_FIELDS) {
    const p = find(field);
    if (!p) throw new RepairEditError(`${where} has no ${field}; change it by hand.`);
    replaceValue(p, next[field]);
  }
  const rolePair = find('role');
  if (next.role) {
    if (rolePair) {
      replaceValue(rolePair, next.role);
    } else {
      const first = pairs[0].key as Node;
      const column = first.range![0] - lineStart(body, first.range![0]);
      const end = toLineEnd(body, item.range![1]);
      const line = `${' '.repeat(column)}role: ${yamlScalar(next.role)}`;
      splices.push({ start: end, end, text: body[end - 1] === '\n' ? line + eol : eol + line, rank: 1 });
    }
  } else if (rolePair) {
    if (rolePair === pairs[0]) throw new RepairEditError(`${where} starts with its role; change it by hand.`);
    const key = rolePair.key as Node;
    const valueEnd = (rolePair.value as Node | null)?.range?.[2] ?? key.range![2];
    splices.push({ start: lineStart(body, key.range![0]), end: toLineEnd(body, valueEnd), text: '', rank: 0 });
  }
  return splices;
}

/**
 * Return `text` (a domain JSON) with entries of `logical.relationships`
 * removed or changed, by position in the array as written. A changed entry
 * keeps its other keys; nothing outside the array changes.
 */
export function editDomainRelationships(
  text: string,
  edits: { remove: ReadonlySet<number>; update: ReadonlyMap<number, Relationship> },
  file = 'the domain file',
): string {
  if (edits.remove.size === 0 && edits.update.size === 0) return text;
  let raw: unknown[];
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as { logical?: { relationships?: unknown } };
    raw = Array.isArray(parsed.logical?.relationships) ? parsed.logical!.relationships as unknown[] : [];
  } catch (err) {
    throw new RepairEditError(`${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const i of [...edits.remove, ...edits.update.keys()]) {
    if (i < 0 || i >= raw.length) throw new RepairEditError(`${file}: relationship entry ${i + 1} is not there any more.`);
  }
  const next = raw.flatMap((entry, i) => {
    if (edits.remove.has(i)) return [];
    const update = edits.update.get(i);
    if (!update) return [entry];
    const merged: Record<string, unknown> = {
      ...(entry as Record<string, unknown>),
      fromModel: update.fromModel,
      fromColumn: update.fromColumn,
      toModel: update.toModel,
      toColumn: update.toColumn,
      cardinality: update.cardinality,
    };
    if (update.role) merged.role = update.role;
    else delete merged.role;
    return [merged];
  });
  return setDomainRelationships(text, next as Relationship[]);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Where a model file's `relationships:` block is: from the start of its key's
 * line to the start of the next top-level key's line (or the end of the
 * file), so comments between its entries are inside it. Null without one.
 */
function yamlRelationshipsRegion(text: string): [number, number] | null {
  const bom = text.startsWith(BOM) ? 1 : 0;
  const body = text.slice(bom);
  const doc = parseDocument(body);
  const root = doc.contents;
  if (!isMap(root)) return null;
  const pairs = (root.items as unknown[]).filter(isPair) as Pair[];
  const index = pairs.findIndex((p) => isScalar(p.key) && p.key.value === 'relationships');
  if (index === -1) return null;
  const key = pairs[index].key as Node;
  if (!key.range) return null;
  const nextKey = pairs[index + 1]?.key as Node | undefined;
  const end = nextKey?.range ? lineStart(body, nextKey.range[0]) : body.length;
  return [bom + lineStart(body, key.range[0]), bom + end];
}

/** The span that differs between two texts: their longest common prefix and suffix taken off. */
function differingSpans(a: string, b: string): { a: [number, number]; b: [number, number] } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { a: [prefix, a.length - suffix], b: [prefix, b.length - suffix] };
}

/**
 * Whether `after` differs from `before` only inside their relationships —
 * byte for byte everywhere else. A model file: every differing byte, in
 * either text, lies in that text's `relationships:` block. A domain file:
 * the two are identical once `logical.relationships` is emptied in both.
 */
export function onlyRelationshipsChanged(kind: 'model' | 'domain', before: string, after: string): boolean {
  if (before === after) return true;
  if (kind === 'domain') return setDomainRelationships(before, []) === setDomainRelationships(after, []);
  const spans = differingSpans(before, after);
  const inside = (text: string, [start, end]: [number, number]): boolean => {
    if (start === end) return true;
    const region = yamlRelationshipsRegion(text);
    return region !== null && start >= region[0] && end <= region[1];
  };
  return inside(before, spans.a) && inside(after, spans.b);
}

/**
 * Problems with the planned texts themselves, before anything is written:
 * a byte outside the relationships that would change.
 */
export function checkPlannedTexts(plan: RepairPlan): string[] {
  const problems: string[] = [];
  for (const change of plan.changes) {
    try {
      if (!onlyRelationshipsChanged(change.kind, change.original, change.text)) {
        problems.push(`${change.file}: something other than its relationships would change`);
      }
    } catch (err) {
      problems.push(`${change.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** What each domain draws: one relationship per link (core's `normaliseRelationships`). */
function drawnByDomain(snapshot: RepairSnapshot): Map<string, Map<string, Relationship>> {
  const find = libraryIndex(snapshot.modelFiles);
  const drawn = new Map<string, Map<string, Relationship>>();
  for (const domain of snapshot.domains) {
    const models: SemanticModel[] = [];
    for (const name of domain.models) {
      const found = find(name);
      if (found && !models.includes(found.model)) models.push(found.model);
    }
    const { relationships } = normaliseRelationships({ models, own: domain.relationships, filePath: domain.file });
    // The canvas draws an edge only between two of the domain's own models.
    const shown = new Set(domain.models.map(lower));
    drawn.set(domain.filePath, new Map(relationships
      .filter((rel) => shown.has(lower(rel.fromModel)) && shown.has(lower(rel.toModel)))
      .map((rel) => [linkKey(rel), rel])));
  }
  return drawn;
}

/**
 * Check the project as it is after the writes (`after`) against what it was
 * (`before`) and what the plan promised. Returns one line per problem; empty
 * means the repair did exactly what it said:
 *
 * - every written file holds the planned text, and nothing outside its
 *   relationships changed;
 * - every written model file still reads, with exactly as many entries the
 *   reader could not read as before;
 * - every finding the plan fixed is gone, and no new one (except `info`)
 *   appeared;
 * - every diagram draws what it drew before, except links the user chose to
 *   change and links newly stored in the model library.
 */
export function verifyRepair(before: RepairSnapshot, after: RepairSnapshot, plan: RepairPlan): string[] {
  const problems: string[] = [];
  const afterText = new Map<string, string>([
    ...after.modelFiles.map((m) => [m.filePath, m.text] as const),
    ...after.domains.map((d) => [d.filePath, d.text] as const),
  ]);
  for (const change of plan.changes) {
    const text = afterText.get(change.filePath);
    if (text === undefined) {
      problems.push(`${change.file} could not be read back`);
      continue;
    }
    if (text !== change.text) problems.push(`${change.file} does not hold what was written`);
    try {
      if (!onlyRelationshipsChanged(change.kind, change.original, text)) {
        problems.push(`${change.file}: something other than its relationships changed`);
      }
    } catch (err) {
      problems.push(`${change.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (change.kind === 'model') {
      const was = before.modelFiles.find((m) => m.filePath === change.filePath);
      const now = after.modelFiles.find((m) => m.filePath === change.filePath);
      if (was && now && was.untouchable.size !== now.untouchable.size) {
        problems.push(`${change.file}: the entries that could not be read changed`);
      }
    }
  }

  const findingKey = (f: RelationshipFinding): string => `${f.code}\u0000${f.link ?? ''}`;
  for (const g of plan.expect.gone) {
    const still = after.findings.find((f) => f.code === g.code && f.link === g.link && f.files.some((file) => g.files.includes(file)));
    if (still) problems.push(`still there: ${still.message}`);
  }
  const was = new Set(before.findings.map(findingKey));
  // A move switches a per-domain project to the library: copies the user left
  // in two diagram files, each that diagram's own until now, become a finding
  // only because of the switch.
  const ownCopies = (f: RelationshipFinding): boolean => before.mode === 'domain' && after.mode === 'library'
    && f.code === 'REL001' && (f.records ?? []).every((r) => r.source.kind === 'domain');
  for (const f of after.findings) {
    if (f.severity === 'info' || f.code === 'REL008' || ownCopies(f)) continue;
    if (!was.has(findingKey(f))) problems.push(`new: ${f.message}`);
  }
  const rel008 = (s: RepairSnapshot): number => s.findings.filter((f) => f.code === 'REL008').length;
  if (rel008(after) !== rel008(before)) problems.push('the entries that could not be read changed');

  const drawnBefore = drawnByDomain(before);
  const drawnAfter = drawnByDomain(after);
  const { userChanged, consolidated } = plan.expect;
  for (const domain of before.domains) {
    const b = drawnBefore.get(domain.filePath) ?? new Map<string, Relationship>();
    const a = drawnAfter.get(domain.filePath) ?? new Map<string, Relationship>();
    for (const [key, rel] of b) {
      if (userChanged.has(key)) continue;
      const now = a.get(key);
      if (!now) problems.push(`${domain.label} no longer draws ${describeEnds(rel)}`);
      else if (!sameRelationshipMeaning(now, rel)) problems.push(`${domain.label} now draws ${describeEnds(rel)} differently`);
    }
    for (const [key, rel] of a) {
      if (b.has(key) || userChanged.has(key) || consolidated.has(key)) continue;
      problems.push(`${domain.label} now also draws ${describeEnds(rel)}`);
    }
  }
  return problems;
}
