/**
 * "Not shown" notes: what the user's files hold that the canvas is not
 * drawing, said on the canvas (the `filesNotShown` message and the strip
 * above the diagram, `webview/components/Canvas/FilesNotShownBanner.tsx`).
 *
 * The canvas follows the files: every save redraws it. A note is the other
 * half of that promise: when something in a file cannot be drawn, the canvas
 * says so, with the file and line, for as long as it is true, and the note
 * goes by itself when the file is fixed. Shared by the host and the webview;
 * imports nothing.
 */

/** What a note is about. Fixed names: the webview picks its wording's lead and its button by them. */
export type FileNoteCode =
  /** The diagram's own file stopped reading, so the canvas still shows it as it last read. */
  | 'diagramNotRead'
  /** The diagram's file holds changes that could not be saved, so the canvas shows the file on disk. */
  | 'diagramUnsaved'
  /** A redraw after a file change failed inside ERD Studio: the diagram may be out of date. */
  | 'refreshFailed'
  /** A relationships file holds a relationship between two of the diagram's tables, and the diagram does not import it. */
  | 'relationshipsNotImported'
  /** A `Ref`, an inline `[ref: …]` or a `use` line written in a table file: read past, never drawn. */
  | 'notDrawnInTableFile'
  /** A relationships file that does not read (a syntax error, conflict markers): none of its relationships are drawn. */
  | 'relationshipsFileNotRead'
  /** A `.dbml` file saved where ERD Studio reads no file. */
  | 'fileNotRead';

/** What a note's button does: both are requests to the host, which decides. */
export type FileNoteAction =
  /** Add the missing relationships imports to this diagram (one edit, one undo step). */
  | 'addRelationshipsImports'
  /** Read every file again and redraw (writes nothing). */
  | 'reloadFromDisk';

/** One thing in the files that the canvas is not showing. */
export interface FileNote {
  code: FileNoteCode;
  /** Plain words: what is not shown and what to do about it. */
  message: string;
  /** The file to open, relative to the workspace folder, with `/` separators. */
  file?: string;
  /** 1-based line in {@link file}. */
  line?: number;
  action?: FileNoteAction;
}

/** The `filesNotShown` payload: every note for one canvas, most urgent first. Empty clears the strip. */
export interface FilesNotShownPayload {
  items: FileNote[];
}

/** The button label of each action. */
export const FILE_NOTE_ACTION_LABELS: Readonly<Record<FileNoteAction, string>> = {
  addRelationshipsImports: 'Add the import',
  reloadFromDisk: 'Reload from disk',
};

const CODES: ReadonlySet<string> = new Set<FileNoteCode>([
  'diagramNotRead', 'diagramUnsaved', 'refreshFailed', 'relationshipsNotImported',
  'notDrawnInTableFile', 'relationshipsFileNotRead', 'fileNotRead',
]);

const ACTIONS: ReadonlySet<string> = new Set<FileNoteAction>(['addRelationshipsImports', 'reloadFromDisk']);

/** Whether `value` is a note the webview can draw (a host from another version may send anything). */
export function isFileNote(value: unknown): value is FileNote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  return typeof note.code === 'string' && CODES.has(note.code)
    && typeof note.message === 'string' && note.message.length > 0
    && (note.file === undefined || typeof note.file === 'string')
    && (note.line === undefined || (typeof note.line === 'number' && Number.isInteger(note.line) && note.line >= 1))
    && (note.action === undefined || (typeof note.action === 'string' && ACTIONS.has(note.action)));
}

/** A stable identity for a list of notes: the strip a reader hid stays hidden until this changes. */
export function fileNotesSignature(items: readonly FileNote[]): string {
  return items.map((n) => `${n.code}\u0001${n.file ?? ''}\u0001${n.line ?? ''}\u0001${n.message}`).join('\u0002');
}
