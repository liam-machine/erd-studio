/**
 * `erd-studio` CLI entry point (dist/cli.js) — the read-only helper the
 * `/erd-studio-setup` skill drives: `doctor`, `inventory`, `diff`, `version`.
 *
 * Launched through the ~/.erd-studio-cli shims (cliLauncherService), under
 * plain Node or VS Code's own Electron with ELECTRON_RUN_AS_NODE. It never
 * writes a file (spec D5): Claude makes every `.erd-studio` edit itself.
 *
 * Exit codes: 0 ok · 1 diff found blocking drift · 2 usage · 3 environment
 * (no project, bad domain file) · 4 internal. 5 is reserved for the shim.
 */

import { redactPaths } from '../types/feedback';
import { parseArgs, USAGE, type CliOptions } from './args';
import { buildCliContext, CLI_VERSION, CliEnvError } from './context';
import { runDiff } from './diff';
import { runDoctor, runtimeInfo } from './doctor';
import { colourEnabled, formatDiff, formatDoctor, formatInventory, makePaint } from './format';
import { runInventory } from './inventory';

export const EXIT = { ok: 0, drift: 1, usage: 2, env: 3, internal: 4 } as const;

export interface CliIo {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function processIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env };
}

/**
 * Keep the shared services' console diagnostics (written for the extension
 * host's Debug Console) out of the output Claude reads: silenced unless
 * `--verbose`, and then sent to stderr. Returns the restore function.
 */
function captureConsole(verbose: boolean, io: CliIo): () => void {
  const saved = { log: console.log, info: console.info, warn: console.warn, debug: console.debug, error: console.error };
  const sink = (...args: unknown[]): void => {
    if (verbose) { io.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n'); }
  };
  console.log = sink;
  console.info = sink;
  console.warn = sink;
  console.debug = sink;
  console.error = sink;
  return () => Object.assign(console, saved);
}

/** Run the CLI and return its exit code. Never throws. */
export async function main(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wantsJson = argv.includes('--json');
    if (wantsJson) { io.stdout.write(JSON.stringify({ cliVersion: CLI_VERSION, error: { code: 'usage', message } }) + '\n'); }
    io.stderr.write(`erd-studio: ${message}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const paint = makePaint(colourEnabled(io.stdout, io.env));
  const out = (json: unknown, human: () => string): void => {
    if (opts.json) {
      io.stdout.write(JSON.stringify(json, null, 2) + '\n');
    } else if (!opts.quiet) {
      io.stdout.write(human());
    }
  };

  const restoreConsole = captureConsole(opts.verbose, io);
  try {
    switch (opts.command) {
      case 'help':
        if (!opts.quiet) { io.stdout.write(USAGE); }
        return EXIT.ok;

      case 'version': {
        const result = { cliVersion: CLI_VERSION, runtime: runtimeInfo() };
        out(result, () => `erd-studio ${CLI_VERSION} (${result.runtime.kind} ${result.runtime.version})\n`);
        return EXIT.ok;
      }

      case 'doctor': {
        const result = await runDoctor({
          project: opts.project,
          semanticDir: opts.semanticDir,
          noDbt: opts.noDbt,
          dbt: opts.dbt,
          trustVenv: opts.trustVenv,
          cwd: io.cwd,
          env: io.env,
        });
        out(result, () => formatDoctor(result, paint));
        return EXIT.ok;
      }

      case 'inventory': {
        const ctx = await buildCliContext({ project: opts.project, semanticDir: opts.semanticDir, cwd: io.cwd });
        const result = runInventory(ctx, { summary: opts.summary, models: opts.models });
        out(result, () => formatInventory(result, paint));
        return EXIT.ok;
      }

      case 'diff': {
        const ctx = await buildCliContext({ project: opts.project, semanticDir: opts.semanticDir, cwd: io.cwd });
        const { result, exitCode } = runDiff(ctx, { domains: opts.domains, all: opts.all, strict: opts.strict, cwd: io.cwd });
        out(result, () => formatDiff(result, paint));
        return exitCode;
      }

      default:
        return EXIT.usage;
    }
  } catch (err) {
    if (err instanceof CliEnvError) {
      const message = redactPaths(err.message);
      if (opts.json) {
        io.stdout.write(JSON.stringify({ cliVersion: CLI_VERSION, error: { code: err.code, message } }, null, 2) + '\n');
      }
      if (!opts.quiet) { io.stderr.write(`erd-studio: ${message}\n`); }
      return EXIT.env;
    }
    const message = redactPaths(err instanceof Error ? err.message : String(err));
    if (opts.json) {
      io.stdout.write(JSON.stringify({ cliVersion: CLI_VERSION, error: { code: 'internal', message } }, null, 2) + '\n');
    }
    io.stderr.write(`erd-studio: internal error: ${err instanceof Error && err.stack ? err.stack : message}\n`);
    return EXIT.internal;
  } finally {
    restoreConsole();
  }
}

/** True when this module is the process entry (dist/cli.js), not an import (tests). */
function isEntry(): boolean {
  return typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
}

if (isEntry()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
