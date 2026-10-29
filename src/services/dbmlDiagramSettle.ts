/**
 * The settle pass for paths outside the editor (native DBML storage, §5.3
 * step 4, §5.7): every DBML diagram with a member in a folder whose
 * relationships file a library plan creates, or a member whose file the plan
 * moves, renames or deletes, re-rendered with no change of its own, so its
 * `use` lines stay valid in the same write.
 *
 * The editor has its own twin (`SemanticEditorProvider.settleDbmlDiagrams`)
 * that reads open documents; this one reads through `readText`. Both render
 * through core's `editSubjectAreaDbml`. No `vscode`: New Subject Area writers
 * and the CLI-bundled services may use it.
 */

import * as path from 'path';

import { editDiagramLayout, layoutFilePathOf, stickyLayoutsOf } from '@erd-studio/core';
import type { Annotation, NodePosition } from '@erd-studio/core';
import { editSubjectAreaDbml, parseSubjectAreaDbml } from '@erd-studio/core/dbml';
import type { DbmlDiagramTable } from '@erd-studio/core/dbml';

import type { FileWrite } from './fileWrites';
import type { DbmlLibraryWritePlan } from './dbmlLibraryWrites';
import { log } from './logger';

/** The library as a plan leaves it, for rendering a DBML diagram (the codec's `SubjectAreaResolver`, without `vscode`). */
export interface DbmlDiagramResolver {
  resolveTable(name: string): DbmlDiagramTable | undefined;
  relationshipsFilesFor(names: readonly string[]): string[];
  fileExists(relPath: string): boolean;
  pathChanged?: ReadonlySet<string>;
}

/** A plan's resolver: tables, relationships files and file existence after it, and every old and new name whose path changed. */
export function dbmlResolverOf(plan: DbmlLibraryWritePlan): DbmlDiagramResolver {
  const pathChanged = new Set<string>();
  for (const [oldName, newPath] of plan.pathChanged) {
    pathChanged.add(oldName.toLowerCase());
    if (newPath !== null) pathChanged.add(path.posix.basename(newPath).replace(/\.dbml$/i, '').toLowerCase());
  }
  // A table new in this plan gains its file: a diagram listing it in erd_unlinked_tables gives it a use line (D26).
  for (const name of plan.createdTables ?? []) pathChanged.add(name.toLowerCase());
  return {
    resolveTable: (name) => plan.resolveTable(name),
    relationshipsFilesFor: (names) => plan.relationshipsFilesFor(names),
    fileExists: (relPath) => plan.fileExists(relPath),
    ...(pathChanged.size > 0 ? { pathChanged } : {}),
  };
}

/** What {@link settleDbmlDiagramWrites} reads. */
export interface SettleInput {
  /** The semantic dir, absolute. */
  semanticRoot: string;
  /** Every DBML diagram to consider (absolute paths); the caller leaves out the ones it writes itself. */
  diagrams: readonly string[];
  plan: DbmlLibraryWritePlan;
  /** A file's text (absolute path), byte-order mark stripped; null when there is none. */
  readText(filePath: string): string | null;
  /**
   * A change to make to a diagram's v5 object before it is rendered (Give
   * Duplicate Its Own Name repoints only the diagrams whose `use` line
   * resolves to one copy); true when it changed something. A changed
   * position key also rewrites the layout file.
   */
  mutate?(filePath: string, obj: Record<string, unknown>): boolean;
  /** The resolver to render with (default: the plan's). */
  resolver?: DbmlDiagramResolver;
  /** Settle only the diagrams `mutate` changes. */
  mutatedOnly?: boolean;
}

/**
 * The replace writes of the settle pass (absolute paths). A diagram the
 * writer will not touch (it does not read, or holds a second Project) is
 * left as it is, as the editor's settle pass leaves it.
 */
export function settleDbmlDiagramWrites(input: SettleInput): FileWrite[] {
  const { plan } = input;
  const resolver = input.resolver ?? dbmlResolverOf(plan);
  const created = new Set(plan.createdRelationshipsFiles);
  const out: FileWrite[] = [];
  for (const filePath of input.diagrams) {
    const original = input.readText(filePath);
    if (original === null) continue;
    const rel = path.relative(input.semanticRoot, filePath).split(path.sep).join('/');
    let obj: Record<string, unknown>;
    const layoutPath = layoutFilePathOf(filePath);
    const layoutText = input.readText(layoutPath);
    try {
      obj = parseSubjectAreaDbml(original, rel, layoutText).obj;
    } catch {
      continue;
    }
    const before = structuredClone(obj);
    const mutated = input.mutate?.(filePath, obj) ?? false;
    const logical = (obj.logical ?? {}) as { models?: unknown };
    const members = Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const beforeMembers = ((before.logical ?? {}) as { models?: unknown }).models;
    const all = [...members, ...(Array.isArray(beforeMembers) ? beforeMembers.filter((m): m is string => typeof m === 'string') : [])];
    const createdTables = new Set((plan.createdTables ?? []).map((n) => n.toLowerCase()));
    const affected = mutated || !input.mutatedOnly && all.some((m) => plan.pathChanged.has(m.toLowerCase()) || createdTables.has(m.toLowerCase())
      || plan.relationshipsFilesFor([m]).some((f) => created.has(f)));
    if (!affected) continue;
    try {
      const text = editSubjectAreaDbml(original, {
        filePath: rel,
        before,
        after: obj,
        resolveTable: (name) => resolver.resolveTable(name),
        relationshipsFilesFor: (names) => resolver.relationshipsFilesFor(names),
        fileExists: (relPath) => resolver.fileExists(relPath),
        ...(resolver.pathChanged ? { pathChanged: resolver.pathChanged } : {}),
        refreshRelationshipsUses: true,
      });
      if (text !== original) out.push({ kind: 'replace', path: filePath, text });
      if (mutated) {
        const view = (o: Record<string, unknown>): { positions: Record<string, NodePosition>; annotations: Annotation[] } => {
          const v = (o.viewConfig ?? {}) as { positions?: Record<string, NodePosition>; annotations?: Annotation[] };
          return { positions: v.positions ?? {}, annotations: Array.isArray(v.annotations) ? v.annotations : [] };
        };
        const a = view(before);
        const b = view(obj);
        if (JSON.stringify(a.positions) !== JSON.stringify(b.positions)) {
          const next = editDiagramLayout(layoutText, b.positions, stickyLayoutsOf(b.annotations));
          if (next !== null) out.push(layoutText === null ? { kind: 'create', path: layoutPath, text: next } : { kind: 'replace', path: layoutPath, text: next });
        }
      }
    } catch (err) {
      log.warn(`[ERD Studio] ${filePath} left as it is: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
