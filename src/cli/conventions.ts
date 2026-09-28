/**
 * `inventory.conventions` — the modelling conventions a dbt project already
 * follows, read deterministically from its files (model names, folders,
 * schemas, model and column descriptions, the shape of the tables —
 * relationships, keys, column types — snapshots and packages). No AI, no
 * guessing beyond the rules below:
 * the `/erd-studio-setup` skill *confirms* what this finds with the user
 * instead of asking them cold how they model data.
 *
 * Two independent things are reported, because they are usually combined:
 * - `layering` — where data sits (medallion bronze/silver/gold, or dbt's
 *   staging/intermediate/marts);
 * - `shape` — how tables are shaped (Kimball, Data Vault, One Big Table,
 *   Activity Schema, and — only ever as a guess from structure, unless the
 *   descriptions say so — Inmon / 3NF).
 *
 * Free of `vscode` — bundled into `dist/cli.js`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export type LayeringStyle = 'medallion' | 'dbt-layered' | 'none';
export type ShapeStyle = 'kimball' | 'data-vault' | 'one-big-table' | 'activity-schema' | 'inmon-3nf' | 'none';
/** Where shape evidence came from — the independent signal families. */
export type ShapeSource = 'names' | 'descriptions' | 'structure' | 'snapshots' | 'packages';

export interface ProjectConventions {
  layering: {
    style: LayeringStyle;
    evidence: string[];
    /** Detected layer names in pipeline order, e.g. ['bronze','silver','gold']. */
    layers: string[];
  };
  shape: {
    style: ShapeStyle;
    /**
     * 'strong' needs a package, or two independent families (`sources`)
     * agreeing with no competing style.
     */
    confidence: 'strong' | 'weak';
    evidence: string[];
    /** Other styles with at least one signal, strongest first (the "or" in a mixed project). */
    alternatives: Exclude<ShapeStyle, 'none'>[];
    /** The families the chosen style's evidence came from, in this order; empty for 'none'. */
    sources: ShapeSource[];
  };
  history: { snapshots: string[] };
}

/** What detection needs to know about one model. */
export interface ConventionModel {
  name: string;
  kind: 'model' | 'seed' | 'snapshot';
  folder: readonly string[];
  schema: string;
  columnCount: number;
  /** Model description (yml → manifest → catalog comment). */
  description?: string;
  /** Columns with type and description, when known (structure and column wording need them). */
  columns?: ReadonlyArray<{ name: string; dataType?: string; description?: string }>;
  /** Columns with a `unique` test (a key the model is identified by). */
  uniqueKeys?: readonly string[];
}

/** A relationship test between two project models. */
export interface ConventionRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

export interface ConventionInput {
  models: readonly ConventionModel[];
  /** Package identifiers from packages.yml / dependencies.yml / package-lock.yml. */
  packages: readonly string[];
  /** Snapshot names found in the project (in addition to models of kind 'snapshot'). */
  snapshots: readonly string[];
  /** Relationship tests across the project (structure signals). */
  relationships?: readonly ConventionRelationship[];
}

export const MEDALLION_LAYERS = ['bronze', 'silver', 'gold'] as const;
export const DBT_LAYERS = ['staging', 'intermediate', 'marts'] as const;
/** A mart with at least this many columns counts as a wide (One Big Table) model. */
export const WIDE_TABLE_COLUMNS = 60;
/** …but only in a project with at most this many mart models — OBT means few, wide tables. */
export const WIDE_TABLE_MAX_MARTS = 10;

const DBT_LAYER_ALIASES: Record<string, (typeof DBT_LAYERS)[number]> = {
  staging: 'staging', stg: 'staging',
  intermediate: 'intermediate', int: 'intermediate',
  marts: 'marts', mart: 'marts',
};

const DATA_VAULT_PACKAGES = /automate[_-]?dv|dbtvault|datavault4dbt/i;
const ACTIVITY_PACKAGES = /activity[_-]?schema|narrator/i;

/** Lowercase tokens of a schema name: `analytics_silver` → ['analytics','silver']. */
function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function examples(names: readonly string[]): string {
  const shown = [...names].sort().slice(0, 3);
  return shown.join(', ') + (names.length > shown.length ? ', …' : '');
}

function countPhrase(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}

/** The medallion layer a model sits in by folder (any segment), else by schema token; null when none. */
export function medallionLayerOf(folder: readonly string[], schema: string): string | null {
  for (const seg of folder) {
    const s = seg.toLowerCase();
    if ((MEDALLION_LAYERS as readonly string[]).includes(s)) { return s; }
  }
  for (const t of tokens(schema)) {
    if ((MEDALLION_LAYERS as readonly string[]).includes(t)) { return t; }
  }
  return null;
}

function detectLayering(models: readonly ConventionModel[]): ProjectConventions['layering'] {
  const medFolders = new Set<string>();
  const medSchemas = new Set<string>();
  let medModels = 0;
  const dbtFolders = new Set<string>();
  const dbtSchemas = new Set<string>();
  const dbtPrefixes = new Set<string>();
  let dbtModels = 0;

  for (const m of models) {
    if (m.kind === 'seed') { continue; }
    let med = false;
    let dbt = false;
    for (const seg of m.folder) {
      const s = seg.toLowerCase();
      if ((MEDALLION_LAYERS as readonly string[]).includes(s)) { medFolders.add(s); med = true; }
      const d = DBT_LAYER_ALIASES[s];
      if (d) { dbtFolders.add(d); dbt = true; }
    }
    for (const t of tokens(m.schema)) {
      if ((MEDALLION_LAYERS as readonly string[]).includes(t)) { medSchemas.add(t); med = true; }
      const d = DBT_LAYER_ALIASES[t];
      if (d) { dbtSchemas.add(d); dbt = true; }
    }
    const name = m.name.toLowerCase();
    if (name.startsWith('stg_')) { dbtPrefixes.add('staging'); dbt = true; }
    if (name.startsWith('int_')) { dbtPrefixes.add('intermediate'); dbt = true; }
    if (med) { medModels++; }
    if (dbt) { dbtModels++; }
  }

  const ordered = (order: readonly string[], ...sets: Set<string>[]): string[] =>
    order.filter((l) => sets.some((s) => s.has(l)));
  const medLayers = ordered(MEDALLION_LAYERS, medFolders, medSchemas);
  const dbtLayers = ordered(DBT_LAYERS, dbtFolders, dbtSchemas, dbtPrefixes);

  const medEvidence: string[] = [];
  if (medFolders.size) { medEvidence.push(`folders ${ordered(MEDALLION_LAYERS, medFolders).join(', ')}`); }
  if (medSchemas.size) { medEvidence.push(`schemas ${ordered(MEDALLION_LAYERS, medSchemas).join(', ')}`); }
  const dbtEvidence: string[] = [];
  if (dbtFolders.size) { dbtEvidence.push(`folders ${ordered(DBT_LAYERS, dbtFolders).join(', ')}`); }
  if (dbtSchemas.size) { dbtEvidence.push(`schemas ${ordered(DBT_LAYERS, dbtSchemas).join(', ')}`); }
  if (dbtPrefixes.size) {
    dbtEvidence.push(`name prefixes ${[dbtPrefixes.has('staging') ? 'stg_' : '', dbtPrefixes.has('intermediate') ? 'int_' : ''].filter(Boolean).join(', ')}`);
  }

  // A layout needs at least two of its layers: one folder called `gold` alone is not a medallion.
  const medOk = medLayers.length >= 2;
  const dbtOk = dbtLayers.length >= 2;
  if (!medOk && !dbtOk) { return { style: 'none', evidence: [], layers: [] }; }
  const pickMed = medOk && (!dbtOk || medModels >= dbtModels);
  if (pickMed) {
    const evidence = [...medEvidence];
    if (dbtOk) { evidence.push(`also dbt layering (${dbtLayers.join(', ')}) inside it`); }
    return { style: 'medallion', evidence, layers: medLayers };
  }
  const evidence = [...dbtEvidence];
  if (medOk) { evidence.push(`also medallion names (${medLayers.join(', ')})`); }
  return { style: 'dbt-layered', evidence, layers: dbtLayers };
}

type ShapeName = Exclude<ShapeStyle, 'none'>;

const SOURCE_ORDER: readonly ShapeSource[] = ['names', 'descriptions', 'structure', 'snapshots', 'packages'];

interface ShapeSignal { source: ShapeSource; text: string }

interface ShapeCandidate {
  style: ShapeName;
  signals: ShapeSignal[];
  /** Supporting evidence that never counts as a signal on its own (e.g. grain wording). */
  notes: string[];
  /** Tie-breaker: the models that back it. */
  models: Set<string>;
}

function candidate(style: ShapeName): ShapeCandidate {
  return { style, signals: [], notes: [], models: new Set() };
}

function familiesOf(c: ShapeCandidate): ShapeSource[] {
  return SOURCE_ORDER.filter((s) => c.signals.some((sig) => sig.source === s));
}

/** `dim_` when every name uses it, else the prefixes actually seen, e.g. `dim_/dimension_`. */
function prefixLabel(names: readonly string[], prefixes: readonly string[]): string {
  return prefixes.filter((p) => names.some((n) => n.toLowerCase().startsWith(p))).join('/');
}

function withPrefix(models: readonly ConventionModel[], prefixes: readonly string[]): string[] {
  return models
    .filter((m) => m.kind !== 'seed' && prefixes.some((p) => m.name.toLowerCase().startsWith(p)))
    .map((m) => m.name);
}

/**
 * Staging, intermediate, base, raw and bronze models — the layers where facts
 * and dimensions do not live. They are left out of the grain wording and the
 * structural judgement; an explicit "dimension"/"fact" in their descriptions
 * still counts.
 */
export function isStagingLike(m: ConventionModel): boolean {
  const n = m.name.toLowerCase();
  if (n.startsWith('stg_') || n.startsWith('int_') || n.startsWith('base_')) { return true; }
  return m.folder.some((s) => ['staging', 'intermediate', 'bronze', 'base', 'raw'].includes(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Description signals
// ---------------------------------------------------------------------------

export interface DescriptionTerm {
  style: ShapeName;
  /** One hit per model per group: the first (most specific) term of a group wins. */
  group: string;
  /** What the evidence quotes. */
  label: string;
  re: RegExp;
  /** Also read in column descriptions (only the unambiguous terms are). */
  columns: boolean;
  /** Counts only when a non-supporting term of the same style was found somewhere in the project. */
  supporting?: boolean;
  /** A supporting term that also counts when the table shape (structure) already shows its style. */
  backedByStructure?: boolean;
}

/** Ordered: within a group, the more specific term comes first. All matched on word boundaries. */
export const DESCRIPTION_TERMS: readonly DescriptionTerm[] = [
  { style: 'kimball', group: 'dimension', label: 'dimension table', re: /\b(?:dimension|dim)[ _-]?tables?\b/i, columns: true },
  { style: 'kimball', group: 'dimension', label: 'dimensional', re: /\bdimensional(?:ly)?\b/i, columns: false },
  { style: 'kimball', group: 'dimension', label: 'dimension', re: /\bdimensions?\b/i, columns: false },
  { style: 'kimball', group: 'fact', label: 'fact table', re: /\bfacts?[ _-]?tables?\b/i, columns: true },
  { style: 'kimball', group: 'fact', label: 'fact', re: /(?<!\b(?:in|the)\s)\bfacts?\b(?!\s+(?:that|about)\b)/i, columns: false },
  { style: 'kimball', group: 'scd', label: 'slowly changing', re: /\bslowly[ -]changing\b/i, columns: true },
  { style: 'kimball', group: 'scd', label: 'SCD', re: /\bscd(?:[ -]?(?:type)?[ -]?\d)?\b/i, columns: true },
  { style: 'kimball', group: 'star', label: 'star schema', re: /\bstar[ -]schema\b/i, columns: true },
  { style: 'kimball', group: 'conformed', label: 'conformed', re: /\bconformed\b/i, columns: true },
  // dbt_utils.generate_surrogate_key is everywhere: a surrogate key alone says little.
  { style: 'kimball', group: 'surrogate', label: 'surrogate key', re: /\bsurrogate[ _-]?keys?\b/i, columns: true, supporting: true },

  { style: 'data-vault', group: 'vault', label: 'data vault', re: /\bdata[ -]?vault\b/i, columns: true },
  { style: 'data-vault', group: 'vault', label: 'raw vault', re: /\b(?:raw|business)[ -]vault\b/i, columns: true },
  { style: 'data-vault', group: 'hub', label: 'hub', re: /\bhubs?[ _-]?(?:tables?|models?|entit(?:y|ies))\b/i, columns: false },
  { style: 'data-vault', group: 'link', label: 'link table', re: /\blinks?[ _-]?(?:tables?|models?)\b/i, columns: false },
  { style: 'data-vault', group: 'satellite', label: 'satellite', re: /\bsatellites?\b/i, columns: true },
  { style: 'data-vault', group: 'hash', label: 'hash key', re: /\bhash[ _-]?keys?\b/i, columns: true },
  { style: 'data-vault', group: 'hash', label: 'hashdiff', re: /\bhash[ _-]?diffs?\b/i, columns: true },
  { style: 'data-vault', group: 'pit', label: 'point-in-time', re: /\bpoint-in-time\b|\bpit[ _-]tables?\b/i, columns: true },
  // "business key" is plain English in any project: it only supports other vault wording.
  { style: 'data-vault', group: 'bk', label: 'business key', re: /\bbusiness[ _-]keys?\b/i, columns: true, supporting: true },

  { style: 'one-big-table', group: 'obt', label: 'one big table', re: /\bone[ -]big[ -]table\b|\bobt\b/i, columns: false },
  { style: 'one-big-table', group: 'wide', label: 'wide table', re: /\bwide[ _-]?tables?\b/i, columns: false },
  // Kimball dimensions are denormalised too: this only supports other OBT wording.
  { style: 'one-big-table', group: 'denorm', label: 'denormalized', re: /\bde-?normali[sz]ed\b/i, columns: false, supporting: true },

  { style: 'activity-schema', group: 'activity', label: 'activity schema', re: /\bactivity[ _-](?:schema|stream)s?\b/i, columns: true },

  { style: 'inmon-3nf', group: '3nf', label: '3NF', re: /\b3nf\b/i, columns: false },
  { style: 'inmon-3nf', group: '3nf', label: 'third normal form', re: /\bthird[ -]normal[ -]form\b/i, columns: false },
  { style: 'inmon-3nf', group: 'inmon', label: 'Inmon', re: /\binmon\b/i, columns: false },
  { style: 'inmon-3nf', group: 'cif', label: 'corporate information factory', re: /\bcorporate[ -]information[ -]factory\b/i, columns: false },
  { style: 'inmon-3nf', group: 'edw', label: 'enterprise data warehouse', re: /\benterprise[ -]data[ -]warehouse\b/i, columns: false },
  { style: 'inmon-3nf', group: 'edw', label: 'EDW', re: /\bEDW\b/, columns: false },
  // "normalised phone numbers" is plain English: it counts only beside other 3NF wording or a 3NF table shape.
  { style: 'inmon-3nf', group: 'normalised', label: 'normalised', re: /\bnormali[sz]ed\b/i, columns: false, supporting: true, backedByStructure: true },
];

/**
 * A negation shortly before a term: "no surrogate key is needed", "not a fact
 * table", "without a hash key", "isn't a dimension". Tested against the text
 * BEFORE a match — the negator, then at most two words, then the gap — and
 * never across sentence punctuation, so "Not staging. The customer dimension."
 * still counts.
 */
const NEGATED_BEFORE = /(?:\b(?:no|not|without|never|isn['’]t|aren['’]t)|n['’]t)\b(?:[^\w.!?;:]+\w+){0,2}[^\w.!?;:]+$/i;

const globalCopies = new WeakMap<RegExp, RegExp>();

/**
 * True when `re` matches `text` somewhere that is not negated. Every
 * description-term test goes through here, so one rule covers all styles.
 */
export function mentions(re: RegExp, text: string): boolean {
  if (!text) { return false; }
  let g = globalCopies.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    globalCopies.set(re, g);
  }
  g.lastIndex = 0;
  for (let m = g.exec(text); m; m = g.exec(text)) {
    if (!NEGATED_BEFORE.test(text.slice(0, m.index))) { return true; }
    if (m[0].length === 0) { g.lastIndex++; }
  }
  return false;
}

/** "one row per order" — grain wording. Standard dbt docs say it everywhere, so it is supporting evidence only. */
const GRAIN_RE = /\b(?:one|1|a single|single)\s+(?:row|record)s?\s+(?:per|for each|for every)\s+([a-z0-9_]+(?:[ _-][a-z0-9_]+){0,3})/i;
const GRAIN_STOP = /\s+(?:with|in|that|which|where|including|from|as|to|for|of|is|are)\b.*$/i;

export function grainOf(text: string): string | null {
  const m = GRAIN_RE.exec(text);
  if (!m) { return null; }
  const head = m[0].slice(0, m[0].length - m[1].length).replace(/\s+/g, ' ').toLowerCase();
  return `${head}${m[1].replace(GRAIN_STOP, '')}`.trim();
}

function quoteList(names: readonly string[], verb: [string, string], label: string): string {
  return `descriptions: ${examples(names)} ${names.length === 1 ? verb[0] : verb[1]} "${label}"`;
}

function addDescriptionSignals(byStyle: Map<ShapeName, ShapeCandidate>, models: readonly ConventionModel[], structural: ReadonlySet<ShapeName>): void {
  const hits = new Map<DescriptionTerm, { model: Set<string>; column: Set<string> }>();
  for (const m of models) {
    const own = m.description ?? '';
    const cols = (m.columns ?? []).map((c) => c.description ?? '').filter(Boolean);
    const seenGroups = new Set<string>();
    for (const term of DESCRIPTION_TERMS) {
      const key = `${term.style}/${term.group}`;
      if (seenGroups.has(key)) { continue; }
      const inModel = mentions(term.re, own);
      const inColumns = !inModel && term.columns && cols.some((d) => mentions(term.re, d));
      if (!inModel && !inColumns) { continue; }
      seenGroups.add(key);
      const entry = hits.get(term) ?? { model: new Set<string>(), column: new Set<string>() };
      (inModel ? entry.model : entry.column).add(m.name);
      hits.set(term, entry);
    }
  }
  const primary = new Set([...hits.keys()].filter((t) => !t.supporting).map((t) => t.style));
  for (const term of DESCRIPTION_TERMS) {
    const entry = hits.get(term);
    if (!entry || !(primary.has(term.style) || (term.backedByStructure && structural.has(term.style)))) { continue; }
    const c = byStyle.get(term.style)!;
    if (entry.model.size) {
      c.signals.push({ source: 'descriptions', text: quoteList([...entry.model], ['says', 'say'], term.label) });
    }
    if (entry.column.size) {
      c.signals.push({ source: 'descriptions', text: quoteList([...entry.column], ['has columns described as', 'have columns described as'], term.label) });
    }
    for (const n of [...entry.model, ...entry.column]) { c.models.add(n); }
  }
}

// ---------------------------------------------------------------------------
// Structural signals (a Kimball star)
// ---------------------------------------------------------------------------

const NUMERIC_TYPE = /^(?:(?:tiny|small|medium|big|huge)?int(?:eger)?\d*|u?int\d+|number|numeric|decimal|dec|bignumeric|bigdecimal|float\d*|double|real|money|smallmoney)\b/i;
const MEASURE_NAME = /(?:^|_)(?:amount|amt|total|subtotal|qty|quantity|price|cost|revenue|tax|count|cnt|sum|value|weight|duration|spend|margin|profit|discount|fee|balance)s?(?:$|_)/i;
const KEY_NAME = /(?:^|_)(?:id|key|sk|pk|fk|uuid|guid|code|number|num|no|hash)$/i;

/** Numeric by type; with no type known, by a measure-like name. */
function isNumericColumn(c: { name: string; dataType?: string }): boolean {
  const t = (c.dataType ?? '').trim();
  return t ? NUMERIC_TYPE.test(t) : MEASURE_NAME.test(c.name);
}

export interface StarShape {
  facts: string[];
  dimensions: string[];
}

/**
 * Facts and dimensions judged from shape alone, over models outside the
 * staging-like layers (`isStagingLike`). A **fact** has a relationship out to
 * another model and at least one measure — a non-key numeric column, or with
 * no type known an amount/total/qty/price/cost/… name. A **dimension** is not
 * a fact, is the target of a relationship or has a unique key, and at most
 * half of its non-key attributes are numeric.
 */
export function detectStarShape(models: readonly ConventionModel[], relationships: readonly ConventionRelationship[]): StarShape {
  const facts: string[] = [];
  const dimensions: string[] = [];
  const lc = (s: string): string => s.toLowerCase();
  for (const m of models) {
    if (m.kind !== 'model' || isStagingLike(m) || !m.columns?.length) { continue; }
    const name = lc(m.name);
    const out = relationships.filter((r) => lc(r.fromModel) === name && lc(r.toModel) !== name);
    const targeted = relationships.some((r) => lc(r.toModel) === name && lc(r.fromModel) !== name);
    const keyCols = new Set([...out.map((r) => lc(r.fromColumn)), ...(m.uniqueKeys ?? []).map(lc)]);
    const attributes = m.columns.filter((c) => !keyCols.has(lc(c.name)) && !KEY_NAME.test(c.name) && lc(c.name) !== 'id');
    const measures = attributes.filter(isNumericColumn);
    if (out.length > 0 && measures.length > 0) { facts.push(m.name); continue; }
    const keyed = targeted || (m.uniqueKeys?.length ?? 0) > 0;
    if (keyed && attributes.length > 0 && measures.length / attributes.length <= 0.5) { dimensions.push(m.name); }
  }
  return { facts: facts.sort(), dimensions: dimensions.sort() };
}

// ---------------------------------------------------------------------------
// Structural signals (Data Vault, Activity Schema, Inmon / 3NF)
// ---------------------------------------------------------------------------

type ColumnInfo = { name: string; dataType?: string; description?: string };

/** `customer_hk`, `customer_hash_key`, `customer_hkey`, `hk_customer`, `customer_hk_v2`. */
const HASH_KEY_NAME = /(?:^|_)(?:hk|hkey|hash_?key)$|^hk_|_hk_/i;
/** `hashdiff`, `hash_diff`, `customer_hashdiff`, `hd_customer`. */
const HASHDIFF_NAME = /(?:^|_)hash_?diff(?:$|_)|^hd_/i;
/** An md5/sha digest's type: binary, or a 32/40/64-character string. */
const HASH_TYPE = /^(?:var)?binary\b|^bytes\b|^n?(?:var)?char\s*\(\s*(?:32|40|64)\s*\)|^string\s*\(\s*(?:32|40|64)\s*\)|\b(?:md5|sha\d*)\b/i;
/** Names that can hold a hash when the type says so (automate_dv's `customer_pk`); not `_id`. */
const HASH_TYPED_NAME = /(?:^|_)(?:pk|hk|key|hash)$/i;
const LOAD_DATE_NAME = /(?:^|_)(?:load_?(?:date(?:_?time)?|dts|ts|timestamp)|ldts|loaded_at)$/i;
const RECORD_SOURCE_NAME = /(?:^|_)(?:record_?source|rsrc|rec_?src|record_?src)$/i;
/** Other vault bookkeeping columns — neither keys nor descriptive attributes. */
const VAULT_METADATA_NAME = /^(?:effective_(?:from|to)|applied_(?:date|ts)|load_end_(?:date|ts)|end_date|is_current|dv_\w+)$/i;
/** Most non-metadata columns a hub carries (hash key + business key + a few). */
export const HUB_MAX_COLUMNS = 6;
/** Most non-key, non-metadata columns a link carries. */
const LINK_MAX_OTHER_COLUMNS = 4;

const HASHDIFF_WORDS = /\bhash[ _-]?diffs?\b/i;
const HASH_KEY_WORDS = /\bhash[ _-]?keys?\b/i;
const BUSINESS_KEY_WORDS = /\bbusiness[ _-]?keys?\b/i;

function isHashKey(c: ColumnInfo): boolean {
  if (HASHDIFF_NAME.test(c.name)) { return false; }
  if (HASH_KEY_NAME.test(c.name)) { return true; }
  if (mentions(HASH_KEY_WORDS, c.description ?? '')) { return true; }
  return HASH_TYPE.test((c.dataType ?? '').trim()) && HASH_TYPED_NAME.test(c.name);
}

function isVaultMetadata(c: ColumnInfo): boolean {
  return HASHDIFF_NAME.test(c.name) || LOAD_DATE_NAME.test(c.name) || RECORD_SOURCE_NAME.test(c.name) || VAULT_METADATA_NAME.test(c.name);
}

export type VaultKind = 'hub' | 'link' | 'satellite';

/**
 * How a model sits in a Data Vault, judged from its columns alone: `null`
 * unless it has a hash key **and** load metadata (a load date and a record
 * source). With those, a **satellite** has a hashdiff and descriptive
 * attributes; a **link** has two or more hash keys and few other columns; a
 * **hub** has one hash key, a business key and at most `HUB_MAX_COLUMNS`
 * non-metadata columns; anything else is `'vault'` — vault-shaped but none of
 * the three.
 */
export function vaultKindOf(m: ConventionModel): VaultKind | 'vault' | null {
  const cols = m.columns ?? [];
  if (!cols.some((c) => LOAD_DATE_NAME.test(c.name)) || !cols.some((c) => RECORD_SOURCE_NAME.test(c.name))) { return null; }
  const hashKeys = cols.filter(isHashKey);
  if (!hashKeys.length) { return null; }
  const hashdiff = cols.some((c) => HASHDIFF_NAME.test(c.name) || mentions(HASHDIFF_WORDS, c.description ?? ''));
  const others = cols.filter((c) => !isHashKey(c) && !isVaultMetadata(c) && !mentions(HASHDIFF_WORDS, c.description ?? ''));
  if (hashdiff) { return others.length ? 'satellite' : 'vault'; }
  if (hashKeys.length >= 2) { return others.length <= LINK_MAX_OTHER_COLUMNS ? 'link' : 'vault'; }
  const unique = new Set((m.uniqueKeys ?? []).map((k) => k.toLowerCase()));
  const businessKey = others.some((c) => KEY_NAME.test(c.name) || c.name.toLowerCase() === 'id'
    || unique.has(c.name.toLowerCase()) || mentions(BUSINESS_KEY_WORDS, c.description ?? ''));
  // With one or two plain columns beside the hash key, one of them is the business key.
  const hub = others.length > 0 && (businessKey || others.length <= 2) && others.length + hashKeys.length <= HUB_MAX_COLUMNS;
  return hub ? 'hub' : 'vault';
}

export interface VaultShape {
  hubs: string[];
  links: string[];
  satellites: string[];
  /** Every model with a hash key and load metadata (the three kinds and the rest). */
  vaultShaped: string[];
}

/** Hubs, links and satellites among the models outside the staging-like layers. */
export function detectVaultShape(models: readonly ConventionModel[]): VaultShape {
  const out: VaultShape = { hubs: [], links: [], satellites: [], vaultShaped: [] };
  for (const m of models) {
    if (m.kind !== 'model' || isStagingLike(m) || !m.columns?.length) { continue; }
    const kind = vaultKindOf(m);
    if (!kind) { continue; }
    out.vaultShaped.push(m.name);
    if (kind === 'hub') { out.hubs.push(m.name); }
    if (kind === 'link') { out.links.push(m.name); }
    if (kind === 'satellite') { out.satellites.push(m.name); }
  }
  for (const list of [out.hubs, out.links, out.satellites, out.vaultShaped]) { list.sort(); }
  return out;
}

const ACTIVITY_COLUMN = /^activity(?:_name)?$/i;
const ENTITY_COLUMN = /^(?:customer|customer_id|entity|entity_id|anonymous_customer_id)$/i;
const ACTIVITY_TS_COLUMN = /^(?:ts|timestamp|activity_ts|activity_timestamp)$/i;
/** An activity stream is narrow: at most this many columns. */
export const ACTIVITY_STREAM_MAX_COLUMNS = 12;

/**
 * Activity streams: narrow models (at most `ACTIVITY_STREAM_MAX_COLUMNS`
 * columns, outside the staging-like layers) with an activity column, an
 * entity id and a timestamp — `feature_json`, `revenue_impact`, `link` and
 * the like may sit beside them.
 */
export function detectActivityStreams(models: readonly ConventionModel[]): string[] {
  return models
    .filter((m) => m.kind === 'model' && !isStagingLike(m) && !!m.columns?.length
      && m.columns.length <= ACTIVITY_STREAM_MAX_COLUMNS
      && m.columns.some((c) => ACTIVITY_COLUMN.test(c.name))
      && m.columns.some((c) => ENTITY_COLUMN.test(c.name))
      && m.columns.some((c) => ACTIVITY_TS_COLUMN.test(c.name)))
    .map((m) => m.name)
    .sort();
}

/** A normalised (3NF-style) project needs at least this many models outside staging… */
export const NORMALISED_MIN_MODELS = 6;
/** …most of them joined to another by a relationship test… */
const NORMALISED_MIN_JOINED_SHARE = 0.6;
/** …at most this share of them carrying an amount-like column… */
const NORMALISED_MAX_MEASURE_SHARE = 0.2;
/** …and an association table: two keys out and at most this many other columns. */
const ASSOCIATION_MAX_OTHER_COLUMNS = 3;

export interface NormalisedShape {
  /** Models outside staging joined to another one by a relationship test. */
  joined: string[];
  /** All models outside staging with columns. */
  total: number;
  /** Models with an amount-like column. */
  withMeasures: string[];
  /** Association (bridge) tables: keys out to two tables, little else. */
  associations: string[];
}

/**
 * The 3NF (Inmon-style) table shape, or null: at least
 * `NORMALISED_MIN_MODELS` models outside staging, most of them joined by
 * relationship tests, few with an amount-like column (by name — amount,
 * total, qty, price, … — and not text-typed), and at least one association table. Callers use it
 * only when no star or vault shape and no `dim_`/`fct_`/vault names were
 * found — on its own it is a guess, never a finding.
 */
export function detectNormalisedShape(models: readonly ConventionModel[], relationships: readonly ConventionRelationship[]): NormalisedShape | null {
  const lc = (s: string): string => s.toLowerCase();
  const core = models.filter((m) => m.kind === 'model' && !isStagingLike(m) && !!m.columns?.length);
  if (core.length < NORMALISED_MIN_MODELS) { return null; }
  const names = new Set(core.map((m) => lc(m.name)));
  const rels = relationships.filter((r) => names.has(lc(r.fromModel)) && names.has(lc(r.toModel)) && lc(r.fromModel) !== lc(r.toModel));
  const joined: string[] = [];
  const withMeasures: string[] = [];
  const associations: string[] = [];
  for (const m of core) {
    const name = lc(m.name);
    const columns = m.columns ?? [];
    const out = rels.filter((r) => lc(r.fromModel) === name);
    if (out.length || rels.some((r) => lc(r.toModel) === name)) { joined.push(m.name); }
    const keyCols = new Set([...out.map((r) => lc(r.fromColumn)), ...(m.uniqueKeys ?? []).map(lc)]);
    const plain = columns.filter((c) => !keyCols.has(lc(c.name)) && !KEY_NAME.test(c.name) && lc(c.name) !== 'id');
    // An amount by name, unless its known type says it is text (`setting_value varchar`).
    if (plain.some((c) => MEASURE_NAME.test(c.name) && (!c.dataType?.trim() || NUMERIC_TYPE.test(c.dataType.trim())))) { withMeasures.push(m.name); }
    const targets = new Set(out.map((r) => lc(r.toModel)));
    const fkCols = new Set(out.map((r) => lc(r.fromColumn)));
    const others = columns.filter((c) => !fkCols.has(lc(c.name)));
    if (targets.size >= 2 && others.length <= ASSOCIATION_MAX_OTHER_COLUMNS) { associations.push(m.name); }
  }
  if (joined.length / core.length < NORMALISED_MIN_JOINED_SHARE) { return null; }
  if (withMeasures.length / core.length > NORMALISED_MAX_MEASURE_SHARE) { return null; }
  if (!associations.length) { return null; }
  return { joined: joined.sort(), total: core.length, withMeasures: withMeasures.sort(), associations: associations.sort() };
}

function detectShape(input: ConventionInput, snapshots: readonly string[]): ProjectConventions['shape'] {
  const { models, packages } = input;
  const byStyle = new Map<ShapeName, ShapeCandidate>(
    (['kimball', 'data-vault', 'one-big-table', 'activity-schema', 'inmon-3nf'] as const).map((s) => [s, candidate(s)]),
  );
  const kimball = byStyle.get('kimball')!;
  const vault = byStyle.get('data-vault')!;
  const obt = byStyle.get('one-big-table')!;
  const act = byStyle.get('activity-schema')!;
  const inmon = byStyle.get('inmon-3nf')!;
  const pkg = (re: RegExp): string | undefined => packages.find((p) => re.test(p));
  const named = (c: ShapeCandidate, prefixes: string[]): void => {
    const names = withPrefix(models, prefixes);
    if (!names.length) { return; }
    c.signals.push({ source: 'names', text: `${countPhrase(names.length, 'model')} named ${prefixLabel(names, prefixes)} (${examples(names)})` });
    for (const n of names) { c.models.add(n); }
  };

  // Packages decide a style on their own.
  const vaultPkg = pkg(DATA_VAULT_PACKAGES);
  if (vaultPkg) { vault.signals.push({ source: 'packages', text: `package ${vaultPkg}` }); }
  const actPkg = pkg(ACTIVITY_PACKAGES);
  if (actPkg) { act.signals.push({ source: 'packages', text: `package ${actPkg}` }); }

  // Names.
  named(kimball, ['dim_', 'dimension_']);
  named(kimball, ['fct_', 'fact_']);
  named(vault, ['hub_']);
  named(vault, ['lnk_', 'link_']);
  named(vault, ['sat_']);
  named(vault, ['pit_', 'bridge_']);
  named(obt, ['obt_', 'wide_']);
  named(act, ['activity_']);
  const streams = models.filter((m) => m.kind !== 'seed' && /(^|_)stream$/i.test(m.name)).map((m) => m.name);
  if (streams.length) {
    act.signals.push({ source: 'names', text: `${countPhrase(streams.length, 'stream model')} (${examples(streams)})` });
    for (const n of streams) { act.models.add(n); }
  }

  // Structure — judged first (a 3NF shape lets "normalised" wording count), recorded after the descriptions.
  const relationships = input.relationships ?? [];
  const structural: Array<{ c: ShapeCandidate; text: string; models: readonly string[] }> = [];
  const shaped = (c: ShapeCandidate, text: string, names: readonly string[]): void => { structural.push({ c, text, models: names }); };
  const looks = (names: readonly string[], one: string, many: string): string => `${examples(names)} ${names.length === 1 ? `looks like ${one}` : `look like ${many}`}`;

  // Data Vault — hubs, links and satellites by their columns (hash keys + load metadata). Two of the three kinds make a vault.
  const dv = detectVaultShape(models);
  const dvKinds = [dv.hubs, dv.links, dv.satellites].filter((l) => l.length).length;
  if (dvKinds >= 2) {
    if (dv.hubs.length) { shaped(vault, `shape: ${looks(dv.hubs, 'a hub', 'hubs')} (hash key + business key + load date/record source)`, dv.hubs); }
    if (dv.links.length) { shaped(vault, `shape: ${looks(dv.links, 'a link', 'links')} (two or more hash keys + load metadata)`, dv.links); }
    if (dv.satellites.length) { shaped(vault, `shape: ${looks(dv.satellites, 'a satellite', 'satellites')} (hashdiff + load metadata)`, dv.satellites); }
  }
  // Activity Schema — narrow activity + entity + timestamp tables.
  const streamShapes = detectActivityStreams(models);
  if (streamShapes.length) {
    shaped(act, `shape: ${looks(streamShapes, 'an activity stream', 'activity streams')} (activity + entity + timestamp)`, streamShapes);
  }
  // Kimball — a star (facts with keys out and amounts, plus dimensions). Vault-shaped tables and activity
  // streams are not judged: a hub is not a dimension, and a link or satellite is not a fact.
  // Tables *named* like a vault (hub_/link_/sat_/pit_) are excluded too: without a catalog the yml
  // often lists only their keys, so the column check above can miss them, and then a satellite with
  // an amount would read as a Kimball fact and compete with the Data Vault its name already declares.
  const vaultNamed = models.filter((m) => /^(?:hub|lnk|link|sat|pit)_/i.test(m.name)).map((m) => m.name);
  const notStar = new Set([...dv.vaultShaped, ...vaultNamed, ...streamShapes]);
  const star = detectStarShape(models.filter((m) => !notStar.has(m.name)), relationships);
  const isStar = star.facts.length > 0 && star.dimensions.length > 0;
  if (isStar) {
    shaped(kimball, `shape: ${looks(star.facts, 'a fact', 'facts')} (keys to other tables + amounts to add up)`, star.facts);
    shaped(kimball, `shape: ${looks(star.dimensions, 'a dimension', 'dimensions')} (keyed, mostly descriptive details)`, star.dimensions);
  }
  // One Big Table — a few very wide marts.
  const marts = models.filter((m) => m.kind === 'model' && !isStagingLike(m));
  const wide = marts.filter((m) => m.columnCount >= WIDE_TABLE_COLUMNS).map((m) => m.name);
  if (wide.length && marts.length <= WIDE_TABLE_MAX_MARTS) {
    shaped(obt, `${countPhrase(wide.length, 'wide model')} with ${WIDE_TABLE_COLUMNS}+ columns among ${countPhrase(marts.length, 'mart')} (${examples(wide)})`, wide);
  }
  // Inmon / 3NF — only a guess, and only when nothing names or shapes the tables as Kimball or Data Vault.
  const namedOrPackaged = (c: ShapeCandidate): boolean => c.signals.some((s) => s.source === 'names' || s.source === 'packages');
  if (!isStar && dvKinds < 2 && !namedOrPackaged(kimball) && !namedOrPackaged(vault)) {
    const nf = detectNormalisedShape(models, relationships);
    if (nf) {
      const amounts = nf.withMeasures.length ? 'almost no amounts' : 'no amounts';
      shaped(inmon, `shape: ${nf.joined.length} of ${nf.total} models are joined by keys with ${amounts} to add up — normalised (3NF-style)`, nf.joined);
      shaped(inmon, `shape: ${looks(nf.associations, 'an association table', 'association tables')} (keys to two tables, little else)`, nf.associations);
    }
  }

  // Descriptions.
  addDescriptionSignals(byStyle, models, new Set(structural.map((s) => s.c.style)));
  for (const s of structural) {
    s.c.signals.push({ source: 'structure', text: s.text });
    for (const n of s.models) { s.c.models.add(n); }
  }

  // Snapshots support Kimball (SCD Type 2) only alongside an explicit statement — names or descriptions.
  if (snapshots.length && kimball.signals.some((s) => s.source === 'names' || s.source === 'descriptions')) {
    kimball.signals.push({ source: 'snapshots', text: `${countPhrase(snapshots.length, 'dbt snapshot')} keeping history (SCD Type 2): ${examples(snapshots)}` });
  }

  // Grain wording backs up Kimball evidence that is already there, facts first — never a signal on its own.
  if (kimball.signals.length) {
    const factSet = new Set(star.facts);
    const grains = marts
      .map((m) => ({ name: m.name, grain: m.description ? grainOf(m.description) : null }))
      .filter((g): g is { name: string; grain: string } => !!g.grain)
      .sort((a, b) => Number(factSet.has(b.name)) - Number(factSet.has(a.name)) || a.name.localeCompare(b.name))
      .map((g) => `${g.name} is "${g.grain}"`);
    if (grains.length) {
      kimball.notes.push(`descriptions: ${grains.slice(0, 3).join(', ')}${grains.length > 3 ? ', …' : ''}`);
    }
  }

  const hasPackage = (c: ShapeCandidate): boolean => c.signals.some((s) => s.source === 'packages');
  const found = [...byStyle.values()]
    .filter((c) => c.signals.length > 0)
    .sort((a, b) => Number(hasPackage(b)) - Number(hasPackage(a))
      || familiesOf(b).length - familiesOf(a).length
      || b.signals.length - a.signals.length
      || b.models.size - a.models.size);
  if (found.length === 0) {
    return { style: 'none', confidence: 'weak', evidence: [], alternatives: [], sources: [] };
  }
  const [top, ...others] = found;
  const next = others[0];
  const tied = !!next && hasPackage(next) === hasPackage(top)
    && familiesOf(next).length === familiesOf(top).length
    && next.signals.length === top.signals.length;
  // A package decides it on its own; otherwise two independent families agreeing, and no competing style.
  const strong = !tied && (hasPackage(top) ? !others.some(hasPackage) : familiesOf(top).length >= 2 && others.length === 0);
  const evidence = [...top.signals.map((s) => s.text), ...top.notes];
  for (const o of others) { evidence.push(`also seen — ${o.style}: ${o.signals.map((s) => s.text).join('; ')}`); }
  return {
    style: top.style,
    confidence: strong ? 'strong' : 'weak',
    evidence,
    alternatives: others.map((o) => o.style),
    sources: familiesOf(top),
  };
}

/** Pure: the conventions for a set of models, packages and snapshot names. */
export function detectConventions(input: ConventionInput): ProjectConventions {
  const snapshots = [...new Set([
    ...input.snapshots,
    ...input.models.filter((m) => m.kind === 'snapshot').map((m) => m.name),
  ])].sort();
  return {
    layering: detectLayering(input.models),
    shape: detectShape(input, snapshots),
    history: { snapshots },
  };
}

// ---------------------------------------------------------------------------
// Reading the project files
// ---------------------------------------------------------------------------

function readYaml(file: string): unknown {
  try {
    return parseYaml(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Every package identifier the project declares — the `package:`, `git:`,
 * `name:` and `local:` values in `packages.yml`, `dependencies.yml` and
 * `package-lock.yml`. Missing or broken files contribute nothing.
 */
export function readPackageIdentifiers(root: string): string[] {
  const out = new Set<string>();
  for (const file of ['packages.yml', 'dependencies.yml', 'package-lock.yml']) {
    const doc = readYaml(path.join(root, file));
    const list = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).packages : undefined;
    if (!Array.isArray(list)) { continue; }
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') { continue; }
      for (const key of ['package', 'git', 'name', 'local']) {
        const v = (entry as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) { out.add(v.trim()); }
      }
    }
  }
  return [...out];
}

const SKIP_DIRS = new Set(['node_modules', 'dbt_packages', 'dbt_modules', '.git', 'target', '.venv', 'venv']);

/**
 * Snapshot names declared under the snapshot paths: `{% snapshot name %}`
 * blocks in `.sql` files and `snapshots:` lists in `.yml` (dbt 1.9+).
 */
export function findSnapshotNames(root: string, snapshotPaths: readonly string[]): string[] {
  const names = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 8) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) { visit(full, depth + 1); }
        continue;
      }
      if (/\.sql$/i.test(e.name)) {
        let text = '';
        try { text = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        for (const m of text.matchAll(/\{%-?\s*snapshot\s+([A-Za-z_][\w]*)\s*-?%\}/g)) { names.add(m[1]); }
      } else if (/\.ya?ml$/i.test(e.name)) {
        const doc = readYaml(full);
        const list = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).snapshots : undefined;
        if (!Array.isArray(list)) { continue; }
        for (const s of list) {
          const n = s && typeof s === 'object' ? (s as Record<string, unknown>).name : undefined;
          if (typeof n === 'string' && n.trim()) { names.add(n.trim()); }
        }
      }
    }
  };
  for (const p of snapshotPaths) { visit(path.resolve(root, p), 0); }
  return [...names].sort();
}
