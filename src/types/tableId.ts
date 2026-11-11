/**
 * A table's identity (its schema folder and name) and the reference rule
 * that names it in a scope, from `@erd-studio/core`
 * (packages/core/src/tableIdentity.ts). Free of `vscode`, so the host, the
 * CLI, the workers and the webview share one rule.
 */

export type {
  TableId,
  TableFileId,
  TableRefCandidate,
  TableRefStep,
  TableRefMatch,
  ResolveTableRefOptions,
} from '@erd-studio/core';
export {
  tableIdKey,
  sameTableId,
  tableIdOfPath,
  qualifiedRef,
  assignTableRefs,
  matchTableRef,
  resolveTableRef,
  resolveTableRefs,
} from '@erd-studio/core';
