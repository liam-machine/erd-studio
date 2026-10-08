/**
 * Repair Relationships… and Move Relationships to Model Library — the engine
 * (issue #133, R10). No `vscode`: the command runners in `src/commands/` own
 * the dialogs, the writes and the rollback; this file reads, plans and checks.
 *
 * - `readRepairSnapshot` reads every model file (`LogicalModelService.
 *   relationshipCheckModels`, the lookup the canvas and its notification use,
 *   so all three agree — D11) and every v5 domain file, decides the project's
 *   mode (`usesLibraryRelationships`) and runs core's `checkRelationships`.
 * - `analyseRepair` groups every stored record by link (`linkKey`) and sorts
 *   the links into the few fixes that are always safe and everything else.
 *   Fixed automatically, and nothing more: a `one-to-many` saved on its one
 *   side (REL002) moved to its many side's file; the shape 1.6.7 saved for a
 *   line drawn from a dimension to a fact (a model-library many-to-one from
 *   the dimension's whole key to a column that is no key, in a fact with its
 *   own key — core's `isStoredBackwards`, REL006 `fix: 'rehome'`) turned
 *   round into the fact's file, with the `isForeignKey` 1.6.7's Draw
 *   from dbt left on that key column taken off; an endpoint spelled in
 *   another case (REL005) respelled; exact copies (REL001, and REL009's
 *   domain copies of a library link) reduced to the one in its canonical
 *   home; and, for the move, every domain-file relationship stored once in
 *   the model library. A diagram file's copy of a library link that says
 *   something else (REL009, ignored for drawing) is left exactly as it is
 *   and reported, without holding back the library's own fixes for that
 *   link. Everything else — model-library copies that disagree, a missing
 *   model or column (REL003 / REL004), any other direction doubt, an entry
 *   the reader could not read (REL008), a v4 diagram — is left exactly as it
 *   is, every copy of its link, and reported with the file to open. Nothing
 *   is ever asked.
 * - `planRelationshipRepair` computes each file's new text from its bytes as
 *   read: only the `relationships:` list of a model file and
 *   `logical.relationships` of a domain file change, entry by entry, so
 *   comments, unknown keys and unreadable entries survive (plus the one
 *   `isForeignKey: true` line of fix (c)).
 * - `verifyRepair` re-reads the project after the writes and says what is
 *   wrong with the result, if anything — any byte outside the relationships
 *   changed, a planned finding still there, a new one, or a diagram drawing
 *   something other than it did (except a link turned round on purpose or
 *   newly in the model library) — so the runner can put every file back.
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
  canonicalRelationship,
  checkRelationships,
  endEvidenceFromModel,
  isStoredBackwards,
  keyEvidenceContradiction,
  readDomainRelationshipEntries,
  linkKey,
  normaliseRelationshipRole,
  normaliseRelationships,
  parseLogicalModelText,
  sameRelationshipMeaning,
  type CheckDomain,
  type CheckUnreadableModel,
  type RelationshipEnds,
  type RelationshipReadIssue,
  type RelationshipFinding,
  type RelationshipIssueCode,
} from '@erd-studio/core';
import {
  domainRelationshipElementLines,
  domainRelationshipElementTexts,
  editDomainRelationshipEntries,
  setDomainRelationships,
  setYamlRelationships,
} from './minimalEdits';
import { COMMENTS, describeExtras, domainEntryExtras, yamlEntryExtras } from './relationshipEntryExtras';
import { domainTextRelationshipCount, usesLibraryRelationships } from './libraryRelationships';
import { CURRENT_SCHEMA_VERSION, detectDomainFormat } from '../types/semantic';
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
  /** Every entry skipped or read with a default (REL008), by its position in the file's list. */
  readIssues: RelationshipReadIssue[];
  /** The domain's `stubColumns` (models whose missing columns are not findings). */
  stubColumns: string[];
  /** The file's text as read. */
  text: string;
}

/**
 * A v4 domain file (inline models): checked like any other, never written by
 * a repair — its relationships are fixed after "Migrate Domains to Central
 * Model Store".
 */
export interface OlderFormatDomain {
  label: string;
  filePath: string;
  /** The inline models, without any library relationships. */
  models: SemanticModel[];
  relationships: Relationship[];
  /** Position of each of `relationships` in the file's `logical.relationships` array. */
  rawIndexes: number[];
  readIssues: RelationshipReadIssue[];
  stubColumns: string[];
}

/** A domain file whose relationships could not be checked at all. */
export interface UncheckedDomainFile {
  label: string;
  filePath: string;
  /** One plain sentence: why. */
  reason: string;
}

/** Every domain file of the project, as the relationship checks read them. */
export interface DomainFileScan {
  v5: DomainRelationships[];
  v4: OlderFormatDomain[];
  unchecked: UncheckedDomainFile[];
  /**
   * How many `logical.relationships` entries every domain file that parses
   * holds, read raw — `DomainService.countDomainFileRelationships` from the
   * same read, for `usesLibraryRelationships` without a second pass.
   */
  domainFileRelationshipCount: number;
}

type DomainScanSource = Pick<DomainService, 'listDomains'>;

/**
 * Read every domain file of the project once, the one way every relationship
 * check reads them — the canvas banner and notification, Repair
 * Relationships…, and the CLI's `check` / `doctor` / `diff` — so they can
 * never disagree about which files were looked at or what an entry means.
 * A file that cannot be read, or is in a format the checks do not take
 * (hybrid / legacy), is listed in `unchecked`, never skipped without a word.
 */
export function scanDomainFiles(domainService: DomainScanSource, workspaceRoot: string, semanticDir: string): DomainFileScan {
  const scan: DomainFileScan = { v5: [], v4: [], unchecked: [], domainFileRelationshipCount: 0 };
  for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
    const label = `${summary.layer}/${summary.domain}`;
    let text: string;
    let raw: Record<string, unknown>;
    try {
      text = fs.readFileSync(summary.filePath, 'utf-8');
    } catch (err) {
      scan.unchecked.push({
        label, filePath: summary.filePath,
        reason: `it could not be read (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }
    // Parsed exactly as the canvas (`DomainService.getDomain`) and `diff`
    // parse it — a byte-order mark is not stripped — so a file they cannot
    // open is never counted here as checked and clean, nor its entries
    // towards the project's mode.
    if (text.startsWith('\uFEFF')) {
      // Unopenable, but its relationships still say how the project keeps them.
      scan.domainFileRelationshipCount += domainTextRelationshipCount(text);
      scan.unchecked.push({
        label, filePath: summary.filePath,
        reason: 'it starts with a byte-order mark (BOM), so ERD Studio cannot open it — save it as UTF-8 without BOM',
      });
      continue;
    }
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      // A merge conflict must not switch the project's mode: a file whose
      // text still shows a relationship list counts as holding one.
      scan.domainFileRelationshipCount += domainTextRelationshipCount(text);
      scan.unchecked.push({
        label, filePath: summary.filePath,
        reason: `it could not be read (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }
    const rawRelationships = (raw as { logical?: { relationships?: unknown } } | null)?.logical?.relationships;
    // Counted as `DomainService.countDomainFileRelationships` counts — every
    // file that parses — so the project's mode is decided the same way here
    // as everywhere else, even for a file the gate below turns away.
    if (Array.isArray(rawRelationships)) scan.domainFileRelationshipCount += rawRelationships.length;
    // The gate the canvas and `diff` load through (`validateDomainDocument`):
    // a file they refuse is never checked, counted clean, repaired or moved.
    const refused = refusedDomainDocument(raw);
    if (refused) {
      scan.unchecked.push({ label, filePath: summary.filePath, reason: refused });
      continue;
    }
    const format = detectDomainFormat(raw);
    if (format !== 'v5' && format !== 'v4') {
      scan.unchecked.push({
        label, filePath: summary.filePath,
        reason: format === 'hybrid'
          ? 'it mixes inline models with model names, a layout ERD Studio cannot load — run "ERD Studio: Migrate Domains to Central Model Store"'
          : 'it uses a layout from before schema version 4 — run "ERD Studio: Migrate Domains to Central Model Store"',
      });
      continue;
    }
    const logical = (raw.logical && typeof raw.logical === 'object' ? raw.logical : {}) as { models?: unknown; relationships?: unknown };
    const entries = readDomainRelationshipEntries(logical.relationships, label);
    const stubColumns = (Array.isArray(raw.stubColumns) ? raw.stubColumns as unknown[] : [])
      .filter((s): s is string => typeof s === 'string');
    if (format === 'v5') {
      scan.v5.push({
        label,
        filePath: summary.filePath,
        models: (Array.isArray(logical.models) ? logical.models : []).filter((m): m is string => typeof m === 'string'),
        relationships: entries.relationships,
        rawIndexes: entries.rawIndexes,
        defaulted: entries.defaulted,
        readIssues: entries.issues,
        stubColumns,
        text,
      });
      continue;
    }
    // A v4 domain carries its models inline. Read straight from the file (no
    // second load, so no second round of load warnings): what the checks
    // need is each model's name and column names.
    const models: SemanticModel[] = (Array.isArray(logical.models) ? logical.models as unknown[] : [])
      .filter((m): m is SemanticModel => !!m && typeof m === 'object' && typeof (m as SemanticModel).name === 'string')
      .map((m) => ({
        ...m,
        columns: (Array.isArray(m.columns) ? m.columns : [])
          .filter((c) => !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'),
      }));
    scan.v4.push({
      label,
      filePath: summary.filePath,
      // A v4 domain carries its models inline; they hold no library relationships.
      models: models.map(({ relationships: _r, relationshipIssues: _i, ...m }) => m as SemanticModel),
      relationships: entries.relationships,
      rawIndexes: entries.rawIndexes,
      readIssues: entries.issues,
      stubColumns,
    });
  }
  return scan;
}

/**
 * Why the canvas and `diff` would refuse a parsed domain document before
 * looking at its format — the object and `schemaVersion` checks of core's
 * `validateDomainDocument` — as one plain sentence, or undefined.
 */
function refusedDomainDocument(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'it does not hold a JSON object, so ERD Studio cannot open it';
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number') {
    return `it has no numeric "schemaVersion", so ERD Studio cannot open it — add "schemaVersion": ${CURRENT_SCHEMA_VERSION}`;
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    return `it has schemaVersion ${version}, newer than this version of ERD Studio reads (up to ${CURRENT_SCHEMA_VERSION}) — update the extension`;
  }
  return undefined;
}

/** Every readable v5 domain file's models and `logical.relationships`. */
export function readDomainRelationships(
  domainService: Pick<DomainService, 'listDomains'>,
  workspaceRoot: string,
  semanticDir: string,
): DomainRelationships[] {
  return scanDomainFiles(domainService, workspaceRoot, semanticDir).v5;
}

/**
 * The scan as `checkRelationships` takes it: every v5 and v4 domain, each with
 * its stubs and the entries that could not be read. `fileName` names each file
 * in the findings. A v4 domain always keeps its own relationships.
 */
export function toCheckDomains(scan: DomainFileScan, mode: 'library' | 'domain', fileName: (filePath: string) => string): CheckDomain[] {
  const extras = (d: { stubColumns: string[]; readIssues: RelationshipReadIssue[] }) => ({
    ...(d.stubColumns.length > 0 ? { stubColumns: d.stubColumns } : {}),
    ...(d.readIssues.length > 0 ? { readIssues: d.readIssues } : {}),
  });
  return [
    ...scan.v5.map((d) => ({ label: d.label, filePath: fileName(d.filePath), models: d.models, relationships: d.relationships, mode, ...extras(d) })),
    ...scan.v4.map((d) => ({ label: d.label, filePath: fileName(d.filePath), models: d.models, relationships: d.relationships, mode: 'domain' as const, olderFormat: true, ...extras(d) })),
  ];
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
  /**
   * Model files that could not be read, named as `file` (with the absolute
   * `filePath`); `holdsRelationships` when their text has a `relationships:` key.
   */
  unreadable: Array<CheckUnreadableModel & { holdsRelationships?: true; filePath?: string }>;
  /**
   * How many `logical.relationships` entries every domain file holds, read
   * raw (`DomainFileScan.domainFileRelationshipCount`), for the mode a plan
   * leaves the project in. Optional for snapshots built by hand.
   */
  domainFileRelationshipCount?: number;
  /** v4 domain files: checked, never repaired (their findings point at the migration). */
  olderFormat: Array<OlderFormatDomain & { file: string }>;
  /** Domain files that could not be checked at all. */
  unchecked: Array<UncheckedDomainFile & { file: string }>;
  /**
   * Why layers.json could not be used, when it could not: a domain file in a
   * layer folder it names may not have been read at all.
   */
  layersError?: string;
  /** `checkRelationships` over all of it, files named as `file`. */
  findings: RelationshipFinding[];
}

export interface RepairSnapshotDeps {
  workspaceRoot: string;
  semanticDir: string;
  domainService: Pick<DomainService, 'listDomains' | 'countDomainFileRelationships'>;
  logicalModelService: Pick<LogicalModelService, 'relationshipCheckModels' | 'invalidateCache' | 'getModelsDir'>;
  /** The layer config, for its load error (as the CLI's `check` reports it). */
  layerService?: { getLoadError(): string | null };
  /**
   * Keep the model cache (its entries are checked against each file's
   * modification time anyway). For the once-a-session offer, which must not
   * throw away what the canvas just read; the commands always read fresh.
   */
  keepCache?: boolean;
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
  if (!deps.keepCache) logicalModelService.invalidateCache();
  const modelsDir = logicalModelService.getModelsDir();
  const label = (filePath: string): string => repairFileLabel(modelsDir, filePath);

  const { libraryModels, unreadableModels } = logicalModelService.relationshipCheckModels((p) => p);
  const unreadable: RepairSnapshot['unreadable'] = unreadableModels.map((u) => ({ ...u, file: label(u.file), filePath: u.file }));
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
      unreadable.push({ name: stem, file: label(filePath), filePath });
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

  const scan = scanDomainFiles(domainService, workspaceRoot, semanticDir);
  const domains: RepairDomainFile[] = scan.v5.map((d) => ({ ...d, file: label(d.filePath) }));
  const mode = usesLibraryRelationships(
    modelFiles.map((m) => m.model),
    scan.domainFileRelationshipCount,
    unreadableModels.filter((u) => u.holdsRelationships).length,
  ) ? 'library' : 'domain';
  // The same domains, stubs and unreadable entries every other check uses.
  const findings = checkRelationships({
    libraryModels: modelFiles.map((m) => ({ model: m.model, file: m.file })),
    domains: toCheckDomains(scan, mode, label),
    unreadableModels: unreadable,
  });
  const layersError = deps.layerService?.getLoadError() ?? undefined;
  return {
    mode,
    modelFiles,
    domains,
    unreadable,
    domainFileRelationshipCount: scan.domainFileRelationshipCount,
    olderFormat: scan.v4.map((d) => ({ ...d, file: label(d.filePath) })),
    unchecked: scan.unchecked.map((d) => ({ ...d, file: label(d.filePath) })),
    ...(layersError ? { layersError } : {}),
    findings,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface RepairOptions {
  /** "Move Relationships to Model Library": every domain-file relationship goes to its home model's file. */
  moveDomainsToLibrary?: boolean;
}

/**
 * Something a repair leaves for the user — a relationship that needs a
 * decision, an entry it could not read, a file it could not check — with
 * where to look, so the runner can offer to open the file.
 */
export interface RepairReportItem {
  /** One plain sentence. */
  message: string;
  /** The file, as messages name it (relative to the ERD data directory). */
  file?: string;
  /** Its absolute path. */
  filePath?: string;
  /** 1-based line, when it is known up front. */
  line?: number;
  /**
   * The stored entry the item is about. Its line is looked up when the file
   * is opened (`reportItemLine`), so it is right even after the repair moved
   * the entries above it.
   */
  entry?: { kind: 'model' | 'domain'; rel: Relationship };
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
  /** An entry the reader could not read in full (REL008): never touched. */
  untouchable: boolean;
  /** The file it is in, as messages name it. */
  file: string;
  /**
   * What taking this entry out of its file would lose: keys a relationship
   * does not have (`description`, `tests`, …) and, in a model file,
   * `comments`. A repair never removes such an entry.
   */
  extras: string[];
}

/** One link (`linkKey`), and the records of it one repair settles together. */
interface LinkTask {
  key: string;
  /** `library`: settled into one record in the home model's file. `domain`: settled within one domain file. */
  scope: 'library' | 'domain';
  domain?: RepairDomainFile;
  records: Rec[];
  /** REL003 / REL004 / REL006 findings about these records (none for the move). */
  findings: RelationshipFinding[];
  /** Whether the link had a library record before. */
  hadLibraryRecord: boolean;
  /** Whether any domain record here is being moved into the library. */
  moving: boolean;
  /**
   * Other records of the link are settled separately (another domain file's
   * copies, in a per-domain project) or not at all (an older-format diagram's
   * copy), so REL001 / REL009 about the link may remain.
   */
  partialLeft: boolean;
  /**
   * Diagram file copies of a model-library link that say something else than
   * the library's: ignored for drawing, left exactly as they are and listed,
   * never part of the task — so REL009 about the link remains.
   */
  ignoredCopiesLeft: boolean;
}

export interface RepairAnalysis {
  /** The links with an automatic fix. Nothing else is ever changed. */
  tasks: LinkTask[];
  /**
   * Relationships left exactly as they are, one item each: anything that
   * needs a decision (copies that disagree, a missing model or column, a
   * direction the keys doubt), and anything the repair cannot store safely.
   */
  left: RepairReportItem[];
  /** REL008 findings: entries the reader could not read in full, left for the user (with their line). */
  unreadableEntries: RelationshipFinding[];
  /**
   * What the checks found that this command cannot reach, one item each: v4
   * diagrams (fixed after the migration) and files that could not be checked
   * at all. Never reported as "nothing to repair".
   */
  outOfReach: RepairReportItem[];
  /** Every stored record, as read. */
  records: Rec[];
}

/** What changes in one file. */
export interface RepairFileChange {
  filePath: string;
  file: string;
  kind: 'model' | 'domain';
  original: string;
  /**
   * `original` with only the planned column-flag edits applied (a 1.6.7
   * `isForeignKey` taken off a dimension's key, fix (c)), when there are any:
   * everything in `text` outside the relationships must equal this.
   */
  base?: string;
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
  /** Move (and copies in several diagram files of a library project): stored once in the model library. */
  moved: number;
  /** The 1.6.7 shape (REL006 from key evidence): stored backwards, turned round into the many side's file. */
  swapped: number;
  /** A declared `isForeignKey` 1.6.7 left on the key column of a relationship turned round. */
  foreignKeysCleared: number;
}

export interface RepairPlan {
  changes: RepairFileChange[];
  /** How many relationships the plan changes (each once, however many fixes it needs). */
  fixed: number;
  /**
   * When the planned files would change where the project keeps
   * relationships (`usesLibraryRelationships`) other than as the move
   * intends, one plain sentence saying so, for the preview.
   */
  modeChange?: string;
  counts: RepairCounts;
  /** Relationships left as they are, with why and where (see {@link RepairAnalysis.left}). */
  left: RepairReportItem[];
  /**
   * Diagrams that will start drawing a relationship they did not draw: it is
   * now in the model library (`expect.consolidated`) and the diagram holds
   * both its models. One line each, naming the diagram file and the link.
   */
  alsoDrawn: string[];
  unreadableEntries: RelationshipFinding[];
  /** As {@link RepairAnalysis.outOfReach}. */
  outOfReach: RepairReportItem[];
  /** Links whose domain-file copies the plan takes out into the model library (what the move offer counts). */
  movedLinks: Set<string>;
  /** What `verifyRepair` holds the result to. */
  expect: {
    /** Findings that must be gone: no finding with this `code` and `link` may name any of `files`. */
    gone: Array<{ code: RelationshipIssueCode; link: string; files: string[] }>;
    /** Links the plan draws differently on purpose: turned round (the 1.6.7 shape). */
    redrawn: Set<string>;
    /** Links now stored in the model library that were not before: every diagram with both models draws them. */
    consolidated: Set<string>;
    /**
     * By domain file path: the positions (in the file's own list) of the
     * entries the plan removes or changes. Every other entry must read back
     * byte for byte as it was (an entry the reader could not read included).
     */
    domainEntries: Map<string, { remove: Set<number>; update: Set<number> }>;
    /** Where the project keeps relationships once the plan is written. A result in any other mode is refused. */
    modeAfter: 'library' | 'domain';
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

type FindModel = (name: string) => RepairModelFile | undefined;

/** Model lookup as `checkRelationships` does it: exact name, then without case (alphabetically first). */
function libraryIndex(modelFiles: readonly RepairModelFile[]): FindModel {
  const exact = new Map<string, RepairModelFile>();
  for (const m of modelFiles) if (!exact.has(m.name)) exact.set(m.name, m);
  const loose = new Map<string, RepairModelFile>();
  for (const name of [...exact.keys()].sort()) {
    if (!loose.has(lower(name))) loose.set(lower(name), exact.get(name)!);
  }
  return (name) => exact.get(name) ?? loose.get(lower(name));
}

/** `rel` with each end spelled as the library spells it (REL005 is never written). */
function respellWith(find: FindModel, rel: Relationship): Relationship {
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
function meaningOf(find: FindModel, rel: Relationship): Relationship {
  return plain(canonicalRelationship(respellWith(find, rel)));
}

/** `rel` with its two ends swapped (cardinality and role kept). */
function turnedRound(rel: Relationship): Relationship {
  return { ...rel, fromModel: rel.toModel, fromColumn: rel.toColumn, toModel: rel.fromModel, toColumn: rel.fromColumn };
}

/**
 * Whether `rel` (a meaning: respelled, canonical) is stored backwards in the
 * shape ERD Studio 1.6.7 saved for a line drawn from a dimension to a fact,
 * beyond reasonable doubt — core's `isStoredBackwards`, which `check` asks
 * for its `fix: 'rehome'`, so the two never disagree. A REL006 the keys leave
 * open (a one-to-one aggregate at a dimension's grain, an SCD2 dimension's
 * natural key, a line the user turned round on purpose against an unflagged
 * model) is never turned round here: it is listed for the user.
 */
function storedBackwards(find: FindModel, rel: Relationship): boolean {
  return isStoredBackwards(rel, (name) => find(name)?.model);
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

/**
 * The order a reader prefers records in (core's `normaliseRelationships`):
 * library at home, one the key flags do not contradict, by holder, by index.
 */
function rankRecordsWith(find: FindModel): (a: Rec, b: Rec) => number {
  const contradicted = (r: Rec): boolean => keyEvidenceContradiction(r.rel, (name) => find(name)?.model) !== null;
  return (a, b) => compareRecords(a, b, contradicted);
}

function compareRecords(a: Rec, b: Rec, contradicted: (r: Rec) => boolean): number {
  if (a.where !== b.where) return a.where === 'library' ? -1 : 1;
  if (a.where === 'library') {
    const aHome = lower(canonicalRelationship(a.rel).fromModel) === lower(a.modelFile!.name);
    const bHome = lower(canonicalRelationship(b.rel).fromModel) === lower(b.modelFile!.name);
    if (aHome !== bHome) return aHome ? -1 : 1;
    const ca = contradicted(a);
    const cb = contradicted(b);
    if (ca !== cb) return ca ? 1 : -1;
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
    const extras = yamlEntryExtras(modelFile.text);
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
        extras: extras.get(rawIndex) ?? [],
      });
    });
  }
  for (const domain of snapshot.domains) {
    const extras = domainEntryExtras(domain.text);
    // Any entry the reader could not read in full (REL008) — a cardinality it
    // did not recognise and drew as many-to-one, a role it showed shortened
    // or dropped — is left for the user, as a model file's is: storing what
    // the reader guessed (`one_to_many` as many-to-one) would bake the
    // misreading in and silence the warning for good.
    const readIssues = new Set(domain.readIssues.map((i) => i.index));
    domain.relationships.forEach((rel, readIndex) => {
      const rawIndex = domain.rawIndexes[readIndex];
      records.push({
        where: 'domain',
        domain,
        readIndex,
        rawIndex,
        rel: plain(rel),
        untouchable: readIssues.has(rawIndex) || domain.defaulted[readIndex] === true,
        file: domain.file,
        extras: extras.get(rawIndex) ?? [],
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

/** A report item about one stored record: its file, and the entry to find there. */
function recordItem(rec: Rec | undefined, message: string): RepairReportItem {
  if (!rec) return { message };
  const holder = rec.where === 'library' ? rec.modelFile! : rec.domain!;
  return {
    message,
    file: rec.file,
    filePath: holder.filePath,
    entry: { kind: rec.where === 'library' ? 'model' : 'domain', rel: rec.rel },
  };
}

/**
 * Whether a record is turned round into its many side's file: a model-library
 * record in the 1.6.7 shape, in a library-scope task. A diagram file's copy in
 * that shape is never turned round — it keeps the direction it was drawn in
 * (a REL006 for the user: ⇄ on the line), however many diagrams hold it.
 */
function backwardsIn(find: FindModel, task: Pick<LinkTask, 'scope'>): (rec: Rec) => boolean {
  return task.scope === 'library' ? (rec) => isBackwardsRecord(find, rec) : () => false;
}

function isBackwardsRecord(find: FindModel, rec: Rec): boolean {
  return rec.where === 'library' && storedBackwards(find, meaningOf(find, rec.rel));
}

/**
 * Group the project's relationship records by link, and sort them into what
 * a repair fixes on its own and what it leaves for the user. Pure; reads only
 * the snapshot.
 *
 * Fixed automatically (and nothing else): a library entry stored on its one
 * side (REL002) moved to its many side; a model-library record in the 1.6.7
 * shape (`storedBackwards`) turned round into the many side's file; an endpoint spelled in another case
 * (REL005) respelled; exact copies (REL001, and REL009's domain copies of a
 * library link) reduced to the one in the canonical home; and, for the move,
 * domain-file relationships stored once in the model library.
 *
 * Left, said, and never touched: a diagram file's copy of a library link
 * that says something else (only that copy; the link's other fixes go
 * ahead) — and every copy of the link for model-library copies that
 * disagree, a missing model or column (REL003 / REL004), a direction only the
 * user can judge (REL006 other than the 1.6.7 shape), an entry the reader
 * could not read (REL008), and anything that could not be stored without
 * losing what the user wrote.
 */
export function analyseRepair(snapshot: RepairSnapshot, options: RepairOptions = {}): RepairAnalysis {
  const move = options.moveDomainsToLibrary === true;
  const find = libraryIndex(snapshot.modelFiles);
  const rankRecords = rankRecordsWith(find);
  const byRecord = findingsByRecord(snapshot);
  const records = collectRecords(snapshot);
  const groups = new Map<string, Rec[]>();
  for (const r of records) {
    const key = linkKey(r.rel);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  // Links an older-format (v4) diagram also holds: that copy is checked but
  // never repaired, so findings about the link's copies (REL001 / REL009)
  // may remain after a repair of the others.
  const heldOutOfReach = new Set(snapshot.olderFormat.flatMap((d) => d.relationships.map((rel) => linkKey(rel))));
  const candidates: LinkTask[] = [];
  /** Diagram file copies of a library link that say something else: listed, never changed. */
  const ignoredLeft: RepairReportItem[] = [];
  for (const [key, recs] of groups) {
    const library = recs.filter((r) => r.where === 'library');
    const domainRecs = recs.filter((r) => r.where === 'domain');
    // The move settles only what moving needs (copies that disagree are left);
    // a missing endpoint or a doubtful direction is the checks' to report.
    const findingsOf = (of: readonly Rec[]): RelationshipFinding[] =>
      (move ? [] : [...new Set(of.flatMap((r) => byRecord.get(recordId(r)) ?? []))]);
    const domainFiles = new Set(domainRecs.map((r) => r.domain!));
    const libraryScope = library.length > 0
      || (domainRecs.length > 0 && (move || (snapshot.mode === 'library' && domainFiles.size > 1)));
    let perDomain = domainRecs;
    if (libraryScope) {
      let sorted = [...recs].sort(rankRecords);
      perDomain = [];
      // A diagram file's own copy of a link the model library holds is
      // ignored for drawing (REL009): one that says the same goes with the
      // repair; one that says something else is the user's to judge, so it is
      // left exactly as it is and listed — never a reason to leave the
      // library's own fixes undone. Only when the library's copies agree with
      // each other: copies that disagree there leave the whole link (below).
      const ignored = library.length > 0 ? ignoredDomainCopies(find, sorted) : [];
      if (ignored.length > 0) {
        sorted = sorted.filter((r) => !ignored.some((x) => x.rec === r));
        for (const { rec, says, library: libraryMeaning } of ignored) {
          ignoredLeft.push(recordItem(rec,
            `${describeEnds(libraryMeaning)}: ${rec.file} keeps its own copy, which says ${describeRecord(says)} where the model library ` +
            `says ${describeRecord(libraryMeaning)}. Diagrams draw the model library's copy and ignore this one, so it is left as it is — ` +
            `delete it from ${rec.file} if it is wrong.`));
        }
      }
      const moving = sorted.some((r) => r.where === 'domain');
      candidates.push({
        key, scope: 'library', records: sorted, findings: findingsOf(sorted),
        hadLibraryRecord: library.length > 0, moving, partialLeft: heldOutOfReach.has(key),
        ignoredCopiesLeft: ignored.length > 0,
      });
    }
    for (const domain of new Set(perDomain.map((r) => r.domain!))) {
      const sorted = perDomain.filter((r) => r.domain === domain).sort(rankRecords);
      candidates.push({
        key, scope: 'domain', domain, records: sorted, findings: findingsOf(sorted),
        hadLibraryRecord: false, moving: false, partialLeft: sorted.length < recs.length || heldOutOfReach.has(key),
        ignoredCopiesLeft: false,
      });
    }
  }

  const tasks: LinkTask[] = [];
  const left: RepairReportItem[] = [...ignoredLeft];
  const listProblems = new Map<RepairModelFile, string | null>();
  const listProblemOf = (modelFile: RepairModelFile): string | null => {
    if (!listProblems.has(modelFile)) listProblems.set(modelFile, yamlRelationshipsListProblem(modelFile.text, modelFile.file));
    return listProblems.get(modelFile)!;
  };
  for (const task of candidates) {
    const backwards = backwardsIn(find, task);
    const meanings = distinctMeanings(find, task.records, backwards);
    const r = meanings[0].rel;
    const subject = describeEnds(r);
    // A missing model or column needs a decision — unless it is only a
    // diagram copy's, in a link the model library also holds: that copy goes
    // either way (the library's record, which stays, carries any finding of
    // its own), e.g. a copy in a diagram that does not show both models.
    const recordsOf = (f: RelationshipFinding): Rec[] => task.records.filter((rec) => (byRecord.get(recordId(rec)) ?? []).includes(f));
    const onlyDomainCopies = (f: RelationshipFinding): boolean => task.scope === 'library' && task.hadLibraryRecord
      && recordsOf(f).every((rec) => rec.where === 'domain');
    const endpointFindings = task.findings.filter((f) => (f.code === 'REL003' || f.code === 'REL004') && !onlyDomainCopies(f));
    // A domain-file relationship bound for the model library whose from-model
    // has no readable file: it stays where it is, and is said.
    if (task.scope === 'library' && task.moving && endpointFindings.length === 0
      && !meanings.some((m) => find(m.rel.fromModel)) && !task.records.some((rec) => rec.untouchable)) {
      left.push(recordItem(
        task.records.find((rec) => rec.where === 'domain'),
        `${subject}: ${r.fromModel} has no readable file in logical-models/, so it stays where it is.`,
      ));
      continue;
    }
    // A diagram file's copy in the 1.6.7 shape keeps the direction it was
    // drawn in: moved as it is, it would land in the dimension's file (where
    // the next repair would turn it round), and turning it here would change
    // what the diagram draws. It stays, with the ⇄ hint every other diagram
    // copy of that shape gets.
    if (task.scope === 'library' && task.moving && !task.hadLibraryRecord) {
      const drawnBackwards = task.records.find((rec) => rec.where === 'domain' && storedBackwards(find, meaningOf(find, rec.rel)));
      if (drawnBackwards) {
        left.push(recordItem(drawnBackwards,
          `${subject}: the keys say it runs the other way (${r.fromModel}.${r.fromColumn} is ${r.fromModel}'s key, so it cannot be the many side) — ` +
          'it stays in the diagram file as drawn; if so, use ⇄ on the canvas, then run this again; if both sides are unique, make it one-to-one.'));
        continue;
      }
    }
    // What only the user can decide. The link is left exactly as it is —
    // every copy — and named, with the file to open.
    const judgement: Array<{ rec?: Rec; why: string }> = [];
    if (meanings.length > 1) {
      const where = (m: Meaning): string => [...new Set(m.records.map((rec) => rec.file))].join(', ');
      judgement.push({
        rec: meanings[1].records[0],
        why: `its copies disagree (${meanings.map((m) => `${describeRecord(m.rel)} in ${where(m)}`).join('; ')}) — keep the right one and delete the others`,
      });
    }
    for (const finding of endpointFindings) {
      const rec = recordsOf(finding)[0];
      const problem = rec ? missingEnd(find, meaningOf(find, rec.rel), task.scope === 'domain' ? task.domain : undefined) : null;
      judgement.push({ rec, why: `${problem?.what ?? finding.message} — point it at the right model and column, or delete it` });
    }
    for (const finding of task.findings.filter((f) => f.code === 'REL006')) {
      const rec = recordsOf(finding)[0];
      if (rec && backwards(rec)) continue;
      judgement.push({
        rec,
        why: 'the keys suggest it runs the other way — if so, use ⇄ on the canvas; if both sides are unique, make it one-to-one',
      });
    }
    const autoChange = judgement.length === 0 && wouldChange(find, task, r);
    if (judgement.length === 0 && !autoChange) continue;
    const unreadable = task.records.find((rec) => rec.untouchable);
    if (unreadable) {
      left.push(recordItem(unreadable, `${subject}: an entry of it in ${unreadable.file} could not be read in full, so every copy is left as it is — fix that entry first.`));
      continue;
    }
    if (judgement.length > 0) {
      // One item per relationship, naming every reason.
      const uniqueWhy = [...new Set(judgement.map((j) => j.why))];
      left.push(recordItem(judgement[0].rec ?? task.records[0], `${subject}: ${uniqueWhy.join('; ')}. Left as it is.`));
      continue;
    }
    // A diagram's stub columns excuse a missing model or column for that
    // diagram's own copy only. A first model-library copy has no stubs, so it
    // would point at nothing (REL003 / REL004) — known now, not after writing.
    if (task.scope === 'library' && !task.hadLibraryRecord) {
      const stubbed = task.records.map((rec) => ({ rec, what: stubDependentEnd(find, rec) })).find((x) => x.what !== null);
      if (stubbed) {
        left.push(recordItem(stubbed.rec,
          `${subject}: left in ${stubbed.rec.file} — ${stubbed.what}, which only that diagram's stub columns allow, ` +
          'so a model-library copy would point at nothing. Add it to the model file first.'));
        continue;
      }
    }
    // The same relationship as a model-library record must be readable back
    // and drawn where it is drawn now; when it cannot be, it is said now —
    // never planned, written, found wrong and rolled back together with every
    // good change of the run.
    if (task.scope === 'library' && task.moving && find(r.fromModel)) {
      const problem = libraryCopyProblem(find, { ...r, fromModel: find(r.fromModel)!.name });
      if (problem) {
        const domainRec = task.records.find((rec) => rec.where === 'domain')!;
        left.push(recordItem(domainRec, `${subject}: left in ${domainRec.file} — ${problem}. Fix it first.`));
        continue;
      }
    }
    // A model file whose list cannot be edited in place (written on one line,
    // `relationships: [ … ]`, …) leaves this one link as it is, never the run.
    const writeProblem = repairWriteProblem(task, r, find, listProblemOf);
    if (writeProblem) {
      left.push(recordItem(writeProblem.rec, `${subject}: ${writeProblem.message.replace(/[.;]? change (it|its relationships) by hand\.$/, '')} — left as it is; change it by hand.`));
      continue;
    }
    tasks.push(task);
  }
  const outOfReach: RepairReportItem[] = [];
  for (const d of snapshot.olderFormat) {
    const problems = snapshot.findings.filter((f) => f.code !== 'REL008' && f.severity !== 'info' && f.files.includes(d.file)).length;
    if (problems === 0) continue;
    outOfReach.push({
      message: `${d.file} has ${plural(problems, 'relationship problem')} but is still in the older format (inline models), so it is not changed here — ` +
        'run "ERD Studio: Migrate Domains to Central Model Store", then this command again.',
      file: d.file,
      filePath: d.filePath,
    });
  }
  for (const d of snapshot.unchecked) outOfReach.push({ message: `${d.file} was not checked: ${d.reason}.`, file: d.file, filePath: d.filePath });
  // A model file that could not be read: none of its relationships were seen,
  // so nothing about them may be reported as fine.
  for (const u of snapshot.unreadable) {
    outOfReach.push({
      message: `${u.file} was not checked: ${u.line !== undefined ? `it has a YAML error on line ${u.line}` : 'it could not be read'}, so the relationships in it were not looked at — fix it, then run this command again.`,
      file: u.file,
      ...(u.filePath ? { filePath: u.filePath } : {}),
      ...(u.line !== undefined ? { line: u.line } : {}),
    });
  }
  if (snapshot.layersError) {
    outOfReach.push({ message: `layers.json could not be used (${snapshot.layersError}), so diagrams in layer folders it names may not have been checked — fix it, then run this command again.` });
  }
  return {
    tasks,
    left,
    unreadableEntries: snapshot.findings.filter((f) => f.code === 'REL008'),
    outOfReach,
    records,
  };
}

/**
 * The diagram file records among a link's `sorted` records (library first)
 * that say something else than the model library's copy every diagram draws
 * — ignored for drawing (REL009 with `fix: 'ignored-domain-copy'`). Empty
 * when the library's own copies disagree: that link needs a decision as a
 * whole. A model-library record in the 1.6.7 shape is compared as its
 * turned-round self, as the repair reads it; a diagram file's copy always as
 * it is stored (one stored backwards differs on direction, and is listed).
 */
function ignoredDomainCopies(find: FindModel, sorted: readonly Rec[]): Array<{ rec: Rec; says: Relationship; library: Relationship }> {
  const backwards = (rec: Rec): boolean => isBackwardsRecord(find, rec);
  const libraryMeanings = distinctMeanings(find, sorted.filter((r) => r.where === 'library'), backwards);
  if (libraryMeanings.length !== 1) return [];
  const drawn = libraryMeanings[0].rel;
  const out: Array<{ rec: Rec; says: Relationship; library: Relationship }> = [];
  for (const rec of sorted) {
    // An entry the reader could not read in full (REL008) is never judged by
    // what the reader guessed: it stays with its link, which it leaves as is.
    if (rec.where !== 'domain' || rec.untouchable) continue;
    // A diagram file's copy is compared as it is stored, never turned round.
    const says = meaningOf(find, rec.rel);
    if (!sameRelationshipMeaning(says, drawn)) out.push({ rec, says, library: drawn });
  }
  return out;
}

/**
 * Why a domain record's end is acceptable only through its diagram's
 * `stubColumns` (a stub model missing from the library, or a column a stub
 * model's file does not list), or null — the same exemptions
 * `checkRelationships` grants a domain copy and never a library one.
 */
function stubDependentEnd(find: FindModel, rec: Rec): string | null {
  if (rec.where !== 'domain') return null;
  const stubs = new Set((rec.domain?.stubColumns ?? []).map(lower));
  if (stubs.size === 0) return null;
  for (const side of ['from', 'to'] as const) {
    const model = side === 'from' ? rec.rel.fromModel : rec.rel.toModel;
    const column = side === 'from' ? rec.rel.fromColumn : rec.rel.toColumn;
    if (!stubs.has(lower(model))) continue;
    const found = find(model);
    if (!found) return `it uses model ${model}, which is not in the model library`;
    const columns = found.model.columns ?? [];
    if (columns.length > 0 && !columns.some((c) => lower(c.name) === lower(column))) {
      return `it uses ${found.name}.${column}, which ${found.name}'s model file does not list`;
    }
  }
  return null;
}

/**
 * Why `rel`, stored as a model-library record in its from-model's file, could
 * not be read back or drawn as it is drawn now, or null: a model file entry
 * needs every end as non-empty text, and a diagram draws a library record
 * only when its to-model has a readable file (core's `normaliseRelationships`).
 */
function libraryCopyProblem(find: FindModel, rel: Relationship): string | null {
  for (const [what, value] of [['fromColumn', rel.fromColumn], ['toModel', rel.toModel], ['toColumn', rel.toColumn]] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      return `its ${what} is empty, which a model file cannot hold`;
    }
  }
  if (!find(rel.toModel)) {
    return `it points at ${rel.toModel}, which has no readable file in logical-models/, so no diagram would draw a model-library copy`;
  }
  return null;
}

interface Meaning {
  rel: Relationship;
  records: Rec[];
}

/**
 * The distinct things a link's records say, the reader's first choice first.
 * A record `backwards` says is the 1.6.7 shape means its turned-round self.
 */
function distinctMeanings(find: FindModel, records: readonly Rec[], backwards: (rec: Rec) => boolean): Meaning[] {
  const meanings: Meaning[] = [];
  for (const rec of records) {
    const read = meaningOf(find, rec.rel);
    const rel = backwards(rec) ? turnedRound(read) : read;
    const same = meanings.find((m) => sameRelationshipMeaning(m.rel, rel));
    if (same) same.records.push(rec);
    else meanings.push({ rel, records: [rec] });
  }
  return meanings;
}

/**
 * Why settling `task` on `r` would have to edit a model file whose list
 * cannot be edited in place, and the record that file holds — or null. A
 * record's file counts unless it is the record kept unchanged; the home file
 * counts when the record would be appended to it.
 */
function repairWriteProblem(
  task: LinkTask,
  r: Relationship,
  find: FindModel,
  listProblemOf: (modelFile: RepairModelFile) => string | null,
): { message: string; rec?: Rec } | null {
  const home = task.scope === 'library' ? find(r.fromModel) : undefined;
  const keep = keptRecord(task, r, find);
  const keptAsIs = keep !== undefined && keep.where === 'library' && home !== undefined
    && sameStoredFields(keep.rel, { ...r, fromModel: home.name });
  for (const rec of task.records) {
    if (rec.where !== 'library' || (rec === keep && keptAsIs)) continue;
    const problem = listProblemOf(rec.modelFile!);
    if (problem) return { message: problem, rec };
  }
  if (home && !(keptAsIs && keep!.modelFile === home)) {
    const problem = listProblemOf(home);
    if (problem) return { message: problem, rec: task.records[0] };
  }
  return null;
}

/** Whether settling `task` on `r` would change any file. */
function wouldChange(find: FindModel, task: LinkTask, r: Relationship): boolean {
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

function copyEdits<K>(edits: ReadonlyMap<K, FileEdits>): Map<K, FileEdits> {
  return new Map([...edits].map(([key, e]) => [key, {
    remove: new Set(e.remove), update: new Map(e.update), append: [...e.append], notes: [...e.notes],
  }]));
}

function restoreEdits<K>(edits: Map<K, FileEdits>, from: ReadonlyMap<K, FileEdits>): void {
  edits.clear();
  for (const [key, e] of copyEdits(from)) edits.set(key, e);
}

const modelEditsOf = (edits: FileEdits) => ({
  remove: edits.remove,
  update: new Map([...edits.update].map(([i, rel]) => [i, toModelEntry(rel)] as const)),
  append: edits.append.map(toModelEntry),
});

/**
 * Plan a repair: settle every link `analyseRepair` found an automatic fix
 * for, and compute each file's new text from its bytes as read — only the
 * `relationships:` list of a model file and `logical.relationships` of a
 * domain file change, entry by entry (plus, for a relationship turned round
 * from the 1.6.7 shape, the `isForeignKey` that version left on the
 * dimension's key column). Asks nothing; never changes a link that needs a
 * decision. Pure apart from what it read. Throws `RepairEditError` only when
 * a file that checked out cannot be edited after all.
 */
export function planRelationshipRepair(snapshot: RepairSnapshot, options: RepairOptions = {}): RepairPlan {
  const analysis = analyseRepair(snapshot, options);
  const find = libraryIndex(snapshot.modelFiles);
  const modelEdits = new Map<RepairModelFile, FileEdits>();
  const domainEdits = new Map<RepairDomainFile, FileEdits>();
  // The model files the current task edits, to check each still edits cleanly.
  let touchedByTask = new Set<RepairModelFile>();
  const editsFor = (rec: { modelFile?: RepairModelFile; domain?: RepairDomainFile }): FileEdits => {
    if (rec.modelFile) {
      touchedByTask.add(rec.modelFile);
      if (!modelEdits.has(rec.modelFile)) modelEdits.set(rec.modelFile, newEdits());
      return modelEdits.get(rec.modelFile)!;
    }
    if (!domainEdits.has(rec.domain!)) domainEdits.set(rec.domain!, newEdits());
    return domainEdits.get(rec.domain!)!;
  };
  const counts: RepairCounts = {
    rehomed: 0, respelled: 0, deduplicated: 0, domainCopiesRemoved: 0, moved: 0, swapped: 0, foreignKeysCleared: 0,
  };
  const left: RepairReportItem[] = [...analysis.left];
  const gone: RepairPlan['expect']['gone'] = [];
  const redrawn = new Set<string>();
  const consolidated = new Set<string>();
  const consolidatedRecords = new Map<string, Relationship>();
  const movedLinks = new Set<string>();
  let fixed = 0;
  /** Records of settled links, and what each link is stored as afterwards. */
  const settledRecords = new Set<Rec>();
  const settledAs: Relationship[] = [];
  /** Fix (c): key columns of relationships turned round from a dimension's file, by model file. */
  const flagCandidates: Array<{ modelFile: RepairModelFile; column: string }> = [];

  for (const task of analysis.tasks) {
    const backwards = backwardsIn(find, task);
    const meanings = distinctMeanings(find, task.records, backwards);
    const r = meanings[0].rel;
    const subject = describeEnds(r);
    const taskFiles = [...new Set(task.records.map((rec) => rec.file))];
    const taskGone: RepairPlan['expect']['gone'] = [];
    const expectGone = (code: RelationshipIssueCode): void => {
      if ((code === 'REL001' || code === 'REL009') && task.partialLeft) return;
      if (code === 'REL009' && task.ignoredCopiesLeft) return;
      taskGone.push({ code, link: task.key, files: taskFiles });
    };
    const countsBefore = { ...counts };
    const editsBefore = { model: copyEdits(modelEdits), domain: copyEdits(domainEdits) };
    const consolidatedBefore = new Map(consolidatedRecords);
    touchedByTask = new Set();
    const leaveTask = (item: RepairReportItem): void => {
      Object.assign(counts, countsBefore);
      restoreEdits(modelEdits, editsBefore.model);
      restoreEdits(domainEdits, editsBefore.domain);
      consolidatedRecords.clear();
      for (const [key, rel] of consolidatedBefore) consolidatedRecords.set(key, rel);
      consolidated.clear();
      for (const key of consolidatedBefore.keys()) consolidated.add(key);
      left.push(item);
    };

    // One record, at its home. Taking out an entry that carries the user's
    // own keys or comments would lose them: such a link is left as it is.
    const keep = keptRecord(task, r, find);
    const losing = task.records.filter((rec) => rec !== keep && rec.extras.length > 0);
    if (losing.length > 0) {
      const what = losing.map((rec) => `${rec.file} entry ${rec.rawIndex + 1} has ${describeExtras(rec.extras)}`);
      leaveTask(recordItem(losing[0], `${subject}: ${what.join('; ')}, which this change would remove — left as it is; change it by hand.`));
      continue;
    }
    const respelledAny = task.records.some((rec) => !sameStoredFields(rec.rel, respellWith(find, rec.rel)));
    const oneSided = task.records.some((rec) => rec.where === 'library' && rec.rel.cardinality === 'one-to-many');
    const turned = task.records.filter(backwards);
    if (task.scope === 'library') {
      const home = find(r.fromModel);
      if (!home) {
        leaveTask(recordItem(task.records[0], `${subject}: ${r.fromModel} has no readable file in logical-models/, so it stays where it is.`));
        continue;
      }
      const record: Relationship = { ...r, fromModel: home.name };
      for (const rec of task.records) {
        if (rec === keep) continue;
        const edits = editsFor(rec);
        edits.remove.add(rec.rawIndex);
        edits.notes.push(rec.where === 'domain'
          ? `removes its copy of ${describeEnds(record)} (now defined once, in ${home.file})`
          : turned.includes(rec)
            ? `removes ${describeEnds(rec.rel)}, which is stored backwards (its key column as the many side) — kept as ${describeEnds(record)} in ${home.file}`
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
      if (turned.length > 0) { counts.swapped++; expectGone('REL006'); }
      if (libraryRecs.length > 1 && meanings.length === 1) counts.deduplicated++;
      if (domainRecs.length > 0) {
        if (task.hadLibraryRecord) {
          counts.domainCopiesRemoved++;
          expectGone('REL009');
        } else {
          counts.moved++;
          consolidated.add(linkKey(record));
          consolidatedRecords.set(linkKey(record), record);
        }
      }
    } else {
      // Every copy but the one kept — which need not be the first: a later
      // copy carrying the user's own keys is the one kept (`keptRecord`).
      const kept = keep!;
      for (const rec of task.records) {
        if (rec === kept) continue;
        const edits = editsFor(rec);
        edits.remove.add(rec.rawIndex);
        edits.notes.push(`removes another copy of ${describeEnds(r)}`);
      }
      if (!sameStoredFields(kept.rel, respellWith(find, kept.rel)) || linkKey(kept.rel) !== linkKey(r)) {
        const edits = editsFor(kept);
        // Only the spelling changes: the record keeps its own direction and cardinality.
        const record = respellWith(find, kept.rel);
        edits.update.set(kept.rawIndex, record);
        edits.notes.push(`changes ${describeEnds(kept.rel)} to ${describeRecord(record)}`);
      }
      if (respelledAny) { counts.respelled++; expectGone('REL005'); }
      if (task.records.length > 1) {
        counts.deduplicated++;
        expectGone('REL001');
      }
    }
    // Settled — once every model file the task edits still edits in place. An
    // entry that cannot be (a value written as an alias or a | block, a role
    // as its first key) leaves this one link as it is, with the reason.
    let refused: RepairEditError | undefined;
    for (const modelFile of touchedByTask) {
      const edits = modelEdits.get(modelFile);
      if (!edits) continue;
      try {
        editYamlRelationships(modelFile.text, modelEditsOf(edits), modelFile.file);
      } catch (err) {
        if (!(err instanceof RepairEditError)) throw err;
        refused = err;
        break;
      }
    }
    if (refused) {
      leaveTask(recordItem(task.records[0], `${subject}: ${refused.message.replace(/[.;]? change (it|its relationships) by hand\.$/, '')} — left as it is; change it by hand.`));
      continue;
    }
    gone.push(...taskGone);
    fixed++;
    if (turned.length > 0) redrawn.add(task.key);
    if (task.scope === 'library' && task.records.some((rec) => rec.where === 'domain')) movedLinks.add(task.key);
    for (const rec of task.records) settledRecords.add(rec);
    settledAs.push(task.scope === 'library' ? { ...r, fromModel: find(r.fromModel)!.name } : meaningOf(find, respellWith(find, keep!.rel)));
    // Fix (c): only for the 1.6.7 shape stored in the dimension's own file.
    for (const rec of turned) {
      if (rec.where !== 'library') continue;
      const read = meaningOf(find, rec.rel);
      const dimension = find(read.fromModel);
      const key = dimension ? endEvidenceFromModel(dimension.model, read.fromColumn) : undefined;
      if (dimension && dimension === rec.modelFile && key?.isPrimaryKey && key.pkColumnCount === 1 && key.isForeignKeyDeclared) {
        flagCandidates.push({ modelFile: dimension, column: key.column });
      }
    }
  }

  // --- Fix (c): the isForeignKey 1.6.7's Draw from dbt left on a dimension's key.
  // Taken off only when, after the plan, no relationship anywhere has that
  // column as its foreign-key end (a subtype's key that also points at its
  // supertype keeps the flag).
  const fkEnds = [
    ...settledAs,
    ...analysis.records.filter((rec) => !settledRecords.has(rec)).map((rec) => meaningOf(find, rec.rel)),
  ].filter((rel) => rel.cardinality !== 'many-to-many');
  const flagClears = new Map<RepairModelFile, string[]>();
  for (const { modelFile, column } of flagCandidates) {
    if (fkEnds.some((rel) => lower(rel.fromModel) === lower(modelFile.name) && lower(rel.fromColumn) === lower(column))) continue;
    const columns = flagClears.get(modelFile) ?? [];
    if (!columns.includes(column)) flagClears.set(modelFile, [...columns, column]);
  }

  // --- Each file's new text ---------------------------------------------------
  const changes: RepairFileChange[] = [];
  for (const [modelFile, edits] of modelEdits) {
    let base = modelFile.text;
    const clear = flagClears.get(modelFile) ?? [];
    if (clear.length > 0) {
      try {
        base = clearForeignKeyFlags(modelFile.text, clear, modelFile.file);
        counts.foreignKeysCleared += clear.length;
        for (const column of clear) {
          edits.notes.push(`takes isForeignKey off ${modelFile.name}.${column}, its primary key (ERD Studio 1.6.7 marked it by mistake)`);
        }
      } catch (err) {
        if (!(err instanceof RepairEditError)) throw err;
        for (const column of clear) {
          left.push({
            message: `${modelFile.name}.${column} is its primary key but is still marked isForeignKey: true — ${err.message.replace(/[.;]? change (it|its relationships) by hand\.$/, '')}; take the flag off by hand if it is not a foreign key.`,
            file: modelFile.file,
            filePath: modelFile.filePath,
          });
        }
      }
    }
    const text = editYamlRelationships(base, modelEditsOf(edits), modelFile.file);
    if (text !== modelFile.text) {
      changes.push({
        filePath: modelFile.filePath, file: modelFile.file, kind: 'model', original: modelFile.text,
        ...(base !== modelFile.text ? { base } : {}),
        text, notes: edits.notes,
      });
    }
  }
  for (const [domain, edits] of domainEdits) {
    const text = editDomainRelationships(domain.text, edits, domain.file);
    if (text !== domain.text) {
      changes.push({ filePath: domain.filePath, file: domain.file, kind: 'domain', original: domain.text, text, notes: edits.notes });
    }
  }
  changes.sort((a, b) => (a.kind === b.kind ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.kind === 'model' ? -1 : 1));

  // A relationship newly in the model library is drawn by every diagram that
  // holds both its models — including ones that never drew it. Each is named,
  // so the preview says what the diagrams will show, not only which files change.
  const alsoDrawn: string[] = [];
  if (consolidatedRecords.size > 0) {
    const drawnBefore = drawnByDomain(snapshot);
    for (const [key, record] of consolidatedRecords) {
      for (const domain of snapshot.domains) {
        const names = new Set(domain.models.map(lower));
        if (!names.has(lower(record.fromModel)) || !names.has(lower(record.toModel))) continue;
        if (drawnBefore.get(domain.filePath)?.has(key)) continue;
        alsoDrawn.push(`${domain.file} will also draw ${describeEnds(record)}: it holds both models, and the relationship is now in the model library`);
      }
    }
    alsoDrawn.sort();
  }
  // Where new relationships go afterwards (`usesLibraryRelationships`, read
  // from the planned texts). A change the user did not ask for is said in the
  // preview, never left for the next canvas edit to discover.
  const modeAfter = plannedMode(snapshot, changes);
  const intended = options.moveDomainsToLibrary === true && modeAfter === 'library';
  const modeChange = modeAfter === snapshot.mode || intended
    ? undefined
    : modeAfter === 'domain'
      ? 'After this no model file holds a relationship while diagram files still hold their own, so the project goes back to ' +
        'keeping relationships in each diagram\'s file: new relationships will be saved there. Run "Move Relationships to Model ' +
        'Library" afterwards to keep them with their models.'
      : 'After this no diagram file holds a relationship, so the project keeps relationships in the model library from now on: ' +
        'new relationships will be saved with the model that holds the foreign key.';
  return {
    changes,
    fixed: changes.length > 0 ? fixed : 0,
    ...(modeChange ? { modeChange } : {}),
    counts,
    left,
    alsoDrawn,
    unreadableEntries: analysis.unreadableEntries,
    outOfReach: analysis.outOfReach,
    movedLinks: changes.length > 0 ? movedLinks : new Set(),
    expect: {
      gone, redrawn, consolidated,
      domainEntries: new Map([...domainEdits].map(([domain, edits]) => [domain.filePath, {
        remove: new Set(edits.remove), update: new Set(edits.update.keys()),
      }])),
      modeAfter,
    },
  };
}

/**
 * Whether `findings` hold anything Repair Relationships… might settle on its
 * own — REL001 (copies), REL002 (one-to-many on the "one" side), REL005 (a
 * case-only name), REL006 in the 1.6.7 shape (`fix: 'rehome'`) or REL009
 * saying the same as the model library (`fix: 'remove-domain-copy'`). The
 * cheap test before the once-a-session offer reads and plans the whole
 * project: no such finding, no automatic fix (the plan decides the rest).
 */
export function mayHaveAutomaticRepair(findings: readonly RelationshipFinding[]): boolean {
  return findings.some((f) => f.code === 'REL001' || f.code === 'REL002' || f.code === 'REL005'
    || (f.code === 'REL006' && f.fix === 'rehome')
    || (f.code === 'REL009' && f.fix === 'remove-domain-copy'));
}

/**
 * The links (`linkKey`) the move to the model library would actually store
 * there — what the "move them to the model library?" offer counts, so it is
 * never made for links the move would only report as left where they are.
 */
export function linksTheMoveStores(snapshot: RepairSnapshot): Set<string> {
  try {
    return planRelationshipRepair(snapshot, { moveDomainsToLibrary: true }).movedLinks;
  } catch (err) {
    if (err instanceof RepairEditError) return new Set();
    throw err;
  }
}

/** How many entries a domain file's `logical.relationships` holds, read raw (0 when it cannot be read). */
function rawDomainRelationshipCount(text: string): number {
  return domainTextRelationshipCount(text);
}

/** The mode (`usesLibraryRelationships`) the project is in once `changes` are written. */
function plannedMode(snapshot: RepairSnapshot, changes: readonly RepairFileChange[]): 'library' | 'domain' {
  const planned = new Map(changes.map((c) => [c.filePath, c]));
  const models = snapshot.modelFiles.map((modelFile) => {
    const change = planned.get(modelFile.filePath);
    if (!change) return modelFile.model;
    try {
      return parseLogicalModelText(change.text, modelFile.name) ?? { name: modelFile.name, columns: [] };
    } catch {
      return { name: modelFile.name, columns: [] };
    }
  });
  let domainCount = snapshot.domainFileRelationshipCount ?? snapshot.domains.reduce((n, d) => n + rawDomainRelationshipCount(d.text), 0);
  for (const change of changes) {
    if (change.kind === 'domain') domainCount += rawDomainRelationshipCount(change.text) - rawDomainRelationshipCount(change.original);
  }
  const unreadableWithRelationships = snapshot.unreadable.filter((u) => u.holdsRelationships).length;
  return usesLibraryRelationships(models, domainCount, unreadableWithRelationships) ? 'library' : 'domain';
}

/**
 * The record a settled task keeps (updated in place): in library scope a
 * record already in the home model's file — one carrying the user's own keys
 * or comments first, then the first in the file; in domain scope the first
 * the reader draws, unless a later one carries such extras. Undefined when the
 * home file holds none (the record is appended) or there is no home.
 */
function keptRecord(task: LinkTask, r: Relationship, find: FindModel): Rec | undefined {
  const byExtrasThenPlace = (a: Rec, b: Rec): number =>
    Number(b.extras.length > 0) - Number(a.extras.length > 0) || a.rawIndex - b.rawIndex;
  if (task.scope === 'library') {
    const home = find(r.fromModel);
    if (!home) return undefined;
    // A library record's fromModel is its file's model name, so any record in the home file will do.
    return task.records.filter((rec) => rec.where === 'library' && rec.modelFile === home).sort(byExtrasThenPlace)[0];
  }
  const withExtras = task.records.filter((rec) => rec.extras.length > 0);
  return withExtras.length === 1 ? withExtras[0] : task.records[0];
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

interface MissingEnd {
  side: 'from' | 'to';
  kind: 'model' | 'column';
  model: string;
  column: string;
  /** e.g. "model dim_x is not in the model library". */
  what: string;
}

/**
 * The end of `r` whose model or column the library does not have, if any.
 * With `diagram` (a record kept in one domain file), also an end whose model
 * is not one of that diagram's models: the diagram cannot draw it.
 */
function missingEnd(find: FindModel, r: Relationship, diagram?: RepairDomainFile): MissingEnd | null {
  const inDiagram = diagram ? new Set(diagram.models.map(lower)) : undefined;
  const stubs = new Set((diagram?.stubColumns ?? []).map(lower));
  for (const side of ['from', 'to'] as const) {
    const model = side === 'from' ? r.fromModel : r.toModel;
    const column = side === 'from' ? r.fromColumn : r.toColumn;
    const found = find(model);
    // Not one of the diagram's models: the diagram cannot draw it, whatever
    // its stub columns say (they excuse missing columns only, as the checks
    // read it).
    if (inDiagram && !inDiagram.has(lower(model))) {
      if (!found) return { side, kind: 'model', model, column, what: `model ${model} is not in the model library` };
      return { side, kind: 'model', model: found.name, column, what: `model ${found.name} is not one of ${diagram!.file}'s models` };
    }
    // A diagram's stub model or column is not missing there (as the checks read it).
    if (stubs.has(lower(model)) && (!found || (found.model.columns ?? []).every((c) => lower(c.name) !== lower(column)))) continue;
    if (!found) return { side, kind: 'model', model, column, what: `model ${model} is not in the model library` };
    const columns = found.model.columns ?? [];
    if (columns.length > 0 && !columns.some((c) => lower(c.name) === lower(column))) {
      return { side, kind: 'column', model: found.name, column, what: `model ${found.name} has no column ${column}` };
    }
  }
  return null;
}

/**
 * Everything a plan leaves for the user, in the order the preview lists it:
 * relationships left as they are, what the command could not reach, and
 * entries that could not be read (each at its line, named as `snapshot`
 * names its files).
 */
export function repairReportItems(
  plan: Pick<RepairPlan, 'left' | 'outOfReach' | 'unreadableEntries'>,
  snapshot: Pick<RepairSnapshot, 'modelFiles' | 'domains' | 'olderFormat'>,
): RepairReportItem[] {
  const files = new Map<string, string>([
    ...snapshot.modelFiles.map((m) => [m.file, m.filePath] as const),
    ...snapshot.domains.map((d) => [d.file, d.filePath] as const),
    ...snapshot.olderFormat.map((d) => [d.file, d.filePath] as const),
  ]);
  const unreadable = plan.unreadableEntries.map((f): RepairReportItem => {
    const file = f.files[0];
    const filePath = file !== undefined ? files.get(file) : undefined;
    return {
      message: f.message,
      ...(file !== undefined ? { file } : {}),
      ...(filePath ? { filePath } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
    };
  });
  return [...plan.left, ...plan.outOfReach, ...unreadable];
}

/**
 * Where an item's entry is in its file as it is now (1-based), or the item's
 * own line, or undefined (open the file at the top). Reads the file fresh and
 * finds the entry the way the readers do, so the line holds after a repair
 * moved the entries above it.
 */
export function reportItemLine(item: RepairReportItem): number | undefined {
  if (!item.entry || !item.filePath) return item.line;
  let text: string;
  try {
    text = fs.readFileSync(item.filePath, 'utf-8');
  } catch {
    return item.line;
  }
  // The very entry, as stored (not link identity: two copies of one link in
  // a file are two entries, and the item is about one of them).
  const want = item.entry.rel;
  const same = (rel: Relationship): boolean => sameStoredFields(plain(rel), want);
  try {
    if (item.entry.kind === 'model') {
      const model = parseLogicalModelText(text, path.basename(item.filePath).replace(/\.ya?ml$/i, ''));
      const issues = new Set((model?.relationshipIssues ?? []).filter((i) => i.skipped).map((i) => i.index));
      const rawIndexes: number[] = [];
      for (let raw = 0; rawIndexes.length < (model?.relationships?.length ?? 0); raw++) if (!issues.has(raw)) rawIndexes.push(raw);
      const at = (model?.relationships ?? []).findIndex((rel) => same({ ...rel, fromModel: model!.name }));
      return at === -1 ? item.line : yamlRelationshipEntryLine(text, rawIndexes[at]) ?? item.line;
    }
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { logical?: { relationships?: unknown } };
    const entries = readDomainRelationshipEntries(raw?.logical?.relationships, 'the diagram');
    const at = entries.relationships.findIndex((rel) => same(rel));
    const lines = domainRelationshipElementLines(text);
    return at === -1 || !lines ? item.line : lines[entries.rawIndexes[at]] ?? item.line;
  } catch {
    return item.line;
  }
}

/** The 1-based line of entry `index` of a model file's `relationships:` list, or undefined. */
function yamlRelationshipEntryLine(text: string, index: number): number | undefined {
  const bom = text.startsWith(BOM) ? 1 : 0;
  const body = text.slice(bom);
  const doc = parseDocument(body);
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  const pair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'relationships');
  const seq = pair?.value;
  if (!isSeq(seq)) return undefined;
  const item = seq.items[index] as Node | undefined;
  if (!item?.range) return undefined;
  const offset = markerOffset(body, item);
  return body.slice(0, offset).split('\n').length;
}

/**
 * The preview's detail: every file and what changes in it, the relationships
 * left for the user (and why), what the command could not reach, and entries
 * that could not be read.
 */
export function describeRepairPlan(plan: RepairPlan, maxFiles = 12, maxNotes = 4, maxItems = 8): string {
  const lines: string[] = [];
  for (const change of plan.changes.slice(0, maxFiles)) {
    lines.push(`• ${change.file}`);
    for (const note of change.notes.slice(0, maxNotes)) lines.push(`    – ${note}`);
    if (change.notes.length > maxNotes) lines.push(`    – …and ${change.notes.length - maxNotes} more`);
  }
  if (plan.changes.length > maxFiles) lines.push(`• …and ${plan.changes.length - maxFiles} more files`);
  if (plan.modeChange) lines.push('', `Where new relationships are saved: ${plan.modeChange}`);
  if (plan.alsoDrawn.length > 0) {
    lines.push('', 'Diagrams that will start drawing a relationship:');
    for (const note of plan.alsoDrawn.slice(0, 5)) lines.push(`• ${note}`);
    if (plan.alsoDrawn.length > 5) lines.push(`• …and ${plan.alsoDrawn.length - 5} more`);
  }
  const list = (heading: string, items: readonly RepairReportItem[]): void => {
    if (items.length === 0) return;
    lines.push('', heading);
    for (const item of items.slice(0, maxItems)) lines.push(`• ${item.message}`);
    if (items.length > maxItems) lines.push(`• …and ${items.length - maxItems} more (Open File… lists them all)`);
  };
  list('Needs your attention — not changed by this repair:', plan.left);
  list('Not checked or not changed by this command:', plan.outOfReach);
  if (plan.unreadableEntries.length > 0) {
    lines.push('', describeUnreadableEntries(plan.unreadableEntries));
  }
  return lines.join('\n');
}

/** One sentence about REL008 entries, which no repair touches. */
export function describeUnreadableEntries(entries: readonly RelationshipFinding[]): string {
  const where = entries.slice(0, 3).map((f) => `${f.files[0]}${f.line !== undefined ? `:${f.line}` : ''}`);
  return `${plural(entries.length, 'relationship entry', 'relationship entries')} could not be read ` +
    `and ${entries.length === 1 ? 'is' : 'are'} left untouched — fix ${entries.length === 1 ? 'it' : 'them'} by hand: ` +
    `${where.join(', ')}${entries.length > 3 ? ` and ${entries.length - 3} more` : ''}.`;
}

/**
 * The canvas notification offering "Repair Relationships…": how many
 * relationships the repair would fix on its own and, briefly, why. Null when
 * it would fix nothing — a problem only the user can settle is shown on the
 * canvas (badges, banner) and by `erd-studio check`, never nagged about.
 */
export function describeRepairOffer(plan: RepairPlan): string | null {
  if (plan.changes.length === 0 || plan.fixed === 0) return null;
  const c = plan.counts;
  const parts = ([
    [c.rehomed, 'saved in the file of the model it points at'],
    [c.swapped, 'saved the wrong way round (its key column as the "many" side)'],
    [c.deduplicated, 'stored more than once'],
    [c.domainCopiesRemoved, 'kept as an unused copy in a diagram file'],
    [c.moved, 'kept as a copy in several diagrams'],
    [c.respelled, 'spelled with different capital letters'],
  ] as const).filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`);
  const n = plan.fixed;
  return `${n === 1 ? '1 relationship can' : `${n} relationships can`} be tidied up automatically` +
    `${parts.length > 0 ? ` (${parts.join('; ')})` : ''}. Review the fixes with Repair Relationships…? Nothing changes until you confirm.`;
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
/**
 * Why a model file's `relationships:` list as a whole cannot be edited in
 * place by {@link editYamlRelationships} — the file is not YAML, not a
 * mapping, written on one line, or its list is not one `- ` entry per line —
 * or null when it can (an absent or empty list can always be written).
 * `analyseRepair` asks it before planning a fix, so a link stored in such a
 * file is left as it is, said, and never planned.
 */
export function yamlRelationshipsListProblem(text: string, file = 'the model file'): string | null {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const doc = parseDocument(body);
  if (doc.errors.length > 0) return `${file} could not be read as YAML: ${doc.errors[0].message}`;
  const root = doc.contents;
  if (!isMap(root)) return `${file} is not a YAML mapping.`;
  const pair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'relationships');
  const seq = pair?.value as Node | null | undefined;
  if (!pair || seq === null || seq === undefined || (isSeq(seq) && seq.items.length === 0)) return null;
  if (root.flow) return `${file} is written on one line ({ … }); change its relationships by hand.`;
  if (!isSeq(seq) || seq.flow) return `${file}: "relationships:" is not a list with one "- " entry per line; change it by hand.`;
  return null;
}

export function editYamlRelationships(
  text: string,
  edits: { remove: ReadonlySet<number>; update: ReadonlyMap<number, ModelRelationship>; append: readonly ModelRelationship[] },
  file = 'the model file',
): string {
  if (edits.remove.size === 0 && edits.update.size === 0 && edits.append.length === 0) return text;
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const listProblem = yamlRelationshipsListProblem(text, file);
  if (listProblem) throw new RepairEditError(listProblem);
  const doc = parseDocument(body);
  const root = doc.contents as YAMLMap;
  const pair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'relationships');
  const seq = pair?.value as Node | null | undefined;
  const items = isSeq(seq) ? (seq.items as Node[]) : [];

  if (!pair || seq === null || seq === undefined || (isSeq(seq) && items.length === 0)) {
    if (edits.remove.size > 0 || edits.update.size > 0) throw new RepairEditError(`${file} has no relationships to change.`);
    return setYamlRelationships(text, edits.append);
  }
  for (const i of [...edits.remove, ...edits.update.keys()]) {
    if (i < 0 || i >= items.length) throw new RepairEditError(`${file}: relationship entry ${i + 1} is not there any more.`);
  }
  if (items.every((_, i) => edits.remove.has(i)) && edits.append.length === 0) {
    // The whole list goes — with its key, unless a comment in it (above an
    // entry, after the last, on the key's line) would go too: then each entry
    // is taken out on its own and the comments stay under an empty key.
    const region = yamlRelationshipsRegion(body);
    let outside = region ? body.slice(region[0], region[1]) : '';
    for (const item of [...items].reverse()) {
      const [start, end] = itemSpan(body, item);
      if (region) outside = outside.slice(0, start - region[0]) + outside.slice(end - region[0]);
    }
    if (!outside.includes('#')) return setYamlRelationships(text, []);
  }

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
  // `reads` is how the reader turns the written value into what the record
  // holds (a role is trimmed and collapsed): a value that already reads as
  // the wanted one is left exactly as written.
  const replaceValue = (p: Pair, value: string, reads: (written: string) => string | undefined = (w) => w): void => {
    const node = p.value as Node | null;
    const key = String((p.key as { value?: unknown }).value);
    if (!isScalar(node) || !node.range) throw new RepairEditError(`${where}: "${key}" is not a plain value; change it by hand.`);
    if (String(node.value) === value || reads(String(node.value)) === value) return;
    // A block scalar's range runs to the start of the next line (its line
    // break included): spliced, the next key would join this line and the
    // file would no longer parse.
    if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
      throw new RepairEditError(`${where}: "${key}" is written as a block (| or >); change it by hand.`);
    }
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
      replaceValue(rolePair, next.role, normaliseRelationshipRole);
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
  for (const i of edits.update.keys()) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RepairEditError(`${file}: relationship entry ${i + 1} is not an object.`);
    }
  }
  // Entry by entry: every entry not removed or changed keeps its exact bytes
  // (layout, number spelling, escapes, keys); a changed one keeps all but the
  // values that change.
  try {
    return editDomainRelationshipEntries(text, edits);
  } catch (err) {
    throw new RepairEditError(`${file} could not be edited: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Return `text` (a model yml) with the `isForeignKey` line taken off each of
 * `columns` — fix (c), the flag 1.6.7's Draw from dbt left on a dimension's
 * primary key — and every other byte unchanged. A column without the flag is
 * left alone. Throws `RepairEditError` (naming `file`) when a flag cannot be
 * taken off in place: the columns written on one line, a column listed twice,
 * the flag as a column's first key, or a comment on its line.
 */
export function clearForeignKeyFlags(text: string, columns: readonly string[], file = 'the model file'): string {
  if (columns.length === 0) return text;
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const doc = parseDocument(body);
  if (doc.errors.length > 0) throw new RepairEditError(`${file} could not be read as YAML: ${doc.errors[0].message}`);
  const root = doc.contents;
  if (!isMap(root) || root.flow) throw new RepairEditError(`${file} is not written one key per line.`);
  const columnsPair = (root.items as unknown[]).find((p): p is Pair => isPair(p) && isScalar(p.key) && p.key.value === 'columns');
  const seq = columnsPair?.value;
  if (!isSeq(seq) || seq.flow) throw new RepairEditError(`${file}: "columns:" is not a list with one "- " entry per line.`);
  const splices: Splice[] = [];
  for (const name of columns) {
    const matches = (seq.items as unknown[]).filter((item): item is YAMLMap => isMap(item)
      && (item.items as unknown[]).some((p) => isPair(p) && isScalar(p.key) && p.key.value === 'name' && isScalar(p.value) && p.value.value === name));
    if (matches.length !== 1) throw new RepairEditError(`${file}: column ${name} is not listed exactly once.`);
    const column = matches[0];
    if (column.flow) throw new RepairEditError(`${file}: column ${name} is written on one line ({ … }).`);
    const pairs = column.items.filter(isPair) as Pair[];
    const flag = pairs.find((p) => isScalar(p.key) && p.key.value === 'isForeignKey');
    if (!flag) continue;
    const key = flag.key as Node;
    const value = flag.value as Node | null;
    if (flag === pairs[0]) throw new RepairEditError(`${file}: column ${name} starts with isForeignKey.`);
    if (!isScalar(value) || !value.range || value.type === 'BLOCK_LITERAL' || value.type === 'BLOCK_FOLDED' || !key.range) {
      throw new RepairEditError(`${file}: column ${name}'s isForeignKey is not a plain value.`);
    }
    const start = lineStart(body, key.range[0]);
    const end = afterLineEnd(body, value.range[1]);
    if (body.slice(start, key.range[0]).trim() !== '' || body.slice(value.range[1], end).trim() !== '') {
      throw new RepairEditError(`${file}: column ${name}'s isForeignKey shares its line with something else (a comment or another key).`);
    }
    splices.push({ start, end, text: '', rank: 0 });
  }
  return bom + applySplices(body, splices);
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
    // A planned text that would not read back is refused before anything is
    // written, never found out by the read-back after.
    const parseError = plannedTextError(change.kind, change.text);
    if (parseError) {
      problems.push(`${change.file} would no longer read: ${parseError}`);
      continue;
    }
    try {
      if (!onlyRelationshipsChanged(change.kind, change.base ?? change.original, change.text)) {
        problems.push(`${change.file}: something other than its relationships would change`);
      }
    } catch (err) {
      problems.push(`${change.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** Why a planned file text would not parse, or null when it does. */
function plannedTextError(kind: 'model' | 'domain', text: string): string | null {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (kind === 'domain') {
    try {
      JSON.parse(body);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  const doc = parseDocument(body);
  return doc.errors.length > 0 ? doc.errors[0].message.split('\n')[0] : null;
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
    const { relationships } = normaliseRelationships({
      models, own: domain.relationships, filePath: domain.file,
      libraryHasModel: (name) => find(name)?.name === name,
    });
    // The canvas draws an edge only between two of the domain's own models.
    const shown = new Set(domain.models.map(lower));
    drawn.set(domain.filePath, new Map(relationships
      .filter((rel) => shown.has(lower(rel.fromModel)) && shown.has(lower(rel.toModel)))
      .map((rel) => [linkKey(rel), rel])));
  }
  return drawn;
}

/**
 * The unknown keys (comments aside) the relationship entries of `original`
 * carry more often than those of `text` — what a change took out with an
 * entry. Empty when nothing was lost.
 */
function lostEntryKeys(kind: RepairFileChange['kind'], original: string, text: string): string[] {
  const tally = (t: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const extras = kind === 'model' ? yamlEntryExtras(t) : domainEntryExtras(t);
    for (const keys of extras.values()) {
      for (const key of keys) if (key !== COMMENTS) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  let was: Map<string, number>;
  let now: Map<string, number>;
  try {
    was = tally(original);
    now = tally(text);
  } catch {
    return []; // a file that does not parse is reported by the other checks
  }
  return [...was].filter(([key, n]) => (now.get(key) ?? 0) < n).map(([key]) => key).sort();
}

/**
 * Check the project as it is after the writes (`after`) against what it was
 * (`before`) and what the plan promised. Returns one line per problem; empty
 * means the repair did exactly what it said:
 *
 * - every written file holds the planned text, and nothing outside its
 *   relationships changed (a model file's planned `isForeignKey` line aside);
 * - no entry's own keys were lost, and every written model file still reads,
 *   with exactly as many entries the reader could not read as before;
 * - every finding the plan fixed is gone, and no new one (except `info`)
 *   appeared;
 * - every diagram draws what it drew before, except links turned round on
 *   purpose (still drawn, the right way round) and links newly stored in the
 *   model library.
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
      if (!onlyRelationshipsChanged(change.kind, change.base ?? change.original, text)) {
        problems.push(`${change.file}: something other than its relationships changed`);
      }
    } catch (err) {
      problems.push(`${change.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // An entry carrying the user's own keys is never taken out (it is left,
    // and the plan says why), so no file may hold fewer of them afterwards.
    const lostKeys = lostEntryKeys(change.kind, change.original, text);
    if (lostKeys.length > 0) {
      problems.push(`${change.file}: an entry's own ${lostKeys.length === 1 ? 'key' : 'keys'} ${lostKeys.join(', ')} ${lostKeys.length === 1 ? 'is' : 'are'} gone`);
    }
    // A diagram file changes entry by entry: every entry the plan neither
    // removes nor changes must read back exactly as it was written.
    const planned = change.kind === 'domain' ? plan.expect.domainEntries.get(change.filePath) : undefined;
    if (planned) {
      const was = domainRelationshipElementTexts(change.original);
      const now = domainRelationshipElementTexts(text);
      const expected = was?.filter((_, i) => !planned.remove.has(i));
      const keptIndexes = was?.map((_, i) => i).filter((i) => !planned.remove.has(i)) ?? [];
      if (!was || !now || !expected || now.length !== expected.length
        || keptIndexes.some((i, j) => !planned.update.has(i) && now[j] !== was[i])) {
        problems.push(`${change.file}: an entry the repair did not change was rewritten`);
      }
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
  // Where new relationships are saved changes only as the plan said (the
  // move's switch to the library, or one the preview named).
  const modeAfter = plan.expect.modeAfter;
  if (after.mode !== modeAfter) {
    problems.push(after.mode === 'domain'
      ? 'the project would go back to keeping relationships in each diagram\'s file, which the plan did not say'
      : 'the project would switch to keeping relationships in the model library, which the plan did not say');
  }
  // Entries that could not be read in full (REL008) are never touched — in a
  // model file or a diagram file — so their count must not move.
  const rel008 = (snap: RepairSnapshot): number => snap.findings.filter((f) => f.code === 'REL008').length;
  if (rel008(after) !== rel008(before)) {
    problems.push('the entries that could not be read changed');
  }

  const drawnBefore = drawnByDomain(before);
  const drawnAfter = drawnByDomain(after);
  const { redrawn, consolidated } = plan.expect;
  for (const domain of before.domains) {
    const b = drawnBefore.get(domain.filePath) ?? new Map<string, Relationship>();
    const a = drawnAfter.get(domain.filePath) ?? new Map<string, Relationship>();
    for (const [key, rel] of b) {
      const now = a.get(key);
      if (!now) problems.push(`${domain.label} no longer draws ${describeEnds(rel)}`);
      // A link turned round is drawn the other way on purpose.
      else if (!redrawn.has(key) && !sameRelationshipMeaning(now, rel)) problems.push(`${domain.label} now draws ${describeEnds(rel)} differently`);
    }
    for (const [key, rel] of a) {
      if (b.has(key) || consolidated.has(key)) continue;
      problems.push(`${domain.label} now also draws ${describeEnds(rel)}`);
    }
  }
  return problems;
}
