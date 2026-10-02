/**
 * ERD Studio: Move Relationships to Model Library (issue #126).
 *
 * The opt-in for an existing project: every relationship its v5 domain files
 * hold is stored once, in its from-model's `logical-models/*.yml`, and taken
 * out of the domain files. Relationships the domains disagree about are left
 * where they are and listed. Prompted, one WorkspaceEdit, one undo step.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { relationshipKey } from '@erd-studio/core';
import { describeMovePlan, planMoveToLibrary, upsertLibraryRelationship } from '../services/libraryRelationships';
import { ownWrites } from '../services/ownWriteTracker';
import { detectDomainFormat } from '../types/semantic';
import type { Relationship, SemanticModel } from '../types/semantic';
import type { DomainService } from '../services/domainService';
import type { LogicalModelService } from '../services/logicalModelService';

const TITLE = 'Move Relationships to Model Library';

export interface MoveRelationshipsDeps {
  workspaceRoot: string;
  semanticDir: string;
  domainService: Pick<DomainService, 'listDomains'>;
  logicalModelService: Pick<LogicalModelService, 'getModel' | 'modelPath' | 'serializeModel' | 'invalidateCache'>;
  /** Refresh the trees, open canvases and selectors once the files are written. */
  onWritten: (domainPaths: string[]) => Promise<void>;
}

export async function moveRelationshipsToLibrary(deps: MoveRelationshipsDeps): Promise<void> {
  const { workspaceRoot, semanticDir, domainService, logicalModelService } = deps;

  const domains: Array<{ label: string; filePath: string; relationships: Relationship[] }> = [];
  for (const summary of domainService.listDomains(workspaceRoot, semanticDir)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as Record<string, unknown>;
      if (detectDomainFormat(raw) !== 'v5') continue;
      const logical = raw.logical as { relationships?: unknown } | undefined;
      const relationships = (Array.isArray(logical?.relationships) ? logical!.relationships : [])
        .filter((r): r is Relationship => !!r && typeof r === 'object'
          && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string'));
      if (relationships.length > 0) {
        domains.push({ label: `${summary.layer}/${summary.domain}`, filePath: summary.filePath, relationships });
      }
    } catch {
      // An unreadable domain keeps its relationships.
    }
  }

  const models = new Map<string, SemanticModel | null>();
  const libraryModel = (name: string): SemanticModel | null => {
    if (!models.has(name)) models.set(name, logicalModelService.getModel(name));
    return models.get(name) ?? null;
  };
  const plan = planMoveToLibrary(domains, libraryModel);
  if (plan.removeFromDomains.size === 0) {
    const reason = domains.length === 0
      ? 'no domain file holds a relationship of its own.'
      : describeMovePlan(plan).replace(/\n+/g, ' ');
    void vscode.window.showInformationMessage(`${TITLE}: nothing to move — ${reason}`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${TITLE}?`,
    { modal: true, detail: describeMovePlan(plan) },
    'Move Relationships',
  );
  if (choice !== 'Move Relationships') return;

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
    `Moved ${moved} relationship${moved === 1 ? '' : 's'} into the model library.` +
    (left > 0 ? ` ${left} stayed in their domain files (see the list before moving).` : ''),
  );
}
