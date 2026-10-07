/**
 * ERD Studio: Move Relationships to Model Library (issue #126).
 *
 * The opt-in for an existing project: every relationship its v5 domain files
 * hold is stored once, in the `logical-models/*.yml` of the model holding the
 * foreign key, and taken out of the domain files. A library entry stored on
 * its "one" side (a `one-to-many`) is moved to that model too (#133), so a new
 * fact never means editing its dimensions. Prompted.
 *
 * Since #133 this is "Repair Relationships…" with the domain → library move
 * switched on: the same engine (`src/services/relationshipRepair.ts`) and the
 * same runner (`./repairRelationships`). That brings the move the repair's
 * guarantees — the model lookup the canvas notification uses (D11), a copy
 * that disagrees with another (cardinality, role, or the direction of a
 * one-to-one) always asked about, never silently dropped (D12), one QuickPick
 * per conflict with "Leave as is" (Esc cancels everything), a preview of every
 * file and change, disk-only all-or-nothing writes that refuse unsaved files,
 * and a read-back check that puts every file back unless only the
 * relationships changed and every diagram draws what it did.
 *
 * Disk is the one source of truth, and the files are written directly — not
 * through a WorkspaceEdit: 1.6.6 edited them through VS Code's documents, and
 * on a large project VS Code had already disposed some of them, leaving the
 * move unsaved or half applied.
 */

import { runMoveRelationships, writeFileAtomic, type RepairRelationshipsDeps } from './repairRelationships';
import { readDomainRelationships, type DomainRelationships } from '../services/relationshipRepair';

export { readDomainRelationships, writeFileAtomic };
export type { DomainRelationships };

export type MoveRelationshipsDeps = RepairRelationshipsDeps;

/**
 * The command. Never throws: anything unexpected is shown as an error and
 * counted, so neither the palette nor the canvas offer can swallow it.
 */
export async function moveRelationshipsToLibrary(deps: MoveRelationshipsDeps): Promise<void> {
  await runMoveRelationships(deps);
}
