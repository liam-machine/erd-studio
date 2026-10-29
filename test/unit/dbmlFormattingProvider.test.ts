/**
 * Format Document for `.dbml` files (`src/providers/dbmlFormattingProvider.ts`):
 * the formatter every DBML write ends with, answered as the smallest set of
 * whole-line edits, and nothing at all (with a status-bar message) for a file
 * with syntax errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { formatDbml } from '@erd-studio/core/dbml';

import {
  DBML_FORMAT_STATUS_MS,
  DbmlFormattingProvider,
  minimalLineEdits,
  parseErrorsMessage,
  registerDbmlFormatting,
  type LineEdit,
} from '../../src/providers/dbmlFormattingProvider';
import { clearLogBuffer, recentLogLines } from '../../src/services/logger';
import { isErdStudioSaving, saveDocument, saveDocumentByUri, saveWithoutFormatting } from '../../src/providers/documentSave';

const UNFORMATTED = `// Orders
Table fct_order [schema: 'gold', role: 'transaction-fact'] {
  order_line_id BIGINT [pk,note:'Line id']
  customer_key INT [foreign_key: 'true']
    amount "DECIMAL(18,2)" [additive_type: 'additive']


  Note: 'Order lines'
}
`;

/** `text` with `edits` (offsets into it) applied. */
function apply(text: string, edits: readonly LineEdit[]): string {
  let out = '';
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    expect(e.start).toBeGreaterThanOrEqual(at);
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/** A document's text with the provider's TextEdits applied (through its own positions). */
function applyTextEdits(doc: ReturnType<typeof vscode.createMockTextDocument>, edits: vscode.TextEdit[]): string {
  const text = doc.getText();
  const spans = edits.map((e) => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.newText }));
  return apply(text, spans);
}

const provider = new DbmlFormattingProvider();
const options = { tabSize: 2, insertSpaces: true } as vscode.FormattingOptions;

beforeEach(() => {
  vscode._resetMockWorkspace();
  clearLogBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('minimalLineEdits', () => {
  it('turns one text into the other and leaves every shared line alone', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd\nE\nf\n';
    const edits = minimalLineEdits(before, after);
    expect(apply(before, edits)).toBe(after);
    // Two runs of changed lines, never the unchanged a, c, d.
    expect(edits).toEqual([
      { start: 2, end: 4, text: 'B\n' },
      { start: 8, end: 10, text: 'E\nf\n' },
    ]);
  });

  it('is empty for equal texts, and handles inserts, deletes and a missing last line break', () => {
    expect(minimalLineEdits('x\n', 'x\n')).toEqual([]);
    for (const [before, after] of [
      ['', 'a\n'], ['a\n', ''], ['a\nb', 'a\nb\n'], ['a\nb\n', 'a\nb'], ['a\n\n\nb\n', 'a\n\nb\n'], ['x\ny\n', 'y\nx\n'],
    ]) {
      expect(apply(before, minimalLineEdits(before, after)), JSON.stringify([before, after])).toBe(after);
    }
  });

  it('holds for random line edits (seeded)', () => {
    let seed = 7;
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: rand(30) }, () => `l${rand(8)}${rand(3) === 0 ? '\r' : ''}\n`);
      const changed = lines.flatMap((l) => {
        const r = rand(6);
        return r === 0 ? [] : r === 1 ? [l, `n${rand(5)}\n`] : r === 2 ? [`m${rand(5)}\n`] : [l];
      });
      const before = lines.join('');
      const after = changed.join('');
      expect(apply(before, minimalLineEdits(before, after))).toBe(after);
      // A tiny edit budget falls back to one edit of the changed middle, still correct.
      expect(apply(before, minimalLineEdits(before, after, 1))).toBe(after);
    }
  });

  it('a single changed line in a large file is one small edit', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `use { table t${i} } from './t${i}.dbml'\n`);
    const before = lines.join('');
    const after = before.replace('table t2500 }', 'table t2500  }');
    const edits = minimalLineEdits(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("use { table t2500  } from './t2500.dbml'\n");
  });
});

describe('DbmlFormattingProvider', () => {
  it('returns line edits that turn the document into the formatter\'s text', () => {
    const doc = vscode.createMockTextDocument('/p/.erd-studio/tables/fct_order.dbml', UNFORMATTED);
    const edits = provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options);
    expect(edits.length).toBeGreaterThan(0);
    const formatted = formatDbml(UNFORMATTED).text;
    expect(applyTextEdits(doc, edits)).toBe(formatted);
    // Never one replace of the whole document: the comment line and the closing brace stay put.
    const touched = edits.map((e) => e.range.start.line);
    expect(touched).not.toContain(0);
    expect(edits.every((e) => doc.offsetAt(e.range.end) < UNFORMATTED.length)).toBe(true);
    // Two table settings go one per line; the columns are aligned.
    expect(formatted).toContain("Table fct_order [\n  schema: 'gold',\n  role: 'transaction-fact'\n] {\n");
    expect(formatted).toContain("  order_line_id BIGINT          [pk, note: 'Line id']\n");
  });

  it('returns no edits for a file already in the canonical layout', () => {
    const doc = vscode.createMockTextDocument('/p/x.dbml', formatDbml(UNFORMATTED).text);
    expect(provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options)).toEqual([]);
  });

  it('keeps CRLF line endings', () => {
    const crlf = UNFORMATTED.replace(/\n/g, '\r\n');
    const doc = vscode.createMockTextDocument('/p/x.dbml', crlf);
    const out = applyTextEdits(doc, provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toBe(formatDbml(crlf).text);
  });

  it('a file with syntax errors: no edits, a status-bar message with the count for 5 s, and an info log line', () => {
    const status = vi.spyOn(vscode.window, 'setStatusBarMessage');
    const broken = 'Table fct_order {\n  id int [pk\n}\n';
    const doc = vscode.createMockTextDocument('/p/x.dbml', broken);
    expect(provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options)).toEqual([]);
    const count = formatDbml(broken).errors!.length;
    expect(count).toBeGreaterThan(0);
    expect(status).toHaveBeenCalledWith(parseErrorsMessage(count), DBML_FORMAT_STATUS_MS);
    expect(DBML_FORMAT_STATUS_MS).toBe(5000);
    expect(recentLogLines().some((l) => /\[info\] \[dbml\] Format Document left .*x\.dbml as it is: \d+ syntax errors?/.test(l))).toBe(true);
  });

  it('words the status-bar message for one error and for several', () => {
    expect(parseErrorsMessage(1)).toBe('ERD Studio: this DBML file has 1 error — fix it, then format again');
    expect(parseErrorsMessage(3)).toBe('ERD Studio: this DBML file has 3 errors — fix them, then format again');
  });

  it('returns nothing once the request is cancelled', () => {
    const doc = vscode.createMockTextDocument('/p/x.dbml', UNFORMATTED);
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => {} }) } as unknown as vscode.CancellationToken;
    expect(provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options, token)).toEqual([]);
  });

  it('registers for the dbml language and disposes with the extension', () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const before = vscode._formattingProviders.length;
    registerDbmlFormatting({ subscriptions } as unknown as vscode.ExtensionContext);
    expect(vscode._formattingProviders.slice(before).map((p) => p.selector)).toEqual([{ language: 'dbml' }]);
    for (const s of subscriptions) s.dispose();
    expect(vscode._formattingProviders.length).toBe(before);
  });
});

describe('format on save skips ERD Studio\'s own saves', () => {
  let subscriptions: Array<{ dispose(): unknown }> = [];
  beforeEach(() => {
    subscriptions = [];
    registerDbmlFormatting({ subscriptions } as unknown as vscode.ExtensionContext);
    vscode._mockFormatOnSave.enabled = true;
  });
  afterEach(() => {
    for (const s of subscriptions) s.dispose();
  });

  it('answers with no edits while ERD Studio is saving the document, and formats again after', async () => {
    const doc = vscode.createMockTextDocument('/p/own.dbml', UNFORMATTED);
    let during: vscode.TextEdit[] | undefined;
    const save = doc.save;
    doc.save = async () => {
      expect(isErdStudioSaving(doc.uri as unknown as vscode.Uri)).toBe(true);
      during = provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options);
      return save();
    };
    doc._setText(UNFORMATTED);
    expect(await saveWithoutFormatting(doc as unknown as vscode.TextDocument)).toBe(true);
    expect(during).toEqual([]);
    expect(isErdStudioSaving(doc.uri as unknown as vscode.Uri)).toBe(false);
    expect(provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument, options).length).toBeGreaterThan(0);
  });

  it('saveDocument and saveDocumentByUri leave a non-canonical .dbml as it is; the user\'s own save formats it', async () => {
    const a = vscode.createMockTextDocument('/p/a.dbml', UNFORMATTED);
    a._setText(UNFORMATTED);
    expect(await saveDocument(a as unknown as vscode.TextDocument)).toBe(true);
    expect(a.getText()).toBe(UNFORMATTED);

    const b = vscode.createMockTextDocument('/p/b.dbml', UNFORMATTED);
    b._setText(UNFORMATTED);
    expect(await saveDocumentByUri(b.uri as unknown as vscode.Uri)).toBe(true);
    expect(b.getText()).toBe(UNFORMATTED);

    const c = vscode.createMockTextDocument('/p/c.dbml', UNFORMATTED);
    c._setText(UNFORMATTED);
    await c.save();
    expect(c.getText()).toBe(formatDbml(UNFORMATTED).text);
  });

  it('releases the guard when the save throws, and counts overlapping saves of one document', async () => {
    const doc = vscode.createMockTextDocument('/p/t.dbml', UNFORMATTED);
    const uri = doc.uri as unknown as vscode.Uri;
    doc.save = async () => { throw new Error('Document has been closed'); };
    await expect(saveWithoutFormatting(doc as unknown as vscode.TextDocument)).rejects.toThrow('closed');
    expect(isErdStudioSaving(uri)).toBe(false);

    let release!: () => void;
    doc.save = () => new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const first = saveWithoutFormatting(doc as unknown as vscode.TextDocument);
    const firstRelease = release;
    const second = saveWithoutFormatting(doc as unknown as vscode.TextDocument);
    firstRelease();
    await first;
    expect(isErdStudioSaving(uri)).toBe(true);
    release();
    await second;
    expect(isErdStudioSaving(uri)).toBe(false);
  });
});
