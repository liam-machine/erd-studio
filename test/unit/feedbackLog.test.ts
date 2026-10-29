/**
 * Send Feedback's opt-in "Include the recent ERD Studio log" (docs/dev/feedback.md):
 *
 * - off unless the draft says so, and only inside the diagnostics;
 * - every line goes through redactPaths();
 * - the issue form keeps the newest lines that fit the link; Copy report keeps all;
 * - the analysis prompt never sees it (diagnostics are never sent to the model);
 * - an error recorded for Send Feedback reaches the log channel, not the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { buildAnalysisPrompt } from '../../src/services/feedbackAnalysisService';
import {
  MAX_ISSUE_URL_LENGTH,
  buildDiagnosticsView,
  buildFeedbackContext,
  buildIssueUrl,
  collectDiagnostics,
  composeFeedbackFields,
  composeMarkdownReport,
  copyFeedbackReport,
  fitLogToIssueUrl,
  formatDiagnostics,
  hostErrorLog,
  submitFeedback,
  type Diagnostics,
} from '../../src/services/feedbackService';
import { clearLogBuffer, log, recentLogLines, setLogSink, type LogSink } from '../../src/services/logger';
import { FEEDBACK_LOG_LABEL, FEEDBACK_LOG_NOTE, type FeedbackDraft } from '../../src/types/feedback';

const FILE = '/Users/khaidirhasan/Documents/Codes/medical/.erd-studio/silver/sales.dbml';
const context = { extension: { packageJSON: { version: '2.0.0' } } } as never;

const draft = (overrides: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  kind: 'bug',
  title: 'Slow open',
  description: 'Opening the big diagram takes ten seconds.',
  includeDiagnostics: true,
  ...overrides,
});

beforeEach(() => {
  clearLogBuffer();
  hostErrorLog.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setLogSink(undefined);
  vi.restoreAllMocks();
});

describe('the log in the diagnostics', () => {
  it('is absent unless asked for', () => {
    log.info(`[Canvas] Opened ${FILE}: 500 tables posted 5012 ms after ready`);
    expect(collectDiagnostics(context).recentLog).toBeUndefined();
    expect(formatDiagnostics(collectDiagnostics(context))).not.toContain('Recent ERD Studio log');
  });

  it('asked for: every line is redacted, and it is the last section of the text', () => {
    log.info(`[Canvas] Opened ${FILE}: 500 tables posted 5012 ms after ready`);
    log.warn(`[LogicalModelService] /Users/khaidirhasan/Documents/Codes/medical/.erd-studio/tables/gold/fct_order.dbml:4: bad`);
    const d = collectDiagnostics(context, undefined, [], { includeLog: true });
    expect(d.recentLog).toHaveLength(2);
    const text = formatDiagnostics(d);
    expect(text).toContain('Recent ERD Studio log (2 lines):');
    expect(text).toContain('{project}/.erd-studio/{layer}/{domain}.dbml: 500 tables posted 5012 ms after ready');
    expect(text).toContain('{project}/.erd-studio/tables/{table}.dbml');
    for (const secret of ['khaidirhasan', 'medical']) expect(text).not.toContain(secret);
    // The buffer itself stays raw: it is local.
    expect(recentLogLines()[0]).toContain(FILE);
  });

  it('the dialog view carries the redacted lines apart from the diagnostics text', () => {
    log.info(`[Canvas] Opened ${FILE}`);
    const view = buildFeedbackContext(context);
    expect(view.text).not.toContain('Recent ERD Studio log');
    expect(view.log).toHaveLength(1);
    expect(view.log![0]).toContain('{project}/.erd-studio/{layer}/{domain}.dbml');
    expect(view.log![0]).not.toContain('khaidirhasan');
  });

  it('no log lines: the view offers none', () => {
    expect(buildDiagnosticsView(collectDiagnostics(context)).log).toBeUndefined();
  });

  it('the opt-in label says the log can name tables and that the issue is public', () => {
    expect(FEEDBACK_LOG_LABEL).toBe('Include the recent ERD Studio log');
    expect(FEEDBACK_LOG_NOTE).toMatch(/name your tables/);
    expect(FEEDBACK_LOG_NOTE).toMatch(/public GitHub issue/);
  });
});

describe('fitting the log to the issue link', () => {
  const urlOf = (fields: Record<string, string>) => buildIssueUrl(fields, { maxLength: Number.MAX_SAFE_INTEGER });

  function withLog(lines: number): Diagnostics {
    for (let i = 0; i < lines; i++) log.info(`[Canvas] line ${String(i).padStart(3, '0')} ${'x'.repeat(60)}`);
    return collectDiagnostics(context, undefined, [], { includeLog: true });
  }

  it('a short log goes whole', () => {
    const d = withLog(5);
    const fields = fitLogToIssueUrl((x) => composeFeedbackFields(draft(), x), d, urlOf);
    expect(fields.diagnostics).toContain('Recent ERD Studio log (5 lines):');
  });

  it('a long log keeps its newest lines and the URL stays under the limit', () => {
    const d = withLog(200);
    const fields = fitLogToIssueUrl((x) => composeFeedbackFields(draft(), x), d, urlOf);
    expect(urlOf(fields).length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(fields.diagnostics).toContain('line 199');
    expect(fields.diagnostics).not.toContain('line 000');
    const kept = Number(/Recent ERD Studio log \((\d+) lines\)/.exec(fields.diagnostics)![1]);
    expect(kept).toBeGreaterThan(5);
    expect(kept).toBeLessThan(200);
    // One more line would not have fitted.
    const oneMore = composeFeedbackFields(draft(), { ...d, recentLog: d.recentLog!.slice(200 - kept - 1) });
    expect(urlOf(oneMore).length).toBeGreaterThan(MAX_ISSUE_URL_LENGTH);
  });

  it('the copied report keeps every line', () => {
    const d = withLog(200);
    const report = composeMarkdownReport(draft(), d);
    expect(report).toContain('line 000');
    expect(report).toContain('line 199');
  });

  it('submitFeedback sends the log only when ticked, and only inside the diagnostics', async () => {
    withLog(3);
    const previewedLog = buildFeedbackContext(context).log;
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await submitFeedback(context, draft({ includeLog: false }), undefined, { previewedLog });
    expect(decodeURIComponent(String(open.mock.calls[0][0]))).not.toContain('Recent ERD Studio log');
    await submitFeedback(context, draft({ includeLog: true, includeDiagnostics: false }), undefined, { previewedLog });
    expect(decodeURIComponent(String(open.mock.calls[1][0]))).not.toContain('Recent ERD Studio log');
    await submitFeedback(context, draft({ includeLog: true }), undefined, { previewedLog });
    const url = new URL(String(open.mock.calls[2][0]));
    expect(url.searchParams.get('diagnostics')).toContain('Recent ERD Studio log (3 lines):');
    expect(url.searchParams.get('description')).not.toContain('Recent ERD Studio log');
  });

  it('the report carries exactly the lines the dialog previewed, never one logged while it was open', async () => {
    log.info('[Canvas] shown line');
    const previewedLog = buildFeedbackContext(context).log;
    // Logged after the dialog opened (another canvas, the warm-up, a failed analysis request).
    log.info('[Canvas] Opening secret_area.dbml');
    hostErrorLog.record('feedbackAnalysis.request', new Error('table secret_customer failed'));
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await submitFeedback(context, draft({ includeLog: true }), undefined, { previewedLog });
    const diagnostics = new URL(String(open.mock.calls[0][0])).searchParams.get('diagnostics')!;
    expect(diagnostics).toContain('Recent ERD Studio log (1 line):');
    expect(diagnostics).toContain('shown line');
    expect(diagnostics).not.toContain('secret_area');
    const write = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    await copyFeedbackReport(context, draft({ includeLog: true }), undefined, { previewedLog });
    const report = String(write.mock.calls[0][0]);
    expect(report).toContain('shown line');
    expect(report).not.toContain('secret_area');
    // With no preview, no log at all.
    await copyFeedbackReport(context, draft({ includeLog: true }));
    expect(String(write.mock.calls[1][0])).not.toContain('Recent ERD Studio log');
  });

  it('the analysis prompt never carries the log (it takes no diagnostics at all)', () => {
    log.info('[Canvas] Opened secret_customer_table');
    const prompt = buildAnalysisPrompt({ kind: 'bug', description: draft().description, issues: [] });
    expect(prompt).not.toContain('secret_customer_table');
    expect(prompt).not.toContain('Recent ERD Studio log');
  });
});

describe('errors recorded for Send Feedback', () => {
  it('reach the log channel and the buffer, and the console exactly as before (not at all)', () => {
    const lines: string[] = [];
    const at = (level: string) => (message: string | Error) => { lines.push(`${level} ${String(message)}`); };
    const sink: LogSink = { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
    setLogSink(sink);
    hostErrorLog.record('feedbackAnalysis.request', new Error('HTTP 503'));
    expect(lines).toEqual(['error [feedbackAnalysis.request] HTTP 503']);
    expect(console.error).not.toHaveBeenCalled();
    expect(recentLogLines().at(-1)).toMatch(/\[error\] \[feedbackAnalysis\.request\] HTTP 503$/);
    expect(hostErrorLog.recent()).toHaveLength(1);
  });
});

describe('log lines name a diagram by its path, so the redacted copy shows its shape, not its name', () => {
  it('no buffered log line in src names a file by its basename', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf-8');
        for (const m of text.matchAll(/\b\w*[lL]og\.(?:info|warn|error)\(`[^`]*\$\{path\.(?:posix\.)?basename\(/g)) {
          offenders.push(`${path.relative(srcRoot, full)}: ${m[0]}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('a warning that logs the diagram\'s full path reaches the report as {layer}/{domain}.dbml', () => {
    log.warn(`[SemanticEditorProvider] Positions for ${FILE} not saved: disk full`);
    log.warn(`[ERD Studio] ${FILE} left as it is: bad Ref`);
    const lines = collectDiagnostics(context, undefined, [], { includeLog: true }).recentLog!;
    expect(lines.join('\n')).not.toContain('sales');
    expect(lines.join('\n')).not.toContain('khaidirhasan');
    expect(lines[0]).toContain('{project}/.erd-studio/{layer}/{domain}.dbml not saved');
  });
});
