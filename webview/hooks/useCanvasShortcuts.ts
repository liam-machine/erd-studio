/**
 * useCanvasShortcuts — the global keydown handler for the canvas
 * (Escape, Delete/Backspace, Ctrl+F, Ctrl+C/V for notes, F2, Shift+L,
 * Shift+?, V/S mode toggle, Alt+1/2 stage switch).
 *
 * The listener is registered ONCE. Every piece of UI state it needs is read
 * from `useEditorStore.getState()` inside the handler, so selection changes,
 * dialog toggles and domain reloads never re-subscribe the window listener
 * (App.tsx used to carry a 35-entry dependency array for this effect).
 *
 * Decision helpers (text-entry guard, stage shortcut, delete-target priority)
 * live in webview/lib/keyboardShortcuts.ts so they stay unit-testable.
 */

import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

import { useVsCodeApi } from './useVsCodeApi';
import { useEditorStore } from '../store/editorStore';
import { nextStageRequestId } from '../lib/stageRequest';
import {
  isTextEntryElement,
  isLegendToggleShortcut,
  altStageShortcut,
  resolveSingleDeleteTarget,
} from '../lib/keyboardShortcuts';
import { relationshipTarget, type ModelFlowNode, type AnnotationFlowNode } from '@erd-studio/renderer/editor';
import type { WebviewMessage, RelationshipKey, StoredRelationshipEnds } from '../../src/types/messages';
import type { AnnotationColor } from '../../src/types/semantic';

/** The canvas's dialogs: a key pressed with focus inside one is the dialog's. */
const DIALOG_SELECTOR = '.new-fk-dialog, .new-model-dialog, .add-existing-model-dialog, [role="dialog"]';

/** Whether `el` (the focused element) is inside one of the canvas's dialogs. */
export function focusInDialog(el: Element | null): boolean {
  return typeof el?.closest === 'function' && el.closest(DIALOG_SELECTOR) !== null;
}

/** Module-level clipboard for annotation copy/paste (not in Zustand — never drives rendering). */
type CopiedAnnotation = { text: string; color: AnnotationColor; width?: number; height?: number; linkedModel?: string };
let _copiedAnnotation: CopiedAnnotation | null = null;

/** Edge id as produced by graphTransformer for an FK relationship. */
function fkEdgeId(r: RelationshipKey): string {
  return `fk-${r.fromModel}-${r.fromColumn}-${r.toModel}-${r.toColumn}`;
}

/**
 * Resolve selected edge ids to relationship keys for a batch delete. An edge
 * touching a model the batch deletes is left out unless the user picked that
 * line themselves (`pickedEdges`: clicked or Shift+clicked):
 *
 * - a domain-file copy goes with its model anyway (`removeModels` filters the
 *   domain file's `logical.relationships`);
 * - a model-library relationship survives removing a model from a diagram by
 *   design — other diagrams draw it. React Flow's box selection selects every
 *   line touching a boxed model, so such a line is no request to delete it
 *   from the library; only a line the user picked is sent, and then it goes
 *   from the library too.
 */
export function selectedEdgesToRelationships(
  edgeIds: string[],
  relationships: ReadonlyArray<RelationshipKey & { stored?: StoredRelationshipEnds; source?: { kind: string } }>,
  deletedModels: string[],
  pickedEdges: readonly string[] = [],
): Array<RelationshipKey & { stored?: StoredRelationshipEnds }> {
  const deleted = new Set(deletedModels.map((m) => m.toLowerCase()));
  const picked = new Set(pickedEdges);
  const result: Array<RelationshipKey & { stored?: StoredRelationshipEnds }> = [];
  for (const edgeId of edgeIds) {
    const rel = relationships.find((r) => fkEdgeId(r) === edgeId);
    if (!rel) continue;
    const touchesDeleted = deleted.has(rel.fromModel.toLowerCase()) || deleted.has(rel.toModel.toLowerCase());
    if (touchesDeleted && (rel.source?.kind !== 'library' || !picked.has(edgeId))) continue;
    // The ends as drawn plus, when known, as stored on disk (#133).
    result.push(relationshipTarget(rel));
  }
  return result;
}

export function useCanvasShortcuts(): void {
  const vscode = useVsCodeApi();
  const reactFlowInstance = useReactFlow();

  useEffect(() => {
    const post = (message: WebviewMessage) => vscode.postMessage(message);

    const handleKeyDown = (e: KeyboardEvent) => {
      const s = useEditorStore.getState();
      const { domain, contextMenu, selectedAnnotation } = s;

      // Ctrl+F / Cmd+F: Focus search input (F402)
      // This should work regardless of focus state
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        s.focusSearchInput();
        return;
      }

      // Guard: Don't intercept if user is typing in an input field
      // (input / textarea / select / contentEditable). Everything below this
      // point is a canvas shortcut and must not steal printable characters.
      if (isTextEntryElement(document.activeElement)) {
        return;
      }

      // Shift+? : Toggle legend panel (after the guard so '?' can be typed)
      if (isLegendToggleShortcut(e)) {
        e.preventDefault();
        s.setLegendOpen(!s.legendOpen);
        return;
      }

      // Ctrl+C / Cmd+C: Copy selected annotation (skip if context menu is open)
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedAnnotation && domain && !contextMenu) {
        const ann = domain.viewConfig.annotations?.find((a) => a.id === selectedAnnotation);
        if (ann) {
          e.preventDefault();
          _copiedAnnotation = {
            text: ann.text,
            color: ann.color ?? 'yellow',
            ...(ann.width != null ? { width: ann.width } : {}),
            ...(ann.height != null ? { height: ann.height } : {}),
            ...(ann.linkedModel ? { linkedModel: ann.linkedModel } : {}),
          };
        }
        return;
      }

      // Ctrl+V / Cmd+V: Paste copied annotation (skip if context menu is open)
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && _copiedAnnotation && domain && !domain.readOnly && !contextMenu) {
        e.preventDefault();
        const id = crypto.randomUUID();
        // Place relative to current viewport center
        const { x: vx, y: vy, zoom } = reactFlowInstance.getViewport();
        const container = document.querySelector('.react-flow');
        const rect = container?.getBoundingClientRect();
        const centerX = rect ? (rect.width / 2 - vx) / zoom : 200;
        const centerY = rect ? (rect.height / 2 - vy) / zoom : 200;
        post({
          type: 'addAnnotation',
          payload: {
            id,
            text: _copiedAnnotation.text,
            x: Math.round(centerX + 30),
            y: Math.round(centerY + 30),
            color: _copiedAnnotation.color,
            ...(_copiedAnnotation.width != null ? { width: _copiedAnnotation.width } : {}),
            ...(_copiedAnnotation.height != null ? { height: _copiedAnnotation.height } : {}),
            ...(_copiedAnnotation.linkedModel ? { linkedModel: _copiedAnnotation.linkedModel } : {}),
          },
        });
        s.setEditingAnnotationId(id);
        return;
      }

      // F2: Edit selected column (rename)
      if (e.key === 'F2' && s.selectedColumns.length === 1 && s.detailPanelOpen && domain && !domain.readOnly) {
        e.preventDefault();
        s.setEditingColumn(s.selectedColumns[0]);
        return;
      }

      // ESCAPE KEY: Close dialogs first, then deselect
      if (e.key === 'Escape') {
        e.preventDefault();

        // Close any open dialog (priority order)
        if (s.feedbackDialogOpen) {
          s.setFeedbackDialogOpen(false);
          return;
        }
        if (s.newModelDialogOpen) {
          s.setNewModelDialogOpen(false);
          return;
        }
        if (s.newFkDialogOpen) {
          s.setNewFkDialogOpen(false);
          s.clearFkDialogPrefill();
          s.clearFkDialogEditData();
          return;
        }
        if (s.addExistingModelDialogOpen) {
          s.setAddExistingModelDialogOpen(false);
          return;
        }

        // Clear column selection first (before deselecting model)
        if (s.selectedColumns.length > 0) {
          s.clearColumnSelection();
          return;
        }

        // No dialogs open — deselect nodes, edges, and annotations
        if (s.selectedNode || s.selectedEdges.length > 0 || s.selectedEdge || selectedAnnotation) {
          s.selectNode(null);
          s.selectAnnotation(null);
          s.setDetailPanelOpen(false);
          s.setSelectedEdges([]);
          s.setSelectedEdge(null);
          s.setHighlightedColumns(new Set());
          return;
        }

        // Nothing selected — if in select mode, return to pan mode
        if (s.canvasMode === 'select') {
          s.setCanvasMode('pan');
        }
        return;
      }

      // Shift+L: Trigger auto-layout
      if (e.shiftKey && e.key === 'L') {
        e.preventDefault();
        s.triggerAutoLayout();
        return;
      }

      // V / S: Canvas mode toggle (Figma-style)
      // No modifier keys — only fires when no input has focus (guarded above).
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if ((e.key === 'v' || e.key === 'V') && s.canvasMode !== 'pan') {
          e.preventDefault();
          s.setCanvasMode('pan');
          return;
        }
        if ((e.key === 's' || e.key === 'S') && s.canvasMode !== 'select' && domain && !domain.readOnly) {
          e.preventDefault();
          s.setCanvasMode('select');
          return;
        }
      }

      // Alt+1/2: Switch stage tabs. Matched on e.code (Digit1/Digit2) because
      // macOS maps Option+1/2 to '¡'/'™' at the e.key level.
      const targetStage = altStageShortcut(e);
      if (targetStage) {
        e.preventDefault();
        if (domain && domain.stage !== targetStage) {
          post({ type: 'switchStage', payload: { stage: targetStage, requestId: nextStageRequestId() } });
        }
        return;
      }

      // DELETE KEY: Delete selected design models, annotations, or edges
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!domain || domain.readOnly) return;
        // Focus on one of a dialog's buttons (Swap sides, a direction
        // choice), which the text-entry guard above lets through: the key
        // belongs to the dialog, never to the selection behind it. The
        // relationship, new-model and add-model dialogs are panels without a
        // backdrop, so with focus on the canvas behind one the key still
        // deletes the selection; the feedback dialog is modal.
        if (s.feedbackDialogOpen || focusInDialog(document.activeElement)) return;

        const { selectedEdges, selectedNode, selectedColumns, detailPanelOpen } = s;

        // Priority -1: Multi-select delete (2+ items selected) — immediate, no confirmation.
        // Read React Flow's selection from the nodes array (source of truth for multi-select).
        const allSelectedNodes = s.nodes.filter((n) => n.selected);
        const selectedModelNames = allSelectedNodes
          .filter((n): n is ModelFlowNode => n.type === 'model')
          .map((n) => n.data.modelName);
        // graphTransformer namespaces annotation node IDs as `annotation-${id}` —
        // unwrap to the raw domain ID for the wire protocol.
        const selectedAnnotationIds = allSelectedNodes
          .filter((n): n is AnnotationFlowNode => n.type === 'annotation')
          .map((n) => n.data.annotationId);
        const totalSelected =
          selectedModelNames.length + selectedAnnotationIds.length + selectedEdges.length;

        if (totalSelected >= 2) {
          e.preventDefault();

          // One batched message per kind — each is a single WorkspaceEdit on
          // the host, so the whole selection is one (or at most three) undo
          // steps instead of one per item.
          if (selectedModelNames.length > 0) {
            post({ type: 'removeModels', payload: { modelNames: selectedModelNames } });
          }

          if (selectedAnnotationIds.length > 0) {
            post({ type: 'removeAnnotations', payload: { ids: selectedAnnotationIds } });
          }

          // Skip edges the model batch cascades, and model-library lines a
          // box selection pulled in with their model (only a line the user
          // picked themselves is deleted from the library).
          const relationships = selectedEdgesToRelationships(
            selectedEdges,
            domain.relationships,
            selectedModelNames,
            s.pickedEdges,
          );
          if (relationships.length > 0) {
            post({ type: 'removeRelationships', payload: { relationships } });
          }

          s.selectNode(null);
          s.selectAnnotation(null);
          s.setSelectedEdges([]);
          s.clearPickedEdges();
          return;
        }

        // Single-item delete. Priority order lives in resolveSingleDeleteTarget:
        // annotation > columns > model > edges. Columns must beat the model so
        // Delete with column rows selected removes the columns instead of
        // opening the delete-model confirmation.
        const deleteTarget = resolveSingleDeleteTarget({
          selectedAnnotation,
          selectedNode,
          modelExists: !!selectedNode && domain.models.some((m) => m.name === selectedNode),
          selectedColumnCount: selectedColumns.length,
          detailPanelOpen,
          selectedEdgeCount: selectedEdges.length,
        });

        // Priority 0: Delete selected annotation (no confirmation — undo exists)
        if (deleteTarget === 'annotation' && selectedAnnotation) {
          e.preventDefault();
          post({ type: 'removeAnnotation', payload: { id: selectedAnnotation } });
          s.selectAnnotation(null);
          return;
        }

        // Priority 1: Delete selected columns (immediate)
        if (deleteTarget === 'columns' && selectedNode) {
          e.preventDefault();
          for (const colName of selectedColumns) {
            post({
              type: 'removeColumn',
              payload: { modelName: selectedNode, columnName: colName },
            });
          }
          s.clearColumnSelection();
          return;
        }

        // Priority 2: Remove selected node (with confirmation)
        if (deleteTarget === 'model') {
          e.preventDefault();
          if (!detailPanelOpen) {
            s.setDetailPanelOpen(true);
          }
          s.setPendingDeleteConfirmation(true);
          return;
        }

        // Priority 3: Delete selected edges (no confirmation, immediate)
        if (deleteTarget === 'edges') {
          e.preventDefault();
          const relationships = selectedEdgesToRelationships(selectedEdges, domain.relationships, []);
          if (relationships.length === 1) {
            post({ type: 'removeRelationship', payload: relationships[0] });
          } else if (relationships.length > 1) {
            post({ type: 'removeRelationships', payload: { relationships } });
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // vscode is a module-level singleton and the React Flow instance is stable
    // for the life of the provider — the listener is registered once.
  }, [vscode, reactFlowInstance]);
}
