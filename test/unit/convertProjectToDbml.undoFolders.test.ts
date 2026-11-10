/**
 * #275 (2): Convert Project to DBML, then Edit > Undo. VS Code's undo of the
 * one WorkspaceEdit puts every file back (its creates are deleted, its
 * deletes restored, its replaces reverted), but the folders Convert made for
 * the new files (`ensureDir` in `convertProjectToDbml`) are not part of the
 * edit, so they stay behind empty: `gold/diagrams`, `silver/tables/public`,
 * `silver/relationships`, … The undo must leave the folder tree as it was.
 *
 * The mock has no native undo, so this test plays VS Code's part: it reverts
 * every write of the plan on disk and fires the events VS Code fires for an
 * undo (an `Undo` text change for each replaced file, and the file-delete
 * event for the created files), then checks the folders. A folder that
 * existed before Convert, or that holds anything now, always stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { convertProjectToDbml, planProjectDbmlConversion, type ConvertProjectDeps } from '../../src/commands/convertProjectToDbml';
import { ConvertToDbmlPanel } from '../../src/providers/ConvertToDbmlPanel';
import { TableLibraryService } from '../../src/services/logicalModelService';

/** The dev-host fixture Liam converted: JSON diagrams in gold/ and silver/, a flat YAML library. */
const DBT_PROJECT_ERD = path.resolve(__dirname, '../fixtures/dbt-project/.erd-studio');

let root: string;
let erd: string;

/** Every folder under the semantic dir, posix, relative. */
function folders(dir = erd): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(d, entry.name);
      out.push(path.relative(erd, p).split(path.sep).join('/'));
      walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every file under the semantic dir, posix, relative → text. */
function files(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fs.readdirSync(erd, { recursive: true }) as string[]) {
    const full = path.join(erd, f);
    if (fs.statSync(full).isFile()) out.set(f.split(path.sep).join('/'), fs.readFileSync(full, 'utf-8'));
  }
  return out;
}

function ageFiles(dir: string): void {
  const past = new Date(Date.now() - 60_000);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) ageFiles(p);
    else fs.utimesSync(p, past, past);
  }
}

function deps(): ConvertProjectDeps {
  return {
    workspaceRoot: root,
    semanticDir: '.erd-studio',
    tableLibraryService: new TableLibraryService(root, '.erd-studio'),
    onConverted: vi.fn(async () => {}),
  } as ConvertProjectDeps;
}

/** Click Convert in the panel each time it shows; answer every toast with nothing. */
function answerConvert(): void {
  const real = ConvertToDbmlPanel.show.bind(ConvertToDbmlPanel);
  vi.spyOn(ConvertToDbmlPanel, 'show').mockImplementation((content) => {
    const choice = real(content);
    const panel = vscode.window._webviewPanels.at(-1)!;
    setTimeout(() => { void panel._simulateMessage({ type: 'convert' }); }, 0);
    return choice;
  });
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async () => undefined as never);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-undo-'));
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vscode._resetMockWebviewPanels();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  (vscode.window.tabGroups as { all: unknown[] }).all = [];
});

afterEach(() => {
  ConvertToDbmlPanel.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** VS Code's undo of the conversion's WorkspaceEdit, played on disk: deletes restored, replaces reverted, creates deleted. */
async function undoConversion(plan: Awaited<ReturnType<typeof planProjectDbmlConversion>>, filesBefore: Map<string, string>): Promise<void> {
  const abs = (rel: string): string => path.join(erd, ...rel.split('/'));
  for (const d of [...plan.deletes].reverse()) {
    fs.mkdirSync(path.dirname(abs(d)), { recursive: true });
    fs.writeFileSync(abs(d), filesBefore.get(d)!);
  }
  for (const r of [...plan.replaces].reverse()) {
    fs.writeFileSync(abs(r.path), filesBefore.get(r.path)!);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs(r.path))) as unknown as ReturnType<typeof vscode.createMockTextDocument>;
    doc._setText(filesBefore.get(r.path)!);
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
  }
  for (const c of [...plan.creates].reverse()) fs.rmSync(abs(c.path));
  await vscode._fireDidDeleteFiles(plan.creates.map((c) => vscode.Uri.file(abs(c.path))));
  await new Promise((r) => setTimeout(r, 100));
}

describe('#275: Convert Project to DBML, then Undo', () => {
  async function convert(): Promise<{ plan: Awaited<ReturnType<typeof planProjectDbmlConversion>>; foldersBefore: string[]; filesBefore: Map<string, string> }> {
    fs.cpSync(DBT_PROJECT_ERD, erd, { recursive: true });
    ageFiles(erd);
    // A folder the user made, empty, before Convert: never Convert's to remove.
    fs.mkdirSync(path.join(erd, 'gold', 'scratch'));
    const foldersBefore = folders();
    const filesBefore = files();
    const plan = await planProjectDbmlConversion(deps());
    expect(plan.creates.length).toBeGreaterThan(0);
    answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    return { plan, foldersBefore, filesBefore };
  }

  it('puts every file back and leaves no empty folder Convert created', async () => {
    const { plan, foldersBefore, filesBefore } = await convert();
    const created = folders().filter((f) => !foldersBefore.includes(f));
    // Convert made folders for its new files (the reported ones among them).
    expect(created).toEqual(expect.arrayContaining(['gold/diagrams', 'silver/diagrams', 'silver/tables/public']));

    await undoConversion(plan, filesBefore);

    // Every file is back, byte for byte (git is clean) ...
    expect(files()).toEqual(filesBefore);
    // ... and so is the folder tree: no empty gold/diagrams, silver/tables/public, silver/relationships left
    // behind, and the user's own empty gold/scratch still there.
    expect(folders()).toEqual(foldersBefore);
  });

  it('a folder Convert made that now holds a file of the user\'s stays, with its parents', async () => {
    const { plan, foldersBefore, filesBefore } = await convert();
    fs.writeFileSync(path.join(erd, 'silver', 'tables', 'public', 'notes.md'), 'mine\n');

    await undoConversion(plan, filesBefore);

    expect(fs.readFileSync(path.join(erd, 'silver', 'tables', 'public', 'notes.md'), 'utf-8')).toBe('mine\n');
    expect(folders()).toEqual([...foldersBefore, 'silver/tables', 'silver/tables/public'].sort());
  });

  it('only the delete of a file Convert created sweeps: another delete removes nothing', async () => {
    const { plan } = await convert();
    const diagram = plan.creates.find((c) => c.path.startsWith('gold/diagrams/'))!;
    const diagrams = path.join(erd, 'gold', 'diagrams');
    for (const f of fs.readdirSync(diagrams)) fs.rmSync(path.join(diagrams, f));
    await vscode._fireDidDeleteFiles([vscode.Uri.file(path.join(erd, 'gold', 'not-convert.dbml'))]);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(diagrams)).toBe(true);
    await vscode._fireDidDeleteFiles([vscode.Uri.file(path.join(erd, ...diagram.path.split('/')))]);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(diagrams)).toBe(false);
  });
});
