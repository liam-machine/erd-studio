/**
 * Hand-rolled argv parsing for the `erd-studio` CLI — no dependencies, so
 * `dist/cli.js` stays one self-contained file.
 *
 * Flags may appear before or after the subcommand, as `--flag value` or
 * `--flag=value`. Every flag is checked against the subcommand's allowlist:
 * an unknown or misplaced flag is a usage error (exit 2), never ignored,
 * because a silently dropped `--domain` would diff the wrong thing.
 */

export type CliCommand = 'doctor' | 'inventory' | 'diff' | 'version' | 'help';

export const CLI_COMMANDS: readonly CliCommand[] = ['doctor', 'inventory', 'diff', 'version', 'help'];

export interface CliOptions {
  command: CliCommand;
  /** `--project <dir>`: the dbt project (or a folder near it). */
  project?: string;
  /** `--semantic-dir <rel>`: ERD data dir relative to the project root. */
  semanticDir: string;
  json: boolean;
  quiet: boolean;
  /** `--verbose`: let the shared services' console diagnostics through to stderr. */
  verbose: boolean;
  /** doctor: skip running `dbt --version`. */
  noDbt: boolean;
  /** doctor: an explicit dbt executable (or the directory holding one). */
  dbt?: string;
  /** doctor: also run a dbt inside the project's own venv. */
  trustVenv: boolean;
  /** inventory: omit per-column detail. */
  summary: boolean;
  /** inventory: restrict to these model names. */
  models?: string[];
  /** diff: domain files (repeatable). */
  domains: string[];
  /** diff: every domain under the semantic dir. */
  all: boolean;
  /** diff: advisory rows block too. */
  strict: boolean;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

type FlagSpec = { takesValue: boolean; commands: readonly CliCommand[] | 'all' };

const FLAGS: Record<string, FlagSpec> = {
  '--project': { takesValue: true, commands: 'all' },
  '--semantic-dir': { takesValue: true, commands: 'all' },
  '--json': { takesValue: false, commands: 'all' },
  '--quiet': { takesValue: false, commands: 'all' },
  '--verbose': { takesValue: false, commands: 'all' },
  '--help': { takesValue: false, commands: 'all' },
  '--version': { takesValue: false, commands: 'all' },
  '--no-dbt': { takesValue: false, commands: ['doctor'] },
  '--dbt': { takesValue: true, commands: ['doctor'] },
  '--trust-venv': { takesValue: false, commands: ['doctor'] },
  '--summary': { takesValue: false, commands: ['inventory'] },
  '--models': { takesValue: true, commands: ['inventory'] },
  '--domain': { takesValue: true, commands: ['diff'] },
  '--all': { takesValue: false, commands: ['diff'] },
  '--strict': { takesValue: false, commands: ['diff'] },
};

export const DEFAULT_CLI_SEMANTIC_DIR = '.erd-studio';

/**
 * Parse `argv` (without the node + script entries). Throws `CliUsageError`
 * for anything it does not understand.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    command: 'help',
    semanticDir: DEFAULT_CLI_SEMANTIC_DIR,
    json: false,
    quiet: false,
    verbose: false,
    noDbt: false,
    trustVenv: false,
    summary: false,
    domains: [],
    all: false,
    strict: false,
  };

  let command: CliCommand | null = null;
  const seen: Array<{ flag: string; value?: string }> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      const spec = FLAGS[flag];
      if (!spec) { throw new CliUsageError(`Unknown option ${flag}.`); }
      let value: string | undefined;
      if (spec.takesValue) {
        if (eq !== -1) {
          value = arg.slice(eq + 1);
        } else {
          value = argv[i + 1];
          if (value === undefined || value.startsWith('--')) {
            throw new CliUsageError(`${flag} needs a value.`);
          }
          i++;
        }
        if (value.trim() === '') { throw new CliUsageError(`${flag} needs a value.`); }
      } else if (eq !== -1) {
        throw new CliUsageError(`${flag} does not take a value.`);
      }
      seen.push({ flag, value });
      continue;
    }
    if (arg === '-h') { seen.push({ flag: '--help' }); continue; }
    if (arg.startsWith('-') && arg !== '-') { throw new CliUsageError(`Unknown option ${arg}.`); }
    if (command !== null) { throw new CliUsageError(`Unexpected argument "${arg}".`); }
    if (!(CLI_COMMANDS as readonly string[]).includes(arg)) {
      throw new CliUsageError(`Unknown command "${arg}". Expected one of: doctor, inventory, diff, version.`);
    }
    command = arg as CliCommand;
  }

  const flags = new Set(seen.map((s) => s.flag));
  if (flags.has('--help')) {
    opts.command = 'help';
  } else if (flags.has('--version') && command === null) {
    opts.command = 'version';
  } else {
    opts.command = command ?? 'help';
  }

  for (const { flag, value } of seen) {
    const spec = FLAGS[flag];
    if (spec.commands !== 'all' && opts.command !== 'help' && !spec.commands.includes(opts.command)) {
      throw new CliUsageError(`${flag} is not an option of "${opts.command}".`);
    }
    switch (flag) {
      case '--project': opts.project = value; break;
      case '--semantic-dir': opts.semanticDir = normaliseSemanticDir(value!); break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--no-dbt': opts.noDbt = true; break;
      case '--dbt': opts.dbt = value; break;
      case '--trust-venv': opts.trustVenv = true; break;
      case '--summary': opts.summary = true; break;
      case '--models': {
        const names = value!.split(',').map((n) => n.trim()).filter(Boolean);
        if (names.length === 0) { throw new CliUsageError('--models needs at least one model name.'); }
        opts.models = [...new Set([...(opts.models ?? []), ...names])];
        break;
      }
      case '--domain': opts.domains.push(value!); break;
      case '--all': opts.all = true; break;
      case '--strict': opts.strict = true; break;
      default: break;
    }
  }

  if (opts.command === 'diff' && opts.domains.length === 0 && !opts.all) {
    throw new CliUsageError('diff needs --domain <path> or --all.');
  }
  if (opts.command === 'diff' && opts.domains.length > 0 && opts.all) {
    throw new CliUsageError('Use either --domain or --all, not both.');
  }
  return opts;
}

/** `--semantic-dir` must stay inside the project: relative, forward slashes, no `..`. */
function normaliseSemanticDir(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || cleaned.split('/').includes('..')) {
    throw new CliUsageError('--semantic-dir must be a folder inside the project, e.g. .erd-studio');
  }
  return cleaned;
}

export const USAGE = `erd-studio — read-only helper for ERD Studio (used by the /erd-studio-setup skill)

Usage:
  erd-studio doctor    [--json] [--no-dbt] [--dbt <path>] [--trust-venv]
  erd-studio inventory [--json] [--summary] [--models a,b,c]
  erd-studio diff      [--json] (--domain <path> | --all) [--strict]
  erd-studio version

Shared options:
  --project <dir>       dbt project folder (default: found from the current folder)
  --semantic-dir <rel>  ERD Studio data folder inside the project (default .erd-studio)
  --json                machine-readable output on stdout
  --quiet               no human-readable output (exit code only)
  --verbose             show internal diagnostics on stderr

Exit codes: 0 ok · 1 diff found drift · 2 usage error · 3 project/domain problem · 4 internal error
`;
