/**
 * LibraryDropOverlay — what the canvas shows for a drop of tables
 * (`useLibraryDrop`): the "Hold Shift and drop to add … to this diagram"
 * hint while a Table Library drag is in progress ("Let go to add …" while it
 * is over the canvas and will land), and a highlight while an acceptable drag
 * is over the canvas.
 *
 * Rendered inside React Flow's container, over the canvas. Neither part takes
 * pointer events, so the drop lands on the canvas below. The hint is a polite
 * live region: a screen reader announces it without moving focus.
 */

import React from 'react';

import { libraryDragHintText } from '../../hooks/useLibraryDrop';
import './LibraryDropOverlay.css';

export interface LibraryDropOverlayProps {
  /** An acceptable drag is over the canvas. */
  active: boolean;
  /** The Table Library drag's tables while the hint shows, else null. */
  hintTables: readonly string[] | null;
}

export const LibraryDropOverlay: React.FC<LibraryDropOverlayProps> = ({ active, hintTables }) => (
  <>
    {active && <div className="library-drop__highlight" aria-hidden="true" data-testid="library-drop-highlight" />}
    <div className="library-drop__hint-region" role="status" aria-live="polite">
      {hintTables && hintTables.length > 0 && (
        <div className={`library-drop__hint${active ? ' library-drop__hint--over' : ''}`}>
          {libraryDragHintText(hintTables, active)}
        </div>
      )}
    </div>
  </>
);
