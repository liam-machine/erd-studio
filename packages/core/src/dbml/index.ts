/**
 * `@erd-studio/core/dbml` — native DBML storage: the readers and the
 * writers (splicers) of `.dbml` table, relationships and diagram files, and the
 * multi-file compile `doctor` uses. These are the only modules that load
 * the DBML parser; the main entry stays parser-free, so the webview and the
 * renderer never pay for the parser.
 *
 * Every export is typed with ERD Studio's own types: nothing here names a
 * type from the parser package, whose declarations import an uninstalled package.
 * Pass `dbml: dbmlStorageReader` to `loadDisplaySubjectArea` to read DBML
 * diagrams.
 */

import type { DbmlStorageReader } from '../types/dbmlStorage.js';
import { parseTableDbml } from './readTable.js';
import { readRelationshipsDbml } from './readRelationships.js';
import { parseSubjectAreaDbml, subjectAreaMembersDbml } from './readDiagram.js';

export { parseTableDbml } from './readTable.js';
export type { ParseTableDbmlOptions } from './readTable.js';
export { readRelationshipsDbml } from './readRelationships.js';
export { parseSubjectAreaDbml, subjectAreaMembersDbml, diagramSummaryDbml, diagramUseRole } from './readDiagram.js';
export type { DbmlDiagramSummary, DiagramUseRole } from './readDiagram.js';
export { compileDbmlProject } from './compileProject.js';
export { outlineDbmlFile } from './outline.js';
export { renderNewTableDbml, editTableDbml, renamedColumnsOf } from './writeTable.js';
export type { EditTableDbmlOptions, ForeignDbmlMetadata } from './writeTable.js';
export { editRelationshipsDbml, relationshipUnits, refUnitSortKey, usePathBetween, DBML_CONVERT_FIRST_MESSAGE } from './writeRelationships.js';
export type { RefUnit, RelationshipsFileEdit, DbmlResolvedTable } from './writeRelationships.js';
export { renderNewSubjectAreaDbml, editSubjectAreaDbml, pendingRelationshipRef } from './writeDiagram.js';
export type { SubjectAreaDbmlEdit, NewSubjectAreaDbml, DbmlDiagramTable } from './writeDiagram.js';
export { readErdLayoutDbml, erdLayoutEntrySpan, editDiagramLayoutDbml } from './erdLayoutDbml.js';
export type { ErdLayoutDbmlReading, ErdLayoutProblem, DiagramLayoutEdit } from './erdLayoutDbml.js';
export { formatDbml } from './format.js';
export type { DbmlFormatOptions, DbmlFormatResult, DbmlFormatSkipReason } from './format.js';
export { applyTextEdits } from './splice.js';
export type { TextEdit } from './splice.js';
export { DbmlEditRefused } from './errors.js';
export type { DbmlParserModule } from './parserModule.js';
// Parser-free, from the main entry: re-exported so a host reading a project needs one import.
export { attachRelationships, dbmlTableLookup } from '../dbmlAttach.js';

/** The readers `loadDisplaySubjectArea` takes as its `dbml` option, bound to the pinned parser. */
export const dbmlStorageReader: DbmlStorageReader = Object.freeze({
  parseTable: (text: string, fileStem: string, options?: { schemaFolder?: string }) => parseTableDbml(text, fileStem, options),
  readRelationships: (text: string) => readRelationshipsDbml(text),
  parseSubjectArea: (text: string, filePath: string) => parseSubjectAreaDbml(text, filePath),
  subjectAreaMembers: (text: string, filePath: string) => subjectAreaMembersDbml(text, filePath),
});
