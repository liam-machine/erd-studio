/**
 * EmbeddedTablesBanner — "This file holds its own tables. Import these
 * tables…" (native DBML storage, §2.5).
 *
 * A `.dbml` in a layer folder that declares Tables and has no table `use`
 * line is most likely a single-file DBML (a dbdiagram.io download or a rich
 * export) dropped there. An ERD Studio diagram names its tables through `use`
 * lines, so the canvas shows none of them. The host says so with
 * `dbmlEmbeddedTables` after the load; the button posts
 * `importEmbeddedTables`, which runs Import DBML on this file (the command
 * asks for a name and shows its dry run before writing anything).
 */

import React from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import './ManifestHint.css';

export const EmbeddedTablesBanner: React.FC = () => {
  const embeddedTables = useEditorStore((s) => s.embeddedTables);
  const send = useSend();

  if (!embeddedTables) { return null; }

  return (
    <div className="manifest-hint embedded-tables-banner" role="status">
      <span className="manifest-hint__icon" aria-hidden="true">&#9432;</span>
      <span className="manifest-hint__text">
        <span className="manifest-hint__lead">
          This file holds its own tables. An ERD Studio diagram lists tables from the table library, so none
          of them are shown here.
        </span>
      </span>
      <button
        type="button"
        className="manifest-hint__action"
        onClick={() => send({ type: 'importEmbeddedTables' })}
      >
        Import these tables…
      </button>
    </div>
  );
};
