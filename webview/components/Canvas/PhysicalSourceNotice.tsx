/**
 * PhysicalSourceNotice — "dbt has not been compiled" strip for the physical canvas.
 *
 * The physical stage used to communicate this by accident: with no manifest
 * every model resolved to nothing and rendered grey, so the canvas looked
 * broken and the user inferred why. Existence now comes from the dbt project
 * itself, so the canvas looks entirely normal while every schema is empty and
 * types appear only for the columns whose yml declares `data_type:` — a quieter
 * lie than the old one. This strip is the replacement signal, and it is the
 * only one: the manifestStaleness banner lives in the DiscrepancyPanel and is
 * only ever shown while a comparison is open.
 *
 * The copy deliberately does NOT offer `dbt compile` as a route to column
 * types. dbt populates manifest `columns[].data_type` from this same schema
 * yml, so compiling adds no type a reader does not already have — that
 * misconception is the whole reason this stage was rebuilt. Compiling buys the
 * resolved schema name; only `dbt docs generate` reaches the warehouse.
 *
 * What it does offer is **Run dbt parse** (#110): parse needs no warehouse
 * (only a working profile) and writes the manifest this stage reads columns
 * and tests from. The host runs it in a terminal and the manifest watcher
 * refreshes the canvas, at which point this strip goes away by itself.
 *
 * Dismissal is session-only (see the store) — if dbt still has not been run
 * after a reload, the notice comes back.
 */

import React from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import './PhysicalSourceNotice.css';

export const PhysicalSourceNotice: React.FC = () => {
  const domain = useEditorStore((s) => s.domain);
  const dismissed = useEditorStore((s) => s.physicalSourceNoticeDismissed);
  const dismiss = useEditorStore((s) => s.dismissPhysicalSourceNotice);
  const send = useSend();

  const sources = domain?.physicalSources;
  // `sources` is undefined on the logical stage and on any payload from an
  // older host, both of which have nothing to say here.
  if (dismissed || domain?.stage !== 'physical' || !sources) { return null; }
  if (sources.manifest || sources.catalog) { return null; }

  return (
    <div className="physical-source-notice" role="status">
      <span className="physical-source-notice__icon" aria-hidden="true">&#9432;</span>
      <span className="physical-source-notice__text">
        <span className="physical-source-notice__lead">
          dbt hasn&apos;t been run in this project yet, so ERD Studio can&apos;t read your models&apos;
          columns and tests.
        </span>{' '}
        <span className="physical-source-notice__hint">
          Needs a working dbt profile. For real column types, run <code>dbt docs generate</code> afterwards.
        </span>
      </span>
      <button
        type="button"
        className="physical-source-notice__action"
        onClick={() => send({ type: 'runDbtParse' })}
      >
        Run dbt parse
      </button>
      <button
        type="button"
        className="physical-source-notice__dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  );
};
