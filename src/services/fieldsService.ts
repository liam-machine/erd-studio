/**
 * The project's field list: `<semanticRoot>/fields.yml`, read with core's
 * `parseFieldsText` and cached against the file's mtime and size, so an
 * external edit (a git pull, an assistant, a hand edit) is picked up on the
 * next read without a reload. `invalidate()` drops the cache for a watcher
 * that knows the file changed.
 *
 * Read only: ERD Studio never writes fields.yml (the setup guide writes it
 * after the user says yes; the canvas only opens it). With no file the list
 * is core's `STARTING_FIELD_LIST`, and `exists` is false, so a caller passes
 * a list into the DisplaySubjectArea only when there is a file
 * ({@link FieldsService.displayFields}).
 *
 * No `vscode`: the CLI (`dist/cli.js`) bundles this module.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  FIELDS_FILE_NAME,
  STARTING_FIELD_LIST,
  parseFieldsText,
  type FieldList,
  type FieldsFileProblem,
} from '@erd-studio/core';

/** fields.yml larger than this is not read (it is a short list; anything this big is a mistake). */
export const FIELDS_FILE_MAX_BYTES = 1024 * 1024;

/** What a read of fields.yml gives. Shared and frozen: never mutate it. */
export interface FieldsReading {
  /** Whether `filePath` exists (as anything: a folder by that name exists too, and is reported). */
  readonly exists: boolean;
  /** Absolute path of fields.yml, whether or not it exists. */
  readonly filePath: string;
  /** The resolved list: the file's, or the starting set when there is no usable file. */
  readonly list: FieldList;
  /** Every problem with the file (none when it does not exist). Messages name no file. */
  readonly problems: readonly FieldsFileProblem[];
}

function freezeReading(reading: FieldsReading): FieldsReading {
  for (const defs of [reading.list.tables, reading.list.columns]) {
    for (const def of defs) {
      if (def.values) Object.freeze(def.values);
      Object.freeze(def.home);
      Object.freeze(def);
    }
    Object.freeze(defs);
  }
  Object.freeze(reading.list.leftOut);
  Object.freeze(reading.list);
  for (const problem of reading.problems) Object.freeze(problem);
  Object.freeze(reading.problems);
  return Object.freeze(reading);
}

/**
 * The YAML budget a fields.yml is read with: doctor and the editor read
 * untrusted repos, so alias expansion is bounded like a bundled example's
 * table files (`DRAFT_FILE_LIMITS`), not only by the file's byte size.
 */
export const FIELDS_FILE_PARSE_BUDGET = Object.freeze({ maxNodes: 50_000, maxChars: FIELDS_FILE_MAX_BYTES });

function problem(message: string): FieldsFileProblem {
  return { code: 'fieldsYamlInvalid', severity: 'error', message };
}

/**
 * Read `<semanticRoot>/fields.yml` once, uncached. Never throws: a file that
 * cannot be read is reported as a `fieldsYamlInvalid` problem and gives the
 * starting set.
 */
export function readFieldsFile(semanticRoot: string): FieldsReading {
  const filePath = path.join(semanticRoot, FIELDS_FILE_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return freezeReading({ exists: false, filePath, list: STARTING_FIELD_LIST, problems: [] });
  }
  if (!stat.isFile()) {
    return freezeReading({
      exists: true, filePath, list: STARTING_FIELD_LIST,
      problems: [problem(`${FIELDS_FILE_NAME} is not a file. The starting set is used.`)],
    });
  }
  if (stat.size > FIELDS_FILE_MAX_BYTES) {
    return freezeReading({
      exists: true, filePath, list: STARTING_FIELD_LIST,
      problems: [problem(`The file is too large to read (over ${FIELDS_FILE_MAX_BYTES} bytes). The starting set is used.`)],
    });
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return freezeReading({
      exists: true, filePath, list: STARTING_FIELD_LIST,
      problems: [problem(`The file could not be read (${reason}). The starting set is used.`)],
    });
  }
  const { list, problems } = parseFieldsText(text.replace(/^﻿/, ''), FIELDS_FILE_PARSE_BUDGET);
  return freezeReading({ exists: true, filePath, list, problems });
}

/** A cached reader of one project's fields.yml. */
export class FieldsService {
  private reading: FieldsReading | null = null;
  private signature: string | null = null;
  readonly filePath: string;

  /** `semanticRoot` is the absolute semantic dir (`<project>/.erd-studio`). */
  constructor(readonly semanticRoot: string) {
    this.filePath = path.join(semanticRoot, FIELDS_FILE_NAME);
  }

  private fileSignature(): string {
    try {
      const stat = fs.statSync(this.filePath);
      return `${stat.isFile() ? 'f' : 'o'}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'none';
    }
  }

  /** The current reading: from the cache while the file's mtime and size are unchanged. */
  read(): FieldsReading {
    const signature = this.fileSignature();
    if (this.reading && signature === this.signature) return this.reading;
    this.reading = readFieldsFile(this.semanticRoot);
    this.signature = signature;
    return this.reading;
  }

  /** The resolved list (the starting set without a file). */
  getList(): FieldList {
    return this.read().list;
  }

  /**
   * The list to put in a DisplaySubjectArea (`fields`): the file's, or
   * undefined when there is no file — so a project without one renders and
   * posts exactly what it did before — or when the file cannot be read as a
   * field list (a `fieldsYamlInvalid` problem), as core's loader omits it.
   */
  displayFields(): FieldList | undefined {
    const reading = this.read();
    if (!reading.exists) return undefined;
    return reading.problems.some((p) => p.code === 'fieldsYamlInvalid') ? undefined : reading.list;
  }

  /** Drop the cache: the next read goes to disk whatever the file's mtime says. */
  invalidate(): void {
    this.reading = null;
    this.signature = null;
  }
}
