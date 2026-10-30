/**
 * Shared helpers for the DBML writer tests (§9.3 of the native DBML storage
 * spec): reading a table back, building the resolvers the relationships and
 * diagram writers take from a map of files, the multi-file compile every
 * written text is held to under 9.1.1, 10.3.1 and 11.0.0 (errors and
 * warnings, through each parser's own diagnostics provider), and a small
 * seeded PRNG. Not a test file.
 */
import * as DbmlParse from '@dbml/parse';
import * as DbmlParseV9 from 'dbml-parse-v9';
import * as DbmlParseV10 from 'dbml-parse-v10';

import { parseTableDbml } from '../src/dbml/readTable';
import { readRelationshipsDbml } from '../src/dbml/readRelationships';
import { attachRelationships, dbmlTableLookup } from '../src/dbmlAttach';
import { classifySemanticFile } from '../src/storage';
import type { DbmlResolvedTable } from '../src/dbml/writeRelationships';
import type { DbmlDiagramTable } from '../src/dbml/writeDiagram';
import type { DbmlAttachTable } from '../src/types/dbmlStorage';
import type { SemanticTable, TableRelationship } from '../src/types/semantic';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = any;

/** The three parser modules, with their diagnostics providers, oldest first. */
export const DIAGNOSTIC_PARSERS: ReadonlyArray<readonly [string, Loose]> = [
  ['9.1.1', DbmlParseV9],
  ['10.3.1', DbmlParseV10],
  ['11.0.0', DbmlParse],
];

const ROOT = '/erd-studio/';

/** One diagnostic of a multi-file compile: the parser, the file (relative), its type and text. */
export interface ProjectDiagnostic {
  parser: string;
  file: string;
  type: string;
  text: string;
}

/**
 * Every error and warning the parsers report for `files` (posix paths
 * relative to the semantic dir) compiled as one project, each entry
 * diagnosed with the files it `use`s. `parsers` narrows the list (a text
 * holding an 11.0-only typed value is held to 11.0.0 alone).
 */
export function projectDiagnostics(
  files: Readonly<Record<string, string>>,
  entries: readonly string[] = Object.keys(files),
  parsers: readonly string[] = DIAGNOSTIC_PARSERS.map(([v]) => v),
): ProjectDiagnostic[] {
  const out: ProjectDiagnostic[] = [];
  for (const [version, P] of DIAGNOSTIC_PARSERS) {
    if (!parsers.includes(version)) continue;
    const layout = new P.MemoryProjectLayout();
    for (const [path, text] of Object.entries(files)) {
      layout.setSource(P.Filepath.from(ROOT + path), text.replace(/^﻿/, ''));
    }
    const compiler = new P.Compiler(layout);
    const provider = new P.DBMLDiagnosticsProvider(compiler);
    for (const entry of entries) {
      for (const d of provider.provideDiagnostics(P.Filepath.from(ROOT + entry)) as Loose[]) {
        if (d.type !== 'error' && d.type !== 'warning') continue;
        out.push({ parser: version, file: entry, type: d.type, text: `${d.startRow ?? '?'}: ${d.text}` });
      }
    }
  }
  return out;
}

/** Whether `files` compile with no error or warning in every parser (or in those named). */
export function cleanEverywhere(files: Readonly<Record<string, string>>, entries?: readonly string[], parsers?: readonly string[]): boolean {
  return projectDiagnostics(files, entries, parsers).length === 0;
}

/** The stem of a `.dbml` path. */
export function stemOf(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.dbml$/i, '');
}

/** Read a table file, or throw with its error. */
export function readTable(text: string, stem: string): Extract<ReturnType<typeof parseTableDbml>, { ok: true }> {
  const reading = parseTableDbml(text, stem);
  if (!reading.ok) throw new Error(`${stem}: ${reading.error.message}`);
  return reading;
}

/** A deep copy (JSON shapes only). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** What a path relative to the semantic dir is, in the layer-first tree. */
function kindOf(path: string): ReturnType<typeof classifySemanticFile> {
  return classifySemanticFile(path, { tablesDirIsLayer: false });
}

/** The library's table files in `files` (`<layer>/tables/<schema>/<name>.dbml`). */
export function tableFilesOf(files: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(files).filter(([path]) => kindOf(path).kind === 'table' && kindOf(path).storage === 'dbml');
}

/** A table the writers resolve: read from its file, plus extra YAML tables by name. */
interface LibraryTable {
  table: SemanticTable;
  reference: string;
  path: string;
  folder: string;
  alias?: string;
  storage: 'yaml' | 'dbml';
}

/** Every table in `files`, read; `yaml` adds YAML tables (name → path) with no DBML file. */
export function libraryOf(files: Readonly<Record<string, string>>, yaml: Readonly<Record<string, string>> = {}): LibraryTable[] {
  const out: LibraryTable[] = [];
  for (const [path, text] of tableFilesOf(files)) {
    const reading = parseTableDbml(text, stemOf(path), { schemaFolder: kindOf(path).schema });
    if (!reading.ok) continue;
    out.push({
      table: reading.table,
      reference: reading.declaredReference,
      path,
      // 2.0-switch: S6a drops the attach folder; no Ref has a home folder in the layer-first tree.
      folder: kindOf(path).schema ?? '',
      ...(reading.alias !== undefined ? { alias: reading.alias } : {}),
      storage: 'dbml',
    });
  }
  for (const [name, path] of Object.entries(yaml)) {
    out.push({ table: { name, columns: [{ name: 'id', dataType: 'int', description: '' }] }, reference: name, path, folder: '', storage: 'yaml' });
  }
  return out;
}

/** `resolve` for the relationships writer over a library (names and DBML aliases, without case). */
export function relationshipsResolver(library: readonly LibraryTable[]): (name: string) => DbmlResolvedTable | undefined {
  return (name) => {
    const entry = library.find((t) => t.table.name.toLowerCase() === name.toLowerCase())
      ?? library.find((t) => t.alias !== undefined && t.alias.toLowerCase() === name.toLowerCase());
    if (!entry) return undefined;
    const columns = (entry.table.columns ?? []).map((c) => c.name);
    return {
      name: entry.table.name,
      reference: entry.reference,
      columns: (column) => columns.find((c) => c === column) ?? columns.find((c) => c.toLowerCase() === column.toLowerCase()),
      path: entry.path,
      storage: entry.storage,
      primaryKey: (entry.table.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name),
    };
  };
}

/** `resolveTable` for the diagram writer over a library. */
export function diagramResolver(library: readonly LibraryTable[]): (name: string) => DbmlDiagramTable | undefined {
  const resolve = relationshipsResolver(library);
  return (name) => {
    const r = resolve(name);
    return r ? { name: r.name, reference: r.reference, path: r.path, storage: r.storage } : undefined;
  };
}

/** The relationships files in `files` (`<layer>/relationships/<f>.dbml`), in path byte order. */
export function relationshipsFilesOf(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files).filter((p) => kindOf(p).kind === 'relationships').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Each owner's relationships, read from every relationships file of `files` and attached (§2.4), keyed lower-case. */
export function ownersOf(files: Readonly<Record<string, string>>, library: readonly LibraryTable[] = libraryOf(files)): Map<string, TableRelationship[]> {
  const readings = relationshipsFilesOf(files).map((path) => ({ path, folder: '', reading: readRelationshipsDbml(files[path]) }));
  const attach: DbmlAttachTable[] = library.map((t) => ({
    table: t.table,
    folder: t.folder,
    storage: t.storage,
    ...(t.alias !== undefined ? { dbmlAlias: t.alias } : {}),
  }));
  return attachRelationships(readings, dbmlTableLookup(attach)).byOwner;
}

/** Each owner's relationships as ONE relationships file holds them (attached against the whole library), keyed lower-case. */
export function ownersOfFile(files: Readonly<Record<string, string>>, file: string, library: readonly LibraryTable[] = libraryOf(files)): Map<string, TableRelationship[]> {
  const others = Object.fromEntries(Object.entries(files).filter(([p]) => kindOf(p).kind !== 'relationships'));
  return ownersOf({ ...others, [file]: files[file] }, library);
}

/**
 * Relationships without `compositeKey` names and in a stable order, for
 * comparing what a file means. A one-member composite group is a plain
 * relationship (§2.8: a lone key is written as a one-column Ref).
 */
export function comparableRelationships(list: readonly TableRelationship[] | undefined): Array<Record<string, unknown>> {
  // A group is named by what it joins (its column pairs, sorted), so the order entries come in does not matter.
  const members = new Map<string, string[]>();
  const groupOf = (r: TableRelationship): string | undefined => (r.compositeKey ? `${r.toModel.toLowerCase()}\u0000${r.compositeKey}` : undefined);
  for (const r of list ?? []) {
    const key = groupOf(r);
    if (key) members.set(key, [...(members.get(key) ?? []), `${r.fromColumn.toLowerCase()}>${r.toColumn.toLowerCase()}`]);
  }
  return (list ?? []).map((r) => {
    const key = groupOf(r);
    const pairs = key ? members.get(key)! : [];
    return {
      fromColumn: r.fromColumn.toLowerCase(),
      toModel: r.toModel.toLowerCase(),
      toColumn: r.toColumn.toLowerCase(),
      cardinality: r.cardinality,
      role: r.role ?? null,
      group: pairs.length > 1 ? [...pairs].sort().join(',') : null,
    };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** mulberry32: a tiny seeded PRNG (no dependency), returning numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One written text and what it needs to compile (§9.3 `dbmlMultiParser`). */
export interface WriterOutcome {
  /** The written file, relative to the semantic dir. */
  path: string;
  output: string;
  /** The files it is compiled with (its `use` targets), without the written one. */
  context?: Record<string, string>;
  /** The text the writer was given (null for a new file); Law 5 holds the output to the parsers this input compiles clean in. */
  input?: string | null;
  /** The parsers to hold the output to, when not worked out from `input`. */
  parsers?: readonly string[];
}

/** A writer test case whose output the multi-parser test compiles again. */
export interface WriterCase {
  name: string;
  run(): WriterOutcome;
  check(outcome: WriterOutcome): void;
}

/**
 * The parsers Law 5 holds an outcome to: those in which its input (with
 * the same context) compiled with no error or warning, or all three for a
 * new file.
 */
export function lawFiveParsers(outcome: WriterOutcome): string[] {
  const all = DIAGNOSTIC_PARSERS.map(([v]) => v);
  if (outcome.parsers) return [...outcome.parsers];
  if (outcome.input === undefined || outcome.input === null) return all;
  const files = { ...(outcome.context ?? {}), [outcome.path]: outcome.input };
  return all.filter((v) => projectDiagnostics(files, [outcome.path], [v]).length === 0);
}

/** The project a {@link WriterOutcome} compiles as: its context plus the written file. */
export function projectOf(outcome: WriterOutcome): Record<string, string> {
  return { ...(outcome.context ?? {}), [outcome.path]: outcome.output };
}
