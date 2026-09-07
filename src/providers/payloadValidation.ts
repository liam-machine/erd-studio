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
import type {
  DuplicateMode,
  FeedbackAttachment,
  FeedbackImageMime,
  FeedbackKind,
} from '../types/feedback';
import {
  DUPLICATE_MODES,
  FEEDBACK_ATTACHMENT_SOURCES,
  FEEDBACK_IMAGE_MIMES,
  FEEDBACK_KINDS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../types/feedback';

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
 * convention (`[a-z][a-z0-9_]*`) so newly created models stay consistent.
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
    return 'Column name must use lowercase letters, numbers, and underscores';
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
    if (seen.has(name)) {
      return `Duplicate column name "${name}".`;
    }
    seen.add(name);
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

/** Type guard for an accepted image mime type. */
export function isValidFeedbackImageMime(value: unknown): value is FeedbackImageMime {
  return typeof value === 'string' && (FEEDBACK_IMAGE_MIMES as readonly string[]).includes(value);
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
 */
function validateFeedbackDomainSummary(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Domain summary must be an object.';
  }
  const domain = value as {
    name?: unknown;
    layer?: unknown;
    stage?: unknown;
    modelCount?: unknown;
    relationshipCount?: unknown;
    schemaVersion?: unknown;
  };
  for (const key of ['name', 'layer', 'stage'] as const) {
    if (typeof domain[key] !== 'string') {
      return `Domain summary ${key} must be a string.`;
    }
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

/**
 * Validate one attachment: id/name non-empty strings, accepted mime, finite
 * positive `bytes` at or under MAX_ATTACHMENT_BYTES, a `data:<mime>;base64,`
 * dataUrl whose declared mime matches `mime`, and a known `source`.
 * Returns null when valid.
 */
export function validateFeedbackAttachment(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Attachment must be an object.';
  }
  const attachment = value as Partial<FeedbackAttachment>;
  if (typeof attachment.id !== 'string' || !attachment.id.trim()) {
    return 'Attachment id must be a non-empty string.';
  }
  if (typeof attachment.name !== 'string' || !attachment.name.trim()) {
    return 'Attachment name must be a non-empty string.';
  }
  if (!isValidFeedbackImageMime(attachment.mime)) {
    return 'Attachment mime type is not an accepted image type.';
  }
  if (!isFiniteNumber(attachment.bytes) || attachment.bytes <= 0) {
    return 'Attachment size must be a positive number of bytes.';
  }
  if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
    return `Attachment "${attachment.name}" is larger than the 10 MB limit.`;
  }
  if (typeof attachment.dataUrl !== 'string' || !attachment.dataUrl.startsWith(`data:${attachment.mime};base64,`)) {
    return 'Attachment data URL must be a base64 image data URL matching its mime type.';
  }
  if (
    typeof attachment.source !== 'string' ||
    !(FEEDBACK_ATTACHMENT_SOURCES as readonly string[]).includes(attachment.source)
  ) {
    return 'Attachment source is not recognised.';
  }
  if (attachment.onClipboard !== undefined && typeof attachment.onClipboard !== 'boolean') {
    return 'Attachment onClipboard must be a boolean.';
  }
  return null;
}

/**
 * Validate an attachment list: an array, at most MAX_ATTACHMENTS entries, no
 * duplicate `id`, every entry valid, and the summed `bytes` at or under
 * MAX_TOTAL_ATTACHMENT_BYTES. `undefined` is valid (no attachments).
 * Returns null when valid.
 */
export function validateFeedbackAttachments(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return 'Attachments must be a list.';
  }
  if (value.length > MAX_ATTACHMENTS) {
    return `At most ${MAX_ATTACHMENTS} images can be attached.`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const entry of value) {
    const error = validateFeedbackAttachment(entry);
    if (error) {
      return error;
    }
    const attachment = entry as FeedbackAttachment;
    if (seen.has(attachment.id)) {
      return 'Attachment ids must be unique.';
    }
    seen.add(attachment.id);
    total += attachment.bytes;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    return 'Attachments exceed the total size limit.';
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
 * `kind`, non-empty string `description`, optional string `context`.
 */
export function validateAnalyzeFeedbackPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Feedback analysis request must be an object.';
  }
  const payload = value as {
    requestId?: unknown;
    kind?: unknown;
    description?: unknown;
    context?: unknown;
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
  return null;
}

/**
 * Validate a `submitFeedback` payload: valid `kind`, string `title` and
 * `description`, optional string `steps`, boolean `includeDiagnostics`,
 * attachments via validateFeedbackAttachments, optional positive integer
 * `regressionOf` / `commentOnIssue`, optional string[] `webviewErrors`,
 * optional domain summary.
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
    attachments?: unknown;
    screenshotError?: unknown;
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
  if (payload.screenshotError !== undefined && typeof payload.screenshotError !== 'string') {
    return 'Screenshot error must be a string.';
  }
  const attachmentsError = validateFeedbackAttachments(payload.attachments);
  if (attachmentsError) {
    return attachmentsError;
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

/** Validate a `copyFeedbackReport` payload (same rules minus attachments/issue numbers). */
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
    attachmentNames?: unknown;
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
  const namesError = validateStringList(payload.attachmentNames, 'Attachment names');
  if (namesError) {
    return namesError;
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
