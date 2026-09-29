// Pipeline self-tests: `npm test` in video/ (node:test — deliberately not the root vitest run,
// which must never depend on video/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildCues, buildTimeline, MAX_CUE_CHARS, splitCaption, toTranscriptTs, toVtt } from '../build-timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const script = parse(readFileSync(join(HERE, '..', 'script.yaml'), 'utf8'));

const mini = {
  timing: { lead: 0.5, gap: 0.25, tail: 0.6, fade: 0.3 },
  chapters: ['1 · A'],
  scenes: [
    { id: 'a', module: 'm', minDur: 1, lines: [{ id: 'a1', beat: 'x', caption: 'One.' }, { id: 'a2', beat: 'y', pause: 0.1, caption: 'and two.' }] },
    { id: 'b', module: 'm', minDur: 5, lines: [{ id: 'b1', beat: 'z', caption: 'Three.' }] },
  ],
};
const durs = { a1: 1, a2: 2, b1: 1 };

test('scene starts, line starts and beats come from the audio durations', () => {
  const tl = buildTimeline(mini, durs);
  const [a, b] = tl.scenes;
  assert.equal(a.start, 0);
  assert.deepEqual(a.beats.x, { t: 0.5, end: 1.5 });
  assert.deepEqual(a.beats.y, { t: 1.6, end: 3.6 });   // `pause` replaces the gap
  assert.equal(a.dur, 4.2);                              // lastLineEnd + tail
  assert.equal(b.start, 4.2);
  assert.equal(b.dur, 5);                                // minDur wins
  assert.equal(tl.total, 9.2);
});

test('a missing clip or a duplicate beat fails loudly', () => {
  assert.throws(() => buildTimeline(mini, { a1: 1 }), /no voice clip for line a2/);
  const dup = structuredClone(mini);
  dup.scenes[0].lines[1].beat = 'x';
  assert.throws(() => buildTimeline(dup, durs), /duplicate beat x/);
});

test('captions split at sentence then clause boundaries and never exceed the cue limit', () => {
  assert.deepEqual(splitCaption('Short one.'), ['Short one.']);
  const long = 'New to Claude Code? Install it and sign in first. The panel links you there, whenever you are ready to go.';
  const parts = splitCaption(long);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' '), long);
  for (const p of parts) assert.ok(p.length <= MAX_CUE_CHARS, p);
});

test('continuation lines merge into one cue; cues are ordered and never overlap', () => {
  const tl = buildTimeline(mini, durs);
  const cues = buildCues(tl);
  assert.equal(cues[0].text, 'One. and two.');
  assert.equal(cues[0].start, 0.5);
  assert.equal(cues[1].text, 'Three.');
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].end, 'overlap');
  assert.ok(cues.at(-1).end <= tl.total);
});

test('VTT and transcript module are well formed', () => {
  const tl = buildTimeline(mini, durs);
  const cues = buildCues(tl);
  const vtt = toVtt(cues);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.500 --> 00:00:0\d\.\d{3}\n/);
  const ts = toTranscriptTs(tl, cues);
  assert.match(ts, /do not edit/);
  assert.match(ts, /export const GETTING_STARTED_CUES: \{ start: number; end: number; text: string \}\[\] = \[/);
  assert.match(ts, /export const GETTING_STARTED_TRANSCRIPT: string = \[\n  'One\. and two\.',\n  'Three\.',\n\]\.join\('\\n\\n'\);/);
  assert.match(toTranscriptTs(buildTimeline({ ...mini, scenes: [{ ...mini.scenes[1], lines: [{ id: 'b1', beat: 'z', caption: "It's here." }] }] }, durs), []), /'It\\'s here\.'/);
  assert.doesNotMatch(ts, /^import /m);
});

test('script.yaml: unique ids, every scene module exists, every beat a module reads is defined', () => {
  const ids = script.scenes.flatMap((s) => s.lines.map((l) => l.id));
  assert.equal(new Set(ids).size, ids.length);
  const mods = new Set(readdirSync(join(HERE, '..', 'player', 'scenes')).map((f) => f.replace(/\.js$/, '')));
  for (const sc of script.scenes) {
    assert.ok(mods.has(sc.module), `missing player/scenes/${sc.module}.js`);
    const src = readFileSync(join(HERE, '..', 'player', 'scenes', `${sc.module}.js`), 'utf8');
    const used = new Set([...src.matchAll(/beats\.(\w+)/g)].map((m) => m[1]));
    const defined = new Set(sc.lines.map((l) => l.beat));
    for (const b of used) assert.ok(defined.has(b), `${sc.module}.js reads beats.${b}, not defined in scene ${sc.id}`);
    if (sc.accentAfter) assert.ok(defined.has(sc.accentAfter.beat));
  }
});

test('player code has no CSS transitions, keyframes, timers or randomness (frames must be pure)', () => {
  const dir = join(HERE, '..', 'player');
  const files = ['style.css', 'lib.js', 'main.js', 'editor.js', ...readdirSync(join(dir, 'scenes')).map((f) => `scenes/${f}`)];
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hit = code.match(/@keyframes|transition\s*:|Math\.random|setTimeout|setInterval|Date\.now/);
    assert.equal(hit, null, `${f}: ${hit?.[0]}`);
  }
});

// The video shows the product's own words. When the walkthrough, the Draw from dbt command, the
// canvas or the setup skill is reworded, these fail so the mock is updated (and re-rendered) with it.
const REPO = join(HERE, '..', '..');
const flat = (s) => s.replace(/\s+/g, ' ');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const sceneSrc = (m) => readFileSync(join(HERE, '..', 'player', 'scenes', `${m}.js`), 'utf8');

// editor.js fetches the walkthrough images at import time; give it the real files.
globalThis.fetch = async (url) => ({ text: async () => read(...String(url).replace(/^\//, '').split('/')) });
const editor = await import('../player/editor.js');

test('scene order: hook, install, draw, canvas, design, physical, enrich, sample, end card; at most 65 s', () => {
  assert.deepEqual(script.scenes.map((s) => s.module), ['hook', 'install', 'draw', 'canvas', 'design', 'physical', 'enrich', 'sample', 'endCard']);
  assert.ok(script.maxDuration <= 65);
  const mods = readdirSync(join(HERE, '..', 'player', 'scenes')).map((f) => f.replace(/\.js$/, ''));
  assert.deepEqual(mods.sort(), script.scenes.map((s) => s.module).sort(), 'no unused scene modules');
});

test('the extension listing and the walkthrough mock use the real package.json copy', () => {
  const { EXTENSION, WALKTHROUGH } = editor;
  assert.equal(EXTENSION.name, pkg.displayName);
  assert.equal(EXTENSION.publisher, pkg.publisher);
  assert.equal(EXTENSION.description, pkg.description);
  const wt = pkg.contributes.walkthroughs.find((w) => w.id === 'erdStudio.getStarted');
  assert.equal(WALKTHROUGH.title, wt.title);
  assert.equal(WALKTHROUGH.description, wt.description);
  assert.deepEqual(WALKTHROUGH.steps.map((s) => s.id), wt.steps.map((s) => s.id));
  for (const step of WALKTHROUGH.steps) {
    const real = wt.steps.find((s) => s.id === step.id);
    assert.equal(step.title, real.title, `step title ${step.id}`);
    assert.equal(`media/walkthrough/${step.svg}.svg`, real.media.svg, `step image ${step.id}`);
    if (step.text) {
      // "<text>\n[<button>](command:…)": VS Code draws a link on its own line as a button.
      const [text, link] = real.description.split('\n');
      assert.equal(step.text, text, `step text ${step.id}`);
      assert.equal(step.button, link.match(/^\[([^\]]+)\]\(command:/)[1], `step button ${step.id}`);
    }
  }
  const draw = wt.steps.find((s) => s.id === 'draw');
  assert.match(draw.description, /\(command:erdStudio\.drawFromDbt\)/);
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === id);
  assert.equal(editor.WALKTHROUGH.steps.find((s) => s.id === 'enrich').button, cmd('erdStudio.setupAiHelper').title);
});

test('the watch step and its image state the real length of this video', () => {
  const wt = pkg.contributes.walkthroughs.find((w) => w.id === 'erdStudio.getStarted');
  const watch = wt.steps.find((s) => s.id === 'watch');
  assert.match(watch.title + watch.description, /one-minute/);
  assert.ok(script.maxDuration <= 65, 'a one-minute video');
  assert.match(read('media', 'walkthrough', 'watch.svg'), />1:0\d</);
});

test('the Draw from dbt mock uses the command\'s real copy', () => {
  const { DRAW_PICK } = editor;
  const cmd = read('src', 'commands', 'drawFromDbt.ts');
  const picker = read('src', 'providers', 'dbtDraftPicker.ts');
  assert.ok(cmd.includes(`const TITLE = '${DRAW_PICK.title}';`), 'QuickPick title');
  assert.ok(cmd.includes(`title: '${DRAW_PICK.progress}'`), 'progress notification');
  assert.ok(cmd.includes('prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`'));
  assert.equal(DRAW_PICK.namePrompt, 'Name the diagram. It is saved in the Gold layer.');
  assert.ok(picker.includes(`placeHolder: '${DRAW_PICK.placeholder}'`), 'placeholder');
  assert.ok(picker.includes(`CHOOSE_MODELS_LABEL = '$(checklist) ${DRAW_PICK.choose.label}'`), 'Choose models row');
  assert.ok(picker.includes('description: `pick up to ${limit} of ${models.length}`'));
  const limit = read('src', 'services', 'dbtDraft.ts').match(/DRAFT_MODEL_LIMIT = (\d+);/)[1];
  const all = DRAW_PICK.rows.reduce((n, r) => n + Number(r.description.split(' ')[0]), 0);
  assert.equal(DRAW_PICK.choose.description, `pick up to ${limit} of ${all}`);
  // Each folder row: "N models" and the first names (up to four), matching the canvas.
  for (const r of DRAW_PICK.rows) assert.equal(r.detail.split(', ').length, Number(r.description.split(' ')[0]));
  assert.deepEqual(DRAW_PICK.rows[0].detail.split(', ').sort(), editor.MODELS.map((m) => m.name).sort(), 'marts = the canvas');
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'erdStudio.drawFromDbt' && c.title === 'Draw from dbt…'));
});

test('the canvas mocks use the webview\'s own words', async () => {
  const toolbar = read('webview', 'components', 'Toolbar', 'Toolbar.tsx');
  const { DIFF_TOOLTIP, DISC } = await import('../player/scenes/physical.js');
  assert.ok(toolbar.includes(`'${DIFF_TOOLTIP}'`), 'Diff tooltip');
  assert.ok(toolbar.includes("'⊕ Diff'") && toolbar.includes("'⊘ Diff'"));
  assert.ok(toolbar.includes('Layout'), 'Layout button');
  const disc = read('webview', 'components', 'DiscrepancyPanel', 'DiscrepancyPanel.tsx');
  for (const s of [`>${DISC.allMatched}<`, `>${DISC.current}<`, `>${DISC.target}<`, `>${DISC.vs}<`, `>${DISC.matched}<`]) assert.ok(disc.includes(s), s);
  const tabs = read('webview', 'components', 'Toolbar', 'StageTabs.tsx');
  assert.ok(tabs.includes("label: 'Logical'") && tabs.includes("label: 'Physical'"));

  const { PANEL } = await import('../player/scenes/design.js');
  const cols = read('packages', 'renderer', 'src', 'components', 'DetailPanel', 'ColumnEditor.tsx');
  const panel = read('packages', 'renderer', 'src', 'components', 'DetailPanel', 'DetailPanel.tsx');
  assert.ok(cols.includes('Columns ({columns.length})'));
  assert.equal(PANEL.columns, `Columns (${editor.MODELS[1].cols.length})`);
  assert.ok(panel.includes('Relationships ({totalRelationships})'));
  assert.equal(PANEL.relationships, `Relationships (${PANEL.rels.length})`);
  const semantic = read('packages', 'core', 'src', 'types', 'semantic.ts');
  for (const r of PANEL.rels) assert.ok(semantic.includes(`'${r.card}'`), r.card);
});

test('the enrich scene types the real setup command and replies in the skill\'s words', async () => {
  const { PROMPT, REPLY } = await import('../player/scenes/enrich.js');
  const assistants = read('src', 'types', 'aiAssistants.ts');
  assert.ok(assistants.includes(`'${PROMPT}'`), 'setup prompt');
  const skill = flat(read('src', 'harness', 'claude', 'erd-studio-setup', 'SKILL.md'));
  const said = REPLY.replace(/<\/?b>/g, '**').replace('(4 models)', '(8 models)');
  assert.ok(skill.includes(said), 'the enrich route\'s opening line');
  const line = script.scenes.find((s) => s.module === 'enrich').lines.find((l) => l.beat === 'setup');
  assert.ok(line.caption.includes(PROMPT) && line.caption.includes(editor.WALKTHROUGH.steps.at(-1).button));
});

test('the sample scene uses the real confirm message', async () => {
  const { CONFIRM, DOWNLOAD } = await import('../player/scenes/sample.js');
  const host = read('src', 'providers', 'GettingStartedPanel.ts');
  const expr = host.match(/SAMPLE_CONFIRM_MESSAGE =\s*((?:"[^"]*"|'[^']*')(?:\s*\+\s*(?:"[^"]*"|'[^']*'))*);/)?.[1];
  assert.ok(expr, 'SAMPLE_CONFIRM_MESSAGE found');
  assert.equal(CONFIRM, new Function(`return ${expr};`)(), 'confirm message');
  assert.ok(host.includes(`SAMPLE_DOWNLOAD_ACTION = '${DOWNLOAD}'`), 'Download action');
  assert.ok(sceneSrc('sample').includes("open: 'sample'"), 'shows the walkthrough\'s sample step');
});

test('the end card names the real steps', async () => {
  const { STEPS } = await import('../player/scenes/endCard.js');
  const wt = pkg.contributes.walkthroughs.find((w) => w.id === 'erdStudio.getStarted');
  assert.equal(STEPS[0], `Install ${pkg.displayName}`);
  assert.equal(STEPS[1], wt.steps.find((s) => s.id === 'openProject').title);
  assert.equal(STEPS[2], editor.WALKTHROUGH.steps.find((s) => s.id === 'draw').button);
});

test('nothing calls ERD Studio open source (the licence is PolyForm Shield: source-available)', () => {
  assert.match(read('LICENSE'), /PolyForm Shield/);
  const dir = join(HERE, '..', 'player');
  const files = ['thumbnail.html', 'editor.js', ...readdirSync(join(dir, 'scenes')).map((f) => `scenes/${f}`)];
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /open[ -]source/i, f);
  assert.doesNotMatch(JSON.stringify(script), /open[ -]source/i, 'script.yaml');
});
