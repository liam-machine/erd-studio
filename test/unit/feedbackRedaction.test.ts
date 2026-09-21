/**
 * Path redaction — `redactPaths()` in src/types/feedback.ts and every place a
 * report's text leaves the machine through it.
 *
 * A filed issue is public, and before this the diagnostics block carried the
 * reporter's absolute paths verbatim (issue #64 published a username and a
 * project folder). The redactor works by path *shape* so it holds for error
 * messages nobody has written yet; these tests pin both the shapes and the
 * wiring, since a helper that nothing calls protects nobody.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildAnalysisPrompt } from '../../src/services/feedbackAnalysisService';
import {
  collectDiagnostics,
  composeFeedbackFields,
  composeMarkdownReport,
  hostErrorLog,
} from '../../src/services/feedbackService';
import { redactPaths, type FeedbackDraft } from '../../src/types/feedback';

const DOMAIN_FILE = '/Users/khaidirhasan/Documents/Codes/medical/.erd-studio/silver/sales.json';
const SECRETS = ['khaidirhasan', 'medical', 'silver', 'sales'];

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('redactPaths', () => {
  it.each([
    [
      `Invalid JSON in domain file ${DOMAIN_FILE}: Unexpected end of JSON input`,
      'Invalid JSON in domain file {project}/.erd-studio/{layer}/{domain}.json: Unexpected end of JSON input',
    ],
    [
      '/Users/k/medical/.erd-studio/templates/{id}.json: bad',
      '{project}/.erd-studio/templates/{template}.json: bad',
    ],
    [
      'Could not read /Users/jo/My Projects/acme dbt/.erd-studio/logical-models/dim_customer.yml',
      'Could not read {project}/.erd-studio/logical-models/{model}.yml',
    ],
    ['/home/jo/acme/.erd-studio/layers.json failed', '{project}/.erd-studio/layers.json failed'],
    ['/home/jo/acme/erd-studio/gold/finance.json', '{project}/erd-studio/{layer}/{domain}.json'],
    [
      "ENOENT: open 'C:\\Users\\Jo Smith\\acme\\target\\manifest.json'",
      "ENOENT: open '{path}/manifest.json'",
    ],
    ['\\\\fileserver\\share\\acme\\dbt_project.yml bad', '{path}/dbt_project.yml bad'],
    ['~/work/acme/models/marts/schema.yml was missing', '{path}/{file}.yml was missing'],
    ['/Users/jo/sales report.json: bad', '{path}/{file}.json: bad'],
    [
      'at x (https://file+.vscode-resource.vscode-cdn.net/Users/jo/.vscode/extensions/liamwynne.erd-studio-1.0.7/dist/webview.js:12:5)',
      'at x ({extension}/dist/webview.js:12:5)',
    ],
    ['file:///c%3A/Users/jo/acme/.erd-studio/layers.json failed', '{project}/.erd-studio/layers.json failed'],
  ])('%s', (input, expected) => {
    expect(redactPaths(input)).toBe(expected);
  });

  it.each([
    'See https://github.com/liam-machine/erd-studio/issues/64',
    'Model name must match /^[a-z][a-z0-9_]*$/',
    'read/write access and a 1/2 ratio',
    'Language model copilot/gpt-4o-mini cannot be used',
    '',
  ])('leaves %j alone', (input) => {
    expect(redactPaths(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = redactPaths(`a ${DOMAIN_FILE} b C:\\x\\y\\z.yml c`);
    expect(redactPaths(once)).toBe(once);
  });
});

describe('where a report leaves the machine', () => {
  afterEach(() => hostErrorLog.clear());

  const draft: FeedbackDraft = {
    kind: 'bug',
    title: `Crash opening ${DOMAIN_FILE}`,
    description: `Error shown on canvas: Invalid JSON in domain file ${DOMAIN_FILE}`,
    steps: `1. open ${DOMAIN_FILE}`,
    includeDiagnostics: true,
  };

  function diagnostics() {
    hostErrorLog.record('sendDomainData', `Invalid JSON in domain file ${DOMAIN_FILE}`);
    const context = { extension: { packageJSON: { version: '1.0.7' } } };
    return collectDiagnostics(context as never, undefined, [`[extension] Could not read ${DOMAIN_FILE}`]);
  }

  it('collectDiagnostics redacts both error lists but leaves the log itself raw', () => {
    const d = diagnostics();
    expect(d.hostErrors[0]).toContain('{project}/.erd-studio/{layer}/{domain}.json');
    expect(d.webviewErrors[0]).toContain('{project}/.erd-studio/{layer}/{domain}.json');
    expectNoSecrets([...d.hostErrors, ...d.webviewErrors].join('\n'));
    expect(hostErrorLog.recent()[0]).toContain(DOMAIN_FILE);
  });

  it('the issue form carries no path in any field', () => {
    const fields = composeFeedbackFields(draft, diagnostics());
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['title', 'description', 'steps', 'diagnostics']));
    expectNoSecrets(Object.values(fields).join('\n'));
  });

  it('the copied Markdown report carries no path', () => {
    expectNoSecrets(composeMarkdownReport(draft, diagnostics()));
  });

  it('the analysis prompt carries no path', () => {
    const prompt = buildAnalysisPrompt({
      kind: 'bug',
      description: draft.description,
      context: draft.steps,
      issues: [],
    });
    expect(prompt).toContain('{project}/.erd-studio/{layer}/{domain}.json');
    expectNoSecrets(prompt);
  });
});
