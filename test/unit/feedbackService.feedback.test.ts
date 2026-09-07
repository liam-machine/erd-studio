/**
 * feedbackService — the kind-aware half added for the Feedback dialog.
 *
 * `test/unit/feedbackService.test.ts` covers the shared primitives and must
 * keep passing untouched; everything here is new surface built beside them:
 * per-kind templates and field ids, the Markdown report behind "Copy report",
 * the diagnostics chips the dialog renders, and the image helpers.
 *
 * The VS Code-facing half (submitFeedback, saveAttachments) is exercised
 * end-to-end through the provider in semanticEditorProvider.feedback.test.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  BUG_REPORT_TEMPLATE,
  FEATURE_REQUEST_TEMPLATE,
  attachmentFileName,
  buildDiagnosticsChips,
  buildDiagnosticsView,
  composeFeedbackFields,
  composeMarkdownReport,
  contextFieldForKind,
  decodeImageDataUrl,
  defaultTitleForKind,
  formatDiagnostics,
  templateForKind,
  truncationOrderForKind,
  type Diagnostics,
} from '../../src/services/feedbackService';
import type { FeedbackAttachment, FeedbackDraft } from '../../src/types/feedback';

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

/** 1×1 transparent PNG. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function attachment(overrides: Partial<FeedbackAttachment> = {}): FeedbackAttachment {
  return {
    id: '1-canvas-png',
    name: 'canvas.png',
    mime: 'image/png',
    bytes: 70,
    dataUrl: TINY_PNG,
    source: 'canvas',
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

  describe('the screenshot field', () => {
    it('tells the user to paste the screenshot the clipboard took', () => {
      const fields = composeFeedbackFields(
        draft({ attachments: [attachment({ onClipboard: true })] }),
        diagnostics,
      );
      expect(fields.screenshot).toBe(
        'A screenshot is on your clipboard — click here and press Ctrl+V / ⌘V to attach it.',
      );
    });

    it('tells the user to drag the saved file when the clipboard refused it', () => {
      // The browser may refuse the clipboard write; the saved copy is what
      // makes that recoverable, so the field must point at the file instead.
      const fields = composeFeedbackFields(
        draft({ attachments: [attachment({ onClipboard: false })] }),
        diagnostics,
      );
      expect(fields.screenshot).toBe('Drag the saved screenshot file here to attach it.');
    });

    it('treats an unrecorded clipboard result as a refusal, never a promise', () => {
      const fields = composeFeedbackFields(draft({ attachments: [attachment()] }), diagnostics);
      expect(fields.screenshot).toBe('Drag the saved screenshot file here to attach it.');
    });

    it('has no screenshot field at all with no image', () => {
      expect(composeFeedbackFields(draft(), diagnostics).screenshot).toBeUndefined();
    });
  });
});

describe('composeMarkdownReport', () => {
  it('lays the whole report out in issue-form order', () => {
    const report = composeMarkdownReport(
      draft({ steps: '1. Rename dim_task\n2. Look at the canvas', attachments: [attachment()] }),
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
        '## Attachments',
        '',
        '- canvas.png',
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

  it('lists caller-supplied attachment names over the draft\'s own', () => {
    const report = composeMarkdownReport(
      draft({ attachments: [attachment()], includeDiagnostics: false }),
      diagnostics,
      { attachmentNames: ['screen-capture.png'] },
    );
    expect(report).toContain('- screen-capture.png');
    expect(report).not.toContain('- canvas.png');
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

  it('adds a domain chip when a canvas was open', () => {
    const chips = buildDiagnosticsChips({
      ...diagnostics,
      domain: { name: 'orders', layer: 'silver', stage: 'logical', modelCount: 4, relationshipCount: 3 },
    });
    expect(chips[3]).toEqual({ label: 'silver/orders · 4 models', tone: 'normal' });
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

describe('decodeImageDataUrl', () => {
  it('accepts all four image types and returns the mime alongside the bytes', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const decoded = decodeImageDataUrl(`data:${mime};base64,AAAA`);
      expect(decoded?.mime).toBe(mime);
      expect(decoded?.bytes).toBeInstanceOf(Buffer);
      expect(decoded?.bytes.length).toBe(3);
    }
  });

  it('decodes a real PNG payload', () => {
    const decoded = decodeImageDataUrl(TINY_PNG);
    // PNG magic number — proof the base64 actually round-tripped.
    expect(decoded?.bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('rejects anything that is not an accepted image data URL', () => {
    expect(decodeImageDataUrl('data:text/plain;base64,AA')).toBeNull();
    expect(decodeImageDataUrl('data:image/svg+xml;base64,AA')).toBeNull();
    expect(decodeImageDataUrl('image/png;base64,AA')).toBeNull();
    expect(decodeImageDataUrl('data:image/png;base64,not base64!')).toBeNull();
    expect(decodeImageDataUrl('')).toBeNull();
  });
});

describe('attachmentFileName', () => {
  it('zero-pads the index and uses the mime\'s extension', () => {
    expect(attachmentFileName(attachment(), 1, '2026-09-07T01-02-03-000Z')).toBe(
      'erd-studio-2026-09-07T01-02-03-000Z-01.png',
    );
    expect(attachmentFileName(attachment({ mime: 'image/jpeg' }), 3, 'S')).toBe(
      'erd-studio-S-03.jpg',
    );
    expect(attachmentFileName(attachment({ mime: 'image/gif' }), 12, 'S')).toBe(
      'erd-studio-S-12.gif',
    );
    expect(attachmentFileName(attachment({ mime: 'image/webp' }), 4, 'S')).toBe(
      'erd-studio-S-04.webp',
    );
  });
});
