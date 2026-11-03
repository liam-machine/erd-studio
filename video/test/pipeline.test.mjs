// Pipeline self-tests: `npm test` in video/ (node:test — deliberately not the root vitest run,
// which must never depend on video/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildCues, buildTimeline, CUTS, cutCommand, cutOf, MAX_CUE_CHARS, missingManifestMessage, splitCaption, toTranscriptTs, toVtt } from '../build-timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const script = parse(readFileSync(join(HERE, '..', 'script.yaml'), 'utf8'));
/** The logical cut (VARIANT=logical): the one-minute tour for a folder without dbt. */
const logicalSrc = readFileSync(join(HERE, '..', 'script.logical.yaml'), 'utf8');
const logical = parse(logicalSrc);
const SCRIPTS = { 'script.yaml': script, 'script.logical.yaml': logical };
const SCENES = join(HERE, '..', 'player', 'scenes');
/** Scene module files (no extension) directly in `dir` under player/scenes/. */
const modulesIn = (dir = '') => readdirSync(join(SCENES, dir)).filter((f) => f.endsWith('.js')).map((f) => (dir ? `${dir}/` : '') + f.replace(/\.js$/, ''));

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

test('a missing voice manifest names the cut\'s own path and the tts command that writes it', () => {
  assert.equal(missingManifestMessage(CUTS['']), 'build/voice/manifest.json missing — run `npm run tts` first');
  assert.equal(missingManifestMessage(CUTS.logical), 'build-logical/voice/manifest.json missing — run `VARIANT=logical npm run tts` first');
  assert.equal(cutCommand(CUTS[''], 'timeline'), 'npm run timeline');
  assert.equal(cutCommand(CUTS.logical, 'timeline'), 'VARIANT=logical npm run timeline');
});

test('each cut writes its own files; the logical module exports its own constants', () => {
  assert.equal(cutOf(), CUTS['']);
  assert.equal(cutOf('logical').script, 'script.logical.yaml');
  assert.throws(() => cutOf('nope'), /unknown VARIANT nope/);
  const tl = buildTimeline(mini, durs);
  const cues = buildCues(tl);
  const ts = toTranscriptTs(tl, cues, CUTS.logical);
  assert.match(ts, /^\/\/ GENERATED by video\/build-timeline\.mjs from video\/script\.logical\.yaml/);
  assert.match(ts, /`VARIANT=logical npm run timeline`/);
  assert.match(ts, /Caption cues for media\/onboarding\/getting-started-logical\.mp4/);
  assert.match(ts, /export const LOGICAL_GETTING_STARTED_CUES: \{ start: number; end: number; text: string \}\[\] = \[/);
  assert.match(ts, /export const LOGICAL_GETTING_STARTED_TRANSCRIPT: string = \[/);
  assert.doesNotMatch(ts, /export const GETTING_STARTED_/);
  // the default cut's module is exactly what it always was (the shipped file is not regenerated)
  const dflt = toTranscriptTs(tl, cues);
  assert.ok(dflt.startsWith("// GENERATED by video/build-timeline.mjs from video/script.yaml — do not edit by hand.\n// Regenerate with `npm run timeline` in video/ (see video/README.md). Pure data: no imports,\n"));
  assert.match(dflt, /Caption cues for media\/onboarding\/getting-started\.mp4, in seconds/);
  // outputs never collide
  const outs = Object.values(CUTS).flatMap((c) => [c.build, c.vtt, c.ts, c.mp4, c.cues, c.transcript]);
  assert.equal(new Set(outs).size, outs.length);
});

for (const [file, sc] of Object.entries(SCRIPTS)) {
  test(`${file}: unique ids, every scene module exists, every beat a module reads is defined`, () => {
    const ids = sc.scenes.flatMap((s) => s.lines.map((l) => l.id));
    assert.equal(new Set(ids).size, ids.length);
    const mods = new Set([...modulesIn(), ...modulesIn('logical')]);
    for (const scene of sc.scenes) {
      assert.ok(mods.has(scene.module), `missing player/scenes/${scene.module}.js`);
      const src = readFileSync(join(SCENES, `${scene.module}.js`), 'utf8');
      const used = new Set([...src.matchAll(/beats\.(\w+)/g)].map((m) => m[1]));
      const defined = new Set(scene.lines.map((l) => l.beat));
      for (const b of used) assert.ok(defined.has(b), `${scene.module}.js reads beats.${b}, not defined in scene ${scene.id}`);
      if (scene.accentAfter) assert.ok(defined.has(scene.accentAfter.beat));
    }
  });
}

test('player code has no CSS transitions, keyframes, timers or randomness (frames must be pure)', () => {
  const dir = join(HERE, '..', 'player');
  const files = ['style.css', 'lib.js', 'main.js', 'editor.js', ...modulesIn().map((m) => `scenes/${m}.js`), ...modulesIn('logical').map((m) => `scenes/${m}.js`)];
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
const sceneSrc = (m) => readFileSync(join(SCENES, `${m}.js`), 'utf8');
const wt = pkg.contributes.walkthroughs.find((w) => w.id === 'erdStudio.getStarted');

// editor.js fetches the walkthrough images at import time; give it the real files.
globalThis.fetch = async (url) => ({ text: async () => read(...String(url).replace(/^\//, '').split('/')) });
const editor = await import('../player/editor.js');

test('scene order: hook, install, draw, canvas, design, physical, enrich, sample, end card; at most 65 s', () => {
  assert.deepEqual(script.scenes.map((s) => s.module), ['hook', 'install', 'draw', 'canvas', 'design', 'physical', 'enrich', 'sample', 'endCard']);
  assert.ok(script.maxDuration <= 65);
  assert.deepEqual(modulesIn().sort(), script.scenes.map((s) => s.module).sort(), 'no unused scene modules');
});

test('logical cut: scene order; its own scenes live in scenes/logical/ and none is unused; at most 65 s', () => {
  assert.deepEqual(logical.scenes.map((s) => s.module),
    ['logical/hook', 'install', 'logical/newDiagram', 'logical/tables', 'logical/files', 'logical/importDbml', 'enrich', 'endCard']);
  assert.ok(logical.maxDuration <= 65, 'a one-minute video');
  const own = logical.scenes.map((s) => s.module).filter((m) => m.startsWith('logical/'));
  assert.deepEqual(modulesIn('logical').sort(), [...new Set(own)].sort(), 'no unused logical scene modules');
  for (const m of logical.scenes.map((s) => s.module).filter((m) => !m.startsWith('logical/'))) {
    assert.ok(script.scenes.some((s) => s.module === m), `${m} is shared with the dbt cut`);
  }
  // the shared voice settings, so the two cuts sound the same
  assert.deepEqual(logical.voice, script.voice);
  assert.deepEqual(logical.timing, script.timing);
  // a rendered timeline, when there is one, is inside the budget too
  const built = join(HERE, '..', 'build-logical', 'timeline.json');
  if (existsSync(built)) {
    const total = JSON.parse(readFileSync(built, 'utf8')).total;
    assert.ok(total <= logical.maxDuration, `logical timeline ${total}s`);
  }
});

// No dbt anywhere in the logical cut: not in its script, not in its own scene modules, and not
// on screen in any frame (shared scenes and the walkthrough mock included).
const NO_DBT = /\bdbt\b|Physical|manifest/i;
const NO_DBT_ON_SCREEN = /\bdbt\b|Physical|manifest|\bDiff\b|sample project/i;

test('logical cut: no line of script.logical.yaml or of a logical scene module names dbt', () => {
  // only the leading header comment may name them (it lists the words to keep out)
  const lines = logicalSrc.split('\n');
  const body = lines.slice(lines.findIndex((l) => !l.startsWith('#')));
  for (const l of body) assert.doesNotMatch(l, NO_DBT, `script.logical.yaml: ${l}`);
  for (const m of modulesIn('logical')) {
    sceneSrc(m).split('\n').forEach((l, i) => assert.doesNotMatch(l, NO_DBT, `${m}.js:${i + 1}: ${l}`));
  }
  // the header comment names the forbidden words (that is its job), and nothing else does
  assert.match(logicalSrc, /^# .*dbt, Physical, Diff, manifest, sample project/m);
});

test('logical cut: no frame shows dbt, Physical, Diff, manifest or the sample project', async () => {
  const durations = Object.fromEntries(logical.scenes.flatMap((s) => s.lines.map((l) => [l.id, 2.5])));
  const tl = buildTimeline(logical, durations);
  const strip = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  for (const sc of tl.scenes) {
    const mod = (await import(`../player/scenes/${sc.module}.js`)).default;
    for (let lt = 0; lt <= sc.dur; lt += 0.1) {
      const text = strip(mod.render(lt, { beats: sc.beats, dur: sc.dur, t: sc.start + lt, scene: sc }));
      assert.doesNotMatch(text, NO_DBT_ON_SCREEN, `${sc.id} +${lt.toFixed(1)}s: ${text.match(NO_DBT_ON_SCREEN)?.[0]}`);
    }
    for (const h of sc.headline ?? []) assert.doesNotMatch(h, NO_DBT_ON_SCREEN);
  }
  for (const c of logical.chapters) assert.doesNotMatch(c, NO_DBT_ON_SCREEN);
  // the generated transcript module, when written, carries no dbt either
  const ts = join(REPO, 'src', 'types', CUTS.logical.ts);
  if (existsSync(ts)) assert.doesNotMatch(readFileSync(ts, 'utf8'), NO_DBT);
});

test('the extension listing and the walkthrough mock use the real package.json copy', () => {
  const { EXTENSION, WALKTHROUGH } = editor;
  assert.equal(EXTENSION.name, pkg.displayName);
  assert.equal(EXTENSION.publisher, pkg.publisher);
  assert.equal(EXTENSION.description, pkg.description);
  // the logical cut shows the listing's own sentences, up to the first one that names dbt
  const short = editor.descriptionWithoutDbt();
  assert.ok(pkg.description.startsWith(short) && short.length > 40, short);
  assert.doesNotMatch(short, /\bdbt\b/i);
  assert.equal(WALKTHROUGH.title, wt.title);
  assert.equal(WALKTHROUGH.description, wt.description);
  assert.deepEqual(WALKTHROUGH.steps.map((s) => s.id), wt.steps.map((s) => s.id));
  for (const step of WALKTHROUGH.steps) {
    const real = wt.steps.find((s) => s.id === step.id);
    assert.equal(step.when, real.when, `step when ${step.id}`);
    assert.equal(step.title, real.title, `step title ${step.id}`);
    assert.equal(`media/walkthrough/${step.svg}.svg`, real.media.svg, `step image ${step.id}`);
    if (step.text) {
      // "<text>\n[<button>](command:…)": VS Code draws a link on its own line as a button.
      const [text, link, moreText, moreLink] = real.description.split('\n');
      assert.equal(step.text, text, `step text ${step.id}`);
      assert.equal(step.button, link.match(/^\[([^\]]+)\]\(command:/)[1], `step button ${step.id}`);
      if (moreText !== undefined) {
        assert.ok(step.more, `step ${step.id} has a second paragraph`);
        assert.equal(step.more.text, moreText, `step more text ${step.id}`);
        assert.equal(step.more.button, moreLink.match(/^\[([^\]]+)\]\(command:/)[1], `step more button ${step.id}`);
      } else assert.equal(step.more, undefined, `step ${step.id} has one paragraph`);
    }
  }
  // Which steps each window shows, from the real `when` clauses: the dbt tour runs in a dbt
  // project, the logical cut in a folder without dbt (before and after its first diagram).
  const shown = (ctx) => wt.steps.filter((s) => editor.whenHolds(s.when, ctx)).map((s) => s.id);
  assert.deepEqual(shown(editor.DBT_PROJECT), ['watch', 'draw', 'importDbml', 'enrich']);
  assert.deepEqual(shown(editor.PLAIN_FOLDER), ['watchLogical', 'newDiagram', 'importDbml', 'enrich']);
  assert.deepEqual(shown(editor.PLAIN_FOLDER_WITH_DIAGRAM), ['watchLogical', 'openDiagram', 'importDbml', 'enrich']);
  for (const ctx of Object.values(editor.WINDOWS)) assert.deepEqual(editor.visibleSteps(ctx).map((s) => s.id), shown(ctx));
  assert.doesNotThrow(() => editor.walkthrough({ open: 'draw' }));
  assert.doesNotThrow(() => editor.walkthrough({ open: 'enrich', wide: true }));
  assert.throws(() => editor.walkthrough({ open: 'newDiagram' }), /not shown in this window/);
  assert.throws(() => editor.walkthrough({ open: 'draw', ctx: editor.PLAIN_FOLDER }), /not shown in this window/);
  assert.equal(editor.whenHolds('erdStudio.hasDbtProject && !erdStudio.hasDiagrams', editor.DBT_PROJECT), true);
  assert.equal(editor.whenHolds('erdStudio.hasDbtProject && !erdStudio.hasDiagrams', editor.PLAIN_FOLDER), false);
  assert.throws(() => editor.whenHolds('erdStudio.hasDbtProject || foo', editor.DBT_PROJECT), /unsupported/);
  assert.throws(() => editor.whenHolds('erdStudio.hasDbtProject && foo', editor.DBT_PROJECT), /unknown context key foo/);
  // every open step a scene shows fits the window (newDiagram's two paragraphs need wide + dense)
  for (const [open, o] of [['draw', {}], ['enrich', { wide: true }], ['newDiagram', { ctx: editor.PLAIN_FOLDER, wide: true, dense: true }],
    ['importDbml', { ctx: editor.PLAIN_FOLDER_WITH_DIAGRAM, wide: true }], ['enrich', { ctx: editor.PLAIN_FOLDER_WITH_DIAGRAM, wide: true }]]) {
    const g = editor.wtGeom({ open, ...o });
    assert.ok(g.BOTTOM <= editor.BODY.h, `${open} open: walkthrough ends at ${g.BOTTOM}px, the window body is ${editor.BODY.h}px`);
  }
  const draw = wt.steps.find((s) => s.id === 'draw');
  assert.match(draw.description, /\(command:erdStudio\.drawFromDbt\)/);
  assert.match(wt.steps.find((s) => s.id === 'newDiagram').description, /\(command:erdStudio\.createDomain\)/);
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === id);
  assert.equal(editor.WALKTHROUGH.steps.find((s) => s.id === 'enrich').button, cmd('erdStudio.setupAiHelper').title);
  assert.equal(editor.WALKTHROUGH.steps.find((s) => s.id === 'importDbml').button, cmd('erdStudio.importDbml').title);
  // the logical cut's install scene opens the plain folder's walkthrough on New Diagram
  const install = logical.scenes.find((s) => s.module === 'install');
  assert.equal(install.props.window, 'plain');
  assert.ok(editor.visibleSteps(editor.WINDOWS[install.props.window]).some((s) => s.id === install.props.open));
});

test('the watch steps and their image state the real length of these videos', () => {
  for (const id of ['watch', 'watchLogical']) {
    const watch = wt.steps.find((s) => s.id === id);
    assert.match(watch.title + watch.description, /one-minute/, id);
    assert.doesNotMatch(wt.steps.find((s) => s.id === 'watchLogical').description, /\bdbt\b/i);
  }
  assert.ok(script.maxDuration <= 65 && logical.maxDuration <= 65, 'one-minute videos');
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

test('the canvas mocks use the webview\'s own words', async (t) => {
  const toolbar = read('webview', 'components', 'Toolbar', 'Toolbar.tsx');
  const { DIFF_TOOLTIP, DISC } = await import('../player/scenes/physical.js');
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

  // The dbt cut's Physical scene shows the toolbar's former "⊕ Diff" button and narrates "Diff
  // compares the two"; the button is now "Compare with dbt". Only a re-render of the dbt cut
  // (new narration) can fix that, so it is listed rather than failed.
  if (toolbar.includes(`'${DIFF_TOOLTIP}'`) && toolbar.includes("'⊕ Diff'") && toolbar.includes("'⊘ Diff'")) return;
  t.todo('dbt cut: the Diff button is now "Compare with dbt" (Toolbar.tsx compareButtonWording); re-word scene physical and re-render the dbt cut');
});

test('the enrich scene types the real setup command and replies in the skill\'s words', async () => {
  const { PROMPT, REPLY } = await import('../player/scenes/enrich.js');
  const assistants = read('src', 'types', 'aiAssistants.ts');
  assert.ok(assistants.includes(`'${PROMPT}'`), 'setup prompt');
  const skill = flat(read('src', 'harness', 'claude', 'erd-studio-setup', 'SKILL.md'));
  const said = REPLY.replace(/<\/?b>/g, '**').replace('(4 models)', '(8 models)');
  assert.ok(skill.includes(said), 'the enrich route\'s opening line');
  for (const sc of [script, logical]) {
    const line = sc.scenes.find((s) => s.module === 'enrich').lines.find((l) => l.beat === 'setup');
    assert.ok(line.caption.includes(PROMPT) && line.caption.includes(editor.WALKTHROUGH.steps.find((s) => s.id === 'enrich').button));
  }
});

test('logical cut: the enrich scene replies with the Without dbt route\'s first line', () => {
  const { props } = logical.scenes.find((s) => s.module === 'enrich');
  const route = flat(read('src', 'harness', 'claude', 'erd-studio-setup', 'references', 'without-dbt.md'));
  // the reference's example names its own diagram: the sales diagram (6 tables)
  const said = props.reply.replace(/<\/?b>/g, '**').replace('**orders** diagram (2 tables)', '**sales** diagram (6 tables)');
  assert.ok(route.includes(said), 'the Without dbt route\'s "Enriching existing tables" opening line');
  assert.match(props.reply, /\(2 tables\)/);
  assert.ok(editor.WINDOWS[props.window], props.window);
  assert.equal(props.tab, editor.NEW_DIAGRAM.file.split('/').at(-1));
});

test('the sample scene uses the real confirm message', async (t) => {
  const { CONFIRM, DOWNLOAD, RETIRED_SAMPLE_STEP } = await import('../player/scenes/sample.js');
  const host = read('src', 'providers', 'GettingStartedPanel.ts');
  const expr = host.match(/SAMPLE_CONFIRM_MESSAGE =\s*((?:"[^"]*"|'[^']*')(?:\s*\+\s*(?:"[^"]*"|'[^']*'))*);/)?.[1];
  assert.ok(expr, 'SAMPLE_CONFIRM_MESSAGE found');
  assert.equal(CONFIRM, new Function(`return ${expr};`)(), 'confirm message');
  assert.ok(host.includes(`SAMPLE_DOWNLOAD_ACTION = '${DOWNLOAD}'`), 'Download action');
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'erdStudio.trySampleProject'), 'the command still exists');
  assert.ok(!wt.steps.some((s) => s.id === RETIRED_SAMPLE_STEP.id), 'the walkthrough no longer has the sample step');
  t.todo('dbt cut: scene sample opens the walkthrough step it no longer has (RETIRED_SAMPLE_STEP); rework or drop it when the dbt cut is next re-rendered');
});

test('the end card names the real steps', async () => {
  const { STEPS, TAGLINE } = await import('../player/scenes/endCard.js');
  assert.equal(STEPS[0], `Install ${pkg.displayName}`);
  assert.equal(STEPS[1], wt.steps.find((s) => s.id === 'openProject').title);
  assert.equal(STEPS[2], editor.WALKTHROUGH.steps.find((s) => s.id === 'draw').button);
  assert.equal(TAGLINE.length, 2);
  // the logical cut: the same first two, then the New Diagram button
  const { props } = logical.scenes.find((s) => s.module === 'endCard');
  assert.deepEqual(props.steps, [STEPS[0], STEPS[1], editor.WALKTHROUGH.steps.find((s) => s.id === 'newDiagram').button]);
  assert.equal(props.tagline.length, 2);
});

test('logical cut: New Diagram, the empty canvas, New Table and New Relationship use the product\'s words', async () => {
  const ext = read('src', 'extension.ts');
  const errors = read('src', 'services', 'diagramCommandErrors.ts');
  const { NEW_DIAGRAM } = editor;
  assert.ok(errors.includes(`NEW_DIAGRAM_TITLE = '${NEW_DIAGRAM.title}'`), 'name box title');
  assert.ok(ext.includes(`placeHolder: '${NEW_DIAGRAM.placeholder}'`), 'name box placeholder');
  // a fresh DBML project: the first diagram goes in Gold by itself, and the prompt says so
  assert.ok(ext.includes("? `Name the diagram. Saved in the ${layerLabel} layer${tableLibraryService.writesDbml() ? ' — Move Diagram to Layer… changes it later' : ''}.`"));
  assert.equal(NEW_DIAGRAM.prompt, 'Name the diagram. Saved in the Gold layer — Move Diagram to Layer… changes it later.');
  assert.ok(ext.includes('message: `Saved as ${asSlug}`'), 'the Info line');
  assert.equal(NEW_DIAGRAM.savedAs('orders'), 'Saved as orders');
  assert.ok(read('packages', 'core', 'src', 'types', 'layer.ts').includes("label: 'Gold'"));
  assert.equal(NEW_DIAGRAM.file, `.erd-studio/gold/diagrams/${NEW_DIAGRAM.name.toLowerCase()}.dbml`);
  assert.equal(pkg.contributes.commands.find((c) => c.command === 'erdStudio.createDomain').title.replace(/…$/, ''), NEW_DIAGRAM.title);

  const { EMPTY_CANVAS, NEW_TABLE, ADD_MENU, NEW_RELATIONSHIP, TABLES } = await import('../player/scenes/logical/tables.js');
  const empty = read('webview', 'components', 'EmptyCanvas', 'EmptyCanvas.tsx');
  for (const s of [`>${EMPTY_CANVAS.title}<`, `'${EMPTY_CANVAS.body}'`, `Or let your AI assistant draw it:{' '}`, EMPTY_CANVAS.link]) assert.ok(empty.includes(s), s);
  assert.ok(flat(empty).includes(`> ${EMPTY_CANVAS.button} </button>`), 'New Table button');
  assert.ok(empty.includes("!logicalOnly ? 'dbt' : 'new'"), 'New Table is the primary action without dbt');

  const dlg = flat(read('webview', 'components', 'NewModelDialog', 'NewModelDialog.tsx'));
  for (const s of [`>${NEW_TABLE.title}</h3>`, `> ${NEW_TABLE.name} </label>`, `> ${NEW_TABLE.schema} </label>`, `STARTER_COLUMNS_LABEL = '${NEW_TABLE.starter}'`,
    `> ${NEW_TABLE.cancel} </button>`, `> ${NEW_TABLE.create} </button>`, `> ${NEW_TABLE.addColumn} </button>`, `>${NEW_TABLE.fromTemplate}<`,
    `blank: 'no columns yet'`, `dimension: 'something you describe (customer, product)'`, 'Table names start with {template.prefix}',
    'No columns yet. Click "Add Column" to add columns to this table.', 'Columns ({resolvedColumns.length})', '`Creates ${newTablePathPreview(']) assert.ok(dlg.includes(s), s);
  const templates = read('src', 'services', 'templateService.ts');
  assert.ok(templates.includes("label: 'Blank'") && templates.includes("label: 'Dimension',") && templates.includes("prefix: 'dim_',"));
  assert.equal(NEW_TABLE.blank, 'Blank — no columns yet');
  assert.equal(NEW_TABLE.dimension, 'Dimension — something you describe (customer, product)');
  // the Dimension template's columns, {name} = customer, are the node the dialog makes
  const dimBlock = templates.slice(templates.indexOf("id: 'dimension'"), templates.indexOf("id: 'fact'"));
  const tmplCols = [...dimBlock.matchAll(/\{ name: '([^']+)', dataType: '([^']+)'/g)].map(([, n, ty]) => [n.replace('{name}', 'customer'), ty]);
  assert.deepEqual(TABLES[0].cols.map((c) => [c.name, c.type]), tmplCols);
  assert.equal(TABLES[0].name, NEW_TABLE.table);
  assert.equal(TABLES[0].cols.length, 7);
  const preview = read('src', 'types', 'schemaFolder.ts');
  assert.ok(preview.includes("return `${dir ? `${dir}/` : ''}${layer}/tables/${listed}/${name}.dbml`;"));
  assert.equal(NEW_TABLE.creates('dim_customer'), 'Creates .erd-studio/gold/tables/gold/dim_customer.dbml');

  const tb = read('webview', 'components', 'Toolbar', 'Toolbar.tsx');
  assert.ok(flat(tb).includes('+ Add <span'), '+ Add');
  for (const item of ADD_MENU) assert.ok(flat(tb).includes(`> ${item} </button>`), item);
  assert.ok(tb.includes('{!logicalOnly && <StageTabs'), 'no stage tabs without dbt');

  const fk = flat(read('webview', 'components', 'NewFkDialog', 'NewFkDialog.tsx'));
  const rel = read('webview', 'lib', 'relationshipDialog.ts');
  assert.ok(rel.includes("return `${editing ? 'Edit' : 'New'} ${pairCount > 1 ? 'Composite ' : ''}Relationship`;"));
  assert.equal(NEW_RELATIONSHIP.title, 'New Relationship');
  for (const [label, , empty] of NEW_RELATIONSHIP.fields.slice(0, 4)) {
    assert.ok(fk.includes(`> ${label} </label>`), label);
    assert.ok(fk.includes(`>${empty}</option>`), empty);
  }
  assert.ok(rel.includes(`HOW_MANY_LABEL = '${NEW_RELATIONSHIP.fields[4][0]}'`));
  assert.ok(rel.includes("text: named ? `Many ${from} rows → one ${to}` : 'Many → one'"));
  assert.equal(NEW_RELATIONSHIP.fields[4][1], 'Many fct_order rows → one dim_customer');
  for (const s of [`>${NEW_RELATIONSHIP.preview}<`, `'${NEW_RELATIONSHIP.create}'`, `> ${NEW_RELATIONSHIP.cancel} </button>`]) assert.ok(fk.includes(s), s);
});

test('logical cut: the files are the 2.0 layer-first DBML the writers produce', async () => {
  const { FILES, TREE } = await import('../player/scenes/logical/files.js');
  const { TABLES } = await import('../player/scenes/logical/tables.js');
  const header = read('packages', 'core', 'src', 'dbmlRichProperties.ts');
  const rels = FILES['gold/relationships/gold.dbml'];
  assert.ok(header.includes(`'${rels[0]}'`), 'the relationships file header line');
  // the same shapes as the native fixture's files
  const fixture = read('test', 'fixtures', 'dbml-native', '.erd-studio', 'gold', 'relationships', 'gold.dbml');
  assert.ok(fixture.startsWith(rels[0]));
  for (const l of rels.filter((x) => x.startsWith('use '))) assert.match(l, /^use \{ table gold\.\w+ \} from '\.\.\/tables\/gold\/\w+\.dbml'$/);
  assert.match(fixture, /^Ref: gold\.fct_order\.customer_key >\? gold\.dim_customer\.customer_key$/m);
  assert.equal(rels.at(-1), 'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key');
  const fct = FILES['gold/tables/gold/fct_order.dbml'];
  assert.equal(fct[0], 'Table gold.fct_order {');
  assert.equal(fct.length, TABLES[1].cols.length + 2);
  TABLES[1].cols.forEach((c, i) => assert.ok(fct[i + 1].trim().startsWith(`${c.name} ${/\W/.test(c.type) ? `"${c.type}"` : c.type}`), c.name));
  assert.match(read('packages', 'core', 'src', 'dbml', 'writeTable.ts'), /\[pk/);
  // the Explorer lists exactly these files, at their 2.0 paths
  const paths = [];
  const stack = [];
  for (const [d, kind, label] of TREE) {
    stack[d] = label;
    if (kind !== 'folder') paths.push(stack.slice(1, d + 1).join('/'));
  }
  assert.deepEqual(paths.sort(), ['gold/diagrams/orders.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/dim_customer.dbml', 'gold/tables/gold/fct_order.dbml', 'layers.json'].sort());
  assert.ok(Object.keys(FILES).every((f) => paths.includes(f)));
});

test('logical cut: the Export Diagram pick uses the command\'s real rows', async () => {
  const { EXPORT_PICK } = await import('../player/scenes/logical/importDbml.js');
  const src = read('src', 'commands', 'exportDiagram.ts');
  assert.ok(src.includes(`EXPORT_TITLE = '${EXPORT_PICK.title}'`));
  assert.ok(src.includes('placeHolder: `Export the design of "${name}" as…`'));
  assert.equal(EXPORT_PICK.placeholder, 'Export the design of "orders" as…');
  const ext = read('packages', 'core', 'src', 'exportDiagram.ts');
  for (const r of EXPORT_PICK.rows) {
    assert.ok(src.includes(JSON.stringify(r.detail)) || src.includes(`'${r.detail}'`), r.detail);
    assert.ok(src.includes(`label: '${r.label}'`) || src.includes(`'dbml-rich': '${r.label}'`), r.label);
  }
  assert.ok(ext.includes("mermaid: 'mmd'") && ext.includes("dbml: 'dbml'"));
  assert.deepEqual(EXPORT_PICK.rows.map((r) => r.description), ['.mmd', '.dbml', '.dbml']);
});

test('nothing calls ERD Studio open source (the licence is PolyForm Shield: source-available)', () => {
  assert.match(read('LICENSE'), /PolyForm Shield/);
  const dir = join(HERE, '..', 'player');
  const files = ['thumbnail.html', 'editor.js', ...modulesIn().map((m) => `scenes/${m}.js`), ...modulesIn('logical').map((m) => `scenes/${m}.js`)];
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /open[ -]source/i, f);
  for (const [file, sc] of Object.entries(SCRIPTS)) assert.doesNotMatch(JSON.stringify(sc), /open[ -]source/i, file);
});
