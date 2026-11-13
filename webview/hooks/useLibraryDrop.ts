/**
 * Dropping tables on the canvas: Table Library rows dragged from the sidebar,
 * or table files dragged from the Explorer.
 *
 * When the host says a Table Library drag has started (`libraryDragStarted`),
 * the canvas shows "Drop to add … to this diagram" — until the drop, the
 * host's `libraryDragEnded` (the drag was used up: dropped on a canvas or a
 * diagram's row, or it missed the canvas and the host added it there),
 * {@link LIBRARY_DRAG_HINT_MS}, the diagram changing or the host selecting a
 * table on it, or the webview's next pointer event (pointer events come back
 * once the drag is over). While an acceptable drag is over the canvas, it says
 * "Let go to add …".
 *
 * A drop event seldom reaches the canvas on macOS: VS Code turns the
 * webview's pointer events off during a workbench drag unless Shift is held
 * (the editor group then takes the drop and opens the file: the host's
 * missed-drop watcher adds the tables instead), and with Shift Chromium
 * refuses to deliver a drag that started in the workbench to the webview's
 * out-of-process frame, so the drop reaches nothing. That last case is caught
 * here: the webview's first pointer event after the drag, when
 * {@link dragEndedOverCanvas} says the drag ended over the diagram, is posted
 * as a `dropTables` marked `afterDrag` (the host adds the drag it remembered,
 * if nothing used it up). A drag from the glass sidebar (a webview) also says
 * where it was let go (`libraryDragReleased`, a screen point): the canvas
 * under it posts that drop at once, without waiting for the pointer to move,
 * when it knows where it sits on screen (`releaseInPage`, from its own
 * pointer events). See docs/dev/architecture.md, "Dragging tables from the
 * Table Library".
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
import { DROP_TABLES_URI_LIMIT, DROP_TABLES_URI_MAX_LENGTH, TABLE_LIBRARY_DRAG_MIME, type CanvasFrame, type LibraryDragRelease } from '../../src/types/messages';

/** How long the "Drop to add" hint stays without a drop or a pointer move (a long sidebar takes a while to cross). */
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

/** What the page measures now, to tell whether a {@link CanvasFrame} still holds. */
export interface PageMetrics {
  readonly windowX: number;
  readonly windowY: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/** This page's metrics (window place, size, pixel ratio). */
export function pageMetrics(win: Pick<Window, 'screenX' | 'screenY' | 'innerWidth' | 'innerHeight' | 'devicePixelRatio'> = window): PageMetrics {
  return { windowX: win.screenX, windowY: win.screenY, width: win.innerWidth, height: win.innerHeight, pixelRatio: win.devicePixelRatio };
}

/** One pointer event's page point and screen point. */
export interface PointerPoint {
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
}

/** How far apart (page pixels, on one axis) two pointer events must be to measure the page's scale from. */
export const FRAME_SAMPLE_MIN_PX = 8;

/** A measured scale within 1% of one of VS Code's zoom steps (1.2 to a whole power) is that step. */
export function snapScale(scale: number): number {
  const step = 1.2 ** Math.round(Math.log(scale) / Math.log(1.2));
  return Math.abs(scale - step) <= step * 0.01 ? step : scale;
}

/**
 * Where the page sits on screen ({@link CanvasFrame}), from two of its
 * pointer events at least {@link FRAME_SAMPLE_MIN_PX} apart: screen pixels
 * per page pixel (they differ by VS Code's zoom), measured on the axis that
 * moved more (the other must agree when it moved too), and the page's
 * top-left corner on screen. Null when the two cannot say.
 */
export function frameOfPointers(a: PointerPoint, b: PointerPoint, metrics: PageMetrics): CanvasFrame | null {
  const values = [a.screenX, a.screenY, a.clientX, a.clientY, b.screenX, b.screenY, b.clientX, b.clientY];
  if (!values.every(Number.isFinite)) return null;
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const moved = alongX ? dx : dy;
  if (Math.abs(moved) < FRAME_SAMPLE_MIN_PX) return null;
  const measured = (alongX ? b.screenX - a.screenX : b.screenY - a.screenY) / moved;
  if (!(measured > 0.1 && measured <= 16)) return null;
  const across = alongX ? dy : dx;
  if (Math.abs(across) >= FRAME_SAMPLE_MIN_PX) {
    const other = (alongX ? b.screenY - a.screenY : b.screenX - a.screenX) / across;
    if (Math.abs(other - measured) > measured * 0.02) return null;
  }
  const scale = snapScale(measured);
  const frame: CanvasFrame = { originX: b.screenX - b.clientX * scale, originY: b.screenY - b.clientY * scale, scale, ...metrics };
  return isCanvasFrame(frame) ? frame : null;
}

/** A well-formed {@link CanvasFrame}: its eight finite numbers, a positive size, scale and pixel ratio. */
export function isCanvasFrame(value: unknown): value is CanvasFrame {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  const keys = ['originX', 'originY', 'scale', 'windowX', 'windowY', 'width', 'height', 'pixelRatio'];
  if (!keys.every((k) => typeof f[k] === 'number' && Number.isFinite(f[k]))) return false;
  return (f.width as number) > 0 && (f.height as number) > 0 && (f.scale as number) > 0 && (f.pixelRatio as number) > 0;
}

/** A well-formed {@link LibraryDragRelease}: its eight finite numbers. */
export function isDragRelease(value: unknown): value is LibraryDragRelease {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'refX', 'refY', 'refScreenX', 'refScreenY', 'windowX', 'windowY'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

/** Whether two frames are the same, give or take measuring noise (nothing new to report). */
export function sameFrame(a: CanvasFrame | null, b: CanvasFrame | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.originX - b.originX) < 0.5 && Math.abs(a.originY - b.originY) < 0.5 && Math.abs(a.scale - b.scale) < 0.001
    && a.windowX === b.windowX && a.windowY === b.windowY && a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio;
}

/** Whether the page measures now exactly what it did when `frame` was read (so the frame holds). */
function frameHolds(frame: unknown, metrics: PageMetrics): frame is CanvasFrame {
  return isCanvasFrame(frame)
    && frame.windowX === metrics.windowX && frame.windowY === metrics.windowY
    && frame.width === metrics.width && frame.height === metrics.height && frame.pixelRatio === metrics.pixelRatio;
}

/**
 * Where a glass sidebar drag's release ({@link LibraryDragRelease}) falls in
 * this page, by the first frame that still holds: the page's own (from its
 * pointer events), else `given` (the last frame a canvas of the same editor
 * group reported). A frame holds only while the window's place, the page's
 * size and the pixel ratio are exactly what they were when it was read; a
 * release from another window never maps. Null when unknown: the drop then
 * waits for the pointer, as before.
 */
export function releaseInPage(
  release: unknown,
  metrics: PageMetrics,
  own: CanvasFrame | null,
  given?: unknown,
): { x: number; y: number } | null {
  if (!isDragRelease(release) || release.windowX !== metrics.windowX || release.windowY !== metrics.windowY) return null;
  const frame = frameHolds(own, metrics) ? own : frameHolds(given, metrics) ? given : null;
  if (!frame) return null;
  const screenX = release.refScreenX + (release.x - release.refX) * frame.scale;
  const screenY = release.refScreenY + (release.y - release.refY) * frame.scale;
  const point = { x: (screenX - frame.originX) / frame.scale, y: (screenY - frame.originY) / frame.scale };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
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
    : `Drop to add ${what} to this diagram`;
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
  /**
   * This canvas has posted a drop (`dropTables`). The canvas then turns React
   * Flow's first-open `fitView` off: on a diagram that opened empty that fit
   * is still queued, and would fire on the first tables to appear, the
   * dropped ones, moving the view the user dropped into.
   */
  dropPosted: boolean;
  /**
   * The host's `libraryDragReleased`: a glass sidebar drag was let go at this
   * screen point. Finishes the drop at once when the point is on this diagram
   * and the page knows where it sits; otherwise does nothing (the pointer path
   * still applies).
   */
  libraryDragReleased: (release: unknown, frame?: unknown) => void;
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
  const [dropPosted, setDropPosted] = useState(false);
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
  const pendingReveal = useEditorStore((s) => s.pendingTableReveal ?? s.pendingTableSelection);
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

  /**
   * The drag ended at this page point (no drop event came): if it is on the
   * diagram (`dragEndedOverCanvas`), post the `afterDrag` drop there.
   */
  const finishAfterDrag = useCallback((sample: PointerSample): void => {
    const landed = dragEndedOverCanvas(sample, { width: window.innerWidth, height: window.innerHeight });
    if (!landed) return;
    if (!editableRef.current) {
      onRefused?.(DROP_REFUSED_READ_ONLY);
      return;
    }
    const point = screenToFlowPosition({ x: sample.x, y: sample.y });
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    setDropPosted(true);
    send({
      type: 'dropTables',
      payload: { position: { x: Math.round(point.x), y: Math.round(point.y) }, uris: [], fromLibrary: true, afterDrag: true },
    });
  }, [onRefused, screenToFlowPosition, send]);

  useEffect(() => {
    if (!dragArmed || viewer) return undefined;
    const onFirstPointer = (event: PointerEvent): void => {
      const at = libraryDragAt.current;
      endLibraryDrag();
      if (at === undefined || Date.now() - at > LIBRARY_DRAG_FRESH_MS || !loadedRef.current) return;
      const target = event.target as Element | null;
      finishAfterDrag({
        x: event.clientX,
        y: event.clientY,
        movementX: event.type === 'pointermove' ? event.movementX : 0,
        movementY: event.type === 'pointermove' ? event.movementY : 0,
        onDiagram: typeof target?.closest === 'function' && target.closest('.react-flow') !== null,
      });
    };
    window.addEventListener('pointermove', onFirstPointer, true);
    window.addEventListener('pointerdown', onFirstPointer, true);
    return () => {
      window.removeEventListener('pointermove', onFirstPointer, true);
      window.removeEventListener('pointerdown', onFirstPointer, true);
    };
  }, [dragArmed, viewer, endLibraryDrag, finishAfterDrag]);

  // Where this page sits on screen, from its own pointer events (a glass
  // sidebar drop is placed by it): two of them at least FRAME_SAMPLE_MIN_PX
  // apart, with nothing measured changing between. Reported to the host when
  // it changes, so a canvas opened later in the same editor group can use it.
  const ownFrame = useRef<CanvasFrame | null>(null);
  useEffect(() => {
    if (viewer) return undefined;
    let anchor: { point: PointerPoint; metrics: PageMetrics } | null = null;
    const onPointer = (event: PointerEvent): void => {
      const metrics = pageMetrics();
      const point: PointerPoint = { screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY };
      const sameMetrics = anchor !== null && anchor.metrics.windowX === metrics.windowX && anchor.metrics.windowY === metrics.windowY
        && anchor.metrics.width === metrics.width && anchor.metrics.height === metrics.height && anchor.metrics.pixelRatio === metrics.pixelRatio;
      if (!anchor || !sameMetrics) {
        anchor = { point, metrics };
        return;
      }
      // Too close to measure from: keep the anchor until the pointer has moved far enough.
      if (Math.max(Math.abs(point.clientX - anchor.point.clientX), Math.abs(point.clientY - anchor.point.clientY)) < FRAME_SAMPLE_MIN_PX) return;
      const frame = frameOfPointers(anchor.point, point, metrics);
      anchor = { point, metrics };
      if (!frame || sameFrame(frame, ownFrame.current)) return;
      ownFrame.current = frame;
      send({ type: 'canvasFrame', payload: { ...frame } });
    };
    window.addEventListener('pointermove', onPointer, { capture: true, passive: true });
    window.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [viewer, send]);

  const libraryDragReleased = useCallback((release: unknown, frame?: unknown): void => {
    const startedAt = libraryDragAt.current;
    if (viewer || startedAt === undefined || Date.now() - startedAt > LIBRARY_DRAG_FRESH_MS || !loadedRef.current) return;
    const point = releaseInPage(release, pageMetrics(), ownFrame.current, frame);
    // Unknown where this page is: the pointer path finishes it, as before.
    if (!point) return;
    const target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(point.x, point.y) : null;
    const sample: PointerSample = { x: point.x, y: point.y, onDiagram: target !== null && target.closest('.react-flow') !== null };
    // Not on this diagram (another editor, the tab bar, outside the window): another canvas may take it.
    if (!dragEndedOverCanvas(sample, { width: window.innerWidth, height: window.innerHeight })) return;
    endLibraryDrag();
    finishAfterDrag(sample);
  }, [viewer, endLibraryDrag, finishAfterDrag]);

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
      setDropPosted(true);
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
    libraryDragReleased,
    dropPosted,
  };
}
