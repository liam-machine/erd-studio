/**
 * The naming migration (#182, part 4 of #162): a v5 project's files moved to
 * the v6 table naming, planned without touching disk.
 *
 * {@link planNamingMigration} takes the text of every subject area file and
 * every library table file and returns the moves and rewrites that turn
 * them into v6: `logical-models/…` → `tables/…` (a folder one level down
 * moves with its files), and in each file only the keys the naming renames.
 * Every other byte — comments, key order, unknown keys, number text,
 * anchors, line endings, and every relationship as stored (`one-to-many`,
 * a backwards `many-to-one`) — is kept. A v6 project plans nothing, so a
 * second run is a no-op. The extension applies the plan as one
 * `WorkspaceEdit`; `erd-studio doctor` only describes it. Pure: no `vscode`,
 * no `fs`.
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Pair, YAMLMap } from 'yaml';

import {
  LOGICAL_MODELS_DIR,
  TABLES_DIR,
  TABLE_NAMING_SCHEMA_VERSION,
  detectSubjectAreaFormat,
  toTableNamingDocument,
} from '@erd-studio/core';

import { insertFirstJsonMember, rewriteJsonScalars } from './minimalEdits';

/** One file the planner reads: its path relative to the semantic dir (`/`-separated) and its text. */
export interface NamingMigrationFile {
  readonly path: string;
  readonly text: string;
}

export interface NamingMigrationInput {
  /** Every subject area file (`{layer}/{name}.json`). */
  readonly subjectAreas: readonly NamingMigrationFile[];
  /** Every table file in `logical-models/` and `tables/`, top level or one folder down. */
  readonly tables: readonly NamingMigrationFile[];
  /** `tables/` is a layer folder (see the extension's `tablesDirIsLayer`): nothing may move into it. */
  readonly tablesFolderIsLayer: boolean;
}

/** A file moved from `logical-models/` to `tables/`; `text` is set when its keys change too. */
export interface NamingMigrationMove {
  readonly from: string;
  readonly to: string;
  readonly text?: string;
  /** The keys renamed in it, in file order (`modelRole → tableRole`, …). */
  readonly keys: readonly string[];
}

/** A subject area file whose keys change in place. */
export interface NamingMigrationRewrite {
  readonly path: string;
  readonly text: string;
  readonly keys: readonly string[];
}

export interface NamingMigrationPlan {
  readonly moves: readonly NamingMigrationMove[];
  readonly rewrites: readonly NamingMigrationRewrite[];
  /**
   * Why the project cannot migrate as it is. Non-empty means nothing may be
   * applied: the moves and rewrites are what the rest would be.
   */
  readonly refusals: readonly string[];
  /** Subject area files still in schema v4: "Migrate to v5" first, which then chains on. */
  readonly v4SubjectAreas: readonly string[];
  /** Files moved as they are, with why their keys were left (still read either way). */
  readonly notes: readonly string[];
}

/** The v5 → v6 key renames in a table file (#162). */
const TABLE_KEY_RENAMES = { modelRole: 'tableRole' } as const;
const RELATIONSHIP_KEY_RENAMES = { fromModel: 'fromTable', toModel: 'toTable' } as const;

/** Whether the plan has anything to apply. */
export function namingMigrationIsEmpty(plan: NamingMigrationPlan): boolean {
  return plan.moves.length === 0 && plan.rewrites.length === 0;
}

const isLibraryFile = (p: string, dir: string): boolean => p.startsWith(`${dir}/`);

/** The renamed keys of a table file's text, by splicing each key's own text; null when it is left as it is. */
function renameTableKeys(text: string): { text: string; keys: string[] } | { why: string } {
  let doc;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch {
    return { why: 'it does not parse as YAML' };
  }
  if (doc.errors.length > 0) return { why: `it has a YAML error (${doc.errors[0].code})` };
  if (!isMap(doc.contents)) return { why: 'it is not a YAML mapping' };
  const edits: Array<{ start: number; end: number; text: string; key: string }> = [];
  const renameIn = (map: YAMLMap, renames: Record<string, string>): void => {
    const has = (key: string): boolean => map.items.some((pair) => isScalar(pair.key) && pair.key.value === key);
    for (const pair of map.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.key.range) continue;
      const to = renames[pair.key.value];
      // A key whose v6 name is already written is left: the v6 one is what is read.
      if (to === undefined || has(to)) continue;
      const [start, end] = pair.key.range;
      const source = text.slice(start, end);
      // Only a key spelled out as itself (plain or quoted) is spliced; an
      // escaped one is left, and still read under its v5 name.
      if (!source.includes(pair.key.value)) continue;
      // The last occurrence: an anchor written before the key (`&modelRole modelRole:`) keeps its name.
      const at = source.lastIndexOf(pair.key.value);
      edits.push({ start, end, text: source.slice(0, at) + to + source.slice(at + pair.key.value.length), key: `${pair.key.value} → ${to}` });
    }
  };
  const root = doc.contents;
  renameIn(root, TABLE_KEY_RENAMES);
  const relationships = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'relationships')?.value;
  if (isSeq(relationships)) {
    for (const item of relationships.items) {
      if (isMap(item)) renameIn(item, RELATIONSHIP_KEY_RENAMES);
    }
  }
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { text: out, keys: edits.sort((a, b) => a.start - b.start).map((e) => e.key) };
}

/** The keys that differ between a document and its v6 version, for the preview. */
function renamedKeysOf(before: unknown, after: unknown, out: string[] = []): string[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    before.forEach((b, i) => renamedKeysOf(b, after[i], out));
  } else if (before && after && typeof before === 'object' && typeof after === 'object') {
    const b = Object.keys(before);
    const a = Object.keys(after);
    b.forEach((key, i) => {
      if (a[i] !== undefined && a[i] !== key) out.push(`${key} → ${a[i]}`);
      renamedKeysOf((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[a[i] ?? key], out);
    });
  }
  return out;
}

/** A v5 subject area file's text in the v6 naming, every other byte kept; null when it cannot be done in place. */
function renameSubjectAreaKeys(text: string, parsed: Record<string, unknown>): { text: string; keys: string[] } | null {
  const target = toTableNamingDocument(parsed);
  const hadVersion = 'schemaVersion' in parsed;
  // No `schemaVersion` (a v5 file can say so by its content alone): rename in place, then add it first.
  const { schemaVersion: _added, ...renamed } = target;
  const inPlace = hadVersion ? target : renamed;
  const keys = [...new Set(renamedKeysOf(parsed, inPlace))];
  const out = rewriteJsonScalars(text, inPlace);
  if (out === null) return null;
  if (hadVersion) return { text: out, keys: [...keys, `schemaVersion ${String(parsed.schemaVersion)} → ${TABLE_NAMING_SCHEMA_VERSION}`] };
  const withVersion = insertFirstJsonMember(out, 'schemaVersion', TABLE_NAMING_SCHEMA_VERSION);
  return withVersion === null ? null : { text: withVersion, keys: [...keys, `schemaVersion ${TABLE_NAMING_SCHEMA_VERSION} added`] };
}

/** The table name a library path holds (its file stem). */
const stemOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.yml$/, '');

/**
 * Plan the move of a project to the v6 file naming. Refuses, saying why, a
 * project with a layer called `tables`, a table name in both libraries
 * (ignoring case), two files that would land on one path on a
 * case-insensitive file system, and a subject area file that does not load
 * (a v4 one is listed in `v4SubjectAreas`: "Migrate to v5" chains on).
 */
export function planNamingMigration(input: NamingMigrationInput): NamingMigrationPlan {
  const refusals: string[] = [];
  const notes: string[] = [];
  const v4SubjectAreas: string[] = [];
  const moves: NamingMigrationMove[] = [];
  const rewrites: NamingMigrationRewrite[] = [];

  const v5Tables = input.tables.filter((f) => isLibraryFile(f.path, LOGICAL_MODELS_DIR));
  const v6Tables = input.tables.filter((f) => isLibraryFile(f.path, TABLES_DIR));

  if (input.tablesFolderIsLayer && v5Tables.length > 0) {
    refusals.push(
      `This project has a layer called "${TABLES_DIR}", and the new naming keeps the Table Library in .erd-studio/${TABLES_DIR}/. ` +
        `Rename that layer (its folder and its id in layers.json), then migrate.`,
    );
  }

  // A name in both libraries is two definitions of one table: which to keep is the user's call.
  const v6Names = new Map(v6Tables.map((f) => [stemOf(f.path).toLowerCase(), f.path]));
  for (const file of v5Tables) {
    const other = v6Names.get(stemOf(file.path).toLowerCase());
    if (other !== undefined) {
      refusals.push(`"${stemOf(file.path)}" has a file in both ${file.path} and ${other}. Keep one of them, then migrate.`);
    }
  }

  // Two files landing on one path once case is ignored (macOS and Windows file systems).
  const taken = new Map(v6Tables.map((f) => [f.path.toLowerCase(), f.path]));
  for (const file of v5Tables) {
    const to = `${TABLES_DIR}/${file.path.slice(LOGICAL_MODELS_DIR.length + 1)}`;
    const clash = taken.get(to.toLowerCase());
    if (clash !== undefined && clash !== to && !v6Names.has(stemOf(file.path).toLowerCase())) {
      refusals.push(`${file.path} and ${clash} differ only in case, so they would be one file on macOS and Windows. Rename one, then migrate.`);
    } else if (clash !== undefined && clash !== to) {
      // Reported above, by name.
    } else if (clash === undefined) {
      taken.set(to.toLowerCase(), file.path);
    }
    const renamed = renameTableKeys(file.text);
    if ('why' in renamed) {
      notes.push(`${file.path} is moved as it is: ${renamed.why}. Its keys are still read under their old names.`);
      moves.push({ from: file.path, to, keys: [] });
    } else {
      moves.push({ from: file.path, to, keys: renamed.keys, ...(renamed.keys.length > 0 ? { text: renamed.text } : {}) });
    }
  }

  for (const file of input.subjectAreas) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text.replace(/^﻿/, ''));
    } catch {
      refusals.push(`${file.path} is not valid JSON (an unfinished edit or a merge conflict?). Fix it, then migrate.`);
      continue;
    }
    const format = detectSubjectAreaFormat(parsed);
    if (format === 'v6') continue;
    // A v4 file with no inline table has nothing for "Migrate to v5" to move
    // (it skips such files): it is renamed in place, as a v5 file is.
    const inline = ((parsed as { logical?: { models?: unknown } }).logical?.models);
    if (format === 'v4' && Array.isArray(inline) && inline.length > 0) {
      v4SubjectAreas.push(file.path);
      continue;
    }
    if (format !== 'v5' && format !== 'v4') {
      refusals.push(`${file.path} does not load (it is a ${format} file). Fix it, then migrate.`);
      continue;
    }
    const renamed = renameSubjectAreaKeys(file.text, parsed as Record<string, unknown>);
    if (renamed === null) {
      refusals.push(`${file.path} holds a key in both namings, so it cannot be renamed in place. Remove the one not read, then migrate.`);
      continue;
    }
    rewrites.push({ path: file.path, ...renamed });
  }
  if (v4SubjectAreas.length > 0) {
    refusals.push(
      `${v4SubjectAreas.length} diagram file${v4SubjectAreas.length === 1 ? ' is' : 's are'} still in schema v4 ` +
        `(${v4SubjectAreas.join(', ')}). Run "Migrate Subject Areas to the Central Table Library" first; it carries on into this migration.`,
    );
  }

  return { moves, rewrites, refusals, v4SubjectAreas, notes };
}

/** The plan in words: the modal's detail and `erd-studio doctor`'s preview. */
export function describeNamingMigration(plan: NamingMigrationPlan): string {
  const lines: string[] = [];
  if (plan.refusals.length > 0) {
    lines.push('Can\'t migrate yet:', ...plan.refusals.map((r) => `• ${r}`), '');
  }
  if (plan.moves.length > 0) {
    lines.push(`Move ${plan.moves.length} table file${plan.moves.length === 1 ? '' : 's'} to ${TABLES_DIR}/:`);
    for (const move of plan.moves) {
      lines.push(`• ${move.from} → ${move.to}${move.keys.length > 0 ? ` (${move.keys.join(', ')})` : ''}`);
    }
  }
  if (plan.rewrites.length > 0) {
    lines.push(`Rename keys in ${plan.rewrites.length} diagram file${plan.rewrites.length === 1 ? '' : 's'}:`);
    for (const rewrite of plan.rewrites) lines.push(`• ${rewrite.path} (${rewrite.keys.join(', ')})`);
  }
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  if (lines.length === 0) lines.push('Nothing to change: this project already uses the new file naming.');
  return lines.join('\n');
}
