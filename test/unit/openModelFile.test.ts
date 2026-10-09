/**
 * The one-per-broken-file notification and the "open at the error" helper
 * shared by it and the canvas's openModelFile message (#110).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';

import { modelFileErrorNotice, notifyModelFileError, openModelFileAt } from '../../src/commands/openModelFile';

afterEach(() => vi.restoreAllMocks());

describe('modelFileErrorNotice', () => {
  const at = (kind: Parameters<typeof modelFileErrorNotice>[0]['kind'], line?: number) =>
    modelFileErrorNotice({ filePath: '/p/.erd-studio/logical-models/dim_x.yml', kind, line });

  it('names the file, the line and a tip about quoting for a scalar error', () => {
    expect(at('yamlScalar', 4)).toBe(
      'dim_x.yml has a YAML error on line 4 and can\'t be shown on the diagram. Tip: put double quotes around text that contains ": ".',
    );
  });

  it('tailors the tip by kind', () => {
    expect(at('yamlIndent', 2)).toContain('spaces, not tabs');
    expect(at('yamlDuplicateKey', 2)).toContain('a key appears twice');
    expect(at('yamlStructure', 1)).toContain('one YAML document');
    expect(at('read')).toBe(
      "dim_x.yml couldn't be read and can't be shown on the diagram. Tip: check the file still exists and that VS Code can read it.",
    );
    expect(at('yamlOther')).toBe(
      'dim_x.yml has a YAML error and can\'t be shown on the diagram. Tip: put double quotes around text that contains ": ".',
    );
  });

  it('names an unresolved git merge conflict and how to resolve it (#145)', () => {
    expect(modelFileErrorNotice({
      filePath: '/p/.erd-studio/logical-models/dim_x.yml', kind: 'yamlOther', line: 3, mergeConflict: true,
    })).toBe(
      "dim_x.yml has an unresolved git merge conflict on line 3 and can't be shown on the diagram. "
        + 'Tip: keep one side of each conflict, save, then git add the file.',
    );
  });
});

describe('openModelFileAt / notifyModelFileError', () => {
  it('puts the cursor on the 1-based line and column', async () => {
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({ lineCount: 20 } as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    await openModelFileAt('/p/x.yml', 4, 3);
    const options = show.mock.calls[0][1] as { selection: { start: { line: number; character: number } } };
    expect(options.selection.start).toMatchObject({ line: 3, character: 2 });
  });

  it('opens the file when the user picks Open file, without blocking the caller', async () => {
    let pick: (v: string) => void = () => {};
    vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(new Promise((r) => { pick = r as never; }) as never);
    const open = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({ lineCount: 20 } as never);
    vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);

    notifyModelFileError({ name: 'x', filePath: '/p/x.yml', kind: 'yamlScalar', line: 2, message: 'm' });
    expect(open).not.toHaveBeenCalled();
    pick('Open file');
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });
});
