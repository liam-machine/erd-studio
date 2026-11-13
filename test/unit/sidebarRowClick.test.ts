/**
 * A sidebar row's click and double-click (`sidebarRowClick.ts`, and
 * `openInDiagram`'s `highlight` path in relationshipsView.ts): the rule a
 * table row's (and a relationship row's) click follows — the diagram the
 * user is looking at, else the only one, else a pick, else the file — with
 * the table or line selected gently; and the double-click, told from two
 * clicks for the native views, that closes a pick the click left open and
 * opens the file once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { DOUBLE_CLICK_MS, RowActivations, chooseDiagram, diagramTheClickChooses, rowActivationKey } from '../../src/commands/sidebarRowClick';
import { noDiagramYetMessage, openInDiagram, openTableFile, type RelationshipsViewDeps } from '../../src/commands/relationshipsView';
import type { RelationshipNode } from '../../src/providers/RelationshipsTreeProvider';
import type { TableLibraryTableNode } from '../../src/providers/ModelLibraryTreeProvider';
import type { SubjectAreaSummary } from '../../src/types/semantic';
import type { RelationshipEntry } from '../../src/services/relationshipsOverview';

const SALES = '/p/.erd-studio/gold/diagrams/sales.dbml';
const CRM = '/p/.erd-studio/gold/diagrams/crm.dbml';
const STAGING = '/p/.erd-studio/silver/diagrams/staging.dbml';

describe('chooseDiagram: where a row\'s click goes', () => {
  it('(a) the diagram the user is looking at shows it: highlighted there, even when others show it too', () => {
    expect(chooseDiagram([SALES, CRM], CRM)).toEqual({ kind: 'here', filePath: CRM });
    expect(chooseDiagram([SALES], SALES)).toEqual({ kind: 'here', filePath: SALES });
  });

  it('the active editor is not a diagram (nothing in front): one diagram opens, several ask, none is none', () => {
    expect(chooseDiagram([SALES], undefined)).toEqual({ kind: 'open', filePath: SALES });
    expect(chooseDiagram([SALES, CRM], undefined)).toEqual({ kind: 'pick' });
    expect(chooseDiagram([], undefined)).toEqual({ kind: 'none' });
  });

  it('a diagram in front that does not show it changes nothing: (b) one other opens, (c) several ask, (d) none', () => {
    expect(chooseDiagram([SALES], STAGING)).toEqual({ kind: 'open', filePath: SALES });
    expect(chooseDiagram([SALES, CRM], STAGING)).toEqual({ kind: 'pick' });
    expect(chooseDiagram([], STAGING)).toEqual({ kind: 'none' });
  });

  it('matches the diagram in front by path, however it is spelled', () => {
    expect(chooseDiagram([SALES], '/p/.erd-studio/gold/diagrams/../diagrams/SALES.dbml').kind).toBe('here');
  });

  it('Show on Another Diagram… leaves out the diagram the click highlights or opens, and none when the click asks', () => {
    expect(diagramTheClickChooses([SALES, CRM], CRM)).toBe(CRM);
    expect(diagramTheClickChooses([SALES], undefined)).toBe(SALES);
    expect(diagramTheClickChooses([SALES, CRM], undefined)).toBeUndefined();
    expect(diagramTheClickChooses([], SALES)).toBeUndefined();
  });
});

describe('openInDiagram from the sidebar (highlight)', () => {
  let exec: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
  });

  const summary = (filePath: string): SubjectAreaSummary => ({ domain: filePath.split('/').pop()!.replace('.dbml', ''), layer: 'gold', filePath });
  const members: Record<string, string[]> = {
    [SALES]: ['fct_order', 'dim_customer'],
    [CRM]: ['dim_customer', 'fct_order'],
    [STAGING]: ['stg_orders'],
  };
  const deps = (over: Partial<RelationshipsViewDeps> = {}): RelationshipsViewDeps => ({
    relationshipLocation: () => ({ filePath: '/p/.erd-studio/gold/relationships/gold.dbml', line: 7 }),
    findTableFile: () => null,
    listSubjectAreas: () => [summary(SALES), summary(CRM), summary(STAGING)],
    memberNames: (p) => members[p] ?? [],
    layerLabel: () => 'Gold',
    revealRelationship: vi.fn(async () => undefined),
    revealTable: vi.fn(async () => undefined),
    ...over,
  });
  const table = (name: string, referencingDomains: string[] = []): TableLibraryTableNode =>
    ({ type: 'model', name, filePath: `/p/.erd-studio/gold/tables/gold/${name}.dbml`, referencingDomains });
  const entry: RelationshipEntry = {
    fromModel: 'fct_order', toModel: 'dim_customer', fromColumns: ['customer_sk'], toColumns: ['customer_sk'],
    cardinality: 'many-to-one', problems: [], source: { kind: 'library', table: 'fct_order' },
    first: {} as RelationshipEntry['first'],
  } as unknown as RelationshipEntry;
  const relationship: RelationshipNode = { type: 'relationship', entry, side: 'from', parentId: 'erdStudio.relationships.table:fct_order' };
  const opened = () => exec.mock.calls.filter((c) => c[0] === 'erdStudio.openDomain').map((c) => c[1]);

  it('(a) highlights the table on the diagram in front, gently, opening nothing and asking nothing', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const d = deps({ lookingAtDiagram: () => CRM });
    await openInDiagram(table('dim_customer'), d, { highlight: true, fallBackToFile: true });
    expect(opened()).toEqual([]);
    expect(pick).not.toHaveBeenCalled();
    expect(d.revealTable).toHaveBeenCalledWith(CRM, 'dim_customer', { gentle: true });
  });

  it('(a) is the diagram last active and still on screen when the active editor is not a diagram (the deps answer it)', async () => {
    // `lookingAtDiagram` is the active diagram, else the last active one still visible: one answer either way.
    const d = deps({ lookingAtDiagram: () => SALES });
    await openInDiagram(table('fct_order'), d, { highlight: true });
    expect(d.revealTable).toHaveBeenCalledWith(SALES, 'fct_order', { gentle: true });
    expect(opened()).toEqual([]);
  });

  it('(b) nothing in front shows it and one diagram does: that diagram opens, and the table is selected gently there', async () => {
    const d = deps({ lookingAtDiagram: () => STAGING, memberNames: (p) => (p === SALES ? ['dim_date'] : []) });
    await openInDiagram(table('dim_date'), d, { highlight: true, fallBackToFile: true });
    expect(opened()).toEqual([SALES]);
    expect(d.revealTable).toHaveBeenCalledWith(SALES, 'dim_date', { gentle: true });
  });

  it('(c) several show it and none is in front: asks which (never a guess), then opens it gently', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items[1]) as never);
    const d = deps({ lookingAtDiagram: () => undefined });
    await openInDiagram(table('dim_customer'), d, { highlight: true, fallBackToFile: true });
    expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label)).toEqual(['sales', 'crm']);
    expect(opened()).toEqual([CRM]);
    expect(d.revealTable).toHaveBeenCalledWith(CRM, 'dim_customer', { gentle: true });
  });

  it('(d) no diagram shows it: a row\'s click opens the table\'s file, with a status-bar line that says why', async () => {
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const d = deps({ lookingAtDiagram: () => SALES });
    await openInDiagram(table('dim_orphan'), d, { highlight: true, fallBackToFile: true });
    expect(status).toHaveBeenCalledWith(noDiagramYetMessage('"dim_orphan"', 'table'), 8000);
    expect(String(status.mock.calls[0][0])).toBe('ERD Studio: No diagram shows "dim_orphan" yet, so this is the table\'s file.');
    expect(info).not.toHaveBeenCalled();
    expect(exec.mock.calls[0][0]).toBe('vscode.open');
    expect((exec.mock.calls[0][1] as vscode.Uri).fsPath).toBe('/p/.erd-studio/gold/tables/gold/dim_orphan.dbml');
    expect(d.revealTable).not.toHaveBeenCalled();
  });

  it('a relationship whose two tables the diagram in front shows: its line is highlighted there, though another diagram shows it too', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const d = deps({ lookingAtDiagram: () => CRM });
    await openInDiagram(relationship, d, { highlight: true, fallBackToFile: true });
    expect(pick).not.toHaveBeenCalled();
    expect(opened()).toEqual([]);
    expect(d.revealRelationship).toHaveBeenCalledWith(CRM, {
      fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_sk', toColumn: 'customer_sk' }], gentle: true,
    });
  });

  it('a relationship with nothing in front still asks between the diagrams (the file last)', async () => {
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    await openInDiagram(relationship, deps(), { highlight: true, fallBackToFile: true });
    expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label)).toEqual(['sales', 'crm', '$(go-to-file) Open in File']);
    expect(opened()).toEqual([]);
  });

  it('without highlight (Go to Table…, the canvas\'s Show on Other Diagrams…) nothing changes: no "in front", no gentle', async () => {
    const d = deps({ lookingAtDiagram: () => CRM, memberNames: (p) => (p === SALES ? ['dim_date'] : []) });
    await openInDiagram(table('dim_date'), d);
    expect(opened()).toEqual([SALES]);
    expect(d.revealTable).toHaveBeenCalledWith(SALES, 'dim_date');
  });

  it('a cancelled click (a double-click came) closes its pick and opens nothing', async () => {
    const source = new vscode.CancellationTokenSource();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async () => {
      source.cancel();
      return { label: 'sales', summary: summary(SALES) };
    }) as never);
    await openInDiagram(table('dim_customer'), deps(), { highlight: true, token: source.token as vscode.CancellationToken });
    // The token went to the pick (VS Code closes it on cancel), and the pick's answer is ignored.
    expect(pick.mock.calls[0][2]).toBe(source.token);
    expect(opened()).toEqual([]);
  });

  it('Open File opens the table\'s file, a double-click\'s tab kept; a non-table says how to use it', async () => {
    await openTableFile(table('dim_customer'), { pinned: true });
    expect(exec.mock.calls[0][0]).toBe('vscode.open');
    expect(exec.mock.calls[0][2]).toEqual({ preview: false });
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await openTableFile({ type: 'layer' });
    expect(String(error.mock.calls[0][0])).toContain('Right-click a table in the Table Library');
  });
});

describe('RowActivations: a double-click in a view without one', () => {
  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it('a second activation of the same row within the window is the double-click: the file opens once, the click ran once', async () => {
    const c = clock();
    const rows = new RowActivations(c.now);
    const primary = vi.fn(async () => undefined);
    const secondary = vi.fn(async () => undefined);
    await rows.click('table:a', primary, secondary);
    c.advance(DOUBLE_CLICK_MS - 100);
    await rows.click('table:a', primary, secondary);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    // A third click starts afresh (never a second double-click).
    c.advance(100);
    await rows.click('table:a', primary, secondary);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it('two clicks far apart, or on two rows, are two clicks', async () => {
    const c = clock();
    const rows = new RowActivations(c.now);
    const primary = vi.fn(async () => undefined);
    const secondary = vi.fn(async () => undefined);
    await rows.click('table:a', primary, secondary);
    c.advance(DOUBLE_CLICK_MS + 1);
    await rows.click('table:a', primary, secondary);
    c.advance(50);
    await rows.click('table:b', primary, secondary);
    expect(primary).toHaveBeenCalledTimes(3);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('a click whose quick pick is still open: the double-click cancels it, waits for it, then opens the file — the pick never left hanging', async () => {
    const c = clock();
    const rows = new RowActivations(c.now);
    const order: string[] = [];
    let pickOpen = false;
    // The first click shows a pick that stays open until its token is cancelled.
    const primary = (token: vscode.CancellationToken) => new Promise<void>((resolve) => {
      pickOpen = true;
      const poll = setInterval(() => {
        if (token.isCancellationRequested) { clearInterval(poll); pickOpen = false; order.push('pick closed'); resolve(); }
      }, 1);
    });
    const secondary = vi.fn(async () => { order.push(`file opened (pick open: ${pickOpen})`); });
    const first = rows.click('table:a', primary, secondary);
    c.advance(200);
    await rows.click('table:a', primary, secondary);
    await first;
    expect(order).toEqual(['pick closed', 'file opened (pick open: false)']);
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it('settle (the glass page\'s own dblclick): closes the last click\'s pick and waits for it; at once with none', async () => {
    const rows = new RowActivations();
    await rows.settle();
    let cancelled = false;
    const first = rows.click('rel:x', (token) => new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (token.isCancellationRequested) { clearInterval(poll); cancelled = true; resolve(); } }, 1);
    }), async () => undefined);
    await rows.settle();
    await first;
    expect(cancelled).toBe(true);
  });

  it('a click on another row cancels a pick the last one left open', async () => {
    const rows = new RowActivations();
    let firstToken: vscode.CancellationToken | undefined;
    void rows.click('table:a', async (token) => { firstToken = token; }, async () => undefined);
    await rows.click('table:b', async () => undefined, async () => undefined);
    expect(firstToken?.isCancellationRequested).toBe(true);
  });

  it('keys a row by what it names, never by the object a refresh replaces', () => {
    const a1 = rowActivationKey({ type: 'model', name: 'a', filePath: '/p/t/a.dbml' });
    expect(a1).toBe(rowActivationKey({ type: 'model', name: 'a', filePath: '/p/t/../t/a.dbml' }));
    const rel = (parentId: string) => rowActivationKey({ type: 'relationship', parentId, side: 'from', entry: { fromModel: 'f', toModel: 't', fromColumns: ['x'], toColumns: ['y'] } });
    expect(rel('p1')).toBe(rel('p1'));
    expect(rel('p1')).not.toBe(rel('p2'));
    expect(rowActivationKey({ type: 'layer' })).toBeUndefined();
  });
});
