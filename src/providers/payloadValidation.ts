/**
 * Runtime validation for webview → extension message payloads.
 *
 * The message types in src/types/messages.ts are compile-time only. The
 * webview bundle and the extension host can drift across updates, and the
 * host writes payload values straight into domain JSON / model YAML files,
 * so every value that ends up on disk is checked here first.
 *
 * All functions are pure and return either `null` (valid) or an error string,
 * or act as type guards — no vscode imports so they are trivially testable.
 */

import type { Cardinality, ColumnDef, ModelRole, Stage } from '../types/semantic';
import { COLUMN_NAME_PATTERN, MODEL_NAME_PATTERN, MODEL_NAME_RULE, findDuplicateNames } from '../types/naming';
import type { DuplicateMode, FeedbackKind } from '../types/feedback';
import { MAX_COMPOSITE_PAIRS, MODEL_ALIAS_MAX_LENGTH, MODEL_ALIAS_RULE, RELATIONSHIP_ROLE_MAX_LENGTH, isValidModelAlias } from '@erd-studio/core';
import { DUPLICATE_MODES, FEEDBACK_KINDS, isFeedbackAiProviderChoice } from '../types/feedback';

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

/**
 * Path-safety check for a model name, independent of authoring style.
 *
 * A model name becomes a file name under `logical-models/`, so anything that
 * could resolve outside that directory — path separators, `..`, an absolute
 * path, a Windows drive prefix, a NUL byte — is rejected. Nothing else is:
 * names that come from the user's own dbt project (Add Existing Model) are
 * whatever dbt allows, including uppercase and digit-leading names.
 */
export function validateModelNameSafety(name: unknown): string | null {
  if (typeof name !== 'string') {
    return 'Model name is required.';
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Model name cannot be empty.';
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return 'Model name cannot contain path separators.';
  }
  if (trimmed.includes('\0') || /^[A-Za-z]:/.test(trimmed) || trimmed === '.') {
    return 'Model name cannot be a file system path.';
  }
  return null;
}

/**
 * Validate a model name the user authored (New Model dialog, rename). On top
 * of {@link validateModelNameSafety} this enforces the project's naming
 * convention (`[A-Za-z][A-Za-z0-9_]*`) so newly created models stay consistent.
 *
 * Do NOT use this for names discovered in the dbt project — see
 * {@link validateModelNameSafety}.
 */
export function validateModelName(name: unknown): string | null {
  const safetyError = validateModelNameSafety(name);
  if (safetyError) {
    return safetyError;
  }
  if (!MODEL_NAME_PATTERN.test((name as string).trim())) {
    return MODEL_NAME_RULE;
  }
  return null;
}

/**
 * Validate an `updateModelAlias` payload. An empty alias is valid — it clears
 * the key — so only a non-empty one is held to the table-name rule.
 */
export function validateModelAliasPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return 'Missing payload.';
  }
  const { modelName, alias } = payload as { modelName?: unknown; alias?: unknown };
  const nameError = validateModelNameSafety(modelName);
  if (nameError) {
    return nameError;
  }
  if (typeof alias !== 'string') {
    return 'Table name must be a string.';
  }
  const trimmed = alias.trim();
  if (trimmed.length > MODEL_ALIAS_MAX_LENGTH) {
    return `Table name is longer than ${MODEL_ALIAS_MAX_LENGTH} characters.`;
  }
  if (trimmed && !isValidModelAlias(trimmed)) {
    return MODEL_ALIAS_RULE;
  }
  return null;
}

/** Longest `meta` key accepted from the canvas. */
export const META_KEY_MAX_LENGTH = 100;
/** Longest `meta` value accepted from the canvas. */
export const META_VALUE_MAX_LENGTH = 2000;

/**
 * Validate an `updateMeta` payload: a patch of top-level text values
 * (`set`) and key removals (`remove`) on a model's or a column's `meta`.
 * A key is a single line of text; it may not be set and removed at once.
 */
export function validateMetaPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return 'Missing payload.';
  }
  const { modelName, columnName, set, remove } = payload as {
    modelName?: unknown; columnName?: unknown; set?: unknown; remove?: unknown;
  };
  const nameError = validateModelNameSafety(modelName);
  if (nameError) {
    return nameError;
  }
  if (columnName !== undefined && (typeof columnName !== 'string' || !columnName.trim())) {
    return 'Column name must be a non-empty string.';
  }
  if (set !== undefined && (!set || typeof set !== 'object' || Array.isArray(set))) {
    return 'Metadata values must be an object.';
  }
  if (remove !== undefined && (!Array.isArray(remove) || remove.some((k) => typeof k !== 'string'))) {
    return 'Metadata keys to remove must be a list of strings.';
  }
  const entries = Object.entries((set ?? {}) as Record<string, unknown>);
  const removed = new Set((remove ?? []) as string[]);
  if (entries.length === 0 && removed.size === 0) {
    return 'Nothing to change.';
  }
  for (const [key, value] of entries) {
    const keyError = validateMetaKey(key);
    if (keyError) return keyError;
    if (typeof value !== 'string') {
      return `Value of "${key}" must be text.`;
    }
    if (value.length > META_VALUE_MAX_LENGTH) {
      return `Value of "${key}" is longer than ${META_VALUE_MAX_LENGTH} characters.`;
    }
    if (removed.has(key)) {
      return `"${key}" cannot be set and removed at once.`;
    }
  }
  return null;
}

function validateMetaKey(key: string): string | null {
  if (!key.trim()) {
    return 'Metadata key is required.';
  }
  if (key !== key.trim()) {
    return 'Metadata key cannot start or end with a space.';
  }
  if (key.length > META_KEY_MAX_LENGTH) {
    return `Metadata key is longer than ${META_KEY_MAX_LENGTH} characters.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    return 'Metadata key must be a single line of text.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Validate a single column definition (name + data type). */
export function validateColumnDef(column: unknown): string | null {
  if (typeof column !== 'object' || column === null) {
    return 'Column definition is required';
  }
  const col = column as Partial<ColumnDef>;
  const trimmedName = typeof col.name === 'string' ? col.name.trim() : '';
  if (!trimmedName) {
    return 'Column name is required';
  }
  if (!COLUMN_NAME_PATTERN.test(trimmedName)) {
    return 'Column name must use only letters, numbers, and underscores';
  }
  if (typeof col.dataType !== 'string' || !col.dataType.trim()) {
    return 'Data type is required';
  }
  return null;
}

/**
 * Validate a list of column definitions: each must pass `validateColumnDef`
 * and names must be unique within the list.
 */
export function validateColumnDefs(columns: unknown): string | null {
  if (!Array.isArray(columns)) {
    return 'Columns must be a list.';
  }
  const seen = new Set<string>();
  for (const column of columns) {
    const error = validateColumnDef(column);
    if (error) {
      return error;
    }
    const name = (column as ColumnDef).name.trim();
    if (seen.has(name.toLowerCase())) {
      return `Duplicate column name "${name}".`;
    }
    seen.add(name.toLowerCase());
  }
  return null;
}

export { findDuplicateNames };

// ---------------------------------------------------------------------------
// Enumerated values
// ---------------------------------------------------------------------------

export const CARDINALITIES: readonly Cardinality[] = [
  'many-to-one',
  'one-to-one',
  'one-to-many',
  'many-to-many',
];

export function isValidCardinality(value: unknown): value is Cardinality {
  return typeof value === 'string' && (CARDINALITIES as readonly string[]).includes(value);
}

/**
 * A relationship's optional `role` label from the New / Edit Relationship
 * dialog: absent, or text of at most `RELATIONSHIP_ROLE_MAX_LENGTH` characters
 * ('' clears it). The host trims it with `normaliseRelationshipRole`.
 */
export function isValidRelationshipRole(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.trim().length <= RELATIONSHIP_ROLE_MAX_LENGTH);
}

/** The columns of each end of a relationship payload; `extraPairs` once validated by `validateExtraPairs`. */
interface LinkPayloadEnds {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  extraPairs?: unknown;
}

/** Every column pair of a payload: the first, then any `extraPairs` (assumed valid). */
const pairsOfPayload = (link: LinkPayloadEnds): Array<{ fromColumn: string; toColumn: string }> => [
  { fromColumn: link.fromColumn, toColumn: link.toColumn },
  ...(Array.isArray(link.extraPairs) ? link.extraPairs as Array<{ fromColumn: string; toColumn: string }> : []),
];

/**
 * A composite foreign key's other column pairs (#133 L2): absent, or at most
 * `MAX_COMPOSITE_PAIRS - 1` pairs of valid column names; across every pair,
 * the first included, no from column and no to column used twice (without
 * case); and, with more than one pair, not many-to-many. Returns an error, or
 * null.
 */
export function validateExtraPairs(extraPairs: unknown, link: LinkPayloadEnds & { cardinality?: unknown }): string | null {
  if (extraPairs === undefined) return null;
  if (!Array.isArray(extraPairs) || extraPairs.length > MAX_COMPOSITE_PAIRS - 1) {
    return `a composite key has at most ${MAX_COMPOSITE_PAIRS} column pairs.`;
  }
  const valid = (p: unknown): p is { fromColumn: string; toColumn: string } => !!p && typeof p === 'object' && !Array.isArray(p)
    && typeof (p as { fromColumn?: unknown }).fromColumn === 'string' && COLUMN_NAME_PATTERN.test((p as { fromColumn: string }).fromColumn)
    && typeof (p as { toColumn?: unknown }).toColumn === 'string' && COLUMN_NAME_PATTERN.test((p as { toColumn: string }).toColumn);
  if (!extraPairs.every(valid)) return 'each column pair needs two valid column names.';
  const pairs = pairsOfPayload({ ...link, extraPairs });
  const distinct = (cols: string[]): boolean => new Set(cols.map((c) => c.toLowerCase())).size === cols.length;
  if (!distinct(pairs.map((p) => p.fromColumn)) || !distinct(pairs.map((p) => p.toColumn))) {
    return 'a column is used twice in the composite key.';
  }
  if (pairs.length > 1 && link.cardinality === 'many-to-many') return 'a composite key can\'t be many-to-many.';
  return null;
}

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameColumnSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...new Set(a.map((c) => c.toLowerCase()))];
  const y = [...new Set(b.map((c) => c.toLowerCase()))];
  return x.length === a.length && x.length === y.length && x.every((c) => y.includes(c));
};

/**
 * A relationship's ends (#133 L3): a self-reference joins two columns of one
 * model, but a column can't point at itself. Returns an error, or null.
 */
export function validateRelationshipEnds(link: LinkPayloadEnds): string | null {
  if (typeof link.fromModel !== 'string' || typeof link.toModel !== 'string' || !sameText(link.fromModel, link.toModel)) return null;
  return pairsOfPayload(link).some((p) => typeof p.fromColumn === 'string' && typeof p.toColumn === 'string' && sameText(p.fromColumn, p.toColumn))
    ? "a column can't point at itself."
    : null;
}

/**
 * The New / Edit Relationship dialog's `markKey` (#133 L1): absent, or one
 * end of the link — its model and, as a set without case, exactly that end's
 * columns (1–8, each a valid column name). For a self-reference either end
 * may be named; the columns decide which. Returns an error, or null.
 */
export function validateMarkKey(markKey: unknown, link: LinkPayloadEnds): string | null {
  if (markKey === undefined) return null;
  const invalid = 'the key to mark must be one end of the relationship.';
  if (!markKey || typeof markKey !== 'object' || Array.isArray(markKey)) return invalid;
  const { model, columns } = markKey as { model?: unknown; columns?: unknown };
  if (typeof model !== 'string' || !Array.isArray(columns) || columns.length < 1 || columns.length > 8) return invalid;
  if (!columns.every((c): c is string => typeof c === 'string' && COLUMN_NAME_PATTERN.test(c))) return invalid;
  const pairs = pairsOfPayload(link);
  const ends: Array<[string, string[]]> = [[link.fromModel, pairs.map((p) => p.fromColumn)], [link.toModel, pairs.map((p) => p.toColumn)]];
  return ends.some(([m, cols]) => sameText(m, model) && sameColumnSet(columns, cols)) ? null : invalid;
}

export const MODEL_ROLES: readonly ModelRole[] = [
  'conformed-dim',
  'domain-dim',
  'transaction-fact',
  'periodic-snapshot',
  'accumulating-snapshot',
  'factless-fact',
  'reference',
  'gold-fact',
  'gold-dim',
];

export function isValidModelRole(value: unknown): value is ModelRole {
  return typeof value === 'string' && (MODEL_ROLES as readonly string[]).includes(value);
}

export type KeyType = 'PK' | 'FK' | 'NK';

export const KEY_TYPES: readonly KeyType[] = ['PK', 'FK', 'NK'];

export function isValidKeyType(value: unknown): value is KeyType {
  return typeof value === 'string' && (KEY_TYPES as readonly string[]).includes(value);
}

export function isValidStage(value: unknown): value is Stage {
  return value === 'logical' || value === 'physical';
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Type guard for `FeedbackKind`. */
export function isValidFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

/** Type guard for `DuplicateMode`. */
export function isValidDuplicateMode(value: unknown): value is DuplicateMode {
  return typeof value === 'string' && (DUPLICATE_MODES as readonly string[]).includes(value);
}

/** True for a positive, whole issue number. */
function isIssueNumber(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

/** Validate an optional `string[]` field, e.g. `webviewErrors`. */
function validateStringList(value: unknown, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return `${label} must be a list of strings.`;
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return `${label} must be a list of strings.`;
    }
  }
  return null;
}

/**
 * Validate the optional domain summary carried on the feedback messages. It
 * only ever reaches the diagnostics text, so the checks are shape checks.
 *
 * The domain's name and layer are not among them, and not by omission: they
 * name the user's own project, so they are no longer carried at all (see
 * `FeedbackDomainSummary`). Nothing here reads a key the diagnostics do not
 * render, so a payload that carried one anyway could not surface it.
 */
function validateFeedbackDomainSummary(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Domain summary must be an object.';
  }
  const domain = value as {
    stage?: unknown;
    modelCount?: unknown;
    relationshipCount?: unknown;
    schemaVersion?: unknown;
  };
  if (typeof domain.stage !== 'string') {
    return 'Domain summary stage must be a string.';
  }
  for (const key of ['modelCount', 'relationshipCount'] as const) {
    if (!isFiniteNumber(domain[key])) {
      return `Domain summary ${key} must be a finite number.`;
    }
  }
  if (domain.schemaVersion !== undefined && !isFiniteNumber(domain.schemaVersion)) {
    return 'Domain summary schemaVersion must be a finite number.';
  }
  return null;
}

/** Validate a `requestFeedbackContext` payload (all fields optional). Returns null when valid. */
export function validateRequestFeedbackContextPayload(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback context request must be an object.';
  }
  const payload = value as { webviewErrors?: unknown; domain?: unknown };
  return (
    validateStringList(payload.webviewErrors, 'Webview errors') ??
    validateFeedbackDomainSummary(payload.domain)
  );
}

/**
 * Validate an `analyzeFeedback` payload: finite integer `requestId`, valid
 * `kind`, optional boolean `kindChosenByUser`, non-empty string `description`,
 * optional string `context`, optional `trigger` of `"debounce"` or `"user"`.
 */
export function validateAnalyzeFeedbackPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback analysis request must be an object.';
  }
  const payload = value as {
    requestId?: unknown;
    kind?: unknown;
    kindChosenByUser?: unknown;
    description?: unknown;
    context?: unknown;
    trigger?: unknown;
  };
  if (!isFiniteNumber(payload.requestId) || !Number.isInteger(payload.requestId)) {
    return 'Analysis request id must be a finite integer.';
  }
  if (!isValidFeedbackKind(payload.kind)) {
    return 'Feedback kind must be "bug" or "feature".';
  }
  if (typeof payload.description !== 'string') {
    return 'Description must be a string.';
  }
  if (!payload.description.trim()) {
    return 'Description cannot be empty.';
  }
  if (payload.context !== undefined && typeof payload.context !== 'string') {
    return 'Context must be a string.';
  }
  // Decides whether the kind is stated to the model as the user's decision, so
  // a non-boolean is refused rather than read as "yes".
  if (
    payload.kindChosenByUser !== undefined &&
    typeof payload.kindChosenByUser !== 'boolean'
  ) {
    return 'Kind-chosen flag must be a boolean.';
  }
  // `trigger` decides whether an unprimed language-model request is allowed to
  // run, so an unrecognised value is refused rather than read as "user".
  if (
    payload.trigger !== undefined &&
    payload.trigger !== 'debounce' &&
    payload.trigger !== 'user'
  ) {
    return 'Analysis trigger must be "debounce" or "user".';
  }
  return null;
}

/**
 * Validate a `submitFeedback` payload: valid `kind`, string `title` and
 * `description`, optional string `steps`, boolean `includeDiagnostics`,
 * optional positive integer `regressionOf` / `commentOnIssue`, optional
 * string[] `webviewErrors`, optional domain summary.
 */
export function validateSubmitFeedbackPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback submission must be an object.';
  }
  const payload = value as {
    kind?: unknown;
    title?: unknown;
    description?: unknown;
    steps?: unknown;
    includeDiagnostics?: unknown;
    webviewErrors?: unknown;
    regressionOf?: unknown;
    commentOnIssue?: unknown;
    domain?: unknown;
  };
  if (!isValidFeedbackKind(payload.kind)) {
    return 'Feedback kind must be "bug" or "feature".';
  }
  if (typeof payload.title !== 'string') {
    return 'Title must be a string.';
  }
  if (typeof payload.description !== 'string') {
    return 'Description must be a string.';
  }
  if (payload.steps !== undefined && typeof payload.steps !== 'string') {
    return 'Steps must be a string.';
  }
  if (typeof payload.includeDiagnostics !== 'boolean') {
    return 'Diagnostics flag must be a boolean.';
  }
  for (const key of ['regressionOf', 'commentOnIssue'] as const) {
    if (payload[key] !== undefined && !isIssueNumber(payload[key])) {
      return `Issue number for ${key} must be a positive integer.`;
    }
  }
  return (
    validateStringList(payload.webviewErrors, 'Webview errors') ??
    validateFeedbackDomainSummary(payload.domain)
  );
}

/** Validate a `copyFeedbackReport` payload (same rules minus the issue numbers). */
export function validateCopyFeedbackReportPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback report must be an object.';
  }
  const payload = value as {
    kind?: unknown;
    title?: unknown;
    description?: unknown;
    steps?: unknown;
    includeDiagnostics?: unknown;
    webviewErrors?: unknown;
    domain?: unknown;
  };
  if (!isValidFeedbackKind(payload.kind)) {
    return 'Feedback kind must be "bug" or "feature".';
  }
  if (typeof payload.title !== 'string') {
    return 'Title must be a string.';
  }
  if (typeof payload.description !== 'string') {
    return 'Description must be a string.';
  }
  if (payload.steps !== undefined && typeof payload.steps !== 'string') {
    return 'Steps must be a string.';
  }
  if (typeof payload.includeDiagnostics !== 'boolean') {
    return 'Diagnostics flag must be a boolean.';
  }
  return (
    validateStringList(payload.webviewErrors, 'Webview errors') ??
    validateFeedbackDomainSummary(payload.domain)
  );
}

/**
 * Validate a `setFeedbackProvider` payload: one of the four known choices,
 * plus the same optional diagnostics context `requestFeedbackContext` carries
 * (the reply is a full `feedbackContext`).
 *
 * An unrecognised choice is refused rather than coerced to `auto`: writing a
 * value the resolver does not know would silently restore the old precedence
 * and send the text somewhere the user did not pick.
 */
export function validateSetFeedbackProviderPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Provider choice must be an object.';
  }
  const payload = value as { provider?: unknown; webviewErrors?: unknown; domain?: unknown };
  if (!isFeedbackAiProviderChoice(payload.provider)) {
    return 'Analysis provider must be "auto", "vscode", "endpoint" or "hosted".';
  }
  return (
    validateStringList(payload.webviewErrors, 'Webview errors') ??
    validateFeedbackDomainSummary(payload.domain)
  );
}

/**
 * Validate an `openFeedbackLink` payload. `issue` opens a GitHub thread (with
 * `comment` for the new-comment anchor); `extension` opens the Extensions view.
 */
export function validateOpenFeedbackLinkPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback link must be an object.';
  }
  const payload = value as { target?: unknown; issue?: unknown; comment?: unknown };
  if (payload.target === 'extension') {
    return null;
  }
  if (payload.target !== 'issue') {
    return 'Feedback link target must be "issue" or "extension".';
  }
  if (!isIssueNumber(payload.issue)) {
    return 'Issue number must be a positive integer.';
  }
  if (payload.comment !== undefined && typeof payload.comment !== 'boolean') {
    return 'Comment flag must be a boolean.';
  }
  return null;
}

/**
 * Validate an `addModelsFromDbt` payload. It carries nothing — the host asks
 * which models itself — so only an absent payload or an empty object passes;
 * anything else is refused rather than ignored, so a sender that starts
 * passing model names is caught instead of silently dropped.
 */
export function validateAddModelsFromDbtPayload(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Add models from dbt takes no payload.';
  }
  if (Object.keys(value).length > 0) {
    return 'Add models from dbt takes no payload.';
  }
  return null;
}

/**
 * Validate a `dismissManifestHint` payload (#113). It carries nothing — only
 * an absent payload or an empty object passes, like `addModelsFromDbt`.
 */
export function validateDismissManifestHintPayload(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
    return 'Dismissing the dbt parse hint takes no payload.';
  }
  return null;
}

/**
 * Validate an `openModelFile` payload: `{ modelName }`. The name is held to
 * the path-safety rule rather than the authoring pattern, because a model
 * added from dbt may carry a name dbt allows (uppercase, digit-leading) and
 * its broken file must still be openable.
 */
export function validateOpenModelFilePayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Open model file needs a model name.';
  }
  return validateModelNameSafety((value as { modelName?: unknown }).modelName);
}

/** `layoutFinished` (usage telemetry only): a non-negative finite duration, a boolean and an optional `firstOpen` boolean. */
export function validateLayoutFinishedPayload(value: unknown): value is { ms: number; ok: boolean; firstOpen?: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { ms, ok, firstOpen } = value as { ms?: unknown; ok?: unknown; firstOpen?: unknown };
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && typeof ok === 'boolean'
    && (firstOpen === undefined || typeof firstOpen === 'boolean');
}

// ---------------------------------------------------------------------------
// Numbers / positions
// ---------------------------------------------------------------------------

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an `{ x, y }` point with finite numeric coordinates. */
export function validatePoint(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'Position must be an object with x and y.';
  }
  const point = value as { x?: unknown; y?: unknown };
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    return 'Position coordinates must be finite numbers.';
  }
  return null;
}

/**
 * Validate a `Record<modelName, { x, y }>` positions map as sent by
 * `updatePositions`. Keys must be non-empty strings; values finite points.
 */
export function validatePositions(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Positions must be a map of model name to { x, y }.';
  }
  for (const [name, point] of Object.entries(value as Record<string, unknown>)) {
    if (!name.trim()) {
      return 'Position keys must be non-empty model names.';
    }
    const error = validatePoint(point);
    if (error) {
      return `Position for "${name}" is invalid: ${error}`;
    }
  }
  return null;
}

export interface AnnotationPositionPayload {
  id: string;
  x: number;
  y: number;
}

/**
 * Validate the optional `annotations` list carried by `updatePositions`
 * (`[{ id, x, y }]`). Returns the validated list (empty when absent) or an
 * error string. Ids must be non-empty strings; coordinates finite numbers.
 */
export function validateAnnotationPositions(value: unknown): AnnotationPositionPayload[] | string {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return 'Annotation positions must be a list of { id, x, y }.';
  }
  const result: AnnotationPositionPayload[] = [];
  for (const entry of value) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      return 'Annotation position ids must be non-empty strings.';
    }
    const error = validatePoint(entry);
    if (error) {
      return `Position for annotation "${id}" is invalid: ${error}`;
    }
    const point = entry as { x: number; y: number };
    result.push({ id, x: point.x, y: point.y });
  }
  return result;
}

/**
 * Validate an `updateAnnotation` payload. The id addresses an existing note,
 * and every optional field is written straight into `viewConfig.annotations`,
 * so a non-finite width/height (which would serialise as `null` in the domain
 * JSON) or a non-string id/text/colour is rejected here.
 */
export function validateAnnotationUpdate(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Annotation update must be an object.';
  }
  const payload = value as {
    id?: unknown;
    text?: unknown;
    color?: unknown;
    linkedModel?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    return 'Annotation id must be a non-empty string.';
  }
  if (payload.text !== undefined && typeof payload.text !== 'string') {
    return 'Annotation text must be a string.';
  }
  if (payload.color !== undefined && typeof payload.color !== 'string') {
    return 'Annotation colour must be a string.';
  }
  if (
    payload.linkedModel !== undefined &&
    payload.linkedModel !== null &&
    typeof payload.linkedModel !== 'string'
  ) {
    return 'Annotation linked model must be a model name or null.';
  }
  for (const key of ['width', 'height'] as const) {
    const size = payload[key];
    if (size !== undefined && !isFiniteNumber(size)) {
      return `Annotation ${key} must be a finite number.`;
    }
  }
  return null;
}
