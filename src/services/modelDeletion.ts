/**
 * Delete Model in the Model Library: the model's file goes, and every
 * relationship other model files keep to it goes with it (#133 review 8).
 * All or nothing: every changed file is rendered before the first write, so a
 * file whose `relationships:` cannot be edited in place (an alias, an anchor
 * used elsewhere) refuses with nothing written; a write or the delete that
 * fails puts every file already written back to its previous bytes.
 *
 * No `vscode`: the command owns the confirmation and the messages.
 */

import * as fs from 'fs';

import type { SemanticModel } from '../types/semantic';
import type { LogicalModelService } from './logicalModelService';

export type ModelDeletionService = Pick<LogicalModelService, 'findModelFile' | 'serializeModelAt' | 'writeModelText' | 'deleteModel'>;

/** What happened: `ok`, or why not and whether anything was left changed. */
export type ModelDeletionResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Save `changed` (other models, their relationships to `name` taken out),
 * then delete `name`'s file — or, on any failure, leave every file as it was.
 */
export function deleteModelWithRelationships(
  service: ModelDeletionService,
  name: string,
  changed: readonly SemanticModel[],
): ModelDeletionResult {
  const saves: Array<{ model: string; filePath: string; before: string; text: string }> = [];
  try {
    for (const model of changed) {
      const filePath = service.findModelFile(model.name);
      if (!filePath) throw new Error(`${model.name}'s model file could not be found`);
      saves.push({ model: model.name, filePath, before: fs.readFileSync(filePath, 'utf-8'), text: service.serializeModelAt(model, filePath) });
    }
  } catch (err) {
    return { ok: false, message: `${messageOf(err)} Nothing was changed.` };
  }
  const written: typeof saves = [];
  try {
    for (const save of saves) {
      service.writeModelText(save.filePath, save.text);
      written.push(save);
    }
    service.deleteModel(name);
    return { ok: true };
  } catch (err) {
    const leftBehind: string[] = [];
    for (const save of written.reverse()) {
      try { service.writeModelText(save.filePath, save.before); } catch { leftBehind.push(`${save.model}.yml`); }
    }
    return {
      ok: false,
      message: `${messageOf(err)} ${leftBehind.length === 0
        ? 'Nothing was changed.'
        : `These files could not be put back and may need tidying by hand: ${leftBehind.join(', ')}.`}`,
    };
  }
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
