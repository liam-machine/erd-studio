/**
 * A `vscode.TreeItem` as plain JSON for the glass sidebar's webview
 * (`src/providers/glassSidebar/serialise.ts`). The row's click command stays
 * on the host: the webview only learns that the row has one.
 */
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';

import {
  nodeId,
  plainText,
  serialiseIcon,
  serialiseTreeItem,
  swatchColour,
} from '../../src/providers/glassSidebar/serialise';

const toWebviewUri = (uri: vscode.Uri): string | undefined =>
  uri.path.startsWith('/ext/') ? `https://webview.test${uri.path}` : undefined;

function item(label: unknown, extra: Record<string, unknown> = {}): vscode.TreeItem {
  const t = new vscode.TreeItem('') as unknown as Record<string, unknown>;
  t.label = label;
  Object.assign(t, extra);
  return t as unknown as vscode.TreeItem;
}

const serialise = (t: vscode.TreeItem) => serialiseTreeItem(t, 'id-1', toWebviewUri);

function swatchUri(fill: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${fill}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`) as unknown as vscode.Uri;
}

describe('serialiseTreeItem: label', () => {
  it('a string label', () => {
    expect(serialise(item('dim_customer'))).toEqual({ id: 'id-1', label: 'dim_customer', collapsible: 0, hasCommand: false });
  });

  it('a TreeItemLabel with highlights', () => {
    const node = serialise(item({ label: 'dim_customer', highlights: [[0, 3], [4, 8]] }));
    expect(node.label).toBe('dim_customer');
    expect(node.highlights).toEqual([[0, 3], [4, 8]]);
  });

  it('highlights are clamped to the label, and empty or malformed ranges dropped', () => {
    const node = serialise(item({ label: 'abc', highlights: [[-2, 1], [2, 10], [5, 9], [2, 2], [1, 'x'], [1], 'nope', [1.5, 2]] }));
    expect(node.highlights).toEqual([[0, 1], [2, 3]]);
  });

  it('a TreeItemLabel without highlights has none', () => {
    expect(serialise(item({ label: 'x' }))).not.toHaveProperty('highlights');
    expect(serialise(item({ label: 'x', highlights: [] }))).not.toHaveProperty('highlights');
    expect(serialise(item({ label: 'x', highlights: 'nope' }))).not.toHaveProperty('highlights');
  });

  it('no label: the resource file name, else empty', () => {
    expect(serialise(item(undefined, { resourceUri: vscode.Uri.file('/repo/.erd-studio/silver/sales.dbml') })).label).toBe('sales.dbml');
    expect(serialise(item(undefined)).label).toBe('');
  });
});

describe('serialiseTreeItem: description and tooltip', () => {
  it('a string description', () => {
    expect(serialise(item('a', { description: '12 tables' })).description).toBe('12 tables');
  });

  it('an empty or false description is left out', () => {
    expect(serialise(item('a', { description: '' }))).not.toHaveProperty('description');
    expect(serialise(item('a', { description: false }))).not.toHaveProperty('description');
  });

  it('description true comes from the resource; without a resource there is none', () => {
    const resourceUri = vscode.Uri.file('/repo/models/a.yml');
    expect(serialise(item('a', { description: true, resourceUri })).description).toBe('/repo/models/a.yml');
    expect(serialise(item('a', { description: true }))).not.toHaveProperty('description');
  });

  it('a string tooltip is kept as it is', () => {
    expect(serialise(item('a', { tooltip: 'Plain *text*' })).tooltip).toBe('Plain *text*');
  });

  it('a MarkdownString tooltip becomes plain text', () => {
    const md = new vscode.MarkdownString('$(table) **dim_customer**\n\n`gold` layer · [open](command:erdStudio.x)\n\n---\n\n*12 columns*');
    expect(serialise(item('a', { tooltip: md })).tooltip).toBe('dim_customer\n\ngold layer · open\n\n12 columns');
  });

  it('an empty or unknown tooltip is left out', () => {
    expect(serialise(item('a', { tooltip: new vscode.MarkdownString('') }))).not.toHaveProperty('tooltip');
    expect(serialise(item('a', { tooltip: { notMarkdown: true } }))).not.toHaveProperty('tooltip');
  });

  it('plainText strips markup, HTML and escapes', () => {
    expect(plainText(undefined)).toBeUndefined();
    expect(plainText(null)).toBeUndefined();
    expect(plainText('raw')).toBe('raw');
    expect(plainText({ value: '# Title\n<b>bold</b> ![img](x.png)&nbsp;end' })).toBe('Title\nbold  end');
  });

  it('plainText keeps escaped characters literal (not emphasis, links or headings)', () => {
    expect(plainText({ value: '\\*not italic\\* and \\_x\\_' })).toBe('*not italic* and _x_');
    expect(plainText({ value: '\\[not a link\\](x)' })).toBe('[not a link](x)');
    expect(plainText({ value: '\\# not a heading' })).toBe('# not a heading');
    expect(plainText({ value: 'a \\\\ b' })).toBe('a \\ b');
  });
});

describe('serialiseTreeItem: collapsible state, contextValue, resource', () => {
  it.each([
    [undefined, 0],
    [vscode.TreeItemCollapsibleState.None, 0],
    [vscode.TreeItemCollapsibleState.Collapsed, 1],
    [vscode.TreeItemCollapsibleState.Expanded, 2],
    [7, 0],
  ])('collapsibleState %s → %s', (state, expected) => {
    expect(serialise(item('a', { collapsibleState: state })).collapsible).toBe(expected);
  });

  it('contextValue is carried; empty or non-string is left out', () => {
    expect(serialise(item('a', { contextValue: 'logicalModel' })).contextValue).toBe('logicalModel');
    expect(serialise(item('a', { contextValue: '' }))).not.toHaveProperty('contextValue');
    expect(serialise(item('a', { contextValue: { evil: true } }))).not.toHaveProperty('contextValue');
  });

  it('resourceUri: only the file name reaches the webview', () => {
    const node = serialise(item('a', { resourceUri: vscode.Uri.file('/Users/someone/repo/.erd-studio/gold/finance.dbml') }));
    expect(node.resource).toBe('finance.dbml');
    expect(JSON.stringify(node)).not.toContain('/Users/someone');
  });
});

describe('serialiseTreeItem: the click command never leaves the host', () => {
  it('a row with a command carries only hasCommand: true', () => {
    const command = {
      command: 'erdStudio.openDomain',
      title: 'Open',
      arguments: [{ secret: '/Users/someone/repo/.erd-studio/gold/finance.dbml' }, 'second-arg'],
      tooltip: 'Open diagram',
    };
    const node = serialise(item('finance', { command }));
    expect(node.hasCommand).toBe(true);
    expect(node).not.toHaveProperty('command');
    const json = JSON.stringify(node);
    expect(json).not.toContain('erdStudio.openDomain');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('second-arg');
    expect(json).not.toContain('Open diagram');
  });

  it('no command, or one without an id, is hasCommand: false', () => {
    expect(serialise(item('a')).hasCommand).toBe(false);
    expect(serialise(item('a', { command: { title: 'x' } })).hasCommand).toBe(false);
  });
});

describe('serialiseIcon', () => {
  it('a ThemeIcon, without and with a colour', () => {
    expect(serialiseIcon(new vscode.ThemeIcon('table'), toWebviewUri)).toEqual({ kind: 'theme', id: 'table' });
    expect(serialiseIcon(new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')), toWebviewUri))
      .toEqual({ kind: 'theme', id: 'warning', color: 'list.warningForeground' });
  });

  it('a Uri inside the resource roots becomes a webview URL; outside, nothing', () => {
    expect(serialiseIcon(vscode.Uri.file('/ext/media/icon.svg'), toWebviewUri))
      .toEqual({ kind: 'uri', light: 'https://webview.test/ext/media/icon.svg', dark: 'https://webview.test/ext/media/icon.svg' });
    expect(serialiseIcon(vscode.Uri.file('/elsewhere/icon.svg'), toWebviewUri)).toBeUndefined();
  });

  it('a { light, dark } pair; one side missing falls back to the other', () => {
    expect(serialiseIcon({ light: vscode.Uri.file('/ext/l.svg'), dark: vscode.Uri.file('/ext/d.svg') }, toWebviewUri))
      .toEqual({ kind: 'uri', light: 'https://webview.test/ext/l.svg', dark: 'https://webview.test/ext/d.svg' });
    expect(serialiseIcon({ light: vscode.Uri.file('/ext/l.svg'), dark: vscode.Uri.file('/outside/d.svg') }, toWebviewUri))
      .toEqual({ kind: 'uri', light: 'https://webview.test/ext/l.svg', dark: 'https://webview.test/ext/l.svg' });
    expect(serialiseIcon({ light: vscode.Uri.file('/outside/l.svg'), dark: vscode.Uri.file('/outside/d.svg') }, toWebviewUri)).toBeUndefined();
  });

  it('a layer swatch data URI becomes its colour', () => {
    expect(serialiseIcon(swatchUri('#22C55E'), toWebviewUri)).toEqual({ kind: 'swatch', color: '#22c55e' });
    expect(swatchColour(swatchUri('#abc'))).toBe('#abc');
    expect(swatchColour(swatchUri('red'))).toBeUndefined();
    expect(swatchColour(vscode.Uri.file('/ext/a.svg') as unknown as vscode.Uri)).toBeUndefined();
  });

  it('a swatch from a real-style Uri (scheme "data", decoded path)', () => {
    const svg = '<svg><rect fill="#60a5fa"/></svg>';
    const uri = { scheme: 'data', path: `image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, fsPath: '', toString: () => 'data:image%2Fsvg%2Bxml...' };
    expect(swatchColour(uri as unknown as vscode.Uri)).toBe('#60a5fa');
  });

  it('nothing, or an unknown shape, is no icon', () => {
    expect(serialiseIcon(undefined, toWebviewUri)).toBeUndefined();
    expect(serialiseIcon('/ext/icon.svg', toWebviewUri)).toBeUndefined();
    expect(serialiseIcon({ foo: 1 }, toWebviewUri)).toBeUndefined();
  });

  it('serialiseTreeItem carries the icon', () => {
    expect(serialise(item('a', { iconPath: new vscode.ThemeIcon('folder') })).icon).toEqual({ kind: 'theme', id: 'folder' });
    expect(serialise(item('a'))).not.toHaveProperty('icon');
  });
});

describe('JSON safety', () => {
  it('a fully loaded row survives a JSON round trip unchanged', () => {
    const node = serialise(item({ label: 'fct_order', highlights: [[0, 3]] }, {
      description: 'gold',
      tooltip: new vscode.MarkdownString('**fct_order**'),
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'logicalModel',
      iconPath: new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.green')),
      resourceUri: vscode.Uri.file('/repo/fct_order.yml'),
      command: { command: 'erdStudio.open', title: 'Open', arguments: [() => 'fn', new Map()] },
      id: 'tree:fct_order',
    }));
    expect(JSON.parse(JSON.stringify(node))).toEqual(node);
    expect(node).toEqual({
      id: 'id-1',
      label: 'fct_order',
      highlights: [[0, 3]],
      description: 'gold',
      tooltip: 'fct_order',
      collapsible: 1,
      hasCommand: true,
      contextValue: 'logicalModel',
      icon: { kind: 'theme', id: 'table', color: 'charts.green' },
      resource: 'fct_order.yml',
    });
  });

  it('every value is a plain string, number, boolean, array or object', () => {
    const node = serialise(item('x', { iconPath: vscode.Uri.file('/ext/i.svg'), resourceUri: vscode.Uri.file('/r/x.yml') }));
    const walk = (v: unknown): void => {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return;
      expect(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype).toBe(true);
      for (const child of Object.values(v as object)) walk(child);
    };
    walk(node);
  });
});

describe('nodeId', () => {
  it("uses the TreeItem's own id, prefixed by the section", () => {
    const seen = new Map<string, number>();
    expect(nodeId('diagrams', undefined, item('a', { id: 'layer:gold' }), seen)).toBe('diagrams:layer:gold');
  });

  it('else parent id and label, numbering repeats under one parent', () => {
    const seen = new Map<string, number>();
    expect(nodeId('tables', undefined, item('dim_a'), seen)).toBe('tables/dim_a');
    expect(nodeId('tables', 'tables/gold', item('dim_a'), seen)).toBe('tables/gold/dim_a');
    expect(nodeId('tables', 'tables/gold', item({ label: 'dim_a' }), seen)).toBe('tables/gold/dim_a#1');
    expect(nodeId('tables', 'tables/gold', item('dim_a'), seen)).toBe('tables/gold/dim_a#2');
    expect(nodeId('tables', 'tables/gold', item('dim_a'), new Map())).toBe('tables/gold/dim_a');
  });
});
