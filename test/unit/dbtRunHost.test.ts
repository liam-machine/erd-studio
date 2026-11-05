/**
 * Open Physical view after Run dbt parse: the success notice is non-modal and
 * can wait in the notification centre, so the canvas it named may have closed
 * before the click. The click still switches a canvas, or says it couldn't.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { openPhysicalCanvas, type PhysicalCanvases } from '../../src/commands/dbtRunHost';

const A = vscode.Uri.file('/p/.erd-studio/silver/a.dbml');
const B = vscode.Uri.file('/p/.erd-studio/silver/b.dbml');

function canvases(open: vscode.Uri[], lastLogical?: vscode.Uri): PhysicalCanvases & { revealed: string[]; switched: string[] } {
  const revealed: string[] = [];
  const switched: string[] = [];
  return {
    revealed,
    switched,
    revealCanvas: (uri) => {
      if (!open.some((u) => String(u) === String(uri))) return false;
      revealed.push(String(uri));
      return true;
    },
    physicalSwitchTarget: () => lastLogical,
    switchStageForUri: (uri, stage) => { switched.push(`${String(uri)}:${stage}`); },
  };
}

describe('openPhysicalCanvas', () => {
  it('switches the canvas the notice named while it is open', async () => {
    const c = canvases([A, B], B);
    const reopened: vscode.Uri[] = [];
    expect(await openPhysicalCanvas(c, A, async (u) => { reopened.push(u); return true; })).toBe(true);
    expect(c.revealed).toEqual([String(A)]);
    expect(c.switched).toEqual([`${String(A)}:physical`]);
    expect(reopened).toHaveLength(0);
  });

  it('that canvas closed: another open logical canvas switches instead', async () => {
    const c = canvases([B], B);
    expect(await openPhysicalCanvas(c, A, async () => true)).toBe(true);
    expect(c.switched).toEqual([`${String(B)}:physical`]);
  });

  it('no canvas open: the diagram is reopened, then switched', async () => {
    const c = canvases([]);
    const reopened: vscode.Uri[] = [];
    expect(await openPhysicalCanvas(c, A, async (u) => { reopened.push(u); return true; })).toBe(true);
    expect(reopened.map(String)).toEqual([String(A)]);
    expect(c.switched).toEqual([`${String(A)}:physical`]);
  });

  it('the diagram cannot be reopened (deleted): false, and nothing switches', async () => {
    const c = canvases([]);
    expect(await openPhysicalCanvas(c, A, async () => false)).toBe(false);
    expect(c.switched).toHaveLength(0);
  });
});
