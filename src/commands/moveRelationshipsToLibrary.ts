/**
 * ERD Studio: Move Relationships to Model Library (issue #126).
 *
 * The opt-in for an existing project: every relationship its v5 domain files
 * hold is stored once, in its from-model's `logical-models/*.yml`, and taken
 * out of the domain files. A relationship the domains disagree about is
 * settled by the user — one QuickPick per conflict, naming the diagrams behind
 * each cardinality — or left as it is in each diagram. Prompted, one
 * WorkspaceEdit.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { relationshipKey } from '@erd-studio/core';
import { describeMovePlan, planMoveToLibrary, resolveConflict, upsertLibraryRelationship } from '../services/libraryRelationships';
import { ownWrites } from '../services/ownWriteTracker';
import { detectDomainFormat } from '../types/semantic';
import type { Cardinality, Relationship, SemanticModel } from '../types/semantic';
import type { DomainService } from '../services/domainService';
import type { LogicalModelService } from '../services/logicalModelService';

const TITLE = 'Move Relationships to Model Library';

export interface MoveRelationshipsDeps {
  workspaceRoot: string;
  semanticDir: string;
  domainService: Pick<DomainService, 'listDomains'>;
  logicalModelService: Pick<LogicalModelService, 'getModel' | 'modelPath' | 'serializeModel' | 'invalidateCache' | 'getModelsDir'>;
  /** Refresh the trees, open canvases and selectors once the files are written. */
  onWritten: (domainPaths: string[]) => Promise<void>;
}

/** A v5 domain file's models and own relationships, as read from disk. */
export interface DomainRelationships {
  /** `{layer}/{domain}`, as the user knows it. */
  label: string;
  filePath: string;
  models: string[];
  relationships: Relationship[];
}

/** Every readable v5 domain file's models and `logical.relationships`. */
export function readDomainRelationships(
  domainService: Pick<DomainService, 'listDomains'>,
  workspaceRoot: string,
  semanticDir: string,
): DomainRelationships[] {
  const domains: DomainRelationships[] = [];
  for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as Record<string, unknown>;
      if (detectDomainFormat(raw) !== 'v5') continue;
      const logical = raw.logical as { models?: unknown; relationships?: unknown } | undefined;
      const models = (Array.isArray(logical?.models) ? logical!.models : []).filter((m): m is string => typeof m === 'string');
      const relationships = (Array.isArray(logical?.relationships) ? logical!.relationships : [])
        .filter((r): r is Relationship => !!r && typeof r === 'object'
          && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string'));
      domains.push({ label: `${summary.layer}/${summary.domain}`, filePath: summary.filePath, models, relationships });
    } catch {
      // An unreadable domain keeps its relationships.
    }
  }
  return domains;
}

export async function moveRelationshipsToLibrary(deps: MoveRelationshipsDeps): Promise<void> {
  const { workspaceRoot, semanticDir, domainService, logicalModelService } = deps;
  const domains = readDomainRelationships(domainService, workspaceRoot, semanticDir)
    .filter((d) => d.relationships.length > 0);

  const models = new Map<string, SemanticModel | null>();
  const libraryModel = (name: string): SemanticModel | null => {
    if (!models.has(name)) models.set(name, logicalModelService.getModel(name));
    return models.get(name) ?? null;
  };
  const libraryRoot = path.dirname(logicalModelService.getModelsDir());
  const fileOf = (model: string): string =>
    path.relative(libraryRoot, logicalModelService.modelPath(model)).split(path.sep).join('/');
  let plan = planMoveToLibrary(domains, libraryModel);
  if (plan.removeFromDomains.size === 0 && plan.conflicts.length === 0) {
    void vscode.window.showInformationMessage(
      `${TITLE}: nothing to move — ${domains.length === 0
        ? 'no diagram file holds a relationship of its own.'
        : 'every relationship in the diagram files starts at a model with no readable file in logical-models/.'}`,
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Define each relationship once, in the model library?',
    { modal: true, detail: describeMovePlan(plan, fileOf) },
    plan.conflicts.length > 0 ? 'Continue' : 'Move Relationships',
  );
  if (choice !== 'Continue' && choice !== 'Move Relationships') return;

  // Each conflict is the user's to settle: which cardinality every diagram draws.
  const conflicts = plan.conflicts;
  for (const [index, conflict] of conflicts.entries()) {
    const { fromModel, fromColumn, toModel, toColumn } = conflict.relationship;
    const picked = await vscode.window.showQuickPick(
      [
        ...conflict.definitions.map((d) => ({
          label: d.cardinality,
          description: `as in ${d.domains.join(', ')}`,
          detail: `Saved once in ${fileOf(fromModel)}; every diagram with ${fromModel} and ${toModel} draws it ${d.cardinality}.`,
          cardinality: d.cardinality as Cardinality | undefined,
        })),
        {
          label: 'Leave it as it is in each diagram',
          description: 'decide later',
          detail: 'It stays in the diagram files. Run this command again to settle it.',
          cardinality: undefined,
        },
      ],
      {
        title: `Conflict ${index + 1} of ${conflicts.length}: ${fromModel}.${fromColumn} → ${toModel}.${toColumn}`,
        placeHolder: 'The diagrams disagree. Which cardinality should every diagram use? (Esc cancels the move)',
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      void vscode.window.showInformationMessage(`${TITLE}: cancelled — nothing was changed.`);
      return;
    }
    if (picked.cardinality) plan = resolveConflict(plan, conflict, picked.cardinality);
  }
  if (plan.removeFromDomains.size === 0) {
    void vscode.window.showInformationMessage(`${TITLE}: nothing was changed.`);
    return;
  }

  const changed = new Map<string, SemanticModel>();
  for (const rel of plan.toLibrary) {
    const model = libraryModel(rel.fromModel)!;
    if (upsertLibraryRelationship(model, rel)) changed.set(model.name, model);
  }

  const edit = new vscode.WorkspaceEdit();
  const docs: vscode.TextDocument[] = [];
  for (const model of changed.values()) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logicalModelService.modelPath(model.name)));
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      logicalModelService.serializeModel(model));
    docs.push(doc);
  }
  const domainPaths: string[] = [];
  for (const domain of domains) {
    const keys = plan.removeFromDomains.get(domain.label);
    if (!keys) continue;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(domain.filePath));
    const text = doc.getText();
    const parsed = JSON.parse(text) as { logical: { relationships: Relationship[] } };
    parsed.logical.relationships = parsed.logical.relationships.filter((rel) => !keys.has(relationshipKey(rel)));
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), JSON.stringify(parsed, null, 2) + '\n');
    docs.push(doc);
    domainPaths.push(domain.filePath);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage(`${TITLE}: VS Code rejected the edit; nothing was changed.`);
    return;
  }
  // Edits land in memory; save them, recorded as our own writes so the
  // watchers do not bounce them back. The caller issues the refreshes.
  for (const doc of docs) {
    await doc.save();
    ownWrites.recordWrite(doc.uri.fsPath);
  }
  logicalModelService.invalidateCache();
  await deps.onWritten(domainPaths);

  const moved = plan.toLibrary.length;
  const left = plan.conflicts.length + plan.skippedNoModel.length;
  void vscode.window.showInformationMessage(
    `Moved ${moved} relationship${moved === 1 ? '' : 's'} into the model library — each is now defined once.` +
    (left > 0 ? ` ${left} stayed in the diagram files; run this command again to settle ${left === 1 ? 'it' : 'them'}.` : ''),
  );
}
