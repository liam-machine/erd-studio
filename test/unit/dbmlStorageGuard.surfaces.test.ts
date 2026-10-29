/**
 * The stable DBML guard on the surfaces outside activation: `erd-studio
 * doctor` reports a DBML project as an error with the update advice,
 * selectors.yml is never regenerated (this version lists no DBML diagram, so
 * it would drop their selectors), a canvas that was open when the project
 * became DBML refuses edits, and package.json shows the message in both views.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { runDoctor } from '../../src/cli/doctor';
import { main } from '../../src/cli/index';
import { DBML_STORAGE_MESSAGE } from '../../src/services/dbmlStorageGuard';
import { SelectorsService } from '../../src/services/selectorsService';
import { DBML_GUARD_ALLOWED_MESSAGE_TYPES, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { FIXTURE_ROOT, makeDbmlProject, snapshot } from './dbmlStorageGuard.fixture';

const REPO_ROOT = path.resolve(__dirname, '../..');
const cleanEnv: NodeJS.ProcessEnv = { PATH: '' };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-surfaces-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('erd-studio doctor', () => {
  it('reports a DBML project as an error and puts the newer ERD Studio first', async () => {
    const root = path.join(tmp, 'p');
    makeDbmlProject(root);
    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: tmp });

    // The first DBML file found (folder listing order varies by file system).
    expect(r.erd.dbmlStorage?.file).toMatch(/^\.erd-studio\/tables\/gold\/[a-z_]+\.dbml$/);
    const found = r.erd.dbmlStorage!.file;
    expect(r.nextSteps[0].id).toBe('update-erd-studio');
    expect(r.nextSteps[0].why).toContain(DBML_STORAGE_MESSAGE);
    expect(r.nextSteps[0].why).toContain("don't create or change files in .erd-studio/");

    let out = '';
    const code = await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } },
      stderr: { write: () => undefined },
      cwd: root,
      env: cleanEnv,
    });
    expect(code).toBe(0);
    expect(out).toContain(`✗ ${DBML_STORAGE_MESSAGE} (found ${found})`);
    expect(out).toMatch(/Next steps:\n {2}1\. Open this project with a newer ERD Studio/);
    // On the latest stable there is nothing to update to: name the pre-release switch.
    expect(r.nextSteps[0].why).toContain('Switch to Pre-Release Version');
  });

  it("gives no advice that would write YAML / JSON into it or replace the newer version's skills", async () => {
    const root = path.join(tmp, 'p');
    makeDbmlProject(root);
    // What a part-converted project and a teammate's pull can leave: a v4
    // diagram, the newer version's skills, and v5-named YAML tables.
    fs.copyFileSync(path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'bob.json'), path.join(root, '.erd-studio', 'silver', 'bob.json'));
    const skill = path.join(root, '.claude', 'skills', 'erd-studio', 'SKILL.md');
    fs.writeFileSync(skill, '<!-- erd-studio-harness: 37 -->\n# ERD Studio (DBML)\n');
    fs.mkdirSync(path.join(root, '.erd-studio', 'logical-models'), { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio', 'logical-models', 'dim_date.yml'), 'name: dim_date\ncolumns: []\n');

    const r = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: tmp });
    expect(r.harness.schemaSkill).toBe('outdated');
    expect(r.erd.domainFormatIssues.length).toBeGreaterThan(0);
    const ids = r.nextSteps.map((s) => s.id);
    expect(ids[0]).toBe('update-erd-studio');
    for (const id of ['update-harness', 'migrate-v5', 'fix-subject-area-naming']) {
      expect(ids, id).not.toContain(id);
    }

    let out = '';
    await main(['doctor', '--project', root, '--no-dbt'], {
      stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: root, env: cleanEnv,
    });
    expect(out).not.toContain('Migrate to the New File Naming');
    expect(out).not.toContain('Update the ERD Studio skills');
    expect(out).toMatch(/Claude skills: schema outdated, .* leave them/);
  });
});

describe('erd-studio inventory / diff / export', () => {
  async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await main(args, {
      stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, cwd, env: cleanEnv,
    });
    return { code, out, err };
  }

  it('stop with dbml-storage (exit 3) instead of reporting an empty or misconfigured project', async () => {
    const root = path.join(tmp, 'p');
    makeDbmlProject(root);
    for (const args of [
      ['inventory', '--summary'],
      ['diff', '--all'],
      ['export', '--domain', '.erd-studio/silver/showcase.dbml', '--format', 'mermaid'],
    ]) {
      const human = await run([...args, '--project', root], root);
      expect(human.code, args[0]).toBe(3);
      expect(human.err, args[0]).toContain(DBML_STORAGE_MESSAGE);
      expect(human.err, args[0]).not.toContain('check --semantic-dir');

      const json = await run([...args, '--project', root, '--json'], root);
      expect(json.code, args[0]).toBe(3);
      expect(JSON.parse(json.out).error.code, args[0]).toBe('dbml-storage');
    }
  });

  it('run as before on a YAML / JSON project', async () => {
    const r = await run(['inventory', '--summary', '--project', FIXTURE_ROOT, '--json'], FIXTURE_ROOT);
    expect(r.code).toBe(0);
  });
});

describe('SelectorsService isBlocked', () => {
  it('leaves selectors.yml untouched (noop) while blocked, and regenerates once it is not', () => {
    const root = path.join(tmp, 'p');
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    const file = path.join(root, 'selectors.yml');
    fs.writeFileSync(file, 'selectors:\n  - name: domain_gone\n    description: x. Managed by ERD Studio.\n    definition: {method: fqn, value: a}\n');
    const before = fs.readFileSync(file, 'utf-8');
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    let blocked = true;
    const svc = new SelectorsService(subjectAreaService, root, '.erd-studio', { isBlocked: () => blocked });

    expect(svc.regenerate()).toEqual({ status: 'noop', filePath: file });
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    blocked = false;
    expect(svc.regenerate().status).toBe('written');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('domain_gone');
  });
});

describe('a canvas open when the project became DBML', () => {
  function buildProvider(rootDir: string) {
    const layerService = new LayerService(rootDir, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(rootDir, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const context = {
      extensionUri: vscode.Uri.file(REPO_ROOT),
      globalStorageUri: vscode.Uri.file(path.join(rootDir, '.global-storage')),
      extension: { packageJSON: { version: '0.0.0-test' } },
      globalState: { get: () => true, update: async () => {} },
      secrets: vscode.createMockSecretStorage(),
      subscriptions: [],
    } as unknown as import('vscode').ExtensionContext;
    return new SemanticEditorProvider(
      context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, rootDir, new SelectorsService(subjectAreaService, rootDir, '.erd-studio'), tableLibraryService,
    );
  }

  it('refuses edits with the update message and writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vscode._resetMockWorkspace();
    const root = path.join(tmp, 'p');
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    const provider = buildProvider(root);
    let dbml = false;
    provider.setDbmlStorageGuard({ isActive: () => dbml });
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
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
    expect(panel.webview.options).toMatchObject({ enableScripts: true });

    dbml = true;
    const before = snapshot(root);
    for (const type of ['updatePositions', 'addAnnotation', 'addModel', 'removeModel', 'undo', 'generateSyncPlan']) {
      expect(DBML_GUARD_ALLOWED_MESSAGE_TYPES.has(type), type).toBe(false);
      panel._postedMessages.length = 0;
      await panel._simulateMessage({ type, payload: { positions: { dim_customer: { x: 1, y: 2 } } } });
      expect(panel._postedMessages, type).toEqual([{ type: 'error', payload: { message: DBML_STORAGE_MESSAGE } }]);
    }
    expect(snapshot(root)).toEqual(before);

    // Backstop: the one write path every canvas edit goes through refuses too.
    const apply = (provider as unknown as {
      applySubjectAreaEdit(d: unknown, m: () => void, o: { stage: 'logical' }): Promise<boolean>;
    }).applySubjectAreaEdit.bind(provider);
    await expect(apply(doc, () => {}, { stage: 'logical' })).rejects.toThrow(DBML_STORAGE_MESSAGE);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    contributes: {
      views: Record<string, Array<{ id: string; when?: string }>>;
      viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
      menus: Record<string, Array<{ command: string; when?: string }>>;
    };
  };

  it('both views show the message, with the update link, only in a DBML project', () => {
    for (const view of ['erdStudio.domainTree', 'erdStudio.modelLibrary']) {
      const dbml = pkg.contributes.viewsWelcome.filter((w) => w.view === view && w.when === 'erdStudio.dbmlStorage');
      expect(dbml, view).toHaveLength(1);
      expect(dbml[0].contents).toContain(DBML_STORAGE_MESSAGE);
      expect(dbml[0].contents).toContain('[Open ERD Studio in Extensions](command:erdStudio.openExtensionPage)');
      expect(dbml[0].contents).not.toContain('Update ERD Studio');
    }
    const noTables = pkg.contributes.viewsWelcome.find((w) => w.contents.startsWith('No tables found'))!;
    expect(noTables.when).toBe('!erdStudio.dbmlStorage');
    const noDiagrams = pkg.contributes.viewsWelcome.find((w) => w.contents.startsWith('No diagrams yet'))!;
    expect(noDiagrams.when).toBe('erdStudio.hasDbtProject && !erdStudio.dbmlStorage');
    const library = pkg.contributes.views['erd-studio'].find((v) => v.id === 'erdStudio.modelLibrary')!;
    expect(library.when).toBe('erdStudio.hasLogicalModelsDir || erdStudio.dbmlStorage');
  });

  it('hides the view title buttons that write', () => {
    for (const command of ['erdStudio.drawFromDbt', 'erdStudio.installCodingHarness', 'erdStudio.addLayer',
      'erdStudio.organizeModelLibrary', 'erdStudio.moveRelationshipsToLibrary', 'erdStudio.migrateToTableNaming']) {
      const entry = pkg.contributes.menus['view/title'].find((m) => m.command === command)!;
      expect(entry.when, command).toMatch(/&& !erdStudio\.dbmlStorage$/);
    }
  });
});
