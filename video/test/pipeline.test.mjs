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
  const files = ['style.css', 'lib.js', 'main.js', ...readdirSync(join(dir, 'scenes')).map((f) => `scenes/${f}`)];
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hit = code.match(/@keyframes|transition\s*:|Math\.random|setTimeout|setInterval|Date\.now/);
    assert.equal(hit, null, `${f}: ${hit?.[0]}`);
  }
});

// The video shows the product's own words. When the Welcome panel or the setup skill is
// reworded, these fail so the mock is updated (and re-rendered) with it.
const REPO = join(HERE, '..', '..');
const flat = (s) => s.replace(/\s+/g, ' ');

test('the Welcome-panel mock uses the real panel copy (src/types/gettingStarted.ts)', async () => {
  const panel = flat(readFileSync(join(REPO, 'src', 'types', 'gettingStarted.ts'), 'utf8'));
  const helperSrc = readFileSync(join(HERE, '..', 'player', 'scenes', 'helper.js'), 'utf8');
  const { READY, GROUPS } = await import('../player/scenes/helper.js');
  assert.ok(READY.startsWith('AI helper ready for Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor. '));
  assert.ok(panel.includes(READY.replace(/^AI helper ready for [^.]*\. /, '')), 'setupReadyMessage([]) tail');
  for (const [title, why] of GROUPS) {
    assert.ok(panel.includes(title), `group title: ${title}`);
    assert.ok(panel.includes(why), `group text: ${why}`);
  }
  for (const s of [
    'Your AI assistant', 'Set up my AI helper', 'Start the guided setup', 'Open the canvas', 'Get Claude Code', 'Re-check',
    'The guided setup runs inside an AI coding assistant, and none was found on this computer. Install one, then press Re-check. Claude Code is recommended: it\'s the one the guide is tested with.',
    "guide and ERD Studio's file-format rules for", "(so it's ready whichever you install)", ', plus a small checking tool your assistant uses behind the scenes.',
    'Your assistant checks your dbt setup, works out how your project is modelled and checks with you, builds your logical model and checks it against dbt, explaining each step.',
    'Install an assistant (step 1) and press Re-check to see exactly what to type.',
    'The guided setup creates your first domain for you, or you can start one by hand.', 'Create your first domain', 'Reinstall my AI helper',
  ]) {
    assert.ok(panel.includes(s), `panel copy: ${s}`);
    assert.ok(flat(helperSrc).includes(s), `helper.js copy: ${s}`);
  }
});

test('the Gemini CLI hint shows the sentence the panel copies (GEMINI_SETUP_SENTENCE)', async () => {
  const src = readFileSync(join(REPO, 'src', 'types', 'aiAssistants.ts'), 'utf8');
  const { GEMINI_SENTENCE } = await import('../player/scenes/claude.js');
  assert.ok(src.includes(`GEMINI_SETUP_SENTENCE = '${GEMINI_SENTENCE}'`), GEMINI_SENTENCE);
});

test('the areas scene proposes one area the way the skill does (SKILL.md Stage 3a)', () => {
  const skill = flat(readFileSync(join(REPO, 'src', 'harness', 'claude', 'erd-studio-setup', 'SKILL.md'), 'utf8'));
  const areas = readFileSync(join(HERE, '..', 'player', 'scenes', 'areas.js'), 'utf8');
  assert.ok(skill.includes("Let's start with **orders**"), 'skill proposes one default');
  assert.ok(areas.includes("Let's start with <b style=\"color:var(--text)\">orders</b>"), 'scene proposes one default');
  assert.ok(!/Creating domain/.test(areas), 'the domain file is written in Stage 4, after the modelling step');
});

test('the modelling-style scene detects and confirms in the skill\'s own words (SKILL.md Stage 3b)', async () => {
  const raw = readFileSync(join(REPO, 'src', 'harness', 'claude', 'erd-studio-setup', 'SKILL.md'), 'utf8');
  const stage = raw.slice(raw.indexOf('### 3b.'), raw.indexOf('## Stage 4'));
  assert.ok(stage.startsWith('### 3b.'), 'Stage 3b found');
  const skill = flat(stage.replace(/^\s*> ?/gm, ''));
  // The confident-detection sentence: the first quote under "A table shape detected".
  const confirm = skill.slice(skill.indexOf('A table shape detected')).match(/"([^"]+)"/)?.[1];
  // The lookup narration, 'narrate it ("…")', and the playback opener.
  const lookup = skill.match(/narrate it \("([^"]+)"\)/)?.[1];
  const playback = skill.match(/"(Here's how I'll apply that:)/)?.[1];
  assert.ok(confirm && lookup && playback, 'sentences found in SKILL.md');
  const { CONFIRM, LOOKUP, PLAYBACK } = await import('../player/scenes/modelling.js');
  assert.equal(CONFIRM, confirm, 'confirmation sentence');
  assert.equal(LOOKUP, lookup, 'lookup narration');
  assert.equal(PLAYBACK, playback, 'playback');
  assert.ok(skill.includes('.erd-studio/modelling-approach.md'), 'saved file');
  const scene = readFileSync(join(HERE, '..', 'player', 'scenes', 'modelling.js'), 'utf8');
  assert.ok(scene.includes('.erd-studio/modelling-approach.md'), 'scene shows the saved file');
  assert.ok(!/How does your team like to model/.test(scene), 'never asks cold');
});

test('the sample scene, the helper scene\'s sample link and the end card use the real "Try the sample" copy', async () => {
  // HTML entities in the panel template become the characters the webview renders.
  const panel = flat(readFileSync(join(REPO, 'src', 'types', 'gettingStarted.ts'), 'utf8'))
    .replace(/&mdash;/g, '—').replace(/&rarr;/g, '→').replace(/&#9654;/g, '▶');
  const sample = await import('../player/scenes/sample.js');
  const { NO_PROJECT, SAMPLE_TITLE, SAMPLE_TEXT, SAMPLE_BUTTON, CONFIRM, DOWNLOAD } = sample;
  assert.ok(panel.includes(`<p class="gs-noproject">${NO_PROJECT[0]}<code>${NO_PROJECT[1]}</code>${NO_PROJECT[2]}</p>`), 'no-project note');
  assert.ok(panel.includes(`<h2 class="gs-sample__title">${SAMPLE_TITLE}</h2>`), 'sample card title');
  assert.ok(panel.includes(`<p class="gs-sample__text">${SAMPLE_TEXT}</p>`), 'sample card text');
  assert.ok(panel.includes(`data-action="trySample">${SAMPLE_BUTTON}</button>`), 'sample card button');

  const { SAMPLE_LINK_TEXT } = await import('../player/scenes/helper.js');
  assert.ok(panel.includes(`data-action="trySample">${SAMPLE_LINK_TEXT}</button>`), 'with-project sample link');

  // SAMPLE_CONFIRM_MESSAGE is a concatenation of string literals in GettingStartedPanel.ts.
  const host = readFileSync(join(REPO, 'src', 'providers', 'GettingStartedPanel.ts'), 'utf8');
  const expr = host.match(/SAMPLE_CONFIRM_MESSAGE =\s*((?:"[^"]*"|'[^']*')(?:\s*\+\s*(?:"[^"]*"|'[^']*'))*);/)?.[1];
  assert.ok(expr, 'SAMPLE_CONFIRM_MESSAGE found');
  assert.equal(CONFIRM, new Function(`return ${expr};`)(), 'confirm message');
  assert.ok(host.includes(`SAMPLE_DOWNLOAD_ACTION = '${DOWNLOAD}'`), 'Download action');

  // The sample scene comes last, just before the end card; the end card no longer mentions it.
  const mods = script.scenes.map((s) => s.module);
  assert.deepEqual(mods.slice(-3), ['explore', 'sample', 'endCard'], 'scene order');
  const end = readFileSync(join(HERE, '..', 'player', 'scenes', 'endCard.js'), 'utf8');
  assert.ok(!end.includes(SAMPLE_BUTTON) && !/sample/i.test(end.replace(/^\s*\/\/.*$/gm, '')), 'end card has no sample line');
  const endLines = script.scenes.find((s) => s.module === 'endCard').lines.map((l) => l.caption).join(' ');
  assert.doesNotMatch(endLines, /sample/i);
});

test('the sample scene shows the three real entry points (package.json + gettingStarted.ts)', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const { SIDEBAR, SIDEBAR_LINK, PALETTE_CATEGORY, PALETTE_TITLE, SAMPLE_TITLE, SAMPLE_BUTTON } = await import('../player/scenes/sample.js');

  // 1 · the Welcome panel card (checked verbatim above); the scene draws its title and button.
  const src = readFileSync(join(HERE, '..', 'player', 'scenes', 'sample.js'), 'utf8');
  assert.ok(src.includes('${SAMPLE_TITLE}') && src.includes('${SAMPLE_BUTTON}') && SAMPLE_TITLE && SAMPLE_BUTTON);

  // 2 · the ERD Studio sidebar: the domain tree's welcome view. The scene shows its tail as
  // VS Code renders it: a line that is only a command link is a button, the rest are paragraphs.
  const welcome = pkg.contributes.viewsWelcome.find((v) => v.view === 'erdStudio.domainTree' && v.contents.includes('erdStudio.trySampleProject'));
  assert.ok(welcome, 'domain tree welcome view links trySampleProject');
  const paras = welcome.contents.split('\n\n').map((p) => {
    const m = p.match(/^\[([^\]]+)\]\(command:[^)]+\)$/);
    return m ? [m[1]] : p;
  });
  const tail = paras.slice(paras.length - SIDEBAR.length);
  assert.deepEqual(SIDEBAR, tail, 'sidebar welcome view tail, verbatim');
  assert.ok(welcome.contents.includes(`[${SIDEBAR_LINK}](command:erdStudio.trySampleProject)`), 'sidebar link text');
  assert.deepEqual(SIDEBAR.at(-2), [SIDEBAR_LINK], 'the sample link is the last button');

  // 3 · the Command Palette: "<category>: <title>" of erdStudio.trySampleProject.
  const cmd = pkg.contributes.commands.find((c) => c.command === 'erdStudio.trySampleProject');
  assert.ok(cmd, 'command contributed');
  assert.equal(PALETTE_CATEGORY, cmd.category);
  assert.equal(PALETTE_TITLE, cmd.title);
  assert.ok(src.includes('${PALETTE_CATEGORY}: ${label}') && src.includes('PALETTE_TITLE.slice('), 'palette row renders category: title');
  const pal = script.scenes.find((s) => s.module === 'sample').lines.find((l) => l.beat === 'palette');
  assert.ok(pal.caption.includes(`${cmd.category}: ${cmd.title}`), 'narration names the palette entry');
});
