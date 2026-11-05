/**
 * dbtFailure — a failed dbt run's output becomes one fixed category (the only
 * thing telemetry records) and a one-line local notice with the next step.
 * Fixtures are real dbt-core 1.10 / 1.8 output (ANSI codes, the 1.10
 * deprecation banner and warnings left in).
 */
import { describe, expect, it } from 'vitest';

import {
  classifyDbtFailure,
  DBT_PARSE_FAILURE_FEATURES,
  envVarUsedInProjectFile,
  failureNotice,
  missingAdapterType,
  missingEnvVarName,
  stripAnsi,
  type DbtFailureCategory,
  type FailureContext,
} from '../../src/services/dbtFailure';
import { FEATURES } from '../../src/services/telemetryPayload';
import { DBT_FAILURE_OUTPUTS as OUT } from './dbtOutputFixtures';

const BANNER = '\u001b[0m23:45:27  Running with dbt=1.10.23\n\u001b[0m23:45:27  This version of dbt is deprecated and no longer receives regular patches, including for known bugs.\n';

describe('classifyDbtFailure (real dbt output)', () => {
  const cases: Array<[keyof typeof OUT, DbtFailureCategory]> = [
    ['A_noprofiles', 'profile'],
    ['B_profilename', 'profile'],
    ['C_targetname', 'target'],
    ['C2_targetflag', 'target'],
    ['C3_notargetkey', 'target'],
    ['D_envprofiles', 'envVar'],
    ['E2_envproject', 'envVar'],
    ['F_adapter', 'adapterMissing'],
    ['F2_notype', 'profile'],
    ['G_packages', 'depsMissing'],
    ['H_jinja', 'projectError'],
    ['I_schemayaml', 'projectError'],
    ['J_projyaml', 'projectError'],
    ['J2_projschema', 'projectError'],
    ['K_noproject', 'noProject'],
    ['L_profilesyaml', 'profile'],
    ['M_versionreq', 'dbtVersion'],
    ['N_badref', 'projectError'],
    ['rec18_fabric', 'adapterDeps'],
  ];
  for (const [name, category] of cases) {
    it(`${name} → ${category}`, () => {
      expect(classifyDbtFailure(OUT[name])).toBe(category);
    });
  }

  it('orders the rules so the more specific cause wins', () => {
    // F_adapter also prints "Credentials in profile … invalid".
    expect(OUT.F_adapter).toContain('Credentials in profile');
    expect(classifyDbtFailure(OUT.F_adapter)).toBe('adapterMissing');
    // E2 is a "Parsing Error", G a "Compilation Error", M has "Error encountered in".
    expect(OUT.E2_envproject).toContain('Parsing Error');
    expect(OUT.G_packages).toContain('Compilation Error');
    expect(OUT.M_versionreq).toContain('Error encountered in');
  });

  it('the 1.10 deprecation banner alone is other, not dbtVersion', () => {
    expect(classifyDbtFailure(BANNER)).toBe('other');
    expect(classifyDbtFailure('')).toBe('other');
  });

  it('classifies the fatal error after the last "Encountered an error:", not an earlier warning', () => {
    const text = `${BANNER}\u001b[0m  [WARNING]: Model 'x' depends on a node named 'y' which was not found\n`
      + '\u001b[0m23:45:29  Encountered an error:\nRuntime Error\n  Something nobody has seen before\n';
    expect(classifyDbtFailure(text)).toBe('other');
    // With no "Encountered an error:" the whole text is used.
    expect(classifyDbtFailure("depends on a node named 'y' which was not found")).toBe('projectError');
  });

  it('the stderr --profiles-dir usage error (no "Encountered an error:") is profile', () => {
    expect(OUT.A_noprofiles).not.toContain('Encountered an error:');
    expect(classifyDbtFailure(OUT.A_noprofiles)).toBe('profile');
  });

  it('missing ODBC libraries on Linux and Windows are adapterDeps', () => {
    expect(classifyDbtFailure('Encountered an error:\nImportError: libodbc.so.2: cannot open shared object file: No such file or directory')).toBe('adapterDeps');
    expect(classifyDbtFailure('Encountered an error:\nImportError: DLL load failed while importing pyodbc: The specified module could not be found.')).toBe('adapterDeps');
    expect(classifyDbtFailure('Encountered an error:\nthrift connection method requires additional dependencies.\n  Install the additional required dependencies with `pip install dbt-spark[PyHive]`')).toBe('adapterDeps');
  });

  it('credentials and Windows line endings', () => {
    expect(classifyDbtFailure('Encountered an error:\r\nRuntime Error\r\n  Credentials in profile "p", target "t" invalid: \'host\' is a required property\r\n')).toBe('credentials');
    expect(classifyDbtFailure('Encountered an error:\nValueError: default auth: cannot configure default credentials')).toBe('credentials');
  });
});

describe('extractors (local display only)', () => {
  it('missingEnvVarName', () => {
    expect(missingEnvVarName(OUT.D_envprofiles)).toBe('ERD_PROTO_DUCKDB_PATH');
    expect(missingEnvVarName(OUT.E2_envproject)).toBe('ERD_PROTO_PROFILE');
    expect(missingEnvVarName("Env var required but not provided: 'HAS SPACE'")).toBeNull();
    expect(missingEnvVarName("Env var required but not provided: '1BAD'")).toBeNull();
    expect(missingEnvVarName('nothing')).toBeNull();
  });

  it('missingAdapterType', () => {
    expect(missingAdapterType(OUT.F_adapter)).toBe('snowflake');
    expect(missingAdapterType("No module named 'dbt.adapters.bigquery'")).toBe('bigquery');
    expect(missingAdapterType('Could not find adapter type Snow Flake!')).toBeNull();
    expect(missingAdapterType('nothing')).toBeNull();
  });

  it('envVarUsedInProjectFile', () => {
    const yml = "name: proto\nprofile: \"{{ env_var( 'ERD_PROTO_PROFILE' ) }}\"\nvars:\n  x: \"{{ env_var(\"OTHER\", 'd') }}\"\n";
    expect(envVarUsedInProjectFile(yml, 'ERD_PROTO_PROFILE')).toBe(true);
    expect(envVarUsedInProjectFile(yml, 'OTHER')).toBe(true);
    expect(envVarUsedInProjectFile(yml, 'ERD_PROTO')).toBe(false);
    expect(envVarUsedInProjectFile(yml, 'MISSING')).toBe(false);
  });

  it('stripAnsi', () => {
    expect(stripAnsi('\u001b[0m12:00  [\u001b[33mWARNING\u001b[0m]')).toBe('12:00  [WARNING]');
  });
});

describe('DBT_PARSE_FAILURE_FEATURES', () => {
  it('maps every category to a distinct listed feature key', () => {
    const values = Object.values(DBT_PARSE_FAILURE_FEATURES);
    expect(new Set(values).size).toBe(11);
    for (const v of values) expect(FEATURES).toContain(v);
  });
});

describe('failureNotice', () => {
  const base: FailureContext = {
    command: 'parse', mode: 'normal', exitCode: 2, noCredsAvailable: true, envVar: null, envVarInProject: false, adapterType: null,
  };
  const all: DbtFailureCategory[] = [
    'profile', 'target', 'envVar', 'adapterMissing', 'adapterDeps', 'depsMissing', 'credentials', 'noProject', 'dbtVersion', 'projectError', 'other',
  ];

  it('offers Parse without your credentials for profile, target, envVar and credentials when available', () => {
    for (const c of ['profile', 'target', 'envVar', 'credentials'] as const) {
      expect(failureNotice(c, base).actions, c).toEqual(['noCreds', 'showOutput']);
    }
    expect(failureNotice('profile', { ...base, noCredsAvailable: false }).actions).toEqual(['profileDocs', 'showOutput']);
    expect(failureNotice('target', { ...base, noCredsAvailable: false }).actions).toEqual(['profileDocs', 'showOutput']);
    expect(failureNotice('credentials', { ...base, noCredsAvailable: false }).actions).toEqual(['showOutput']);
  });

  it('never offers noCreds for compile, in noCreds mode, or for an env var the project uses', () => {
    for (const c of all) {
      expect(failureNotice(c, { ...base, command: 'compile' }).actions, c).not.toContain('noCreds');
      expect(failureNotice(c, { ...base, mode: 'noCreds' }).actions, c).not.toContain('noCreds');
    }
    expect(failureNotice('envVar', { ...base, envVar: 'X', envVarInProject: true }).actions).toEqual(['showOutput']);
  });

  it('names the env var and the adapter when known', () => {
    expect(failureNotice('envVar', { ...base, envVar: 'DBT_PW' }).message)
      .toBe('dbt needs the environment variable DBT_PW, which isn\'t set where VS Code started.');
    expect(failureNotice('envVar', base).message).toBe('dbt needs an environment variable, which isn\'t set where VS Code started.');
    expect(failureNotice('envVar', { ...base, envVar: 'P', envVarInProject: true }).message)
      .toBe('dbt needs the environment variable P, which your project\'s files use. Set it where VS Code starts, restart VS Code, and try Run dbt parse again.');
    expect(failureNotice('adapterMissing', { ...base, adapterType: 'snowflake' }).message)
      .toBe('dbt can\'t load the snowflake adapter. Install dbt-snowflake in the same Python environment as dbt, then try Run dbt parse again.');
    expect(failureNotice('adapterMissing', base).message).toContain('the adapter your profile uses');
    expect(failureNotice('adapterMissing', { ...base, command: 'compile' }).message).toContain('try Run dbt compile again');
    expect(failureNotice('adapterMissing', base).actions).toEqual(['adapterDocs', 'showOutput']);
  });

  it('deps, credentials in noCreds mode and the other copy', () => {
    expect(failureNotice('depsMissing', base)).toEqual({
      message: 'This project uses dbt packages that aren\'t installed yet. Run dbt deps downloads them, then dbt parse runs again.',
      actions: ['deps', 'showOutput'],
    });
    expect(failureNotice('credentials', { ...base, mode: 'noCreds' }).message).toBe('Parse without your credentials doesn\'t work with this adapter yet.');
    expect(failureNotice('other', base).message).toBe('dbt parse failed (exit code 2).');
    expect(failureNotice('other', { ...base, exitCode: null }).message).toBe('dbt parse ended without an exit code.');
    expect(failureNotice('other', { ...base, command: 'compile', exitCode: 1 }).message).toBe('dbt compile failed (exit code 1).');
    expect(failureNotice('profile', { ...base, command: 'compile' }).message).toBe('dbt compile needs a dbt profile for this project, and dbt couldn\'t find one.');
  });

  it('never quotes dbt output', () => {
    for (const c of all) {
      const { message } = failureNotice(c, { ...base, envVar: 'SENTINEL_VAR', adapterType: 'zzz' });
      expect(message).not.toMatch(/Encountered an error|Runtime Error/);
    }
  });
});
