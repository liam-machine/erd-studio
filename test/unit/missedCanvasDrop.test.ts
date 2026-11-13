/**
 * A Table Library drag let go over a diagram without Shift (or with Shift
 * released a moment early): VS Code's editor group takes the drop and opens
 * the dragged files there, pinned (EditorDropTarget.handleDrop, checked in the
 * 1.145 bundle: `options: { pinned: true }`). The pure decision
 * (`missedCanvasDrop`) and the watcher that says so and offers the add.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { MISSED_DROP_MS, missedCanvasDrop } from '../../src/services/tableDrop';
import { MISSED_DROP_CLOSE_MS, watchMissedCanvasDrops } from '../../src/providers/missedCanvasDrop';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';

const SEM = '/p/.erd-studio';
const SHOWCASE = `${SEM}/silver/diagrams/showcase.dbml`;
const DIM_LOCATION = `${SEM}/silver/tables/silver/dim_location.dbml`;
const DIM_DATE = `${SEM}/silver/tables/silver/dim_date.dbml`;
const library = [
  { name: 'dim_location', filePath: DIM_LOCATION },
  { name: 'dim_date', filePath: DIM_DATE },
  { name: 'dim_old', filePath: `${SEM}/silver/tables/old/dim_location.dbml`, shadowedBy: DIM_LOCATION },
];
const T0 = 1_000_000;

describe('missedCanvasDrop', () => {
  const base = {
    opened: { filePath: DIM_LOCATION, preview: false },
    drag: { tables: ['dim_location'], at: T0 },
    now: T0 + 2_000,
    frontDiagram: SHOWCASE,
    library,
    platform: 'darwin' as NodeJS.Platform,
  };

  it('is the diagram in front and the whole drag when a dragged table\'s file opens pinned there soon after the drag started', () => {
    expect(missedCanvasDrop(base)).toEqual({ diagramPath: SHOWCASE, names: ['dim_location'] });
    // A multi-select drag: any of its files opening says the whole drag missed.
    expect(missedCanvasDrop({ ...base, drag: { tables: ['dim_date', 'dim_location'], at: T0 } }))
      .toEqual({ diagramPath: SHOWCASE, names: ['dim_date', 'dim_location'] });
  });

  it('matches by file where the drag knew its files (two schema folders may share a name), any case on macOS / Windows', () => {
    const drag = { tables: ['dim_location'], files: [DIM_LOCATION], at: T0 };
    expect(missedCanvasDrop({ ...base, drag, opened: { filePath: DIM_LOCATION.toUpperCase(), preview: false } }))
      .toEqual({ diagramPath: SHOWCASE, names: ['dim_location'], files: [DIM_LOCATION] });
    // The other schema folder's dim_location is not the dragged one.
    expect(missedCanvasDrop({ ...base, drag, opened: { filePath: `${SEM}/gold/tables/gold/dim_location.dbml`, preview: false } })).toBeUndefined();
    // Windows: VS Code's fsPath has a lower-case drive letter, the drag's file an upper-case one.
    expect(missedCanvasDrop({
      ...base,
      platform: 'win32',
      drag: { tables: ['dim_location'], files: ['C:\\p\\.erd-studio\\silver\\tables\\silver\\dim_location.dbml'], at: T0 },
      opened: { filePath: 'c:\\p\\.erd-studio\\silver\\tables\\silver\\dim_location.dbml', preview: false },
    })?.names).toEqual(['dim_location']);
  });

  it('is nothing for a preview tab (a click on a Table Library row), a file the drag did not carry, or an ignored duplicate', () => {
    expect(missedCanvasDrop({ ...base, opened: { filePath: DIM_LOCATION, preview: true } })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, opened: { filePath: DIM_DATE, preview: false } })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, opened: { filePath: '/p/README.md', preview: false } })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, opened: { filePath: `${SEM}/silver/tables/old/dim_location.dbml`, preview: false } })).toBeUndefined();
  });

  it('is nothing with no drag, a stale drag, or no diagram in front of that group before (a text editor, a new split group)', () => {
    expect(missedCanvasDrop({ ...base, drag: undefined })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, now: T0 + MISSED_DROP_MS + 1 })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, now: T0 - 1 })).toBeUndefined();
    expect(missedCanvasDrop({ ...base, frontDiagram: undefined })).toBeUndefined();
  });
});

describe('watchMissedCanvasDrops', () => {
  type Group = { tabs: unknown[]; activeTab: unknown; viewColumn: number };
  const tabGroups = vscode.window.tabGroups as unknown as { all: Group[] };
  const diagramTab = (group: () => Group) => ({
    input: new vscode.TabInputCustom(vscode.Uri.file(SHOWCASE), SUBJECT_AREA_EDITOR_VIEW_TYPE), isPreview: false, get group() { return group(); },
  });
  const fileTab = (file: string, group: () => Group, isPreview = false) => ({
    input: new vscode.TabInputText(vscode.Uri.file(file)), isPreview, get group() { return group(); },
  });
  let drag: { tables: string[]; files?: string[]; at: number } | undefined;
  let deps: Parameters<typeof watchMissedCanvasDrops>[0];
  let watcher: vscode.Disposable;
  let group: Group;

  beforeEach(() => {
    drag = { tables: ['dim_location'], at: T0 };
    group = { tabs: [], activeTab: undefined, viewColumn: 1 };
    const diagram = diagramTab(() => group);
    group.tabs = [diagram];
    group.activeTab = diagram;
    tabGroups.all = [group];
    deps = {
      peekDrag: vi.fn(() => drag),
      takeDrag: vi.fn(() => { const d = drag; drag = undefined; return d; }),
      listTableFiles: () => library,
      diagramName: () => 'showcase',
      addTables: vi.fn(async () => ['dim_location']),
      now: () => T0 + 1_500,
    };
    watcher = watchMissedCanvasDrops(deps);
  });
  afterEach(() => {
    watcher.dispose();
    tabGroups.all = [];
    vi.restoreAllMocks();
  });

  /** VS Code opens the dropped file pinned in the diagram's group, in front. */
  const dropOpensFile = (file = DIM_LOCATION, isPreview = false) => {
    const tab = fileTab(file, () => group, isPreview);
    group.tabs = [...group.tabs, tab];
    group.activeTab = tab;
    vscode._fireDidChangeTabs({ opened: [tab] });
    return tab;
  };
  const tabGroupsApi = vscode.window.tabGroups as unknown as { close?: (tab: unknown, preserveFocus?: boolean) => Promise<boolean> };
  let closed: unknown[];
  beforeEach(() => {
    closed = [];
    tabGroupsApi.close = vi.fn(async (tab: unknown) => { closed.push(tab); return true; });
  });
  afterEach(() => { delete tabGroupsApi.close; });

  it('adds the drag to the diagram the drop was aimed at, uses the drag up, closes the tab the drop opened, and names the add in the status bar', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const tab = dropOpensFile();
    expect(deps.takeDrag).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([tab]);
    await vi.waitFor(() => expect(deps.addTables).toHaveBeenCalledWith(SHOWCASE, ['dim_location'], undefined));
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('$(check) ERD Studio: Added "dim_location" to showcase', expect.any(Number)));
    expect(info).not.toHaveBeenCalled();
  });

  it('passes the drag\'s files on; says nothing in the status bar when nothing was added (already there: the canvas says so)', async () => {
    drag = { tables: ['dim_location'], files: [DIM_LOCATION], at: T0 };
    deps.addTables = vi.fn(async () => []);
    watcher.dispose();
    watcher = watchMissedCanvasDrops(deps);
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    dropOpensFile();
    await vi.waitFor(() => expect(deps.addTables).toHaveBeenCalledWith(SHOWCASE, ['dim_location'], [DIM_LOCATION]));
    await new Promise((r) => setTimeout(r, 0));
    expect(status).not.toHaveBeenCalled();
  });

  it('a drop of a file whose tab was already open (VS Code brings that tab to the front): adds, and leaves that tab open', async () => {
    const tab = { ...fileTab(DIM_LOCATION, () => group), isActive: false };
    group.tabs = [...group.tabs, tab];
    tab.isActive = true;
    group.activeTab = tab;
    vscode._fireDidChangeTabs({ changed: [tab] });
    expect(deps.takeDrag).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([]);
    await vi.waitFor(() => expect(deps.addTables).toHaveBeenCalledWith(SHOWCASE, ['dim_location'], undefined));
    // A later change to that tab (it is in front now, not the diagram) is not a drop.
    drag = { tables: ['dim_location'], at: T0 };
    vscode._fireDidChangeTabs({ changed: [tab] });
    expect(deps.addTables).toHaveBeenCalledTimes(1);
  });

  it('adds a multi-table drag once and closes each file VS Code opens for it, but not a file opened later', async () => {
    drag = { tables: ['dim_location', 'dim_date'], at: T0 };
    const first = dropOpensFile(DIM_LOCATION);
    const second = dropOpensFile(DIM_DATE);
    expect(closed).toEqual([first, second]);
    await vi.waitFor(() => expect(deps.addTables).toHaveBeenCalledTimes(1));
    expect(deps.addTables).toHaveBeenCalledWith(SHOWCASE, ['dim_location', 'dim_date'], undefined);
    deps.now = () => T0 + 1_500 + MISSED_DROP_CLOSE_MS + 1;
    dropOpensFile(DIM_DATE);
    expect(closed).toHaveLength(2);
  });

  it('does nothing for a click on a row (a preview tab), with no drag, or when a text file was in front, not a diagram', () => {
    dropOpensFile(DIM_LOCATION, true);
    // The preview tab is now in front: a pinned open after it was not aimed at the diagram.
    dropOpensFile(DIM_LOCATION);
    expect(deps.takeDrag).not.toHaveBeenCalled();
    drag = undefined;
    dropOpensFile(DIM_LOCATION);
    expect(deps.addTables).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
  });
});
