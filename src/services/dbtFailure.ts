/**
 * dbtFailure — why a dbt run failed, as one fixed category, and what to tell
 * the user about it.
 *
 * dbt's output is classified **on this machine only**: the category is the
 * one thing telemetry records (`DBT_PARSE_FAILURE_FEATURES`). The output, an
 * environment variable's name and an adapter type are shown to the user
 * locally and never sent, logged or stored.
 *
 * Pure: no `vscode`, no file access. The rules come from real dbt-core 1.8 and
 * 1.10 output (exit code 2 for every failure); classify on the text, not on a
 * JSON event name (it is `MainEncounteredError` for nearly everything).
 */

import { stripAnsi } from './dbtEnv';
import type { DbtRunMode } from './dbtLaunch';
import type { TelemetryFeature } from './telemetryPayload';

export { stripAnsi } from './dbtEnv';

export type DbtFailureCategory =
  | 'profile' | 'target' | 'envVar' | 'adapterMissing' | 'adapterDeps' | 'depsMissing'
  | 'credentials' | 'noProject' | 'dbtVersion' | 'projectError' | 'other';

type Matcher = string | RegExp | ((text: string) => boolean);

/** First match wins. Strings are case-sensitive substrings. */
const RULES: ReadonlyArray<readonly [Exclude<DbtFailureCategory, 'other'>, readonly Matcher[]]> = [
  ['profile', [
    'Invalid value for \'--profiles-dir\'',
    'Could not find profile named',
    'no profile was specified',
    'required field "type" not found',
    'trying to read your profiles.yml',
  ]],
  ['target', ['does not have a target named']],
  ['envVar', ['Env var required but not provided']],
  // Before credentials: a missing adapter also prints "Credentials in profile … invalid".
  ['adapterMissing', ['Could not find adapter type', 'Error importing adapter']],
  ['adapterDeps', [
    'requires additional dependencies',
    'pip install dbt-spark[',
    (t) => t.includes('dlopen(') && /odbc/i.test(t),
    /libodbc\.so/,
    /DLL load failed while importing pyodbc/,
  ]],
  ['depsMissing', ['Run "dbt deps"', /package\(s\) installed in /]],
  ['credentials', [(t) => t.includes('Credentials in profile') && t.includes('invalid'), 'default auth:']],
  ['noProject', ['No dbt_project.yml found']],
  // Not the 1.10 banner "This version of dbt is deprecated".
  ['dbtVersion', ['This version of dbt is not supported']],
  ['projectError', ['Compilation Error', 'Parsing Error', 'Syntax error near line', 'which was not found', 'Error encountered in']],
];

function matches(text: string, m: Matcher): boolean {
  if (typeof m === 'string') return text.includes(m);
  if (m instanceof RegExp) return m.test(text);
  return m(text);
}

function firstRule(text: string, skip?: DbtFailureCategory): DbtFailureCategory | null {
  for (const [category, matchers] of RULES) {
    if (category === skip) continue;
    if (matchers.some((m) => matches(text, m))) return category;
  }
  return null;
}

const ENCOUNTERED = 'Encountered an error:';

/**
 * The category of a failed dbt run's output (stdout and stderr together,
 * ANSI codes and all). The text after the **last** `Encountered an error:`
 * (dbt prints it right before the fatal error) is tested first, so a warning
 * earlier in the run cannot decide it; then the whole text (a usage error on
 * stderr has no such line). When there is a fatal error the rules did not
 * recognise, the fallback skips `projectError`: its patterns (`… which was
 * not found`) also appear in dbt's *warnings*, which come before the error.
 */
export function classifyDbtFailure(output: string): DbtFailureCategory {
  const text = stripAnsi(output).replace(/\r\n?/g, '\n');
  const at = text.lastIndexOf(ENCOUNTERED);
  if (at >= 0) {
    return firstRule(text.slice(at + ENCOUNTERED.length)) ?? firstRule(text, 'projectError') ?? 'other';
  }
  return firstRule(text) ?? 'other';
}

/** The missing environment variable's name, for the local notice only (never sent or logged). */
export function missingEnvVarName(output: string): string | null {
  return /Env var required but not provided: '([A-Za-z_][A-Za-z0-9_]{0,99})'/.exec(stripAnsi(output))?.[1] ?? null;
}

/** The adapter type dbt could not load, for the local notice only (never sent or logged). */
export function missingAdapterType(output: string): string | null {
  const text = stripAnsi(output);
  return /Could not find adapter type ([a-z][a-z0-9_]{0,39})!/.exec(text)?.[1]
    ?? /No module named 'dbt\.adapters\.([a-z][a-z0-9_]{0,39})'/.exec(text)?.[1]
    ?? null;
}

/**
 * Whether `dbt_project.yml`'s text uses `env_var('NAME')`. dbt renders
 * `profile:` even when `--profile` is passed, so a variable used there blocks
 * Parse without your credentials too. Reads dbt_project.yml only (it holds no
 * credentials), never a profiles.yml.
 */
export function envVarUsedInProjectFile(dbtProjectYml: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`env_var\\(\\s*['"]${escaped}['"]`).test(dbtProjectYml);
}

/** The fixed telemetry key per category (a failed Run dbt parse). */
export const DBT_PARSE_FAILURE_FEATURES: Record<DbtFailureCategory, TelemetryFeature> = {
  profile: 'dbtParseFailProfile',
  target: 'dbtParseFailTarget',
  envVar: 'dbtParseFailEnvVar',
  adapterMissing: 'dbtParseFailAdapter',
  adapterDeps: 'dbtParseFailAdapterDeps',
  depsMissing: 'dbtParseFailDeps',
  credentials: 'dbtParseFailCredentials',
  noProject: 'dbtParseFailNoProject',
  dbtVersion: 'dbtParseFailDbtVersion',
  projectError: 'dbtParseFailProject',
  other: 'dbtParseFailOther',
};

/** What a failure notice offers. Labels live in `runDbtParse.ts`. */
export type DbtFailureAction = 'noCreds' | 'deps' | 'adapterDocs' | 'profileDocs' | 'showOutput';

export interface FailureContext {
  command: 'parse' | 'compile';
  mode: DbtRunMode;
  /** null when the process ended by a signal. */
  exitCode: number | null;
  /** Parse without your credentials can run: parse, normal mode, dbt Core, host storage. */
  noCredsAvailable: boolean;
  envVar: string | null;
  envVarInProject: boolean;
  adapterType: string | null;
}

/** The one-line cause and the next steps for a failed dbt run (pure; the copy is local only). */
export function failureNotice(
  category: DbtFailureCategory,
  ctx: FailureContext,
): { message: string; actions: DbtFailureAction[] } {
  const cmd = ctx.command === 'parse' ? 'dbt parse' : 'dbt compile';
  const Cmd = ctx.command === 'parse' ? 'Run dbt parse' : 'Run dbt compile';
  const noCreds = ctx.noCredsAvailable && ctx.command === 'parse' && ctx.mode === 'normal';
  const withNoCreds = (otherwise: DbtFailureAction[]): DbtFailureAction[] => (noCreds ? ['noCreds', 'showOutput'] : otherwise);

  switch (category) {
    case 'profile':
      return {
        message: `${cmd} needs a dbt profile for this project, and dbt couldn't find one.`,
        actions: withNoCreds(['profileDocs', 'showOutput']),
      };
    case 'target':
      return {
        message: 'Your dbt profile has no target dbt can use for this project.',
        actions: withNoCreds(['profileDocs', 'showOutput']),
      };
    case 'envVar': {
      const named = ctx.envVar ? `the environment variable ${ctx.envVar}` : 'an environment variable';
      if (ctx.envVarInProject || ctx.mode === 'noCreds') {
        return {
          message: `dbt needs ${named}, which your project's files use. Set it where VS Code starts, restart VS Code, and try ${Cmd} again.`,
          actions: ['showOutput'],
        };
      }
      return {
        message: `dbt needs ${named}, which isn't set where VS Code started.`,
        actions: withNoCreds(['showOutput']),
      };
    }
    case 'adapterMissing': {
      const which = ctx.adapterType
        ? `the ${ctx.adapterType} adapter`
        : ctx.mode === 'noCreds' ? 'the adapter' : 'the adapter your profile uses';
      const install = ctx.adapterType ? `Install dbt-${ctx.adapterType}` : 'Install it';
      return {
        message: `dbt can't load ${which}. ${install} in the same Python environment as dbt, then try ${Cmd} again.`,
        actions: ['adapterDocs', 'showOutput'],
      };
    }
    case 'adapterDeps':
      return {
        message: 'The dbt adapter is installed but needs more to load: an extra such as dbt-spark[PyHive], or an ODBC driver.',
        actions: ['adapterDocs', 'showOutput'],
      };
    case 'depsMissing':
      return {
        message: `This project uses dbt packages that aren't installed yet. Run dbt deps downloads them, then ${cmd} runs again.`,
        actions: ['deps', 'showOutput'],
      };
    case 'credentials':
      if (ctx.mode === 'noCreds') {
        return { message: 'Parse without your credentials doesn\'t work with this adapter yet.', actions: ['showOutput'] };
      }
      return { message: 'dbt rejected the connection details in your dbt profile.', actions: withNoCreds(['showOutput']) };
    case 'noProject':
      return { message: 'dbt couldn\'t find dbt_project.yml in this folder.', actions: ['showOutput'] };
    case 'dbtVersion':
      return {
        message: 'This project needs a different version of dbt (require-dbt-version in dbt_project.yml).',
        actions: ['showOutput'],
      };
    case 'projectError':
      return {
        message: 'dbt found a problem in this project\'s files. The output shows which file and line.',
        actions: ['showOutput'],
      };
    case 'other':
    default:
      return {
        message: ctx.exitCode === null ? `${cmd} ended without an exit code.` : `${cmd} failed (exit code ${ctx.exitCode}).`,
        actions: ['showOutput'],
      };
  }
}
