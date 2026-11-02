/**
 * Dropping tables on the canvas: Table Library rows dragged from the sidebar,
 * or table files dragged from the Explorer.
 *
 * VS Code lets a drag that started in the workbench reach a webview only
 * while Shift is held (without it the editor group takes the drop and opens
 * the file). So when the host says a Table Library drag has started
 * (`libraryDragStarted`), the canvas shows "Hold Shift and drop to add … to
 * this diagram" — until the drop, {@link LIBRARY_DRAG_HINT_MS}, or the next
 * pointer move inside the webview (pointer events come back once the drag is
 * over).
 *
 * Over an editable logical diagram, a drag that carries URIs (or the Table
 * Library drag the host announced) is accepted as a copy and highlights the
 * canvas; the drop posts `dropTables` with the flow position and whatever
 * URIs the DataTransfer holds — possibly none, since what VS Code puts there
 * for a tree drag is not guaranteed: the host then uses the drag it
 * remembered. Never on the physical stage, a read-only diagram, or in the
 * viewer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useReactFlow } from '@xyflow/react';
import { useIsViewer } from '@erd-studio/renderer/editor';

import { useSend } from './useMessageBus';
import { useEditorStore } from '../store/editorStore';
import { DROP_TABLES_URI_LIMIT, DROP_TABLES_URI_MAX_LENGTH } from '../../src/types/messages';

/** How long the "Hold Shift and drop" hint stays without a drop or a pointer move. */
export const LIBRARY_DRAG_HINT_MS = 8000;

/** How long a Table Library drag counts as in progress for accepting a drop (the host remembers it as long). */
export const LIBRARY_DRAG_FRESH_MS = 60_000;

/** The drop highlight goes once no `dragover` has arrived for this long (a missed `dragleave`). */
export const DRAG_OVER_IDLE_MS = 400;

/** DataTransfer types that carry URIs (types are lower case once in a DataTransfer). */
const URI_TYPES = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls'];

/** A VS Code tree's drag mime type (`application/vnd.code.tree.<view id>`). */
const TREE_TYPE_PREFIX = 'application/vnd.code.tree.';

/** The hint for a Table Library drag of `tables`. */
export function libraryDragHintText(tables: readonly string[]): string {
  const what = tables.length === 1 ? tables[0] : `${tables.length} tables`;
  return `Hold Shift and drop to add ${what} to this diagram`;
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

/** Whether a drag may be dropped on the canvas: it carries URIs, comes from a VS Code tree, or the host announced it. */
export function acceptsDrop(dataTransfer: DataTransferLike | null | undefined, libraryDragInProgress: boolean): boolean {
  if (!dataTransfer) return false;
  if (libraryDragInProgress) return true;
  const types = Array.from(dataTransfer.types ?? [], (t) => String(t).toLowerCase());
  return types.some((t) => URI_TYPES.includes(t) || t.startsWith(TREE_TYPE_PREFIX));
}

export interface LibraryDropHandlers {
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

export interface LibraryDrop {
  /** Spread on the canvas wrapper; undefined where nothing may be dropped (physical, read-only, viewer). */
  dropHandlers: LibraryDropHandlers | undefined;
  /** An acceptable drag is over the canvas: draw the drop highlight. */
  dropActive: boolean;
  /** The Table Library drag's tables while its hint shows, else null. */
  hintTables: string[] | null;
  /** The host's `libraryDragStarted`. */
  libraryDragStarted: (tables: readonly string[]) => void;
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

/** Drop handling for the canvas (inside `ReactFlowProvider`). */
export function useLibraryDrop(): LibraryDrop {
  const viewer = useIsViewer();
  const domain = useEditorStore((s) => s.domain);
  const editable = !!domain && domain.stage === 'logical' && !domain.readOnly;
  const { screenToFlowPosition } = useReactFlow();
  const send = useSend();

  const [hintTables, setHintTables] = useState<string[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  /** When the announced Table Library drag started; undefined once it is over (a drop or a pointer move). */
  const libraryDragAt = useRef<number | undefined>(undefined);
  const enterDepth = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const libraryDragStarted = useCallback((tables: readonly string[]) => {
    const names = tables.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (names.length === 0) return;
    libraryDragAt.current = Date.now();
    setHintTables(names);
  }, []);

  const endLibraryDrag = useCallback(() => {
    libraryDragAt.current = undefined;
    setHintTables(null);
  }, []);

  // The hint goes after a while, or as soon as the pointer moves in the
  // webview: pointer events only reach it again once the drag is over.
  useEffect(() => {
    if (!hintTables) return undefined;
    const timer = setTimeout(() => setHintTables(null), LIBRARY_DRAG_HINT_MS);
    window.addEventListener('pointermove', endLibraryDrag);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', endLibraryDrag);
    };
  }, [hintTables, endLibraryDrag]);

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
        payload: { position: { x: Math.round(point.x), y: Math.round(point.y) }, uris: droppedUris(event.dataTransfer) },
      });
    },
  };

  return {
    dropHandlers: viewer ? undefined : editable ? handlers : undefined,
    dropActive: viewer ? false : editable && dropActive,
    hintTables: viewer ? null : editable ? hintTables : null,
    libraryDragStarted,
  };
}
