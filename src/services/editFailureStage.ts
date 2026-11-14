/**
 * Where in the edit pipeline a canvas edit threw (#319). `applySubjectAreaEdit`
 * keeps a cursor as it goes and tags whatever it throws with the cursor's
 * state; the handler's catch reads the tag for usage telemetry (which stage,
 * which storage) and for the toast (whether the change had been made).
 *
 * The first tag wins, so an edit nested in another keeps the inner stage.
 * vscode-free. Holds the errors weakly. A thrown value that is not an object
 * cannot be tagged and reads as untagged (a throw outside the pipeline).
 */

/** The stages of one edit, in order. `other`: after the save (the redraw and the refreshes). */
export type EditStage = 'read' | 'mutate' | 'layoutWrite' | 'storageWrite' | 'jsonWrite' | 'save' | 'other';

/** What kind of file the diagram being edited is. */
export type EditStorage = 'dbml' | 'json';

/** How far one edit has got. */
export interface EditCursor {
  stage: EditStage;
  /** Unknown until the diagram has been read. */
  storage?: EditStorage;
  /** VS Code applied the edit: the change is in the documents, saved or not. */
  applied: boolean;
}

/** What a failure is tagged with: the cursor as it stood at the throw. */
export type EditFailureTag = Readonly<EditCursor>;

export function newEditCursor(): EditCursor {
  return { stage: 'read', applied: false };
}

const tags = new WeakMap<object, EditFailureTag>();

/** Tag `err` with where the edit was; a tag it already has is kept. */
export function tagEditFailure(err: unknown, at: EditCursor): void {
  if (typeof err !== 'object' || err === null || tags.has(err)) return;
  tags.set(err, { ...at });
}

/** Where the edit was when `err` was thrown; undefined for a throw outside the pipeline. */
export function editFailureTag(err: unknown): EditFailureTag | undefined {
  return typeof err === 'object' && err !== null ? tags.get(err) : undefined;
}
