/**
 * feedbackService — the kind-aware half added for the Feedback dialog.
 *
 * `test/unit/feedbackService.test.ts` covers the shared primitives and must
 * keep passing untouched; everything here is new surface built beside them:
 * per-kind templates and field ids, the Markdown report behind "Copy report",
 * and the diagnostics chips the dialog renders.
 *
 * The VS Code-facing half (submitFeedback) is exercised end-to-end through the
 * provider in semanticEditorProvider.feedback.test.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  BUG_REPORT_TEMPLATE,
  FEATURE_REQUEST_TEMPLATE,
  buildDiagnosticsChips,
  buildDiagnosticsView,
  composeFeedbackFields,
  composeMarkdownReport,
  contextFieldForKind,
  defaultTitleForKind,
  formatDiagnostics,
  templateForKind,
  truncationOrderForKind,
  type Diagnostics,
} from '../../src/services/feedbackService';
import type { FeedbackDraft } from '../../src/types/feedback';

const diagnostics: Diagnostics = {
  extensionVersion: '0.6.49',
  vscodeVersion: '1.95.0',
  platform: 'darwin',
  arch: 'arm64',
  hostErrors: [],
  webviewErrors: [],
};

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    kind: 'bug',
    title: 'Edge vanished after rename',
    description: 'Renamed dim_task and the FK edge disappeared.',
    includeDiagnostics: true,
    ...overrides,
  };
}

describe('per-kind issue form routing', () => {
  it('picks the template file for each kind', () => {
    expect(templateForKind('bug')).toBe(BUG_REPORT_TEMPLATE);
    expect(templateForKind('bug')).toBe('bug_report.yml');
    expect(templateForKind('feature')).toBe(FEATURE_REQUEST_TEMPLATE);
    expect(templateForKind('feature')).toBe('feature_request.yml');
  });

  it('defaults a blank title per kind', () => {
    expect(defaultTitleForKind('bug')).toBe('Bug report');
    expect(defaultTitleForKind('feature')).toBe('Feature request');
  });

  it('maps the context field onto the right form field id', () => {
    expect(contextFieldForKind('bug')).toBe('steps');
    expect(contextFieldForKind('feature')).toBe('rationale');
  });

  it('drops diagnostics first and the description last when the URL is too long', () => {
    expect(truncationOrderForKind('bug')).toEqual(['diagnostics', 'steps', 'description']);
    expect(truncationOrderForKind('feature')).toEqual(['diagnostics', 'rationale', 'description']);
  });
});

describe('composeFeedbackFields', () => {
  it('emits the bug form fields with steps', () => {
    const fields = composeFeedbackFields(draft({ steps: '1. Rename dim_task' }), diagnostics);
    expect(fields.title).toBe('Edge vanished after rename');
    expect(fields.steps).toBe('1. Rename dim_task');
    expect(fields.rationale).toBeUndefined();
    expect(fields.diagnostics).toContain('ERD Studio: 0.6.49');
  });

  it('renames steps to rationale for a feature request', () => {
    const fields = composeFeedbackFields(
      draft({ kind: 'feature', steps: 'Today I keep two windows open.' }),
      diagnostics,
    );
    expect(fields.rationale).toBe('Today I keep two windows open.');
    expect(fields.steps).toBeUndefined();
  });

  it('falls back to the per-kind default title', () => {
    expect(composeFeedbackFields(draft({ title: '   ' }), diagnostics).title).toBe('Bug report');
    expect(
      composeFeedbackFields(draft({ kind: 'feature', title: '' }), diagnostics).title,
    ).toBe('Feature request');
  });

  it('applies the regression prefix only when regressionOf is set', () => {
    expect(composeFeedbackFields(draft(), diagnostics).title).toBe('Edge vanished after rename');
    expect(composeFeedbackFields(draft({ regressionOf: 42 }), diagnostics).title).toBe(
      'Regression: Edge vanished after rename',
    );
  });

  it('omits diagnostics when the user removed them', () => {
    expect(
      composeFeedbackFields(draft({ includeDiagnostics: false }), diagnostics).diagnostics,
    ).toBeUndefined();
  });

  it('never fills the Screenshot box, so the user can drop an image straight into it', () => {
    // The extension attaches nothing, so any text here would be an instruction
    // sitting in the box the user has to clear before pasting their own image.
    expect(composeFeedbackFields(draft(), diagnostics).screenshot).toBeUndefined();
    expect(
      composeFeedbackFields(draft({ kind: 'feature' }), diagnostics).screenshot,
    ).toBeUndefined();
  });
});

describe('composeMarkdownReport', () => {
  it('lays the whole report out in issue-form order', () => {
    const report = composeMarkdownReport(
      draft({ steps: '1. Rename dim_task\n2. Look at the canvas' }),
      diagnostics,
    );
    expect(report).toBe(
      [
        '# Edge vanished after rename',
        '',
        '_Bug report · ERD Studio 0.6.49_',
        '',
        '## What happened?',
        '',
        'Renamed dim_task and the FK edge disappeared.',
        '',
        '## Steps to reproduce',
        '',
        '1. Rename dim_task\n2. Look at the canvas',
        '',
        '## Diagnostics',
        '',
        ['```', formatDiagnostics(diagnostics), '```'].join('\n'),
      ].join('\n'),
    );
  });

  it('uses the feature headings for a feature request', () => {
    const report = composeMarkdownReport(
      draft({ kind: 'feature', steps: 'Two windows today.' }),
      diagnostics,
    );
    expect(report).toContain('_Feature request · ERD Studio 0.6.49_');
    expect(report).toContain('## What would you like to be able to do?');
    expect(report).toContain('## Why do you want it?');
    expect(report).not.toContain('## Steps to reproduce');
  });

  it('omits every empty section', () => {
    const report = composeMarkdownReport(
      draft({ description: '   ', steps: '  ', includeDiagnostics: false }),
      diagnostics,
    );
    expect(report).toBe('# Edge vanished after rename\n\n_Bug report · ERD Studio 0.6.49_');
  });

  it('drops the version line entirely when there are no diagnostics', () => {
    const report = composeMarkdownReport(draft(), null);
    expect(report).not.toContain('ERD Studio');
    expect(report.split('\n')[0]).toBe('# Edge vanished after rename');
  });

  it('has no Attachments section — the report carries no files', () => {
    const report = composeMarkdownReport(draft({ steps: 'Rename it.' }), diagnostics);
    expect(report).not.toContain('## Attachments');
  });
});

describe('buildDiagnosticsChips', () => {
  it('emits the version, editor and platform chips in order', () => {
    expect(buildDiagnosticsChips(diagnostics)).toEqual([
      { label: 'ERD Studio 0.6.49', tone: 'normal' },
      { label: 'VS Code 1.95.0', tone: 'normal' },
      { label: 'darwin arm64', tone: 'normal' },
    ]);
  });

  it('adds a canvas chip describing the graph, never naming it', () => {
    // The domain's name and layer are the user's own business vocabulary and
    // point at a project the maintainer cannot open; the size and stage of the
    // graph are what a bug report actually needs.
    const chips = buildDiagnosticsChips({
      ...diagnostics,
      domain: { stage: 'logical', modelCount: 4, relationshipCount: 3 },
    });
    expect(chips[3]).toEqual({
      label: 'logical \u00b7 4 models \u00b7 3 relationships',
      tone: 'normal',
    });
  });

  it('says "1 model" rather than "1 models"', () => {
    const chips = buildDiagnosticsChips({
      ...diagnostics,
      domain: { stage: 'physical', modelCount: 1, relationshipCount: 1 },
    });
    expect(chips[3].label).toBe('physical \u00b7 1 model \u00b7 1 relationship');
  });

  it('adds an error-tone chip counting host and webview errors together', () => {
    const chips = buildDiagnosticsChips({ ...diagnostics, hostErrors: ['boom'] });
    expect(chips.at(-1)).toEqual({ label: '1 recent error', tone: 'error' });

    const plural = buildDiagnosticsChips({
      ...diagnostics,
      hostErrors: ['boom'],
      webviewErrors: ['oops', 'again'],
    });
    expect(plural.at(-1)).toEqual({ label: '3 recent errors', tone: 'error' });
  });

  it('never shows an error chip when nothing went wrong', () => {
    expect(buildDiagnosticsChips(diagnostics).some((c) => c.tone === 'error')).toBe(false);
  });
});

describe('buildDiagnosticsView', () => {
  it('pairs the chips with the verbatim formatDiagnostics text', () => {
    const view = buildDiagnosticsView(diagnostics);
    expect(view.chips).toEqual(buildDiagnosticsChips(diagnostics));
    expect(view.text).toBe(formatDiagnostics(diagnostics));
    expect(view.text.startsWith('ERD Studio: ')).toBe(true);
  });
});
