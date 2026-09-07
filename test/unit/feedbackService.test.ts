import { describe, it, expect } from 'vitest';

import {
  ErrorLog,
  buildIssueUrl,
  composeIssueFields,
  formatDiagnostics,
  GITHUB_REPO,
  BUG_REPORT_TEMPLATE,
  type Diagnostics,
} from '../../src/services/feedbackService';

const baseDiagnostics: Diagnostics = {
  extensionVersion: '0.6.46',
  vscodeVersion: '1.95.0',
  platform: 'darwin',
  arch: 'arm64',
  hostErrors: [],
  webviewErrors: [],
};

describe('feedbackService', () => {
  describe('ErrorLog', () => {
    it('keeps only the most recent entries', () => {
      const log = new ErrorLog(3);
      for (let i = 0; i < 5; i++) log.record('test', `err ${i}`);
      const recent = log.recent();
      expect(recent).toHaveLength(3);
      expect(recent[0]).toContain('err 2');
      expect(recent[2]).toContain('err 4');
    });

    it('formats Error objects and collapses whitespace', () => {
      const log = new ErrorLog();
      log.record('provider', new Error('multi\n  line   message'), new Date('2026-01-02T03:04:05Z'));
      expect(log.recent()).toEqual(['2026-01-02T03:04:05.000Z [provider] multi line message']);
    });
  });

  describe('formatDiagnostics', () => {
    it('includes domain context and errors when present', () => {
      const text = formatDiagnostics({
        ...baseDiagnostics,
        domain: { name: 'orders', layer: 'silver', stage: 'logical', modelCount: 4, relationshipCount: 3, schemaVersion: 5 },
        hostErrors: ['2026-01-01T00:00:00.000Z [x] boom'],
        webviewErrors: ['2026-01-01T00:00:01.000Z [webview] oops'],
      });
      expect(text).toContain('ERD Studio: 0.6.46');
      expect(text).toContain('silver/orders (stage=logical, schemaVersion=5)');
      expect(text).toContain('Models:     4   Relationships: 3');
      expect(text).toContain('Recent extension errors:');
      expect(text).toContain('boom');
      expect(text).toContain('Recent canvas errors:');
      expect(text).toContain('oops');
    });

    it('omits empty sections', () => {
      const text = formatDiagnostics(baseDiagnostics);
      expect(text).not.toContain('Domain:');
      expect(text).not.toContain('Recent');
    });
  });

  describe('buildIssueUrl', () => {
    it('targets the repo issue form and prefills fields by id', () => {
      const url = buildIssueUrl({ title: 'Canvas blank', description: 'It broke & died', steps: '1. open' });
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(`https://github.com/${GITHUB_REPO}/issues/new`);
      expect(parsed.searchParams.get('template')).toBe(BUG_REPORT_TEMPLATE);
      expect(parsed.searchParams.get('title')).toBe('Canvas blank');
      expect(parsed.searchParams.get('description')).toBe('It broke & died');
      expect(parsed.searchParams.get('steps')).toBe('1. open');
    });

    it('drops empty fields', () => {
      const url = buildIssueUrl({ title: 'x', description: 'y', steps: '' });
      expect(new URL(url).searchParams.has('steps')).toBe(false);
    });

    it('truncates the most expendable field first to fit the length budget', () => {
      const description = 'd'.repeat(500);
      const diagnostics = 'x'.repeat(5000);
      const url = buildIssueUrl({ title: 't', description, diagnostics }, { maxLength: 2000 });
      expect(url.length).toBeLessThanOrEqual(2000);
      const params = new URL(url).searchParams;
      // description survives untouched; diagnostics was cut and marked.
      expect(params.get('description')).toBe(description);
      expect(params.get('diagnostics')).toContain('(truncated)');
    });

    it('removes a field entirely when it cannot be shortened enough', () => {
      const url = buildIssueUrl(
        { title: 't', description: 'keep me', diagnostics: 'x'.repeat(5000) },
        { maxLength: 130 },
      );
      expect(url.length).toBeLessThanOrEqual(130);
      const params = new URL(url).searchParams;
      expect(params.has('diagnostics')).toBe(false);
      expect(params.get('description')).toBe('keep me');
    });
  });

  describe('composeIssueFields', () => {
    it('falls back to a default title and only includes diagnostics when asked', () => {
      const fields = composeIssueFields(
        { title: '   ', description: ' desc ', includeDiagnostics: false },
        baseDiagnostics,
      );
      expect(fields.title).toBe('Bug report');
      expect(fields.description).toBe('desc');
      expect(fields.diagnostics).toBeUndefined();
    });

    it('carries the diagnostics block through when they are asked for', () => {
      const fields = composeIssueFields(
        { title: 't', description: 'd', includeDiagnostics: true },
        baseDiagnostics,
      );
      expect(fields.diagnostics).toContain('ERD Studio: 0.6.46');
    });

    it('never fills the Screenshot box — nothing is attached from here', () => {
      const fields = composeIssueFields(
        { title: 't', description: 'd', includeDiagnostics: true },
        baseDiagnostics,
      );
      expect(fields.screenshot).toBeUndefined();
    });
  });
});
