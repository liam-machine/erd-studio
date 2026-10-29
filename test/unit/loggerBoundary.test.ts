/**
 * Who may read the ERD Studio log.
 *
 * The log holds table, column and diagram names and local paths. Telemetry
 * fields may never hold a name, path or message (CLAUDE.md, telemetry/README.md),
 * so telemetry must never read the logger or its buffer: no telemetry module
 * imports `logger.ts`, and the buffer's readers (`recentLogLines`,
 * `redactedRecentLog`) are called from Send Feedback's opt-in path only.
 *
 * The logger itself imports nothing from VS Code, so the CLI, worker and MCP
 * bundles may log through it (the CLI bundle is also checked end to end in
 * cli.noVscode.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function filesUnder(dir: string, exts = ['.ts', '.tsx', '.js', '.mjs']): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
const read = (file: string): string => fs.readFileSync(file, 'utf-8');
const IMPORTS_LOGGER = /from\s+['"][^'"]*\/logger['"]|require\(\s*['"][^'"]*\/logger['"]\s*\)/;
const BUFFER_READERS = /\b(recentLogLines|redactedRecentLog)\b/;

/** The extension's telemetry modules: the heartbeat, its payload, the known-fixes check and the relationship survey. */
const TELEMETRY_MODULES = [
  'src/services/telemetryService.ts',
  'src/services/telemetryPayload.ts',
  'src/services/knownFixes.ts',
  'src/services/knownFixesService.ts',
  'src/services/relationshipHealth.ts',
  'src/services/physicalTooling.ts',
];

describe('the ERD Studio log stays out of telemetry', () => {
  it('no telemetry module imports the logger or reads its buffer', () => {
    for (const file of TELEMETRY_MODULES) {
      const text = read(path.join(ROOT, file));
      expect(IMPORTS_LOGGER.test(text), `${file} imports the logger`).toBe(false);
      expect(BUFFER_READERS.test(text), `${file} reads the log buffer`).toBe(false);
    }
  });

  it('the telemetry Worker never imports the extension logger', () => {
    const worker = path.join(ROOT, 'telemetry');
    if (!fs.existsSync(worker)) return;
    for (const file of filesUnder(worker)) {
      const text = read(file);
      expect(/services\/logger/.test(text), `${rel(file)} imports the extension logger`).toBe(false);
      expect(BUFFER_READERS.test(text), `${rel(file)} reads the log buffer`).toBe(false);
    }
  });

  it('only Send Feedback reads the buffer', () => {
    const allowed = new Set(['src/services/feedbackService.ts', 'src/services/logger.ts']);
    const readers = filesUnder(path.join(ROOT, 'src'))
      .filter((file) => BUFFER_READERS.test(read(file)))
      .map(rel);
    expect(readers.filter((file) => !allowed.has(file))).toEqual([]);
  });
});

describe('the logger module', () => {
  it('imports nothing (no vscode, no Node built-ins), so every bundle may use it', () => {
    const text = read(path.join(ROOT, 'src/services/logger.ts'));
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/require\(/);
  });
});
