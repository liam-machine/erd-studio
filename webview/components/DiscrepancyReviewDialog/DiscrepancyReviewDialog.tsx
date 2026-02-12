/**
 * DiscrepancyReviewDialog — modal for reviewing all datatype discrepancies on a model.
 *
 * Shows a summary table of columns where the built manifest datatype differs from
 * the approved design expectation. Users can accept or reject each discrepancy
 * individually, or accept all at once.
 */

import { useCallback, useMemo } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { ReconciledColumn } from '../../../src/types/reconciled';
import './DiscrepancyReviewDialog.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DiscrepancyReviewDialog() {
  const modelName = useEditorStore((s) => s.discrepancyReviewModel);
  const setDiscrepancyReviewModel = useEditorStore((s) => s.setDiscrepancyReviewModel);
  const domain = useEditorStore((s) => s.domain);
  const { send } = useMessageBus(() => {});

  // Find the model and its discrepant columns
  const model = useMemo(() => {
    if (!modelName || !domain) return null;
    return domain.models.find((m) => m.name === modelName) ?? null;
  }, [modelName, domain]);

  const discrepantColumns = useMemo(() => {
    if (!model) return [];
    return model.columns.filter((col): col is ReconciledColumn & { discrepancy: NonNullable<ReconciledColumn['discrepancy']> } =>
      col.discrepancy !== undefined
    );
  }, [model]);

  // Handlers
  const handleClose = useCallback(() => {
    setDiscrepancyReviewModel(null);
  }, [setDiscrepancyReviewModel]);

  const handleAccept = useCallback(
    (col: ReconciledColumn & { discrepancy: NonNullable<ReconciledColumn['discrepancy']> }) => {
      if (!modelName) return;
      if (col.discrepancy.structural) {
        send({
          type: 'acceptStructuralDiscrepancy',
          payload: { modelName, columnName: col.name, discrepancyType: col.discrepancy.structural },
        });
      } else {
        send({
          type: 'acceptDiscrepancy',
          payload: { modelName, columnName: col.name },
        });
      }
    },
    [send, modelName],
  );

  const handleReject = useCallback(
    (col: ReconciledColumn & { discrepancy: NonNullable<ReconciledColumn['discrepancy']> }) => {
      if (!modelName) return;
      if (col.discrepancy.structural) {
        send({
          type: 'rejectStructuralDiscrepancy',
          payload: { modelName, columnName: col.name, discrepancyType: col.discrepancy.structural },
        });
      } else {
        send({
          type: 'rejectDiscrepancy',
          payload: { modelName, columnName: col.name },
        });
      }
    },
    [send, modelName],
  );

  const handleUnreject = useCallback(
    (col: ReconciledColumn & { discrepancy: NonNullable<ReconciledColumn['discrepancy']> }) => {
      if (!modelName) return;
      if (col.discrepancy.structural) {
        send({
          type: 'unrejectStructuralDiscrepancy',
          payload: { modelName, columnName: col.name },
        });
      } else {
        send({
          type: 'unrejectDiscrepancy',
          payload: { modelName, columnName: col.name },
        });
      }
    },
    [send, modelName],
  );

  const handleAcceptAll = useCallback(() => {
    if (!modelName) return;
    send({
      type: 'acceptAllDiscrepancies',
      payload: { modelName },
    });
  }, [send, modelName]);

  // Don't render if no model or no discrepancies
  if (!modelName || !model || discrepantColumns.length === 0) {
    return null;
  }

  const unresolvedCount = discrepantColumns.filter((c) => !c.discrepancy.rejected).length;

  return (
    <Panel position="top-left" className="discrepancy-review-dialog__panel">
      <div className="discrepancy-review-dialog">
        {/* Header */}
        <div className="discrepancy-review-dialog__header">
          <div className="discrepancy-review-dialog__title-row">
            <h3 className="discrepancy-review-dialog__title">
              Discrepancy Review
            </h3>
            <button
              className="discrepancy-review-dialog__close"
              onClick={handleClose}
              title="Close"
              aria-label="Close dialog"
            >
              &times;
            </button>
          </div>
          <div className="discrepancy-review-dialog__subtitle">
            <span className="discrepancy-review-dialog__model-name">{modelName}</span>
            {' \u2014 '}
            {discrepantColumns.length} column{discrepantColumns.length !== 1 ? 's' : ''} with discrepancies
          </div>
        </div>

        {/* Table */}
        <div className="discrepancy-review-dialog__table-wrapper">
          <table className="discrepancy-review-dialog__table">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {discrepantColumns.map((col) => (
                <tr
                  key={col.name}
                  className={col.discrepancy.rejected ? 'discrepancy-review-dialog__row--rejected' : ''}
                >
                  <td className="discrepancy-review-dialog__col-name">
                    {col.name}
                  </td>
                  <td className="discrepancy-review-dialog__type">
                    {col.discrepancy.structural === 'extra' ? (
                      <span className="discrepancy-review-dialog__type-badge discrepancy-review-dialog__type-badge--extra">Extra</span>
                    ) : col.discrepancy.structural === 'missing' ? (
                      <span className="discrepancy-review-dialog__type-badge discrepancy-review-dialog__type-badge--missing">Missing</span>
                    ) : (
                      <span className="discrepancy-review-dialog__type-badge discrepancy-review-dialog__type-badge--datatype">DataType</span>
                    )}
                  </td>
                  <td>
                    {col.discrepancy.dataType ? (
                      <code className="discrepancy-review-dialog__expected">
                        {col.discrepancy.dataType.expected}
                      </code>
                    ) : col.discrepancy.structural === 'extra' ? (
                      <span className="discrepancy-review-dialog__structural-label">Not designed</span>
                    ) : col.discrepancy.structural === 'missing' ? (
                      <code className="discrepancy-review-dialog__expected">
                        {col.dataType}
                      </code>
                    ) : '—'}
                  </td>
                  <td>
                    {col.discrepancy.dataType ? (
                      <code className="discrepancy-review-dialog__actual">
                        {col.discrepancy.dataType.actual}
                      </code>
                    ) : col.discrepancy.structural === 'extra' ? (
                      <code className="discrepancy-review-dialog__actual">
                        {col.dataType}
                      </code>
                    ) : col.discrepancy.structural === 'missing' ? (
                      <span className="discrepancy-review-dialog__structural-label">Not built</span>
                    ) : '—'}
                  </td>
                  <td>
                    {col.discrepancy.rejected ? (
                      <span className="discrepancy-review-dialog__status discrepancy-review-dialog__status--rejected">
                        Rejected
                      </span>
                    ) : (
                      <span className="discrepancy-review-dialog__status discrepancy-review-dialog__status--unresolved">
                        Unresolved
                      </span>
                    )}
                  </td>
                  <td className="discrepancy-review-dialog__actions">
                    {col.discrepancy.rejected ? (
                      <button
                        className="discrepancy-review-dialog__btn"
                        onClick={() => handleUnreject(col)}
                        title="Clear rejection"
                      >
                        Undo
                      </button>
                    ) : (
                      <>
                        <button
                          className="discrepancy-review-dialog__btn discrepancy-review-dialog__btn--accept"
                          onClick={() => handleAccept(col)}
                          title={col.discrepancy.structural ? 'Accept and resolve' : 'Accept manifest value'}
                        >
                          Accept
                        </button>
                        <button
                          className="discrepancy-review-dialog__btn discrepancy-review-dialog__btn--reject"
                          onClick={() => handleReject(col)}
                          title="Flag as non-conforming"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="discrepancy-review-dialog__footer">
          {unresolvedCount > 0 && (
            <button
              className="discrepancy-review-dialog__accept-all"
              onClick={handleAcceptAll}
              title="Accept all discrepancies"
            >
              Accept All ({unresolvedCount})
            </button>
          )}
          <button
            className="discrepancy-review-dialog__close-btn"
            onClick={handleClose}
          >
            Close
          </button>
        </div>
      </div>
    </Panel>
  );
}
