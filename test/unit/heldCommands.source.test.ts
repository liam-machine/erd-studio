/**
 * #357: every command the extension registers goes through `registerCommand`
 * (`src/commands/heldCommands.ts`). When a slow look lets `activate()` resolve
 * early, each contributed command activation has not registered yet is held
 * by a stand-in under its id; only the helper takes the stand-in away first.
 * A direct `vscode.commands.registerCommand` for a held id would throw
 * "command already exists", and only on a slow start: found by scanning, so a
 * new call site cannot slip in.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');
const HELPER = path.join(SRC, 'commands', 'heldCommands.ts');

function tsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('#357 commands are registered through the helper only', () => {
  it('no file but the helper calls vscode.commands.registerCommand', () => {
    const direct: string[] = [];
    let viaHelper = 0;
    for (const file of tsUnder(SRC)) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (file !== HELPER && /\bcommands\s*\.\s*registerCommand\s*\(/.test(line)) direct.push(`${path.relative(SRC, file)}:${i + 1}`);
        if (file !== HELPER && /(^|[^.\w])registerCommand\s*\(/.test(line)) viaHelper++;
      });
    }
    expect(direct).toEqual([]);
    // The scan sees the call sites at all (74 when this was written).
    expect(viaHelper).toBeGreaterThanOrEqual(70);
  });
});
