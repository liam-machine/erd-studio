/**
 * Dropping tables on the canvas: Table Library rows dragged from the sidebar,
 * or table files dragged from the Explorer.
 *
 * When the host says a Table Library drag has started (`libraryDragStarted`),
 * the canvas shows "Hold Shift and drop to add … to this diagram" — until
 * the drop, the host's `libraryDragEnded` (the drag was used up: dropped on
 * a canvas or a diagram's row, or it missed the canvas and opened the file),
 * {@link LIBRARY_DRAG_HINT_MS}, the diagram changing or the host selecting a
 * table on it, or the webview's next pointer event (pointer events come back
 * once the drag is over). While an acceptable drag is over the canvas, it says
 * "Let go to add …".
 *
 * A drop event seldom reaches the canvas on macOS: VS Code turns the
 * webview's pointer events off during a workbench drag unless Shift is held
 * (the editor group then takes the drop and opens the file: the host's
 * missed-drop watcher offers the add), and with Shift Chromium
 * refuses to deliver a drag that started in the workbench to the webview's
 * out-of-process frame, so the drop reaches nothing. That last case is caught
 * here: the webview's first pointer event after the drag, when
 * {@link dragEndedOverCanvas} says the drag ended over the diagram, is posted
 * as a `dropTables` marked `afterDrag` (the host adds the drag it remembered,
 * if nothing used it up). See docs/dev/architecture.md, "Dragging tables from
 * the Table Library".
 *
 * When a drop does arrive: over an editable logical diagram, a drag that
 * carries URIs (or the Table Library drag the host announced) is accepted as
 * a copy and highlights the canvas; the drop posts `dropTables` with the flow
 * position and whatever URIs the DataTransfer holds — possibly none: the host
 * then uses the drag it remembered — and `fromLibrary` when the DataTransfer
 * carries the Table Library's own mime type (the host then uses the
 * remembered drag first: a tree drag's URIs are its table rows only, never a
 * schema or layer row's tables).
 *
 * Nothing is added on the physical stage or a read-only diagram: a drop
 * there is answered with {@link DROP_REFUSED_READ_ONLY} (the caller's toast)
 * instead of silence. The viewer takes no drop at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useReactFlow } from '@xyflow/react';
import { useIsViewer } from '@erd-studio/renderer/editor';

import { useSend } from './useMessageBus';
import { useEditorStore } from '../store/editorStore';
import { DROP_TABLES_URI_LIMIT, DROP_TABLES_URI_MAX_LENGTH, TABLE_LIBRARY_DRAG_MIME } from '../../src/types/messages';

/** How long the "Hold Shift and drop" hint stays without a drop or a pointer move (a long sidebar takes a while to cross). */
export const LIBRARY_DRAG_HINT_MS = 20_000;

/** How long a Table Library drag counts as in progress for accepting a drop (the host remembers it as long). */
export const LIBRARY_DRAG_FRESH_MS = 60_000;

/** The drop highlight goes once no `dragover` has arrived for this long (a missed `dragleave`). */
export const DRAG_OVER_IDLE_MS = 400;

/**
 * How far inside the webview's edges the first pointer event after a Table
 * Library drag must be to count as the drag having ended there: a pointer
 * coming in from the sidebar or the tab bar shows up within a move of the
 * edge.
 */
export const AFTER_DRAG_EDGE_PX = 32;

/** One pointer event, as {@link dragEndedOverCanvas} reads it. */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  /** How far the pointer moved since its last event (a real mouse reports it; 0 or absent when unknown). */
  readonly movementX?: number;
  readonly movementY?: number;
  /** The event's target is on the diagram itself (pane, table or line), not a toolbar, panel or dialog. */
  readonly onDiagram: boolean;
}

/**
 * Whether the webview's first pointer event after the host's
 * `libraryDragStarted` says the Table Library drag ended with the pointer
 * over this canvas, so the drop that never arrived was meant for it.
 *
 * On macOS Chromium does not deliver a drag that started in the workbench to
 * the webview's out-of-process frame (its drag target check refuses a frame
 * of another site), so a Shift-drop on the canvas usually reaches nothing;
 * the webview's pointer events then come back, and the first one comes the
 * moment the hand moves on, from where it let go. A pointer that
 * comes in from outside instead (the drag ended in the sidebar, the
 * Explorer, another editor) shows up at the webview's edge, or its last move
 * started outside: neither counts.
 */
export function dragEndedOverCanvas(sample: PointerSample, viewport: { readonly width: number; readonly height: number }): boolean {
  const { x, y } = sample;
  if (!sample.onDiagram || ![x, y, viewport.width, viewport.height].every(Number.isFinite)) return false;
  const inside = (px: number, py: number, margin: number): boolean =>
    px >= margin && py >= margin && px <= viewport.width - margin && py <= viewport.height - margin;
  if (!inside(x, y, AFTER_DRAG_EDGE_PX)) return false;
  const mx = Number.isFinite(sample.movementX) ? sample.movementX! : 0;
  const my = Number.isFinite(sample.movementY) ? sample.movementY! : 0;
  return inside(x - mx, y - my, 1);
}

/** DataTransfer types that carry URIs (types are lower case once in a DataTransfer). */
const URI_TYPES = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls'];

/** A VS Code tree's drag mime type (`application/vnd.code.tree.<view id>`). */
const TREE_TYPE_PREFIX = 'application/vnd.code.tree.';

/** What a drop on the physical stage (or any read-only diagram) is told: nothing is added there. */
export const DROP_REFUSED_READ_ONLY =
  'Tables are added on the Logical tab. Switch to Logical and drop again, or right-click the table in the Table Library and choose Add to Diagram…';

/**
 * The hint for a Table Library drag of `tables`; `over`: an acceptable drag
 * is over the canvas, so letting go adds them.
 */
export function libraryDragHintText(tables: readonly string[], over = false): string {
  const what = tables.length === 1 ? tables[0] : `${tables.length} tables`;
  return over
    ? `Let go to add ${what} to this diagram`
    : `Hold Shift and drop to add ${what} to this diagram. Keep Shift down until you let go.`;
}

type DataTransferLike = Pick<DataTransfer, 'getData'> & { readonly types?: ArrayLike<string> | readonly string[] };

/** One DataTransfer entry as text; '' when it is missing or cannot be read. */
function readData(dataTransfer: DataTransferLike, type: string): string {
  try {
    return dataTransfer.getData(type) ?? '';
  } catch {
    return '';
  }
}

/**
 * Every URI a drop's DataTransfer holds, each once, in order: the
 * `text/uri-list` and `application/vnd.code.uri-list` lines (comments left
 * out; a JSON array is read too) and the `ResourceURLs` JSON array. Anything
 * unreadable is skipped; at most {@link DROP_TABLES_URI_LIMIT}, none longer
 * than {@link DROP_TABLES_URI_MAX_LENGTH}.
 */
export function droppedUris(dataTransfer: DataTransferLike | null | undefined): string[] {
  if (!dataTransfer) return [];
  const uris: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const uri = value.trim();
    if (!uri || uri.startsWith('#') || uri.length > DROP_TABLES_URI_MAX_LENGTH || uris.includes(uri)) return;
    uris.push(uri);
  };
  const addJsonList = (text: string): boolean => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return false;
      parsed.forEach(add);
      return true;
    } catch {
      return false;
    }
  };
  for (const type of ['text/uri-list', 'application/vnd.code.uri-list']) {
    const text = readData(dataTransfer, type).trim();
    if (text.startsWith('[') && addJsonList(text)) continue;
    text.split(/\r?\n/).forEach(add);
  }
  const resources = readData(dataTransfer, 'ResourceURLs').trim();
  if (resources) addJsonList(resources);
  return uris.slice(0, DROP_TABLES_URI_LIMIT);
}

/** A DataTransfer's types, lower case (a browser lower-cases them; a test double may not). */
function typesOf(dataTransfer: DataTransferLike): string[] {
  return Array.from(dataTransfer.types ?? [], (t) => String(t).toLowerCase());
}

/** Whether a drag may be dropped on the canvas: it carries URIs, comes from a VS Code tree, or the host announced it. */
export function acceptsDrop(dataTransfer: DataTransferLike | null | undefined, libraryDragInProgress: boolean): boolean {
  if (!dataTransfer) return false;
  if (libraryDragInProgress) return true;
  return typesOf(dataTransfer).some((t) => URI_TYPES.includes(t) || t.startsWith(TREE_TYPE_PREFIX));
}

/** Whether a drop is a Table Library drag: its DataTransfer carries that view's own mime type. */
export function isLibraryDrag(dataTransfer: DataTransferLike | null | undefined): boolean {
  return !!dataTransfer && typesOf(dataTransfer).includes(TABLE_LIBRARY_DRAG_MIME);
}

export interface LibraryDropHandlers {
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

export interface LibraryDrop {
  /**
   * Spread on the canvas wrapper. On the physical stage or a read-only
   * diagram they add nothing and a drop is refused with a reason; undefined
   * in the viewer and before a diagram has loaded.
   */
  dropHandlers: LibraryDropHandlers | undefined;
  /** An acceptable drag is over the canvas: draw the drop highlight. */
  dropActive: boolean;
  /** The Table Library drag's tables while its hint shows, else null. */
  hintTables: string[] | null;
  /** The host's `libraryDragStarted`. */
  libraryDragStarted: (tables: readonly string[]) => void;
  /** The host's `libraryDragEnded`: the drag was used up elsewhere. */
  libraryDragEnded: () => void;
}

/**
 * The drop effect to ask for: copy (the table is added, not moved), unless the
 * drag allows only move or link. A drop effect the drag does not allow makes
 * the browser refuse the drop, and VS Code decides what a tree drag allows.
 */
export function dropEffectFor(effectAllowed: string | undefined): 'copy' | 'move' | 'link' {
  const allowed = (effectAllowed ?? 'uninitialized').toLowerCase();
  if (allowed === 'uninitialized' || allowed === 'all' || allowed.includes('copy')) return 'copy';
  if (allowed.includes('move')) return 'move';
  if (allowed.includes('link')) return 'link';
  return 'copy';
}

/**
 * Drop handling for the canvas (inside `ReactFlowProvider`). `onRefused` is
 * told why a drop added nothing (the canvas shows it as a toast).
 */
export function useLibraryDrop(onRefused?: (reason: string) => void): LibraryDrop {
  const viewer = useIsViewer();
  const domain = useEditorStore((s) => s.domain);
  const loaded = !!domain;
  const editable = !!domain && domain.stage === 'logical' && !domain.readOnly;
  const { screenToFlowPosition } = useReactFlow();
  const send = useSend();

  const [hintTables, setHintTables] = useState<string[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  /** A Table Library drag is announced and not over yet: the next pointer event in the webview ends it. */
  const [dragArmed, setDragArmed] = useState(false);
  /** When the announced Table Library drag started; undefined once it is over (a drop or a pointer move). */
  const libraryDragAt = useRef<number | undefined>(undefined);
  /** The announced drag's tables, kept after the hint times out: an acceptable drag over the canvas names them again. */
  const libraryDragTables = useRef<string[] | null>(null);
  const enterDepth = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const libraryDragStarted = useCallback((tables: readonly string[]) => {
    const names = tables.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (names.length === 0) return;
    libraryDragAt.current = Date.now();
    libraryDragTables.current = names;
    setHintTables(names);
    setDragArmed(true);
  }, []);

  const endLibraryDrag = useCallback(() => {
    libraryDragAt.current = undefined;
    libraryDragTables.current = null;
    setHintTables(null);
    setDragArmed(false);
  }, []);

  // The diagram changed under the hint, or the host selected a table on it
  // (`revealTable`): the tables were added (or found already there) another
  // way, such as a drop on the diagram's row. The hint has nothing left to say.
  const pendingReveal = useEditorStore((s) => s.pendingTableReveal);
  const domainAtHint = useRef(domain);
  const revealAtHint = useRef(pendingReveal);
  useEffect(() => {
    const revealed = pendingReveal !== null && revealAtHint.current !== pendingReveal;
    if ((domainAtHint.current !== domain || revealed) && hintTables) setHintTables(null);
    domainAtHint.current = domain;
    revealAtHint.current = pendingReveal;
  }, [domain, pendingReveal, hintTables]);

  // The hint goes after a while.
  useEffect(() => {
    if (!hintTables) return undefined;
    const timer = setTimeout(() => setHintTables(null), LIBRARY_DRAG_HINT_MS);
    return () => clearTimeout(timer);
  }, [hintTables]);

  // The drag is over at the webview's first pointer event: pointer events only
  // reach it again once the drag has ended. If it ended over this canvas and
  // no drop event came (see `dragEndedOverCanvas`), that is the drop: post it,
  // marked `afterDrag`, and the host adds the drag it remembered if no drop
  // used it up.
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  useEffect(() => {
    if (!dragArmed || viewer) return undefined;
    const onFirstPointer = (event: PointerEvent): void => {
      const at = libraryDragAt.current;
      endLibraryDrag();
      if (at === undefined || Date.now() - at > LIBRARY_DRAG_FRESH_MS || !loadedRef.current) return;
      const target = event.target as Element | null;
      const landed = dragEndedOverCanvas(
        {
          x: event.clientX,
          y: event.clientY,
          movementX: event.type === 'pointermove' ? event.movementX : 0,
          movementY: event.type === 'pointermove' ? event.movementY : 0,
          onDiagram: typeof target?.closest === 'function' && target.closest('.react-flow') !== null,
        },
        { width: window.innerWidth, height: window.innerHeight },
      );
      if (!landed) return;
      if (!editableRef.current) {
        onRefused?.(DROP_REFUSED_READ_ONLY);
        return;
      }
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      send({
        type: 'dropTables',
        payload: { position: { x: Math.round(point.x), y: Math.round(point.y) }, uris: [], fromLibrary: true, afterDrag: true },
      });
    };
    window.addEventListener('pointermove', onFirstPointer, true);
    window.addEventListener('pointerdown', onFirstPointer, true);
    return () => {
      window.removeEventListener('pointermove', onFirstPointer, true);
      window.removeEventListener('pointerdown', onFirstPointer, true);
    };
  }, [dragArmed, viewer, endLibraryDrag, screenToFlowPosition, send, onRefused]);

  const clearOver = useCallback(() => {
    enterDepth.current = 0;
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    idleTimer.current = undefined;
    setDropActive(false);
  }, []);

  const markOver = useCallback(() => {
    setDropActive(true);
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(clearOver, DRAG_OVER_IDLE_MS);
  }, [clearOver]);

  useEffect(() => () => {
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
  }, []);

  // Nothing may be dropped: no highlight left behind.
  useEffect(() => {
    if (!editable || viewer) clearOver();
  }, [editable, viewer, clearOver]);

  const inProgress = (): boolean =>
    libraryDragAt.current !== undefined && Date.now() - libraryDragAt.current <= LIBRARY_DRAG_FRESH_MS;

  const handlers: LibraryDropHandlers = {
    onDragEnter: (event) => {
      if (!acceptsDrop(event.dataTransfer, inProgress())) return;
      event.preventDefault();
      enterDepth.current += 1;
      markOver();
    },
    onDragOver: (event) => {
      if (!acceptsDrop(event.dataTransfer, inProgress())) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer.effectAllowed); } catch { /* read-only in some engines */ }
      markOver();
    },
    onDragLeave: () => {
      enterDepth.current = Math.max(0, enterDepth.current - 1);
      if (enterDepth.current === 0) clearOver();
    },
    onDrop: (event) => {
      if (!acceptsDrop(event.dataTransfer, inProgress())) return;
      event.preventDefault();
      clearOver();
      endLibraryDrag();
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      send({
        type: 'dropTables',
        payload: {
          position: { x: Math.round(point.x), y: Math.round(point.y) },
          uris: droppedUris(event.dataTransfer),
          ...(isLibraryDrag(event.dataTransfer) ? { fromLibrary: true } : {}),
        },
      });
    },
  };

  // The physical stage, or a read-only diagram: the drop is taken so that it
  // can be answered, and nothing is posted or highlighted.
  const refusing: LibraryDropHandlers = {
    onDragEnter: (event) => {
      if (acceptsDrop(event.dataTransfer, false)) event.preventDefault();
    },
    onDragOver: (event) => {
      if (acceptsDrop(event.dataTransfer, false)) event.preventDefault();
    },
    onDragLeave: () => undefined,
    onDrop: (event) => {
      if (!acceptsDrop(event.dataTransfer, false)) return;
      event.preventDefault();
      onRefused?.(DROP_REFUSED_READ_ONLY);
    },
  };

  // Over the canvas after the hint timed out: the drag's tables, named again ("Let go to add …").
  const shownTables = hintTables ?? (dropActive && inProgress() ? libraryDragTables.current : null);
  return {
    dropHandlers: viewer ? undefined : editable ? handlers : loaded ? refusing : undefined,
    dropActive: viewer ? false : editable && dropActive,
    hintTables: viewer ? null : editable ? shownTables : null,
    libraryDragStarted,
    libraryDragEnded: endLibraryDrag,
  };
}
