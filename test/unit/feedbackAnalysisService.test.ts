/**
 * feedbackAnalysisService — the pure half: prompt construction and reply parsing.
 *
 * Two properties here are load-bearing rather than cosmetic:
 *
 *  1. **Privacy.** `buildAnalysisPrompt` takes no `Diagnostics` parameter, and
 *     this file asserts none of the diagnostics text can appear in a prompt.
 *     Versions, file paths and dbt model names from a possibly private project
 *     must never reach a model.
 *  2. **Hydration.** `parseAnalysisResponse` reads only `number`, `match` and
 *     `why` from the model; every other duplicate field comes from the issue
 *     list the host fetched. A hallucinated `stateReason: 'completed'` plus a
 *     hallucinated `fixedIn` would tell a user to update their extension for a
 *     bug that is still open — the worst thing this feature could do.
 */

import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  type AnalysisIssueSummary,
} from '../../src/services/feedbackAnalysisService';
import { formatDiagnostics, type Diagnostics } from '../../src/services/feedbackService';

const issues: AnalysisIssueSummary[] = [
  {
    number: 41,
    title: 'Canvas blank',
    body: 'The canvas renders nothing after a reload.',
    state: 'open',
    comments: 2,
    url: 'https://github.com/liam-machine/erd-studio/issues/41',
  },
  {
    number: 42,
    title: 'FK edge disappears on rename',
    state: 'closed',
    stateReason: 'completed',
    fixedIn: '0.6.44',
    comments: 5,
    assigned: true,
    url: 'https://github.com/liam-machine/erd-studio/issues/42',
  },
  {
    number: 43,
    title: 'Dark mode for the sidebar',
    state: 'closed',
    stateReason: 'not_planned',
    closingNote: 'The sidebar already follows the theme.',
    url: 'https://github.com/liam-machine/erd-studio/issues/43',
  },
];

const diagnostics: Diagnostics = {
  extensionVersion: '0.6.49',
  vscodeVersion: '1.95.0',
  platform: 'darwin',
  arch: 'arm64',
  domain: { name: 'orders', layer: 'silver', stage: 'logical', modelCount: 4, relationshipCount: 3 },
  hostErrors: ['2026-01-01T00:00:00.000Z [provider] boom'],
  webviewErrors: [],
};

describe('buildAnalysisPrompt', () => {
  it('carries the description, the context and every issue number', () => {
    const prompt = buildAnalysisPrompt({
      kind: 'bug',
      description: 'Renamed dim_task and the FK edge disappeared.',
      context: '1. Rename dim_task',
      issues,
    });
    expect(prompt).toContain('Renamed dim_task and the FK edge disappeared.');
    expect(prompt).toContain('1. Rename dim_task');
    for (const issue of issues) {
      expect(prompt).toContain(`#${issue.number}`);
      expect(prompt).toContain(issue.title);
    }
  });

  it('says which state each listed issue is in, so a duplicate can be judged', () => {
    const prompt = buildAnalysisPrompt({ kind: 'bug', description: 'x'.repeat(20), issues });
    expect(prompt).toContain('#41 [open]');
    expect(prompt).toContain('#42 [closed · done]');
    expect(prompt).toContain('#43 [closed · not planned]');
  });

  it('says so plainly when the issue list could not be fetched', () => {
    const prompt = buildAnalysisPrompt({ kind: 'feature', description: 'A search box.', issues: [] });
    expect(prompt).toContain('(none available)');
  });

  it('leaks no diagnostics — the privacy regression test', () => {
    // The whole diagnostics blob, for reference: nothing from it may appear.
    const text = formatDiagnostics(diagnostics);
    expect(text).toContain('ERD Studio: 0.6.49');

    const prompt = buildAnalysisPrompt({
      kind: 'bug',
      description: 'Renamed dim_task and the FK edge disappeared.',
      context: '1. Rename dim_task',
      issues,
    });

    for (const forbidden of ['ERD Studio:', 'VS Code:', 'Recent extension errors']) {
      expect(prompt).not.toContain(forbidden);
      expect(ANALYSIS_SYSTEM_PROMPT).not.toContain(forbidden);
    }
    expect(prompt).not.toContain('1.95.0');
    expect(prompt).not.toContain('darwin');
  });

  it('asks the model for only the three fields it is trusted with', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('"number", "match" and "why"');
  });
});

/**
 * The classification regression.
 *
 * The prompt used to open "The user is filing this as a bug, but decide for
 * yourself" on **every** fresh dialog, because `bug` is the kind the dialog
 * opens on — so a model was told, as a fact, something the user had never said,
 * and then asked to disagree with it. "I want a new ability to have a new
 * feature" came back classified as a bug.
 */
describe('buildAnalysisPrompt and the kind', () => {
  const wish = 'I want a new ability to have a new feature.';

  it('states no kind at all when the user has not chosen one', () => {
    const prompt = buildAnalysisPrompt({ kind: 'bug', description: wish, issues: [] });

    expect(prompt).toContain('The user has not said which kind this is');
    expect(prompt).not.toMatch(/filing this as a bug/i);
    // Nothing anywhere in it should read as the user having said "bug".
    expect(prompt.slice(0, prompt.indexOf(wish))).not.toMatch(/\bbug\b/i);
  });

  it('does not label the context field by a kind nobody picked either', () => {
    // "steps they gave" over a feature request's rationale is the same anchor
    // by another route.
    const prompt = buildAnalysisPrompt({
      kind: 'bug',
      description: wish,
      context: 'Today I copy the diagram by hand.',
      issues: [],
    });
    expect(prompt).toContain('--- what else they said ---');
    expect(prompt).not.toContain('--- steps they gave ---');
  });

  it('states the kind, and labels the context, once the user has actually chosen', () => {
    const prompt = buildAnalysisPrompt({
      kind: 'feature',
      kindChosenByUser: true,
      description: wish,
      context: 'Today I copy the diagram by hand.',
      issues: [],
    });
    expect(prompt).toContain('The user has chosen to file this as a feature request');
    expect(prompt).toContain('--- why they want it ---');
  });

  it('keeps the bug headings for a chosen bug', () => {
    const prompt = buildAnalysisPrompt({
      kind: 'bug',
      kindChosenByUser: true,
      description: 'The edge vanished.',
      context: '1. Rename it',
      issues: [],
    });
    expect(prompt).toContain('The user has chosen to file this as a bug');
    expect(prompt).toContain('--- steps they gave ---');
  });

  it('defines the two kinds, so the model is not left to guess what they mean', () => {
    // Without this the system prompt never said what separates them.
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/behaviour that already exists/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/does not exist yet/i);
    // The phrasing that was being misread, called out by name.
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('"I want"');
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/a new ability to/i);
  });

  it('asks for confidence as a probability, not a flourish', () => {
    // The dialog now renders both sides of it, so an inflated number is not a
    // harmless one.
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/0\.5 means/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/do not inflate/i);
  });
});

describe('parseAnalysisResponse', () => {
  const reply = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: 'bug',
      confidence: 0.82,
      title: 'FK edge disappears after a model rename',
      context: '1. Rename dim_task',
      reasons: { desc: null, ctx: 'Steps would help.' },
      duplicates: [],
      ...extra,
    });

  it('parses a bare JSON object', () => {
    const analysis = parseAnalysisResponse(reply(), 'feature', issues);
    expect(analysis).toMatchObject({
      kind: 'bug',
      confidence: 0.82,
      title: 'FK edge disappears after a model rename',
      context: '1. Rename dim_task',
    });
    expect(analysis?.reasons).toEqual({ desc: null, ctx: 'Steps would help.' });
  });

  it('parses a ```json fenced block', () => {
    const raw = ['Here you go:', '```json', reply(), '```'].join('\n');
    expect(parseAnalysisResponse(raw, 'bug', issues)?.title).toBe(
      'FK edge disappears after a model rename',
    );
  });

  it('parses an object after leading prose, braces in strings and all', () => {
    const raw = `Sure! I think this is a bug {not an object}.\n${reply({ title: 'A } brace { inside' })}`;
    expect(parseAnalysisResponse(raw, 'bug', issues)?.title).toBe('A } brace { inside');
  });

  it('returns null for anything with no JSON object in it', () => {
    expect(parseAnalysisResponse('I could not decide.', 'bug', issues)).toBeNull();
    expect(parseAnalysisResponse('', 'bug', issues)).toBeNull();
    expect(parseAnalysisResponse('[1, 2, 3]', 'bug', issues)).toBeNull();
    expect(parseAnalysisResponse('{ not: json }', 'bug', issues)).toBeNull();
  });

  it('falls back to the caller\'s kind when the model invents one', () => {
    expect(parseAnalysisResponse(reply({ kind: 'question' }), 'feature', issues)?.kind).toBe('feature');
    expect(parseAnalysisResponse(reply({ kind: undefined }), 'bug', issues)?.kind).toBe('bug');
  });

  it('clamps confidence and every match into 0..1', () => {
    expect(parseAnalysisResponse(reply({ confidence: 7 }), 'bug', issues)?.confidence).toBe(1);
    expect(parseAnalysisResponse(reply({ confidence: -3 }), 'bug', issues)?.confidence).toBe(0);
    expect(parseAnalysisResponse(reply({ confidence: 'nonsense' }), 'bug', issues)?.confidence).toBe(0);

    const analysis = parseAnalysisResponse(
      reply({ duplicates: [{ number: 41, match: 99, why: 'x' }] }),
      'bug',
      issues,
    );
    expect(analysis?.duplicates[0].match).toBe(1);
  });

  it('drops a duplicate whose number is not in the known list', () => {
    const analysis = parseAnalysisResponse(
      reply({
        duplicates: [
          { number: 999, match: 0.95, why: 'Invented.' },
          { number: 41, match: 0.6, why: 'Same symptom.' },
        ],
      }),
      'bug',
      issues,
    );
    expect(analysis?.duplicates.map((d) => d.number)).toEqual([41]);
  });

  it('drops a repeated number rather than listing it twice', () => {
    const analysis = parseAnalysisResponse(
      reply({
        duplicates: [
          { number: 41, match: 0.8, why: 'First.' },
          { number: 41, match: 0.4, why: 'Again.' },
        ],
      }),
      'bug',
      issues,
    );
    expect(analysis?.duplicates).toHaveLength(1);
    expect(analysis?.duplicates[0].why).toBe('First.');
  });

  it('sorts duplicates by match descending, then by the older issue number', () => {
    const analysis = parseAnalysisResponse(
      reply({
        duplicates: [
          { number: 43, match: 0.4, why: 'c' },
          { number: 42, match: 0.9, why: 'a' },
          { number: 41, match: 0.9, why: 'b' },
        ],
      }),
      'bug',
      issues,
    );
    expect(analysis?.duplicates.map((d) => d.number)).toEqual([41, 42, 43]);
  });

  it('hydrates every field but number/match/why from the known issue (A3)', () => {
    const analysis = parseAnalysisResponse(
      reply({
        duplicates: [
          {
            number: 41,
            match: 0.9,
            why: 'Same symptom.',
            // Everything below is a hallucination and must be discarded: the
            // known list says #41 is OPEN.
            title: 'LIES',
            state: 'closed',
            stateReason: 'completed',
            fixedIn: '9.9.9',
            comments: 999,
            assigned: true,
            closingNote: 'Invented.',
            url: 'https://evil.example/41',
          },
        ],
      }),
      'bug',
      issues,
    );

    const duplicate = analysis!.duplicates[0];
    expect(duplicate.match).toBe(0.9);
    expect(duplicate.why).toBe('Same symptom.');
    expect(duplicate.title).toBe('Canvas blank');
    expect(duplicate.state).toBe('open');
    expect(duplicate.stateReason).toBeUndefined();
    expect(duplicate.fixedIn).toBeUndefined();
    expect(duplicate.closingNote).toBeUndefined();
    expect(duplicate.comments).toBe(2);
    expect(duplicate.assigned).toBeUndefined();
    expect(duplicate.url).toBe('https://github.com/liam-machine/erd-studio/issues/41');
  });

  it('carries the real closed-state fields through for a genuinely fixed issue', () => {
    const analysis = parseAnalysisResponse(
      reply({ duplicates: [{ number: 42, match: 0.8, why: 'Same rename bug.' }] }),
      'bug',
      issues,
    );
    expect(analysis?.duplicates[0]).toMatchObject({
      number: 42,
      title: 'FK edge disappears on rename',
      state: 'closed',
      stateReason: 'completed',
      fixedIn: '0.6.44',
      comments: 5,
      assigned: true,
    });
  });

  it('survives a duplicates field that is not an array of objects', () => {
    expect(parseAnalysisResponse(reply({ duplicates: 'none' }), 'bug', issues)?.duplicates).toEqual([]);
    expect(
      parseAnalysisResponse(reply({ duplicates: [null, 5, { why: 'no number' }] }), 'bug', issues)
        ?.duplicates,
    ).toEqual([]);
  });

  it('normalises the reasons object, turning blanks into null', () => {
    const analysis = parseAnalysisResponse(
      reply({ reasons: { desc: '  ', ctx: '  Add steps. ' } }),
      'bug',
      issues,
    );
    expect(analysis?.reasons).toEqual({ desc: null, ctx: 'Add steps.' });
  });

  it('tolerates a missing reasons object entirely', () => {
    const analysis = parseAnalysisResponse(reply({ reasons: undefined }), 'bug', issues);
    expect(analysis?.reasons).toEqual({ desc: null, ctx: null });
  });
});
