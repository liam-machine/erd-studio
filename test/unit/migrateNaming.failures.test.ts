/**
 * "Migrate to the New File Naming" when it fails (#219): each message says
 * whose problem it is, never carries the raw exception or an absolute path,
 * offers the next step as a button that does it, and is counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { migrateToTableNaming, MIGRATE_NAMING_BUTTON, type MigrateNamingDeps } from '../../src/commands/migrateNaming';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/dbt-project');
const TITLE = 'Migrate to the New File Naming';
let root: string;
let erd: string;

function deps(overrides: Partial<MigrateNamingDeps> = {}): MigrateNamingDeps {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: root, semanticDir: '.erd-studio', subjectAreaService, tableLibraryService, version: '9.9.9',
    onMigrated: vi.fn(async () => {}), ...overrides,
  };
}

/** Each toast as its text and button labels. */
function toasts(spy: { mock: { calls: unknown[][] } }): Array<{ message: string; buttons: string[] }> {
  return spy.mock.calls.map((call) => ({ message: String(call[0]), buttons: call.slice(1).filter((a): a is string => typeof a === 'string') }));
}

/** Let the toast's chosen button run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

let error: ReturnType<typeof vi.spyOn>;
let telemetryError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-219-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
  telemetryError = vi.spyOn(telemetry, 'error');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Migrate to the New File Naming: failures (#219)', () => {
  it('an unexpected failure is ours: no raw error or path, Send Feedback (redacted) and Try Again, counted as migrationFailed', async () => {
    const secret = path.join(root, 'private', 'layers.json');
    let calls = 0;
    const subjectAreaService = { listSubjectAreas: () => { calls++; throw new Error(`EACCES: permission denied, open '${secret}'`); } };
    const execute = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    error.mockResolvedValueOnce('Send Feedback' as never).mockResolvedValueOnce('Try Again' as never);

    expect(await migrateToTableNaming(deps({ subjectAreaService } as never))).toBe('failed');

    expect(toasts(error)[0]).toEqual({
      message: `${TITLE} hit a problem in ERD Studio while planning the migration, so nothing was changed. This isn't something you did. Please send us a report.`,
      buttons: ['Send Feedback', 'Try Again'],
    });
    expect(telemetryError).toHaveBeenCalledWith('migrationFailed');
    await settle();
    const prefill = execute.mock.calls.find((c) => c[0] === 'erdStudio.reportBug')?.[1] as { description: string };
    expect(prefill.description).toContain('EACCES');
    expect(prefill.description).not.toContain(root);

    // Try Again runs the command again.
    expect(calls).toBe(1);
    await migrateToTableNaming(deps({ subjectAreaService } as never));
    await settle();
    expect(calls).toBe(3);
  });

  it('a failure after the files moved does not say nothing changed: Send Feedback and Reload Window', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    const onMigrated = vi.fn(async () => { throw new Error(`refresh failed in ${root}`); });

    expect(await migrateToTableNaming(deps({ onMigrated }))).toBe('migrated');

    expect(fs.existsSync(path.join(erd, 'tables', 'dim_task.yml'))).toBe(true);
    expect(toasts(error)).toEqual([{
      message: `${TITLE} hit a problem in ERD Studio after moving the files, so open diagrams may not show the new naming until you reload the window. ` +
        "This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', 'Reload Window'],
    }]);
    expect(telemetryError).toHaveBeenCalledWith('migrationFailed');
  });

  it('a failed v4 step is counted once, by the step itself, and not called nothing-changed', async () => {
    fs.writeFileSync(path.join(erd, 'gold', 'inline.json'), JSON.stringify({
      schemaVersion: 4, domain: 'inline', layer: 'gold', description: '',
      logical: { models: [{ name: 'dim_inline', columns: [{ name: 'k', dataType: 'INT', isPrimaryKey: true }] }], relationships: [] },
    }, null, 2) + '\n');
    const migrateToV5 = vi.fn(async (): Promise<boolean> => { throw new Error('v5 failed'); });

    expect(await migrateToTableNaming(deps({ migrateToV5 }))).toBe('failed');

    expect(telemetryError).not.toHaveBeenCalledWith('migrationFailed');
    expect(toasts(error)).toEqual([{
      message: `${TITLE} hit a problem in ERD Studio while converting the v4 subject areas, so some files may already be converted (source control shows which). ` +
        "This isn't something you did. Please send us a report.",
      buttons: ['Send Feedback', 'Try Again'],
    }]);
  });

  // A read-only folder stops nobody running as root, nor on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a folder it may not create is the user\'s to fix: says so, with Try Again, and leaves no folder behind', async () => {
      vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
      fs.chmodSync(erd, 0o555);
      try {
        expect(await migrateToTableNaming(deps())).toBe('failed');
      } finally {
        fs.chmodSync(erd, 0o755);
      }

      expect(toasts(error)).toEqual([{
        message: `${TITLE}: ERD Studio isn't allowed to create the tables/ folder in .erd-studio/. Check the folder's permissions, then try again. Nothing was changed.`,
        buttons: ['Try Again'],
      }]);
      expect(fs.existsSync(path.join(erd, 'tables'))).toBe(false);
      expect(fs.existsSync(path.join(erd, 'logical-models', 'dim_task.yml'))).toBe(true);
      expect(telemetryError).not.toHaveBeenCalledWith('migrationFailed');
    },
  );

  it('unsaved edits: Show File opens the first, and Save and Try Again saves them, then migrates', async () => {
    const file = path.join(erd, 'logical-models', 'dim_task.yml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    doc.isDirty = true;
    const save = vi.spyOn(doc, 'save').mockImplementation(async () => { doc.isDirty = false; return true; });
    vscode.workspace.textDocuments.push(doc as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    error.mockResolvedValueOnce('Show File' as never);

    expect(await migrateToTableNaming(deps())).toBe('refused');
    expect(toasts(error)[0]).toEqual({
      message: `${TITLE}: .erd-studio/logical-models/dim_task.yml has unsaved edits. Save or revert it, then migrate. Nothing was changed.`,
      buttons: ['Show File', 'Save and Try Again'],
    });
    await settle();
    expect((show.mock.calls[0][0] as vscode.Uri).fsPath).toBe(file);
    expect(info).not.toHaveBeenCalled();

    error.mockResolvedValueOnce('Save and Try Again' as never);
    await migrateToTableNaming(deps());
    await settle();
    expect(save).toHaveBeenCalled();
    expect(fs.existsSync(path.join(erd, 'tables', 'dim_task.yml'))).toBe(true);
  });

  it('Save and Try Again stops, naming the file, when the save fails', async () => {
    const file = path.join(erd, 'logical-models', 'dim_task.yml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    doc.isDirty = true;
    vi.spyOn(doc, 'save').mockResolvedValue(false);
    vscode.workspace.textDocuments.push(doc as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    error.mockResolvedValueOnce('Save and Try Again' as never);

    await migrateToTableNaming(deps());
    await settle();

    expect(toasts(error)[1]).toEqual({
      message: `${TITLE}: ERD Studio couldn't save .erd-studio/logical-models/dim_task.yml. Save or revert it yourself, then migrate. Nothing was changed.`,
      buttons: ['Show File'],
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('the project changed while the dialog was open: Try Again runs it again', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce('Try Again' as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
      .mockImplementationOnce((async () => {
        fs.writeFileSync(path.join(erd, 'logical-models', 'dim_new.yml'), 'name: dim_new\ncolumns: []\n');
        return MIGRATE_NAMING_BUTTON;
      }) as never)
      .mockResolvedValue(undefined as never);

    expect(await migrateToTableNaming(deps())).toBe('cancelled');
    expect(toasts(warn)[0]).toEqual({
      message: `${TITLE}: the project changed while the dialog was open. Nothing was changed; run it again.`,
      buttons: ['Try Again'],
    });
    await settle();
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('VS Code rejecting the edit: plain words on whose problem it is, Try Again and Send Feedback', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    vscode._mockWorkspaceState.applyEditResult = false;

    expect(await migrateToTableNaming(deps())).toBe('failed');

    expect(toasts(error)).toEqual([{
      message: `${TITLE}: VS Code didn't accept the file moves, so nothing was changed. ` +
        "This is usually a file another program has open or a folder you can't write to.",
      buttons: ['Try Again', 'Send Feedback'],
    }]);
    expect(telemetryError).toHaveBeenCalledWith('editRejected');
  });

  it('a subject area that did not save: counted as saveFailed, and Save All saves it', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    const showcase = path.join(erd, 'silver', 'showcase.json');
    vscode._failMockSave(showcase);
    error.mockImplementationOnce((async () => { vscode._unfailMockSave(showcase); return 'Save All'; }) as never);

    expect(await migrateToTableNaming(deps())).toBe('migrated');

    expect(toasts(error)[0]).toEqual({
      message: `${TITLE}: could not save .erd-studio/silver/showcase.json; the change is open in the editor but not on disk. Save it from its tab.`,
      buttons: ['Save All', 'Show File'],
    });
    expect(telemetryError).toHaveBeenCalledWith('saveFailed');
    await settle();
    expect(JSON.parse(fs.readFileSync(showcase, 'utf-8'))).toHaveProperty('subjectArea');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a save that fails and then a refresh that throws: the unsaved warning still shows, and no Reload Window', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    vscode._failMockSave(path.join(erd, 'silver', 'showcase.json'));
    const onMigrated = vi.fn(async () => { throw new Error('refresh failed'); });

    expect(await migrateToTableNaming(deps({ onMigrated }))).toBe('migrated');

    expect(toasts(error).map((t) => t.buttons)).toEqual([['Save All', 'Show File'], ['Send Feedback']]);
    expect(telemetryError).toHaveBeenCalledWith('saveFailed');
  });

  it('Save All that still fails says so, with Show File', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    vscode._failMockSave(path.join(erd, 'silver', 'showcase.json'));
    error.mockResolvedValueOnce('Save All' as never);

    await migrateToTableNaming(deps());
    await settle();

    expect(toasts(error)[1]).toEqual({
      message: `${TITLE}: still could not save .erd-studio/silver/showcase.json. Save it from its tab, or use Edit > Undo to put every file back.`,
      buttons: ['Show File'],
    });
  });

  it('no message on these paths carries an absolute path', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(MIGRATE_NAMING_BUTTON as never);
    vscode._failMockSave(path.join(erd, 'silver', 'showcase.json'));
    await migrateToTableNaming(deps());
    vscode._mockWorkspaceState.applyEditResult = false;
    await migrateToTableNaming(deps());
    for (const { message } of toasts(error)) expect(message).not.toContain(root);
  });
});
