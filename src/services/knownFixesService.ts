/**
 * The VS Code side of "a newer ERD Studio fixes this" — every rule lives in
 * `knownFixes.ts`; this file only supplies storage, the network and the UI.
 *
 * It is wired to the telemetry facade's error path (`setErrorCodeListener`) but
 * does not depend on telemetry being on: the request sends nothing about the
 * user, so its only switch is `erdStudio.checkKnownFixes` (user scope only, so a
 * checked-in settings file cannot turn it on or off for someone else).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getErdStudioSetting } from './configService';
import { safeBaseUrl } from './feedbackAnalysisService';
import {
  KnownFixesChecker,
  type CachedKnownFixes,
  type KnownFixChoice,
  type ShownKnownFixes,
} from './knownFixes';
import { setErrorCodeListener, telemetry } from './telemetryService';

/** The registry, served by the telemetry Worker (`telemetry/known-fixes.json`). */
export const KNOWN_FIXES_ENDPOINT = 'https://erd-studio-telemetry.w2solutions.ai/known-fixes';

export const CHECK_KNOWN_FIXES_SETTING = 'checkKnownFixes';
export const EXTENSION_ID = 'liamwynne.erd-studio';

const CACHE_KEY = 'erdStudio.knownFixes.cache';
const SHOWN_KEY = 'erdStudio.knownFixes.shown';

const UPDATE = 'Update';
const RELOAD = 'Reload Window';
const NOT_NOW = 'Not now';

let endpointOverride: string | null = null;

/** Overrides {@link KNOWN_FIXES_ENDPOINT}. **Tests only.** Pass `null` to go back. */
export function setKnownFixesEndpointForTests(endpoint: string | null): void {
  endpointOverride = endpoint;
}

/** Builds the checker and connects it to recorded error codes. */
export function startKnownFixes(context: vscode.ExtensionContext): KnownFixesChecker {
  const checker = new KnownFixesChecker({
    version: String(context.extension?.packageJSON?.version ?? ''),
    enabled: () => getErdStudioSetting<boolean>(CHECK_KNOWN_FIXES_SETTING, true) !== false,
    url: () => safeBaseUrl(endpointOverride ?? KNOWN_FIXES_ENDPOINT),
    // No headers, no query, no body: the server learns that someone asked, nothing more.
    fetch: (url, init) => fetch(url, { method: 'GET', signal: init.signal }),
    now: () => Date.now(),
    getCache: () => context.globalState.get<CachedKnownFixes>(CACHE_KEY),
    setCache: (value) => void context.globalState.update(CACHE_KEY, value),
    getShown: () => context.globalState.get<ShownKnownFixes>(SHOWN_KEY),
    setShown: (value) => void context.globalState.update(SHOWN_KEY, value),
    installedVersions: () => installedVersions(context.extensionUri?.fsPath),
    // The prompt's outcome is usage telemetry (B18): whether the self-healing loop works.
    // Fixed keys only; like every feature, nothing is recorded while telemetry is off.
    notify: async (message, pendingReload): Promise<KnownFixChoice> => {
      const primary = pendingReload ? RELOAD : UPDATE;
      telemetry.feature('knownFixOffered');
      const picked = await vscode.window.showInformationMessage(message, primary, NOT_NOW);
      if (picked === RELOAD) {
        telemetry.feature('knownFixReload');
        return 'reload';
      }
      if (picked === UPDATE) {
        telemetry.feature('knownFixUpdate');
        return 'update';
      }
      telemetry.feature('knownFixDismissed');
      return 'dismissed';
    },
    openExtension: () => openExtensionPage(),
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
  });
  setErrorCodeListener(code => checker.check(code));
  context.subscriptions.push({ dispose: () => setErrorCodeListener(undefined) });
  return checker;
}

/**
 * ERD Studio in the Extensions view, where the update button is. Falls back to
 * the extension's page, then to a search, as those commands vary by editor.
 */
async function openExtensionPage(): Promise<void> {
  const attempts: Array<[string, unknown]> = [
    ['workbench.extensions.action.showExtensionsWithIds', [EXTENSION_ID]],
    ['extension.open', EXTENSION_ID],
    ['workbench.extensions.search', `@id:${EXTENSION_ID}`],
  ];
  for (const [command, arg] of attempts) {
    try {
      await vscode.commands.executeCommand(command, arg);
      return;
    } catch {
      // Not available in this editor: try the next one.
    }
  }
}

/**
 * Versions of ERD Studio unpacked next to the running one
 * (`…/extensions/liamwynne.erd-studio-1.7.0[-platform]`), minus those VS Code
 * has marked for removal in `.obsolete`. A newer one there is an update that
 * is installed and waiting for a reload. A dev checkout has no such siblings.
 */
export function installedVersions(extensionPath: string | undefined): string[] {
  if (!extensionPath) return [];
  const dir = path.dirname(extensionPath);
  let obsolete: Record<string, unknown> = {};
  try {
    obsolete = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8')) as Record<string, unknown>;
  } catch {
    // No .obsolete file is the ordinary case.
  }
  const prefix = `${EXTENSION_ID}-`;
  const found: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().startsWith(prefix) || obsolete[name]) continue;
    const match = /^(\d+\.\d+\.\d+)(?:-[a-z0-9-]+)?$/i.exec(name.slice(prefix.length));
    if (match) found.push(match[1]);
  }
  return found;
}
