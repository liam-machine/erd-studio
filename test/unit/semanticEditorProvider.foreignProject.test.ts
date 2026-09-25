/**
 * A window serves one dbt project (#82). A domain file from another dbt
 * project in the same workspace must not render against this project's
 * manifest and model library — the editor shows why and offers to switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

function buildProvider(rootDir: string) {
  const layerService = new LayerService(rootDir, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(rootDir, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(rootDir, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  return new SemanticEditorProvider(
    context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, rootDir, new SelectorsService(domainService, rootDir, '.erd-studio'), logicalModelService,
  );
}

async function openIn(provider: SemanticEditorProvider, file: string) {
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (o: number) => ({ o }), save: async () => true,
  };
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return panel;
}

let root: string;
let active: string;
let other: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-foreign-'));
  active = path.join(root, 'finance-dbt');
  other = path.join(root, 'datamodels');
  fs.cpSync(FIXTURE_ROOT, active, { recursive: true });
  fs.cpSync(FIXTURE_ROOT, other, { recursive: true });
  vscode._resetMockWorkspace();
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('opening a domain file from another dbt project', () => {
  it('shows a scriptless page with a switch link instead of the canvas', async () => {
    const panel = await openIn(buildProvider(active), path.join(other, '.erd-studio', 'silver', 'showcase.json'));

    expect(panel.webview.options).toMatchObject({ enableScripts: false, enableCommandUris: ['erdStudio.selectDbtProject'] });
    expect(panel.webview.html).toContain('belongs to the <code>datamodels</code> dbt project');
    expect(panel.webview.html).toContain(`command:erdStudio.selectDbtProject?${encodeURIComponent(JSON.stringify([other]))}`);
    expect(panel.webview.html).not.toContain('<script');
    expect(warn).toHaveBeenCalledWith(
      'ERD Studio: showcase.json belongs to the datamodels dbt project, but finance-dbt is open.',
      'Switch Project',
    );
  });

  it('the notification button runs Select dbt Project with the owning project', async () => {
    warn.mockResolvedValue('Switch Project' as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await openIn(buildProvider(active), path.join(other, '.erd-studio', 'silver', 'showcase.json'));

    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.selectDbtProject', other));
  });

  it("still opens this project's own domain files normally", async () => {
    const panel = await openIn(buildProvider(active), path.join(active, '.erd-studio', 'silver', 'showcase.json'));

    expect(panel.webview.options).toMatchObject({ enableScripts: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
