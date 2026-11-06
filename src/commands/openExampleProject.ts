/**
 * **Open an Example…** (`erdStudio.openExampleProject`) — the one example
 * command (Draft-first, `docs/dev/draft-first.md` §9). It opens the example
 * draft (`openExampleDraft`): the coffee-shop star schema, read-only, with an
 * **Example** switcher over the eight example projects in `docs/examples/`,
 * each a whole native-DBML project laid out the way a modelling pattern lays
 * out a warehouse. Nothing is written until the user keeps one: the coffee
 * shop's **Keep This Example** writes it into the open folder (Import DBML,
 * `openExampleDiagram`); a project's **Save This Example…** writes it into a
 * new folder of its own and opens it there (never into the open project).
 * Works with no folder open: for someone who installed ERD Studio into an
 * empty window, this is the way in.
 *
 * Save This Example…'s steps (`openExampleProject`, resumed with the example
 * chosen; without one, the no-preview fallback picks it from a list first):
 * pick the folder to save it in (the example goes in
 * `<that folder>/<example id>`) → write every file, all or nothing
 * (`writeFilesWithRollback`) → store the pending record
 * (`PENDING_EXAMPLE_OPEN_KEY`) → open the folder: in a new window when one is
 * already open, in this window when it is empty. The window that opens reads
 * the record on activation (`takePendingExample`) and opens the example's
 * first diagram.
 *
 * A folder of that name that already holds an example copy (`.erd-studio/`)
 * is offered as it is (**Open It**) and never overwritten; any other folder of
 * that name stops the command before anything is written.
 *
 * Every vscode call goes through `OpenExampleProjectUi`, so the flow is
 * unit-tested with plain fakes; `vscodeOpenExampleProjectUi()` is the real one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  EXAMPLE_PARENT_FOLDER_KEY,
  PENDING_EXAMPLE_OPEN_KEY,
  availableExampleProjects,
  exampleFiles,
  type ExampleProject,
  type PendingExampleOpen,
} from '../services/exampleProjects';
import { OPEN_IT_BUTTON, oursMessage, showErrorWithActions, type ErrorActions } from '../services/commandErrors';
import {
  EXAMPLE_COFFEE_SHOP_SCOPE_ID,
  afterScope,
  draftFromExampleProject,
  exampleDbmlDraft,
  exampleScopes,
  parseExampleScope,
} from '../services/draftModel';
import type { Draft, DraftPreview, DraftTrigger } from '../types/draft';
import { EXAMPLE_DBML, EXAMPLE_DBML_FILE_NAME, openExampleDiagram } from './openExampleDiagram';
import type { ImportDbmlDeps } from './importDbml';
import { FileWriteRollbackFailed, writeFilesWithRollback, type FileWriteIo } from '../services/fsFileWrites';
import { log } from '../services/logger';
import { pathKey } from '../services/pathKey';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { telemetry } from '../services/telemetryService';
import { recordWriteFailure } from '../services/importTelemetry';

export const OPEN_EXAMPLE_PROJECT_COMMAND = 'erdStudio.openExampleProject';

/** The command's title, as the palette names it (`Open an Example…`), without the ellipsis. */
export const OPEN_EXAMPLE_PROJECT_TITLE = 'Open an Example';
export const OPEN_EXAMPLE_PROJECT_PLACEHOLDER = 'Pick a data model to explore. It opens in a folder of its own.';
export const SAVE_EXAMPLE_HERE_BUTTON = 'Save Example Here';
export const CHOOSE_ANOTHER_FOLDER_BUTTON = 'Choose Another Folder';
export { OPEN_IT_BUTTON };

/** A picker row: the example it stands for. */
export interface ExampleQuickPickItem extends vscode.QuickPickItem {
  example: ExampleProject;
}

/** Every vscode call the flow makes, injectable for tests. */
export interface OpenExampleProjectUi {
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  /** The folder to save `exampleId` in (a folder dialog starting at `defaultFolder`); undefined when cancelled. */
  pickParentFolder(defaultFolder: string, exampleId: string): Promise<string | undefined>;
  /** A modal: `message`, the `detail` under it, `button` and Cancel. True when `button` was picked. */
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** The folders open in this window (absolute). */
  workspaceFolders(): string[];
  /** Open `folder`: in a new window when `forceNewWindow`, else in this one. */
  openFolder(folder: string, forceNewWindow: boolean): Promise<void>;
  /** Open a diagram on the ERD canvas in this window. */
  openDiagram(diagramPath: string): Promise<void>;
}

export interface OpenExampleProjectDeps {
  /** Where the pending record and the last parent folder are kept (`context.globalState`). */
  globalState: Pick<vscode.Memento, 'get' | 'update'>;
  ui?: OpenExampleProjectUi;
  /** The Save dialog's first folder when none is remembered (default: the user's home). */
  homeDir?: string;
  /** File operations for the write (tests make one fail). */
  io?: FileWriteIo;
  now?: () => number;
}

/** What the command did: the example's folder and the diagram opened first. */
export interface OpenExampleProjectResult {
  folder: string;
  diagram: string;
  outcome: 'written' | 'reopened';
}

/** Where Save This Example… and Choose Another Folder enter: with the example already chosen (or its id). */
export type OpenExampleProjectResume = { example: ExampleProject } | { id: string };

/** Run the flow. Resolves undefined when the user cancels or nothing could be opened (each case has already said so). */
export async function openExampleProject(deps: OpenExampleProjectDeps, resume?: OpenExampleProjectResume): Promise<OpenExampleProjectResult | undefined> {
  const ui = deps.ui ?? vscodeOpenExampleProjectUi();
  const now = deps.now ?? Date.now;

  const showError = (message: string, actions: ErrorActions = {}): void => {
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${OPEN_EXAMPLE_PROJECT_TITLE}: "${choice}" failed:`, err);
    });
  };
  const cancelled = (): undefined => {
    telemetry.feature('exampleCancelled');
    return undefined;
  };

  // 1. The example.
  let example = resume === undefined ? undefined : 'example' in resume ? resume.example : availableExampleProjects().find((e) => e.id === resume.id);
  if (resume && !example) {
    showError(`${OPEN_EXAMPLE_PROJECT_TITLE}: this build of ERD Studio has no example by that name.`);
    return undefined;
  }
  if (!example) {
    const examples = availableExampleProjects();
    if (examples.length === 0) {
      showError(`${OPEN_EXAMPLE_PROJECT_TITLE}: this build of ERD Studio has no example projects.`);
      return undefined;
    }
    const picked = await ui.showQuickPick<ExampleQuickPickItem>(
      examples.map((e) => ({ label: e.label, description: e.description, detail: e.detail, example: e })),
      { title: OPEN_EXAMPLE_PROJECT_TITLE, placeHolder: OPEN_EXAMPLE_PROJECT_PLACEHOLDER, matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) return cancelled();
    example = picked.example;
  }
  const chosen = example;

  // 2. Where it goes: a new folder named for it, inside the folder picked.
  const remembered = deps.globalState.get<string>(EXAMPLE_PARENT_FOLDER_KEY);
  const defaultFolder = typeof remembered === 'string' && isDirectory(remembered) ? remembered : (deps.homeDir ?? os.homedir());
  const parent = await ui.pickParentFolder(defaultFolder, chosen.id);
  if (!parent) return cancelled();
  const folder = path.join(parent, chosen.id);
  const chooseAnother: ErrorActions = { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => openExampleProject(deps, { example: chosen }) };

  // 3. A folder of that name already there.
  if (fs.existsSync(folder)) {
    if (isDirectory(folder) && fs.existsSync(path.join(folder, '.erd-studio'))) {
      const open = await ui.confirm(
        `${chosen.id} is already in ${parent}. Open that copy?`,
        'It opens as it is, with any changes made to it. Nothing is overwritten.',
        OPEN_IT_BUTTON,
      );
      if (!open) return cancelled();
      telemetry.feature('exampleReopened');
      await deps.globalState.update(EXAMPLE_PARENT_FOLDER_KEY, parent);
      return handOff(deps, ui, chosen, folder, 'reopened', now());
    }
    showError(`${OPEN_EXAMPLE_PROJECT_TITLE}: a folder named ${chosen.id} is already in ${parent}. Choose another folder for the example. Nothing was written.`, chooseAnother);
    return undefined;
  }

  // 4. Every file, all or nothing.
  const files = exampleFiles(chosen.id);
  const writes = Object.entries(files).map(([rel, text]) => ({ kind: 'create' as const, path: path.join(folder, ...rel.split('/')), text }));
  if (writes.length === 0) {
    showError(`${OPEN_EXAMPLE_PROJECT_TITLE}: this build of ERD Studio has no files for ${chosen.id}.`);
    return undefined;
  }
  try {
    writeFilesWithRollback(writes, { io: deps.io });
  } catch (err) {
    telemetry.error('exampleWriteFailed');
    recordWriteFailure(err, telemetry);
    log.error(`[ERD Studio] ${OPEN_EXAMPLE_PROJECT_TITLE}: could not write ${chosen.id}:`, err);
    const left = err instanceof FileWriteRollbackFailed
      ? `These files could not be removed, so delete them yourself: ${err.unrestored.map((p) => path.relative(parent, p)).join(', ')}.`
      : 'Nothing was left behind.';
    showError(`${OPEN_EXAMPLE_PROJECT_TITLE} couldn't save ${chosen.id} in ${parent}. ${left} Check that you can write to that folder, or choose another.`, chooseAnother);
    return undefined;
  }
  telemetry.feature('exampleOpened');
  telemetry.feature(chosen.feature);
  await deps.globalState.update(EXAMPLE_PARENT_FOLDER_KEY, parent);
  return handOff(deps, ui, chosen, folder, 'written', now());
}

/**
 * 5. Open the example's folder. The window that opens it finds the pending
 * record and opens the first diagram. When this very window already has that
 * folder open, the diagram is opened here instead (VS Code would only focus
 * this window, and nothing would open it).
 */
async function handOff(
  deps: OpenExampleProjectDeps,
  ui: OpenExampleProjectUi,
  example: ExampleProject,
  folder: string,
  outcome: OpenExampleProjectResult['outcome'],
  at: number,
): Promise<OpenExampleProjectResult> {
  const result: OpenExampleProjectResult = { folder, diagram: example.startDiagram, outcome };
  const open = ui.workspaceFolders();
  if (open.some((f) => pathKey(f) === pathKey(folder))) {
    await ui.openDiagram(path.join(folder, ...example.startDiagram.split('/')));
    telemetry.feature('exampleDiagramShown');
    return result;
  }
  const pending: PendingExampleOpen = { folder, diagram: example.startDiagram, at };
  await deps.globalState.update(PENDING_EXAMPLE_OPEN_KEY, pending);
  await ui.openFolder(folder, open.length > 0);
  return result;
}

// ---------------------------------------------------------------------------
// The example draft (Open an Example…)
// ---------------------------------------------------------------------------

export interface ExampleDraftDeps {
  /** The one preview of this extension host. */
  preview: DraftPreview;
  /** `example` (Open an Example…, a draft's Open an Example…), or `sidebar` (the automatic example draft). */
  trigger: DraftTrigger;
  /** The automatic draft: nothing is shown when the draft cannot be built. */
  quiet?: boolean;
  /** In a folder: the Import DBML deps the coffee shop's Keep This Example writes with. Undefined: no folder open. */
  importDeps(): ImportDbmlDeps | undefined;
  /** Save This Example…'s write step (a folder of its own). */
  project: OpenExampleProjectDeps;
}

/**
 * Open the example draft on `scopeId` (default the coffee shop): in a folder
 * the coffee shop is drafted by Import DBML (`openExampleDiagram`, quick, so
 * Keep This Example writes it here); with no folder it is planned in memory
 * (`exampleDbmlDraft`, nothing to keep into: Open Folder…). A project is
 * read from the bundled files (`draftFromExampleProject`); its Save This
 * Example… runs {@link openExampleProject} from the folder dialog onward.
 * The switcher re-enters here with the same preview. Writes nothing itself.
 */
export async function openExampleDraft(deps: ExampleDraftDeps, scopeId: string = EXAMPLE_COFFEE_SHOP_SCOPE_ID): Promise<void> {
  const projects = availableExampleProjects();
  const scopes = exampleScopes(scopeId, projects.map((p) => ({ id: p.id, title: p.label })));
  // The switcher is the user's own choice: never quiet from here on.
  const again = (id: string): Promise<void> => openExampleDraft({ ...deps, quiet: false }, id);
  const parsed = parseExampleScope(scopes.current);
  const failed = (err: unknown): void => {
    telemetry.error('draftBuildFailed');
    log.error(`[ERD Studio] ${OPEN_EXAMPLE_PROJECT_TITLE}: could not build the example draft:`, err);
    if (!deps.quiet) {
      const ui = deps.project.ui ?? vscodeOpenExampleProjectUi();
      void ui.showErrorMessage(oursMessage(OPEN_EXAMPLE_PROJECT_TITLE, 'while drawing the example', 'nothing was changed'));
    }
  };

  if (parsed?.kind === 'exampleProject') {
    const example = projects.find((p) => p.id === parsed.id);
    if (example) {
      let draft: Draft;
      try {
        draft = await draftFromExampleProject({
          id: example.id,
          title: example.label,
          files: exampleFiles(example.id),
          startDiagram: example.startDiagram,
          trigger: deps.trigger,
          hasFolder: deps.importDeps() !== undefined,
          scopes,
        });
      } catch (err) {
        failed(err);
        return;
      }
      for (;;) {
        const answer = await deps.preview.ask(draft);
        if (answer.kind === 'keep') {
          // Save This Example…: the folder dialog onward, unchanged.
          const saved = await openExampleProject(deps.project, { example }).catch((err: unknown) => {
            log.error(`[ERD Studio] ${OPEN_EXAMPLE_PROJECT_TITLE}: Save This Example failed:`, err);
            return undefined;
          });
          answer.settle(saved ? { kept: true } : { kept: false });
          if (saved) return;
          // Not saved (the folder dialog cancelled, a refusal): the same draft answers again.
          continue;
        }
        if (answer.kind === 'scope') {
          const next = await afterScope(deps.preview, draft, () => again(answer.scopeId));
          if (next) {
            draft = next;
            continue;
          }
        }
        return;
      }
    }
  }

  // The coffee shop.
  const importDeps = deps.importDeps();
  if (importDeps) {
    await openExampleDiagram({
      ...importDeps,
      draft: {
        preview: deps.preview,
        trigger: deps.trigger,
        ...(deps.quiet ? { quiet: true } : {}),
        ...(importDeps.draft?.generation ? { generation: importDeps.draft.generation } : {}),
        ...(importDeps.draft?.logicalOnly !== undefined ? { logicalOnly: importDeps.draft.logicalOnly } : {}),
        scopes,
        onScope: again,
      },
    });
    return;
  }
  let draft: Draft;
  try {
    draft = await exampleDbmlDraft({ dbmlText: EXAMPLE_DBML, fileName: EXAMPLE_DBML_FILE_NAME, trigger: deps.trigger, scopes });
  } catch (err) {
    failed(err);
    return;
  }
  // Nothing to keep into here: Open Folder… is the host's; the switcher re-enters.
  for (;;) {
    const answer = await deps.preview.ask(draft);
    if (answer.kind !== 'scope') return;
    const next = await afterScope(deps.preview, draft, () => again(answer.scopeId));
    if (!next) return;
    draft = next;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The real UI. */
export function vscodeOpenExampleProjectUi(): OpenExampleProjectUi {
  return {
    showQuickPick: async (items, options) => vscode.window.showQuickPick([...items], options),
    pickParentFolder: async (defaultFolder, exampleId) => {
      const picked = await vscode.window.showOpenDialog({
        title: `${OPEN_EXAMPLE_PROJECT_TITLE}: choose where to save it. A folder named ${exampleId} is made inside the one you choose.`,
        openLabel: SAVE_EXAMPLE_HERE_BUTTON,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(defaultFolder),
      });
      return picked?.[0]?.fsPath;
    },
    confirm: async (message, detail, button) =>
      (await vscode.window.showInformationMessage(message, { modal: true, detail }, button)) === button,
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    openFolder: async (folder, forceNewWindow) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow });
    },
    openDiagram: async (diagramPath) => {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(diagramPath), SUBJECT_AREA_EDITOR_VIEW_TYPE);
    },
  };
}
