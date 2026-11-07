/**
 * Context fields: the catalogue of built-in fields, the key rules every
 * reader, writer, check and renderer shares, and the resolver that turns a
 * table (or a column) plus the project's field list into the rows a Detail
 * panel draws.
 *
 * **Derive, don't store.** A field's value stays where it always lived (its
 * *home*): a built-in text field in `rationale` (camelCase key), a typed
 * built-in in its own property (`grain`, `modelRole`, `isNaturalKey`,
 * `scdType`, `additiveType`), and every other field — the team's own and
 * the column field `business_rule` — in `meta`. Nothing here keeps a second
 * copy; {@link resolveTableFields} / {@link resolveColumnFields} read the
 * homes.
 *
 * **The field list.** `.erd-studio/fields.yml` (parsed by `fieldsFile.ts`)
 * lists the fields a project records, in display order, as a resolved
 * {@link FieldList}. Without the file a project uses
 * {@link STARTING_FIELD_LIST}.
 *
 * **Spellings in DBML** (the storage reader and writer apply these; nothing
 * else may decide them). A field is one setting `<key>: '<value>'`. Older
 * files spell the same field differently, and every spelling is read:
 *
 * - A rationale-home field `K` is, in this order, `erd_K`, `K`,
 *   `erd_rationale_K`, `rationale_K` ({@link rationaleSpellingNames}). The
 *   value is the FIRST spelling whose value is non-empty text; an edit goes
 *   to that spelling; an empty spelling is skipped.
 * - A meta-home field `k` is, in this order, `erd_k` and `k` (only when
 *   {@link isBareMetaKey}), `erd_meta_k`, `meta_k`, `erd_rationale_k` and
 *   `rationale_k` (only when `k` is not a catalogue rationale field of the
 *   scope), then the `meta_json` entry `k` ({@link metaSpellingNames} lists
 *   the setting names; the `meta_json` entry is the caller's). Here `''` is a
 *   value and stops the search. A key's place in `meta` is the place of its
 *   winning spelling.
 * - A reserved key ({@link isReservedFieldKey}) is never a field key and is
 *   never written bare; a bare reserved setting in a file is not read as a
 *   field (it is kept byte for byte). A meta key that is reserved, or that
 *   is a catalogue key of the same scope whose home is not `meta`
 *   (`meta.purpose`, `meta.role`), keeps `meta` as its home: it is written
 *   `meta_<k>` (or in `meta_json`) and the resolver shows it as its own row,
 *   never merged with the built-in.
 *
 * No `yaml` or `@dbml/parse` import: the main entry, the webview and the
 * renderer load this module.
 */

import { readMeta, setMetaEntry } from './meta.js';
import type { ColumnDef, Meta, MetaValue, Rationale, SemanticTable, TableRole } from './types/semantic.js';
import type { DisplayColumn, DisplayTable } from './types/display.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a field is edited: a text box, a one-line box, a dropdown, a yes / no dropdown. */
export type FieldType = 'text' | 'value' | 'choice' | 'yes-no';
/** Who fills a field in: people or the AI (`anyone`), people only, or copied from dbt's `meta:`. */
export type FieldFilledBy = 'anyone' | 'people' | 'dbt';
/** Which tables a field suits, read from the table's role. */
export type FieldShowFor = 'dimensions' | 'facts' | 'all';
/** Whether a field is recorded on tables or on columns. */
export type FieldScope = 'table' | 'column';
/**
 * Where a field comes from: a built-in that is on without a fields.yml
 * (`starting`), a built-in a project turns on (`optional`), a built-in that
 * is still read and shown but never offered (`retired`), or the team's own.
 */
export type FieldStatus = 'starting' | 'optional' | 'retired' | 'team';

/** Where a field's value lives on a table or a column. */
export type FieldHome =
  | { kind: 'rationale'; key: keyof Rationale }
  | { kind: 'meta' }
  | { kind: 'grain' }
  | { kind: 'role' }
  | { kind: 'naturalKey' }
  | { kind: 'scdType' }
  | { kind: 'additiveType' };

/** One field, fully resolved: everything a renderer or an assistant needs to show and fill it. */
export interface FieldDefinition {
  /** The setting's name in a table file (`open_questions`), and in `meta` for a meta-home field. */
  key: string;
  scope: FieldScope;
  label: string;
  type: FieldType;
  /** For a choice: the only values allowed, in dropdown order. */
  values?: string[];
  /** One sentence: what to write. The canvas placeholder and the assistant's instruction. */
  guidance?: string;
  filledBy: FieldFilledBy;
  showFor: FieldShowFor;
  status: FieldStatus;
  home: FieldHome;
}

/** A project's fields, in display order, plus the dbt `meta:` keys it never copies. */
export interface FieldList {
  tables: FieldDefinition[];
  columns: FieldDefinition[];
  /** dbt `meta:` keys that are another tool's settings: never copied or offered (they still show when present). */
  leftOut: string[];
}

/** Why a row is shown: it is on the list, it is a retired built-in with a value, or it has a value the list does not name. */
export type FieldRowSource = 'list' | 'retired' | 'notInList';

/** One row of a table's or a column's fields, as {@link resolveTableFields} returns it. */
export interface FieldRow {
  /**
   * Stable per table (or column): `rationale:<camelKey>` (`rationale:openQuestions`),
   * `meta:<key>` (`meta:owner`), or the home's kind for a typed built-in
   * (`grain`, `role`, `naturalKey`, `scdType`, `additiveType`). See {@link fieldRowId}.
   */
  id: string;
  definition: FieldDefinition;
  /**
   * The value, when there is one. Text homes give text (`scdType` 2 is `'2'`,
   * a natural key is `'true'`); a meta value keeps its shape (a boolean stays
   * a boolean, a list stays a list). Absent: no value (an empty rationale
   * text counts as none; an empty meta text `''` is a value).
   */
  value?: MetaValue;
  /** For a choice or yes-no row whose value reads as one of its options: that option (`'true'` for a `true` boolean). */
  choice?: string;
  source: FieldRowSource;
  /** False when the value cannot be edited as text (a list, a map, null) or the definition is from a newer core. */
  editable: boolean;
  /** Set (only ever `true`) when a choice or yes-no value is not one of the field's options. The value is still returned. */
  outsideChoices?: boolean;
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const FIELD_TYPES: readonly FieldType[] = Object.freeze(['text', 'value', 'choice', 'yes-no']);
export const FIELD_FILLED_BY: readonly FieldFilledBy[] = Object.freeze(['anyone', 'people', 'dbt']);
export const FIELD_SHOW_FOR: readonly FieldShowFor[] = Object.freeze(['dimensions', 'facts', 'all']);

/** Every table role, in the order the canvas offers them. */
export const TABLE_ROLE_VALUES: readonly TableRole[] = Object.freeze([
  'conformed-dim',
  'domain-dim',
  'transaction-fact',
  'periodic-snapshot',
  'accumulating-snapshot',
  'factless-fact',
  'reference',
  'gold-fact',
  'gold-dim',
] as TableRole[]);

/** Roles whose tables are dimensions (`show_for: dimensions`). */
export const DIMENSION_ROLES: readonly TableRole[] = Object.freeze(['conformed-dim', 'domain-dim', 'gold-dim', 'reference'] as TableRole[]);
/** Roles whose tables are facts (`show_for: facts`). */
export const FACT_ROLES: readonly TableRole[] = Object.freeze([
  'transaction-fact',
  'periodic-snapshot',
  'accumulating-snapshot',
  'factless-fact',
  'gold-fact',
] as TableRole[]);

/**
 * The `meta` key Import DBML keeps another tool's settings under. It is
 * bookkeeping, never a field row (a renderer shows it on its own, read-only).
 */
export const DBML_IMPORT_META_KEY = 'dbml';

/** A field key: what DBML accepts as a setting name and keeps as written (it lower-cases names). */
export const FIELD_KEY_PATTERN = /^[a-z_][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

function builtIn(
  key: string,
  scope: FieldScope,
  label: string,
  type: FieldType,
  status: FieldStatus,
  home: FieldHome,
  guidance: string,
  extra: { values?: readonly string[]; showFor?: FieldShowFor; filledBy?: FieldFilledBy } = {},
): FieldDefinition {
  return {
    key,
    scope,
    label,
    type,
    ...(extra.values ? { values: [...extra.values] } : {}),
    guidance,
    filledBy: extra.filledBy ?? 'anyone',
    showFor: extra.showFor ?? 'all',
    status,
    home,
  };
}

const rationaleHome = (key: keyof Rationale): FieldHome => ({ kind: 'rationale', key });

/**
 * Every built-in field, in catalogue order: table fields (starting, then
 * optional, then retired), then column fields. Frozen.
 */
export const BUILT_IN_FIELDS: readonly FieldDefinition[] = deepFreeze([
  builtIn('grain', 'table', 'Grain', 'text', 'starting', { kind: 'grain' },
    'One row per ___. The one sentence that says what a row is.'),
  builtIn('purpose', 'table', 'Purpose', 'text', 'starting', rationaleHome('purpose'),
    'Who uses this table and the question it answers.'),
  builtIn('decisions', 'table', 'Decisions', 'text', 'starting', rationaleHome('decisions'),
    'A choice a later editor might undo, and why.'),
  builtIn('open_questions', 'table', 'Open questions', 'text', 'starting', rationaleHome('openQuestions'),
    'What is still undecided. Assistants ask about these and never guess.'),
  builtIn('role', 'table', 'Table role', 'choice', 'starting', { kind: 'role' },
    'Which kind of table this is: conformed-dim, transaction-fact, …', { values: TABLE_ROLE_VALUES }),
  builtIn('scd_strategy', 'table', 'History', 'text', 'starting', rationaleHome('scdStrategy'),
    'How this dimension keeps history: which columns track changes and which overwrite.', { showFor: 'dimensions' }),
  builtIn('measures', 'table', 'Measures', 'text', 'starting', rationaleHome('measures'),
    'How the measures add up: which sum across every dimension and which do not.', { showFor: 'facts' }),
  builtIn('source_of_truth', 'table', 'Source of truth', 'value', 'optional', rationaleHome('sourceOfTruth'),
    'The system this data is mastered in.'),
  builtIn('freshness', 'table', 'Freshness', 'text', 'optional', rationaleHome('freshness'),
    'How fresh it must be, and how often it loads.'),
  builtIn('known_issues', 'table', 'Known issues', 'text', 'optional', rationaleHome('knownIssues'),
    'Data problems a consumer should know before trusting a number.'),
  builtIn('retention', 'table', 'Retention', 'text', 'optional', rationaleHome('retention'),
    'How long rows are kept, and why.', { filledBy: 'people' }),
  builtIn('design', 'table', 'Design', 'text', 'retired', rationaleHome('design'),
    'Move to Decisions, or to Purpose.'),
  builtIn('role_choice', 'table', 'Role choice', 'text', 'retired', rationaleHome('roleChoice'),
    'Move to Decisions.'),
  builtIn('grain_choice', 'table', 'Grain choice', 'text', 'retired', rationaleHome('grainChoice'),
    'Move to Decisions.'),
  builtIn('natural_key', 'column', 'Natural key', 'yes-no', 'starting', { kind: 'naturalKey' },
    'The business identifier, like an order number or a customer code.'),
  builtIn('scd_type', 'column', 'SCD type', 'choice', 'starting', { kind: 'scdType' },
    '0 never changes, 1 overwrites, 2 keeps history.', { values: ['0', '1', '2'], showFor: 'dimensions' }),
  builtIn('additive_type', 'column', 'Additivity', 'choice', 'starting', { kind: 'additiveType' },
    'Additive, semi-additive or non-additive.', { values: ['additive', 'semi-additive', 'non-additive'], showFor: 'facts' }),
  builtIn('business_rule', 'column', 'Business rule', 'text', 'optional', { kind: 'meta' },
    'How the value is worked out, in business terms.'),
]);

const BUILT_IN_BY_SCOPE_KEY: ReadonlyMap<string, FieldDefinition> = new Map(
  BUILT_IN_FIELDS.map((def) => [`${def.scope}:${def.key}`, def]),
);

/** The built-in field `key` of `scope`, or undefined. Catalogue membership is always per scope. */
export function builtInField(key: string, scope: FieldScope): FieldDefinition | undefined {
  if (typeof key !== 'string') return undefined;
  return BUILT_IN_BY_SCOPE_KEY.get(`${scope}:${key}`);
}

/**
 * The fields a project records when it has no fields.yml: tables `grain,
 * purpose, decisions, open_questions, role, scd_strategy, measures`; columns
 * `natural_key, scd_type, additive_type`. Frozen; its definitions are the
 * catalogue's own objects.
 */
export const STARTING_FIELD_LIST: FieldList = deepFreeze({
  tables: ['grain', 'purpose', 'decisions', 'open_questions', 'role', 'scd_strategy', 'measures']
    .map((key) => builtInField(key, 'table')!),
  columns: ['natural_key', 'scd_type', 'additive_type'].map((key) => builtInField(key, 'column')!),
  leftOut: [],
});

// ---------------------------------------------------------------------------
// Rationale keys
// ---------------------------------------------------------------------------

/**
 * Every rationale-home key (camelCase), in the ONE order the storage writer
 * and the exports use: the six keys of the first release keep their relative
 * order, the new ones fill in around them.
 */
export const RATIONALE_FIELD_KEYS: ReadonlyArray<keyof Rationale> = Object.freeze([
  'purpose',
  'decisions',
  'openQuestions',
  'design',
  'grainChoice',
  'roleChoice',
  'scdStrategy',
  'measures',
  'sourceOfTruth',
  'freshness',
  'knownIssues',
  'retention',
] as Array<keyof Rationale>);

const RATIONALE_FIELD_KEY_SET: ReadonlySet<string> = new Set(RATIONALE_FIELD_KEYS);

/** Whether `key` is a rationale-home key (camelCase, `openQuestions`). */
export function isRationaleFieldKey(key: string): key is keyof Rationale {
  return typeof key === 'string' && RATIONALE_FIELD_KEY_SET.has(key);
}

/** The rationale key a catalogue field key names (`open_questions` → `openQuestions`), or undefined. Catalogue only. */
export function fieldKeyToRationaleKey(key: string): keyof Rationale | undefined {
  const def = builtInField(key, 'table');
  return def && def.home.kind === 'rationale' ? def.home.key : undefined;
}

/** The field key of a camelCase key (`scdStrategy` → `scd_strategy`). */
export function rationaleKeyToFieldKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Reserved keys and spellings
// ---------------------------------------------------------------------------

// The setting prefixes and ERD Studio's own names are the values of
// dbmlRichProperties.ts (DBML_RICH_*); fields.test.ts pins them equal. They
// are written out here so that module can import this one without a cycle.
const ERD_PREFIX = 'erd_';
const RATIONALE_PREFIX = 'rationale_';
const META_PREFIX = 'meta_';
const META_JSON_SETTING = 'meta_json';
/** The `meta` key whose `meta_` spelling would be `meta_json` itself: always kept in `meta_json`. */
const META_JSON_ENTRY_KEY = 'json';

/** DBML's own setting names (tables and columns, any parser version): never a field. */
export const DBML_SETTING_NAMES: readonly string[] = Object.freeze([
  'note', 'headercolor', 'color', 'pk', 'primary key', 'primary_key', 'unique', 'ref', 'dep',
  'not null', 'not_null', 'null', 'increment', 'default', 'name', 'type', 'check', 'update',
  'delete', 'inactive', 'example',
]);

/** Names ERD Studio writes itself, plus `meta` keys it keeps for its own use: never a team field. */
export const ERD_SETTING_NAMES: readonly string[] = Object.freeze([
  'schema', 'alias', 'role', 'grain', 'foreign_key', 'natural_key', 'scd_type', 'additive_type',
  META_JSON_SETTING, 'erd_placeholder', 'linked_table', META_JSON_ENTRY_KEY, DBML_IMPORT_META_KEY,
]);

/** Names some DBML parsers treat as object-prototype keys: never a field. */
export const UNSAFE_FIELD_KEYS: readonly string[] = Object.freeze(['constructor', '__proto__']);

/** Prefixes that mark a setting as a spelling of something else: never the start of a field key. */
export const RESERVED_FIELD_KEY_PREFIXES: readonly string[] = Object.freeze([ERD_PREFIX, RATIONALE_PREFIX, META_PREFIX]);

const DBML_SETTING_SET: ReadonlySet<string> = new Set(DBML_SETTING_NAMES);
const ERD_SETTING_SET: ReadonlySet<string> = new Set(ERD_SETTING_NAMES);
const UNSAFE_SET: ReadonlySet<string> = new Set(UNSAFE_FIELD_KEYS);

/** Why a key is reserved: a DBML setting, one of ERD Studio's own names, a spelling prefix, or a parser-unsafe name. */
export type ReservedFieldKeyReason = 'dbmlSetting' | 'erdSetting' | 'prefix' | 'unsafe';

/**
 * Why `key` can never be a field key of `scope`, or undefined when it can.
 * Setting names are compared lower-cased, as DBML reads them. The scope is
 * part of the contract (today both scopes reserve the same names).
 */
export function reservedFieldKeyReason(key: string, _scope: FieldScope): ReservedFieldKeyReason | undefined {
  if (typeof key !== 'string') return undefined;
  const name = key.toLowerCase();
  if (UNSAFE_SET.has(name)) return 'unsafe';
  if (DBML_SETTING_SET.has(name)) return 'dbmlSetting';
  if (ERD_SETTING_SET.has(name)) return 'erdSetting';
  if (RESERVED_FIELD_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'prefix';
  return undefined;
}

/**
 * Whether `key` is reserved: a DBML setting (`note`, `pk`, `default`, …),
 * one of ERD Studio's own names (`schema`, `alias`, `role`, `grain`,
 * `natural_key`, `scd_type`, `additive_type`, `foreign_key`, `meta_json`,
 * `linked_table`, `json`, `dbml`, …), a name starting `erd_`, `rationale_`
 * or `meta_`, or `constructor` / `__proto__`. A reserved key is never a
 * team field's key and is never written bare. The built-ins `role`, `grain`,
 * `natural_key`, `scd_type` and `additive_type` are reserved too: they are
 * built-ins, never a team's.
 */
export function isReservedFieldKey(key: string, scope: FieldScope): boolean {
  return reservedFieldKeyReason(key, scope) !== undefined;
}

/**
 * Whether a `meta` key of `scope` is read and written as a bare setting
 * (`owner: 'crm-team'`): it matches {@link FIELD_KEY_PATTERN}, is not
 * reserved, and is not a catalogue key of this scope whose home is not
 * `meta`. So `business_rule` (a column built-in kept in `meta`) is bare, and
 * so is a column's `purpose` (a table built-in only), while a table's
 * `meta.purpose` is not (it would read as the built-in Purpose).
 */
export function isBareMetaKey(key: string, scope: FieldScope): boolean {
  if (typeof key !== 'string' || !FIELD_KEY_PATTERN.test(key)) return false;
  if (isReservedFieldKey(key, scope)) return false;
  const def = builtInField(key, scope);
  return !def || def.home.kind === 'meta';
}

/**
 * The setting names that spell the rationale-home field `fieldKey` (snake
 * case, `open_questions`), in precedence order: `erd_K`, `K`,
 * `erd_rationale_K`, `rationale_K`.
 */
export function rationaleSpellingNames(fieldKey: string): string[] {
  return [`${ERD_PREFIX}${fieldKey}`, fieldKey, `${ERD_PREFIX}${RATIONALE_PREFIX}${fieldKey}`, `${RATIONALE_PREFIX}${fieldKey}`];
}

/**
 * The setting names that spell the `meta` key `key` of `scope`, in
 * precedence order: `erd_k` and `k` (only when {@link isBareMetaKey}),
 * `erd_meta_k` and `meta_k` (never for `json`, whose `meta_` spelling is
 * `meta_json` itself), `erd_rationale_k` and `rationale_k` (only when `k` is
 * not a catalogue rationale field of the scope). The `meta_json` entry `k`
 * comes last and is not a setting name, so it is not listed. Empty for a key
 * that is not an identifier ({@link FIELD_KEY_PATTERN}): only `meta_json`
 * can hold it.
 */
export function metaSpellingNames(key: string, scope: FieldScope): string[] {
  if (typeof key !== 'string' || !FIELD_KEY_PATTERN.test(key)) return [];
  const names: string[] = [];
  if (isBareMetaKey(key, scope)) names.push(`${ERD_PREFIX}${key}`, key);
  if (key !== META_JSON_ENTRY_KEY) names.push(`${ERD_PREFIX}${META_PREFIX}${key}`, `${META_PREFIX}${key}`);
  const rationaleField = scope === 'table' && fieldKeyToRationaleKey(key) !== undefined;
  if (!rationaleField) names.push(`${ERD_PREFIX}${RATIONALE_PREFIX}${key}`, `${RATIONALE_PREFIX}${key}`);
  return names;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const DIMENSION_ROLE_SET: ReadonlySet<string> = new Set(DIMENSION_ROLES);
const FACT_ROLE_SET: ReadonlySet<string> = new Set(FACT_ROLES);

/** Whether a role is a dimension's: `undefined` for no role or a role this core does not know. */
export function isDimensionRole(role?: string): boolean | undefined {
  if (typeof role !== 'string') return undefined;
  if (DIMENSION_ROLE_SET.has(role)) return true;
  if (FACT_ROLE_SET.has(role)) return false;
  return undefined;
}

/** Whether a role is a fact's: `undefined` for no role or a role this core does not know. */
export function isFactRole(role?: string): boolean | undefined {
  if (typeof role !== 'string') return undefined;
  if (FACT_ROLE_SET.has(role)) return true;
  if (DIMENSION_ROLE_SET.has(role)) return false;
  return undefined;
}

/**
 * Whether a field suits a table with `role` (a column field: the column's
 * table). A table with no role, or a role this core does not know, suits
 * every field, as does a `showFor` from a newer core. A field with a value
 * is shown whatever this says.
 */
export function fieldApplies(def: FieldDefinition, role?: string): boolean {
  const showFor = def?.showFor;
  if (showFor === 'dimensions') return isDimensionRole(role) !== false;
  if (showFor === 'facts') return isFactRole(role) !== false;
  return true;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

const HOME_KINDS: ReadonlySet<string> = new Set(['rationale', 'meta', 'grain', 'role', 'naturalKey', 'scdType', 'additiveType']);

/** A row's id for a definition: see {@link FieldRow.id}. */
export function fieldRowId(def: FieldDefinition): string {
  const home = def.home as { kind?: unknown; key?: unknown } | undefined;
  const kind = typeof home?.kind === 'string' ? home.kind : 'meta';
  if (kind === 'rationale') return `rationale:${String(home?.key)}`;
  if (kind === 'meta' || !HOME_KINDS.has(kind)) return `meta:${def.key}`;
  return kind;
}

/**
 * The definition of a `meta` key no list names, as the resolver shows it:
 * labelled with its key, text, the team's. A key that is reserved, or a
 * catalogue key of this scope kept somewhere else (`meta.purpose`), is
 * labelled `<key> (metadata)` so it is never mistaken for the built-in.
 */
export function metaFieldDefinition(key: string, scope: FieldScope): FieldDefinition {
  const def = builtInField(key, scope);
  const shadow = isReservedFieldKey(key, scope) || (def !== undefined && def.home.kind !== 'meta');
  return {
    key,
    scope,
    label: shadow ? `${key} (metadata)` : key,
    type: 'text',
    filledBy: 'anyone',
    showFor: 'all',
    status: 'team',
    home: { kind: 'meta' },
  };
}

type Owner = Record<string, unknown>;

function plainObject(value: unknown): Owner | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Owner) : undefined;
}

function own(obj: Owner | undefined, key: string): unknown {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** A value as a {@link MetaValue}, normalised as `meta` is read (numbers become text); undefined for nothing usable. */
function asMetaValue(raw: unknown): MetaValue | undefined {
  if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') return undefined;
  const holder: Meta = {};
  setMetaEntry(holder, 'v', raw as MetaValue);
  const normalised = readMeta(holder);
  return normalised ? normalised.v : undefined;
}

/** Text that counts as a value: non-blank text, or a number or a boolean as its text. */
function textValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

function readHome(def: FieldDefinition, owner: Owner): MetaValue | undefined {
  const home = def.home as { kind?: unknown; key?: unknown } | undefined;
  switch (home?.kind) {
    case 'rationale': {
      if (typeof home.key !== 'string') return undefined;
      const raw = own(plainObject(owner.rationale), home.key);
      if (raw === null || raw === undefined) return undefined;
      // Older or hand-written files can hold anything: text, or a value kept as it is.
      return textValue(raw) ?? (typeof raw === 'string' ? undefined : asMetaValue(raw));
    }
    case 'grain':
      return textValue(owner.grain);
    case 'role':
      return textValue(owner.modelRole);
    case 'naturalKey':
      return owner.isNaturalKey === true || (typeof owner.isNaturalKey === 'string' && owner.isNaturalKey.trim().toLowerCase() === 'true')
        ? 'true'
        : undefined;
    case 'scdType':
      return textValue(owner.scdType);
    case 'additiveType':
      return textValue(owner.additiveType);
    default:
      // `meta`, and a home from a newer core: read the key from `meta`, so a value is never dropped.
      return asMetaValue(own(plainObject(owner.meta), def.key));
  }
}

function knownDefinition(def: FieldDefinition): boolean {
  const home = def.home as { kind?: unknown } | undefined;
  return (FIELD_TYPES as readonly string[]).includes(def.type)
    && (FIELD_FILLED_BY as readonly string[]).includes(def.filledBy)
    && (FIELD_SHOW_FOR as readonly string[]).includes(def.showFor)
    && typeof home?.kind === 'string' && HOME_KINDS.has(home.kind);
}

function choiceOf(def: FieldDefinition, value: MetaValue): { choice?: string; outside: boolean } {
  if (def.type === 'yes-no') {
    if (typeof value === 'boolean') return { choice: String(value), outside: false };
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === 'true' || text === 'false') return { choice: text, outside: false };
      return { outside: value !== '' };
    }
    return { outside: true };
  }
  if (def.type === 'choice') {
    const values = Array.isArray(def.values) ? def.values : [];
    if (typeof value === 'string' || typeof value === 'boolean') {
      const text = String(value);
      if (values.includes(text)) return { choice: text, outside: false };
      return { outside: text !== '' && values.length > 0 };
    }
    return { outside: values.length > 0 };
  }
  return { outside: false };
}

function makeRow(def: FieldDefinition, value: MetaValue | undefined, source: FieldRowSource): FieldRow {
  const known = knownDefinition(def);
  const kind = (def.home as { kind?: unknown } | undefined)?.kind;
  let editable = known;
  if (known && value !== undefined) {
    if (kind === 'rationale') editable = typeof value === 'string';
    else if (kind === 'meta') editable = typeof value === 'string' || typeof value === 'boolean';
  }
  const row: FieldRow = { id: fieldRowId(def), definition: def, source, editable };
  if (value !== undefined) {
    row.value = value;
    if (known) {
      const { choice, outside } = choiceOf(def, value);
      if (choice !== undefined) row.choice = choice;
      if (outside) row.outsideChoices = true;
    }
  }
  return row;
}

/**
 * A list entry as the resolver uses it: undefined for an entry that is not a
 * definition at all; a copy with a usable `key`, `label` and `home` filled in
 * for one that is incomplete (a cached list from an older or newer core).
 */
function usableDefinition(raw: unknown, scope: FieldScope): FieldDefinition | undefined {
  const def = plainObject(raw) as Partial<FieldDefinition> | undefined;
  if (!def || typeof def.key !== 'string' || def.key === '') return undefined;
  const home = plainObject(def.home);
  const complete = typeof def.label === 'string' && home !== undefined && typeof home.kind === 'string';
  if (complete) return def as FieldDefinition;
  const builtin = builtInField(def.key, scope);
  return {
    ...(builtin ?? metaFieldDefinition(def.key, scope)),
    ...def,
    label: typeof def.label === 'string' ? def.label : builtin?.label ?? def.key,
    home: home && typeof home.kind === 'string' ? (home as FieldHome) : builtin?.home ?? { kind: 'meta' },
  } as FieldDefinition;
}

function listOf(list: FieldList | undefined, scope: FieldScope): unknown[] {
  const value = plainObject(list)?.[scope === 'table' ? 'tables' : 'columns'];
  return Array.isArray(value) ? value : scope === 'table' ? STARTING_FIELD_LIST.tables : STARTING_FIELD_LIST.columns;
}

function resolveFields(scope: FieldScope, owner: Owner, listed: unknown[], role: string | undefined): FieldRow[] {
  const rows: FieldRow[] = [];
  const seen = new Set<string>();
  const metaKeysShown = new Set<string>();
  const add = (def: FieldDefinition, value: MetaValue | undefined, source: FieldRowSource): void => {
    const id = fieldRowId(def);
    seen.add(id);
    if (id.startsWith('meta:')) metaKeysShown.add(def.key);
    rows.push(makeRow(def, value, source));
  };

  // 1. The list, in its order. A field that does not suit the role is left out unless it has a value.
  for (const entry of listed) {
    const def = usableDefinition(entry, scope);
    if (!def || seen.has(fieldRowId(def))) continue;
    if (fieldRowId(def) === `meta:${DBML_IMPORT_META_KEY}`) continue;
    const value = readHome(def, owner);
    if (value === undefined && !fieldApplies(def, role)) continue;
    add(def, value, 'list');
  }

  // 2. Built-ins with a value the list does not name: retired ones, then the rest, in catalogue order.
  for (const retired of [true, false]) {
    for (const def of BUILT_IN_FIELDS) {
      if (def.scope !== scope || (def.status === 'retired') !== retired || seen.has(fieldRowId(def))) continue;
      const value = readHome(def, owner);
      if (value === undefined) continue;
      add(def, value, retired ? 'retired' : 'notInList');
    }
  }

  // 3. Every other `meta` key, in map order (Import DBML's bookkeeping excepted).
  const meta = plainObject(owner.meta);
  if (meta) {
    for (const key of Object.keys(meta)) {
      if (key === DBML_IMPORT_META_KEY || metaKeysShown.has(key) || seen.has(`meta:${key}`)) continue;
      const value = asMetaValue(meta[key]);
      if (value === undefined) continue;
      add(metaFieldDefinition(key, scope), value, 'notInList');
    }
  }
  return rows;
}

function roleOf(table: unknown): string | undefined {
  const role = plainObject(table)?.modelRole;
  return typeof role === 'string' ? role : undefined;
}

/**
 * A table's field rows, in order: the list's fields first, in list order (a
 * listed field that does not suit the table's role is left out unless it
 * has a value); then every field with a value the list leaves out — retired
 * built-ins (`source: 'retired'`), other built-ins (`'notInList'`), then
 * `meta` keys in map order (`'notInList'`, a definition made up from the key:
 * {@link metaFieldDefinition}). `meta.dbml` is never a row. `list` defaults
 * to {@link STARTING_FIELD_LIST}; a list missing a section uses the starting
 * set's. Never throws: an older core's table, a v4 inline model with values
 * of any type, or a malformed list all resolve to what can be read.
 */
export function resolveTableFields(table: DisplayTable | SemanticTable, list?: FieldList): FieldRow[] {
  const owner = plainObject(table);
  if (!owner) return [];
  return resolveFields('table', owner, listOf(list, 'table'), roleOf(owner));
}

/**
 * A column's field rows, as {@link resolveTableFields} orders a table's. A
 * field's `showFor` reads the role of the column's `table`.
 */
export function resolveColumnFields(
  column: DisplayColumn | ColumnDef,
  table: DisplayTable | SemanticTable,
  list?: FieldList,
): FieldRow[] {
  const owner = plainObject(column);
  if (!owner) return [];
  return resolveFields('column', owner, listOf(list, 'column'), roleOf(table));
}
