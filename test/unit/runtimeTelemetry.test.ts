/**
 * The 2.0 runtime failure keys (plan items B4, B10, B12, B16, B18, B19):
 * the fixed tables, the once-per-error mark, the logger's error hook, the
 * command-failure recorder and every logged-error source in `src/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVATION_FAILED,
  HANDLER_GROUP,
  LOGGED_ERROR_AREAS,
  REFRESH_FAILED,
  activationFailureCodes,
  handlerFailureKeys,
  handlerGroupOf,
  harnessFailureKeys,
  hookSkippedFeatures,
  isTelemetryErrorCode,
  loggedErrorCodes,
  welcomeFailureCode,
  writeFailureFeature,
} from '../../src/services/runtimeTelemetry';
import { markRecorded, wasRecorded } from '../../src/services/telemetryOnce';
import { ERROR_CODES, FEATURES, emptyCounters, heartbeatDue, recordError } from '../../src/services/telemetryPayload';
import { createLogger, log, logSourceOf, setErrorHook, writeLog } from '../../src/services/logger';
import { recordCommandFailure } from '../../src/commands/commandFailure';
import { deleteFailure, layersFailure, layersFileMistake, renameReadFailure, renameRefused, unsavedSaveFailure, writeFailure, NEW_DIAGRAM_TITLE, SELECTORS_TITLE } from '../../src/services/diagramCommandErrors';
import { LayersFileUnreadableError } from '../../src/services/layerService';
import { SubjectAreaFileError } from '@erd-studio/core';
import { telemetry } from '../../src/services/telemetryService';

const ROOT = path.resolve(__dirname, '../..');
const errno = (code: string, at = '/home/someone/secret/project/.erd-studio/gold/x.dbml'): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: refused, open '${at}'`), { code, path: at });

afterEach(() => {
  vi.restoreAllMocks();
  setErrorHook(undefined);
});

describe('B4: activation', () => {
  it('each phase records the total and its own code', () => {
    for (const [phase, code] of Object.entries(ACTIVATION_FAILED)) {
      expect(activationFailureCodes(phase as keyof typeof ACTIVATION_FAILED)).toEqual(['activationFailed', code]);
    }
    expect(new Set(Object.values(ACTIVATION_FAILED)).size).toBe(6);
  });

  it('a day whose activation threw before recording an outcome is still due', () => {
    const day = emptyCounters('2026-11-01');
    expect(day.activation).toBeNull();
    expect(heartbeatDue(day, '2026-11-02')).toBe(false);
    expect(heartbeatDue(recordError(day, 'activationFailed'), '2026-11-02')).toBe(true);
    // Another error alone does not make an activation-less day due.
    expect(heartbeatDue(recordError(day, 'saveFailed'), '2026-11-02')).toBe(false);
  });
});

describe('B10 / B16: the write class', () => {
  it('permissions and a full disk are features; anything else is nothing', () => {
    expect(writeFailureFeature(errno('EACCES'))).toBe('writeFailedPermission');
    expect(writeFailureFeature(errno('EROFS'))).toBe('writeFailedPermission');
    expect(writeFailureFeature(errno('ENOSPC'))).toBe('writeFailedDiskFull');
    expect(writeFailureFeature(new TypeError('x is undefined'))).toBeUndefined();
    expect(writeFailureFeature(undefined)).toBeUndefined();
  });

  it('a failed helper install names its target and write class from the errno alone', () => {
    expect(harnessFailureKeys('copilot', 'EACCES')).toEqual({
      errors: ['harnessInstallFailed', 'harnessInstallFailedCopilot'],
      features: ['writeFailedPermission'],
    });
    expect(harnessFailureKeys('claude', undefined)).toEqual({ errors: ['harnessInstallFailed', 'harnessInstallFailedClaude'], features: [] });
    expect(harnessFailureKeys(undefined, 'EBUSY')).toEqual({ errors: ['harnessInstallFailed'], features: [] });
  });

  it('skipped hooks: each reason and tool once, mapped one to one', () => {
    expect(hookSkippedFeatures([
      { id: 'copilot', reason: 'jsonc' },
      { id: 'codex', reason: 'not-json' },
      { id: 'gemini', reason: 'jsonc' },
    ])).toEqual(['hookSkippedJsonc', 'hookSkippedCopilot', 'hookSkippedNotJson', 'hookSkippedCodex', 'hookSkippedGemini']);
    expect(hookSkippedFeatures([{ id: 'codex', reason: 'shape' }, { id: 'codex', reason: 'own-script' }, { id: 'codex', reason: 'newer-script' }]))
      .toEqual(['hookSkippedShape', 'hookSkippedCodex', 'hookSkippedOwnScript', 'hookSkippedNewerScript']);
    expect(hookSkippedFeatures(undefined)).toEqual([]);
  });
});

describe('B10: showCommandFailure records the failure', () => {
  const keys = () => {
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    return () => [...error.mock.calls.map((c) => `!${c[0]}`), ...feature.mock.calls.map((c) => c[0])];
  };
  const ctx = { workspaceRoot: '/home/someone/project', target: '/home/someone/project/.erd-studio/gold/x.dbml', doing: 'while writing the file', outcome: 'Nothing was created.', retry: true };

  it('an error that says what it was doing is ours: commandFailedOurs, plus the builder\'s code', () => {
    const recorded = keys();
    recordCommandFailure(writeFailure(NEW_DIAGRAM_TITLE, new TypeError('bug'), ctx), new TypeError('bug'));
    expect(recorded()).toEqual(['!newDiagramWriteFailed', '!commandFailedOurs']);
  });

  it('EACCES records the write class, not commandFailedOurs', () => {
    const recorded = keys();
    const err = errno('EACCES');
    recordCommandFailure(writeFailure(NEW_DIAGRAM_TITLE, err, ctx), err);
    expect(recorded()).toEqual(['writeFailedPermission']);
  });

  it('a feature code is recorded as a feature, and a failure with no code or class records nothing', () => {
    const recorded = keys();
    recordCommandFailure({ title: NEW_DIAGRAM_TITLE, message: 'm', buttons: [], code: 'newDiagramNoLayers' }, undefined);
    recordCommandFailure({ title: 'Something', message: 'm', buttons: [] }, undefined);
    expect(recorded()).toEqual(['newDiagramNoLayers']);
  });

  it('each builder sets its code on a failure of ours', () => {
    const layersCtx = { workspaceRoot: '/w', layersPath: '/w/.erd-studio/layers.json', doing: 'while saving layers.json', outcome: 'Nothing was changed.' };
    expect(writeFailure(NEW_DIAGRAM_TITLE, new TypeError('bug'), ctx).code).toBe('newDiagramWriteFailed');
    // Only the commands the plan names carry one.
    expect(writeFailure(SELECTORS_TITLE, new TypeError('bug'), ctx).code).toBeUndefined();
    expect(layersFailure('Add Layer', new TypeError('bug'), layersCtx).code).toBe('layersFileFailed');
    expect(deleteFailure('orders', '/w/x.json', new TypeError('bug')).code).toBe('deleteDiagramFailed');
    expect(renameReadFailure('/w/x.json', new TypeError('bug'), '/w').code).toBe('renameDiagramFailed');
    expect(renameRefused('a', 'b').code).toBe('renameDiagramFailed');
    for (const f of [writeFailure(NEW_DIAGRAM_TITLE, new TypeError('bug'), ctx), deleteFailure('o', '/w/x.json', new TypeError('bug'))]) {
      expect(isTelemetryErrorCode(f.code!)).toBe(true);
      expect(f.doing).toBeDefined();
    }
  });

  it('the user\'s environment or file carries no error code: the operation code always means ours', () => {
    const layersCtx = { workspaceRoot: '/w', layersPath: '/w/.erd-studio/layers.json', doing: 'while saving layers.json', outcome: 'Nothing was changed.' };
    expect(writeFailure(NEW_DIAGRAM_TITLE, errno('ENOSPC'), ctx).code).toBeUndefined();
    expect(writeFailure(NEW_DIAGRAM_TITLE, errno('EACCES'), ctx).code).toBeUndefined();
    expect(layersFailure('Add Layer', errno('EACCES'), layersCtx).code).toBeUndefined();
    expect(layersFailure('Add Layer', new LayersFileUnreadableError('Failed to read layers config: EACCES'), layersCtx).code).toBeUndefined();
    // The user's own mistake in layers.json is said in words, not counted as a failure.
    expect(layersFailure('Add Layer', new LayersFileUnreadableError('Invalid layers config: not JSON'), layersCtx).code).toBeUndefined();
    expect(layersFileMistake('Add Layer', layersCtx).code).toBeUndefined();
    expect(deleteFailure('orders', '/w/x.json', errno('EBUSY')).code).toBeUndefined();
    expect(unsavedSaveFailure('orders', 'deleting').code).toBeUndefined();
    expect(unsavedSaveFailure('orders', 'renaming').code).toBeUndefined();
    expect(renameReadFailure('/w/x.json', new SubjectAreaFileError('missing', '/w/x.json', 'x'), '/w').code).toBeUndefined();
    expect(renameReadFailure('/w/x.dbml', new SubjectAreaFileError('invalid-dbml', '/w/x.dbml', 'x', { line: 3 }), '/w').code).toBeUndefined();
  });
});

describe('B12: canvas handler failures', () => {
  it('every message type has a group; an unknown type is other', () => {
    expect(handlerGroupOf('addColumn')).toBe('column');
    expect(handlerGroupOf('undo')).toBe('undo');
    expect(handlerGroupOf('editRelationship')).toBe('relationship');
    expect(handlerGroupOf('notAType')).toBe('other');
    expect(handlerGroupOf('constructor')).toBe('other');
    expect(new Set(Object.values(HANDLER_GROUP)).size).toBe(12);
  });

  it('a failure is the total and its group; a relationship handler only relHandlerFailed', () => {
    expect(handlerFailureKeys('column', { explained: false, overlap: false })).toEqual({ errors: ['handlerFailed', 'handlerFailedColumn'], features: [] });
    expect(handlerFailureKeys('relationship', { explained: false, overlap: false })).toEqual({ errors: ['relHandlerFailed'], features: [] });
  });

  it('an explained refusal is editRefused (nothing for relationships); an overlap is ours', () => {
    expect(handlerFailureKeys('details', { explained: true, overlap: false })).toEqual({ errors: [], features: ['editRefused'] });
    expect(handlerFailureKeys('relationship', { explained: true, overlap: false })).toEqual({ errors: [], features: [] });
    expect(handlerFailureKeys('model', { explained: true, overlap: true })).toEqual({ errors: ['dbmlWriteOverlap', 'handlerFailed', 'handlerFailedModel'], features: [] });
    expect(handlerFailureKeys('relationship', { explained: true, overlap: true })).toEqual({ errors: ['dbmlWriteOverlap', 'relHandlerFailed'], features: [] });
  });

  it('a diagram file the user broke is handlerFileProblem, never a failure of ours', () => {
    expect(handlerFailureKeys('stage', { explained: false, overlap: false, userFile: true })).toEqual({ errors: [], features: ['handlerFileProblem'] });
    expect(handlerFailureKeys('compare', { explained: false, overlap: false, userFile: true })).toEqual({ errors: [], features: ['handlerFileProblem'] });
    expect(handlerFailureKeys('stage', { explained: false, overlap: false, userFile: false })).toEqual({ errors: ['handlerFailed', 'handlerFailedStage'], features: [] });
  });

  it('an error is counted once, however many times it is seen; a thrown string cannot be marked', () => {
    const err = new Error('x');
    expect(wasRecorded(err)).toBe(false);
    markRecorded(err);
    expect(wasRecorded(err)).toBe(true);
    expect(wasRecorded(new Error('x'))).toBe(false);
    markRecorded('text');
    expect(wasRecorded('text')).toBe(false);
    expect(wasRecorded(undefined)).toBe(false);
  });

  it('each watcher kind has its own code', () => {
    expect(Object.values(REFRESH_FAILED)).toEqual([
      'refreshFailedManifest', 'refreshFailedCatalog', 'refreshFailedTable', 'refreshFailedDiagram', 'refreshFailedLayers', 'refreshFailedDbtYml',
    ]);
  });
});

describe('B18: the Welcome panel failure codes', () => {
  it('by message type, unknown or missing as other', () => {
    expect(welcomeFailureCode('start')).toBe('welcomeFailedStart');
    expect(welcomeFailureCode('setupAiHelper')).toBe('welcomeFailedSetup');
    expect(welcomeFailureCode('openClaude')).toBe('welcomeFailedOpenAssistant');
    expect(welcomeFailureCode('openCopilotChat')).toBe('welcomeFailedOpenAssistant');
    expect(welcomeFailureCode('trySample')).toBe('welcomeFailedSample');
    expect(welcomeFailureCode('ready')).toBe('welcomeFailedStatus');
    expect(welcomeFailureCode('refreshStatus')).toBe('welcomeFailedStatus');
    expect(welcomeFailureCode('copyPrompt')).toBe('welcomeFailedOther');
    expect(welcomeFailureCode(undefined)).toBe('welcomeFailedOther');
  });
});

describe('every key used here is in the allowlists', () => {
  it('the tables hold only known keys', () => {
    const known = new Set<string>([...FEATURES, ...ERROR_CODES]);
    const used = [
      ...Object.values(ACTIVATION_FAILED),
      ...Object.values(REFRESH_FAILED),
      ...Object.keys(LOGGED_ERROR_AREAS).flatMap(loggedErrorCodes),
    ];
    for (const key of used) expect(known.has(key), key).toBe(true);
  });
});

describe('B19: the logger error hook', () => {
  it('fires once per error line with only its source tag, never the text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard: string[] = [];
    setErrorHook((source) => heard.push(source));
    createLogger('Canvas').error('Add column failed for /home/someone/secret.dbml');
    log.error('[SemanticEditorProvider] Update meta failed: "customer_name"');
    log.error('no tag at all');
    createLogger('Canvas').warn('not an error');
    createLogger('Draft').info('not an error');
    writeLog('error', '[submitFeedback] HTTP 500', [], new Date(), false);
    expect(heard).toEqual(['Canvas', 'SemanticEditorProvider', '', 'submitFeedback']);
  });

  it('maps each source to its fixed area code, and an unknown or empty one to other', () => {
    expect(loggedErrorCodes('Canvas')).toEqual(['loggedError', 'loggedErrorCanvas']);
    expect(loggedErrorCodes('SemanticEditorProvider')).toEqual(['loggedError', 'loggedErrorCanvas']);
    expect(loggedErrorCodes('Draft')).toEqual(['loggedError', 'loggedErrorDraft']);
    expect(loggedErrorCodes('Table Library')).toEqual(['loggedError', 'loggedErrorSidebar']);
    expect(loggedErrorCodes('ManifestService')).toEqual(['loggedError', 'loggedErrorDbt']);
    expect(loggedErrorCodes('')).toEqual(['loggedError', 'loggedErrorOther']);
    expect(loggedErrorCodes('/home/someone/secret')).toEqual(['loggedError', 'loggedErrorOther']);
    expect(loggedErrorCodes('toString')).toEqual(['loggedError', 'loggedErrorOther']);
  });

  it('a hook that logs an error itself does not recurse, and a hook that throws never reaches the caller', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    setErrorHook(() => {
      calls++;
      log.error('[Canvas] logged from inside the hook');
      throw new Error('hook broke');
    });
    expect(() => log.error('[Canvas] first')).not.toThrow();
    expect(calls).toBe(1);
    // The guard is released after: the next line is heard again.
    log.error('[Canvas] second');
    expect(calls).toBe(2);
  });

  it('removing the hook stops it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = vi.fn();
    setErrorHook(hook);
    setErrorHook(undefined);
    log.error('[Canvas] x');
    expect(hook).not.toHaveBeenCalled();
  });

  it('logSourceOf reads only a leading bracketed tag', () => {
    expect(logSourceOf('[ERD Studio] Import failed')).toBe('ERD Studio');
    expect(logSourceOf('Import [x] failed')).toBe('');
    expect(logSourceOf('[unclosed')).toBe('');
  });
});

describe('loggedErrorAreas: every error source in src/ is in the table', () => {
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }
  const sources = filesUnder(path.join(ROOT, 'src')).map((f) => fs.readFileSync(f, 'utf-8'));

  it('each createLogger scope', () => {
    const scopes = new Set<string>();
    for (const text of sources) for (const m of text.matchAll(/createLogger\('([^']*)'\)/g)) if (m[1]) scopes.add(m[1]);
    expect(scopes.size).toBeGreaterThan(5);
    for (const scope of scopes) expect(Object.keys(LOGGED_ERROR_AREAS), scope).toContain(scope);
  });

  it('each literal [Tag] an unscoped log.error line starts with', () => {
    const tags = new Set<string>();
    for (const text of sources) {
      for (const m of text.matchAll(/\blog\.error\(\s*['`]\[([A-Za-z][^\]$`'{}]{0,59})\]/g)) tags.add(m[1]);
    }
    expect(tags.size).toBeGreaterThan(5);
    for (const tag of tags) expect(Object.keys(LOGGED_ERROR_AREAS), tag).toContain(tag);
  });
});
