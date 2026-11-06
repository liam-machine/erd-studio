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
/** The logical cut (VARIANT=logical): the same tour for a folder without dbt, no dbt beat. */
const logicalSrc = readFileSync(join(HERE, '..', 'script.logical.yaml'), 'utf8');
const logical = parse(logicalSrc);
const SCRIPTS = { 'script.yaml': script, 'script.logical.yaml': logical };
const scriptSrc = readFileSync(join(HERE, '..', 'script.yaml'), 'utf8');
const SCENES = join(HERE, '..', 'player', 'scenes');
/** Scene module files (no extension) directly in `dir` under player/scenes/. */
const modulesIn = (dir = '') => readdirSync(join(SCENES, dir)).filter((f) => f.endsWith('.js')).map((f) => (dir ? `${dir}/` : '') + f.replace(/\.js$/, ''));
/** rec/: the frame both cuts' recorded footage plays in. tour/: their HTML scenes (Confluence, the end card; no dbt anywhere). */
const ALL_MODULES = [...modulesIn('tour'), ...modulesIn('rec')];

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
  // the default cut's module keeps its own header and names
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
    const mods = new Set(ALL_MODULES);
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
  const files = ['style.css', 'lib.js', 'main.js', 'editor.js', 'hero.js', ...ALL_MODULES.map((m) => `scenes/${m}.js`)];
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hit = code.match(/@keyframes|transition\s*:|Math\.random|setTimeout|setInterval|Date\.now/);
    assert.equal(hit, null, `${f}: ${hit?.[0]}`);
  }
});

// The video shows the product's own words. When a start surface, a command, the canvas or the
// setup skill is reworded, these fail so the mock is updated (and re-rendered) with it.
const REPO = join(HERE, '..', '..');
const flat = (s) => s.replace(/\s+/g, ' ');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const sceneSrc = (m) => readFileSync(join(SCENES, `${m}.js`), 'utf8');
const wt = pkg.contributes.walkthroughs.find((w) => w.id === 'erdStudio.getStarted');
const cmdTitle = (id) => pkg.contributes.commands.find((c) => c.command === id)?.title;
const tsConst = (file, name) => read(...file.split('/')).match(new RegExp(`export const ${name}(?:: [^=]+)? = '([^']+)'`))?.[1];
const START_LABELS = Object.fromEntries([...read('src', 'types', 'startActions.ts').match(/START_ACTION_LABELS[^{]+\{([^}]+)\}/)[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));

// editor.js reads the listing's description from package.json at runtime (main.js sets it).
globalThis.PACKAGE_DESCRIPTION = pkg.description;
const editor = await import('../player/editor.js');
const lib = await import('../player/lib.js');
/** The layers a new folder without dbt starts with (src/services/layerService.ts NEW_PROJECT_LAYERS_WITHOUT_DBT): one, Main. */
const NEW_LAYER = (() => {
  const src = read('src', 'services', 'layerService.ts');
  const block = src.slice(src.indexOf('NEW_PROJECT_LAYERS_WITHOUT_DBT: readonly LayerConfig[] = ['), src.indexOf('];', src.indexOf('NEW_PROJECT_LAYERS_WITHOUT_DBT')));
  const ids = [...block.matchAll(/id: '([^']+)', label: '([^']+)'/g)];
  return { id: ids[0][1], label: ids[0][2], count: ids.length };
})();

/** The name box every import ends on in a new folder without dbt: one layer, Main. */
const IMPORT_NAME_PROMPT = `Name the diagram. It is saved in the ${NEW_LAYER.label} layer.`;

test('both cuts lead with importing what you have, then by hand, with AI and Confluence; only the default cut has a dbt beat', () => {
  // the default cut: the hook, the import (picker, the SQL a project holds, its draft), its files, an
  // edit by hand, the same kind of edit by Claude Code, dbt, Confluence, the end card
  // edit by Claude Code, what it changed (held), that change and its code in one pull request, dbt, Confluence, the end card
  assert.deepEqual(script.scenes.map((s) => s.id), ['hook', 'bring', 'importSql', 'draft', 'files', 'byHand', 'aiSetup', 'aiRun', 'aiShow', 'pr', 'dbt', 'confluence', 'end']);
  assert.deepEqual(script.scenes.map((s) => s.module), [...Array(8).fill('rec/window'), 'tour/aiChange', 'tour/pullRequest', 'rec/window', 'tour/confluence', 'tour/endCard']);
  const at = (id) => script.scenes.findIndex((s) => s.id === id);
  assert.ok(at('importSql') < at('byHand') && at('draft') < at('byHand'), 'the import comes before any table built by hand');
  // the logical cut: the same scenes, minus the dbt beat
  assert.deepEqual(logical.scenes.map((s) => s.id), script.scenes.map((s) => s.id).filter((id) => id !== 'dbt'));
  assert.deepEqual(logical.scenes.map((s) => s.module), [...Array(8).fill('rec/window'), 'tour/aiChange', 'tour/pullRequest', 'tour/confluence', 'tour/endCard']);
  // the AI change is held right after it, then the pull request
  for (const sc of [script, logical]) {
    const ids = sc.scenes.map((s) => s.id);
    assert.equal(ids.indexOf('aiShow'), ids.indexOf('aiRun') + 1);
    assert.equal(ids.indexOf('pr'), ids.indexOf('aiShow') + 1);
  }
  assert.deepEqual(logical.voice, script.voice);
  assert.deepEqual(logical.timing, script.timing);
  // no unused modules (the old HTML tour is retired: both cuts are recordings), nothing at the top of scenes/
  assert.deepEqual(modulesIn(), []);
  assert.deepEqual(modulesIn('tour').sort(), ['tour/aiChange', 'tour/confluence', 'tour/endCard', 'tour/pullRequest']);
  assert.deepEqual(modulesIn('rec'), ['rec/window']);
  assert.equal(existsSync(join(SCENES, 'dbt')) && readdirSync(join(SCENES, 'dbt')).length > 0, false, 'the HTML dbt beat is gone: the default cut films the real one');
  // "Watch the Tour" names no length: the default cut may run 80–140 s (maxDuration), the dbt beat
  // 12–24 s; the scenes' minimum lengths alone already fit, so a script edit fails here without a build
  assert.ok(script.maxDuration <= 140);
  const floor = script.scenes.reduce((n, s) => n + s.minDur, 0);
  assert.ok(floor <= script.maxDuration, `the minDurs add up to ${floor}s`);
  assert.ok(logical.maxDuration <= 140);
  const floorL = logical.scenes.reduce((n, s) => n + s.minDur, 0);
  assert.ok(floorL <= logical.maxDuration, `the logical minDurs add up to ${floorL}s`);
  const builtL = join(HERE, '..', 'build-logical', 'timeline.json');
  if (existsSync(builtL)) {
    const tl = JSON.parse(readFileSync(builtL, 'utf8'));
    assert.ok(tl.total >= 80 && tl.total <= 140, `build-logical: ${tl.total}s`);
    const draft = tl.scenes.find((s) => s.id === 'draft');
    assert.ok(draft.start + draft.beats.keep.t < 40, `logical: Keep as Diagram at ${draft.start + draft.beats.keep.t}s`);
  }
  const built = join(HERE, '..', 'build', 'timeline.json');
  if (existsSync(built)) {
    const tl = JSON.parse(readFileSync(built, 'utf8'));
    assert.ok(tl.total >= 80 && tl.total <= 140, `build: ${tl.total}s`);
    const beat = tl.scenes.find(isDbtBeat);
    // Import from dbt, Run dbt parse, the Physical tab held, Compare with dbt: short beside the tour, but each one seen
    assert.ok(beat.dur >= 12 && beat.dur <= 24, `dbt beat ${beat.dur}s`);
    // the import's draft is kept within the first 40 s
    const draft = tl.scenes.find((s) => s.id === 'draft');
    assert.ok(draft.start + draft.beats.keep.t < 40, `Keep as Diagram at ${draft.start + draft.beats.keep.t}s`);
  }
});

test('never "No AI needed": the default cut, the end card and the thumbnail say by hand or with AI', async () => {
  const NO_AI = /no AI needed|nothing to configure|without AI/i;
  for (const sc of [script, logical]) assert.doesNotMatch(JSON.stringify(sc.scenes), NO_AI);
  const { LINE, FREE } = await import('../player/scenes/tour/endCard.js');
  assert.doesNotMatch(`${LINE} ${FREE}`, NO_AI);
  assert.doesNotMatch(readFileSync(join(HERE, '..', 'player', 'thumbnail.html'), 'utf8'), NO_AI);
  // the hook says both ways, and that the assistant's skill is built in
  const hook = script.scenes[0].lines.map((l) => l.caption).join(' ');
  assert.match(hook, /by hand/);
  assert.match(hook, /AI assistant/);
  assert.match(hook, /skill/);
  assert.match(JSON.stringify(script.scenes[0].props.claims), /By hand or with AI/);
  // the Confluence scene names the app, GitHub, the single source of truth and business users
  const share = script.scenes.find((s) => s.id === 'confluence').lines.map((l) => l.caption).join(' ');
  for (const w of ['ERD Studio for Confluence', 'GitHub', 'single source of truth', 'business users']) assert.ok(share.includes(w), w);
  assert.doesNotMatch(share, /\bfree\b|price|\$/i, 'never says the Confluence app is free, nor its price');
  // the end line: free to use, in VS Code
  for (const sc of [script, logical]) assert.match(sc.scenes.at(-1).lines[0].caption, /free to use in VS Code/);
  // the logical cut says the same: its hook, its Confluence scene (script.yaml's own lines)
  assert.deepEqual(logical.scenes[0].lines, script.scenes[0].lines);
  assert.deepEqual(logical.scenes.find((s) => s.id === 'confluence').lines, script.scenes.find((s) => s.id === 'confluence').lines);
});

// dbt is an add-on: no dbt in the logical cut at all, and in the default cut only in its dbt beat.
const NO_DBT = /\bdbt\b|Physical|manifest/i;
const NO_DBT_ON_SCREEN = /\bdbt\b|Physical|manifest|\bDiff\b|sample project/i;
/** The default cut's dbt beat: its own take, in a dbt project, the one scene that may name dbt. */
const isDbtBeat = (sc) => sc.id === 'dbt';
/** The import scene names dbt among the tools a data model already lives in (its narration and logo row). */
const namesDbt = (sc) => isDbtBeat(sc) || sc.id === 'bring';

test('no line of script.logical.yaml or of a tour scene module names dbt; script.yaml only in its dbt beat and the import\'s list of tools', () => {
  // only the leading header comment may name them (it lists the words to keep out)
  const lines = logicalSrc.split('\n');
  const body = lines.slice(lines.findIndex((l) => !l.startsWith('#')));
  for (const l of body) assert.doesNotMatch(l, NO_DBT, `script.logical.yaml: ${l}`);
  for (const m of modulesIn('tour')) {
    sceneSrc(m).split('\n').forEach((l, i) => assert.doesNotMatch(l, NO_DBT, `${m}.js:${i + 1}: ${l}`));
  }
  for (const sc of script.scenes.filter((s) => !namesDbt(s))) {
    assert.doesNotMatch(JSON.stringify(sc), NO_DBT, `script.yaml scene ${sc.id}`);
  }
  // the import names dbt only as a tool, never Physical or the manifest
  assert.doesNotMatch(JSON.stringify(script.scenes.find((s) => s.id === 'bring')), /Physical|manifest|\bDiff\b/);
  for (const c of script.chapters) assert.doesNotMatch(c, NO_DBT_ON_SCREEN);
  // both headers name the forbidden words (that is their job)
  assert.match(logicalSrc, /^# .*dbt, Physical, Diff, manifest, sample project/m);
  assert.match(scriptSrc, /^# .*dbt, Physical, Diff, manifest,/m);
});

test('script.logical.yaml: no frame shows dbt, Physical, Diff, manifest or the sample project', async () => {
  const durations = Object.fromEntries(logical.scenes.flatMap((s) => s.lines.map((l) => [l.id, 2.5])));
  const tl = buildTimeline(logical, durations);
  const strip = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  for (const scene of tl.scenes) {
    const mod = (await import(`../player/scenes/${scene.module}.js`)).default;
    for (let lt = 0; lt <= scene.dur; lt += 0.1) {
      const html = mod.render(lt, { beats: scene.beats, dur: scene.dur, t: scene.start + lt, scene });
      // a folder without dbt has no stage colours: no table border or relationship line in logical blue
      assert.doesNotMatch(html, /class="node" style="[^"]*border-color:#60a5fa/i, `${scene.id} +${lt.toFixed(1)}s: a blue table border`);
      assert.doesNotMatch(html, /<path d="M[^"]*" fill="none" stroke="#60a5fa"/i, `${scene.id} +${lt.toFixed(1)}s: a blue relationship line`);
      assert.doesNotMatch(strip(html), NO_DBT_ON_SCREEN, `${scene.id} +${lt.toFixed(1)}s: ${strip(html).match(NO_DBT_ON_SCREEN)?.[0]}`);
    }
    for (const h of scene.headline ?? []) assert.doesNotMatch(h, NO_DBT_ON_SCREEN);
  }
});

test('the logical cut\'s generated transcript names no dbt', () => {
  const ts = join(REPO, 'src', 'types', CUTS.logical.ts);
  if (existsSync(ts)) assert.doesNotMatch(readFileSync(ts, 'utf8'), NO_DBT);
});

test('the activity bar draws the real ERD Studio icon (package.json contributes it)', () => {
  const container = pkg.contributes.viewsContainers.activitybar.find((c) => c.id === 'erd-studio');
  const file = read(...container.icon.split('/'));
  const body = file.match(/<svg[^>]*viewBox="0 0 24 24"[^>]*>([\s\S]*)<\/svg>/)[1];
  assert.equal(flat(editor.ERD_SIDEBAR_ICON).trim(), flat(body).trim());
  assert.ok(editor.activityBar('erd').includes(editor.ERD_SIDEBAR_ICON));
  // nothing else stands in for it: the old two-boxes glyph is gone from the activity bar
  assert.doesNotMatch(editor.activityBar('erd'), /<rect x="3" y="4" width="8" height="6"/);
});

test('no background music: both cuts are voice only', () => {
  const vpkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(vpkg.scripts)) assert.doesNotMatch(cmd, /music/i, `npm run ${name}`);
  assert.equal(existsSync(join(HERE, '..', 'music.py')), false);
  assert.doesNotMatch(readFileSync(join(HERE, '..', 'encode.sh'), 'utf8'), /amix|music\.(wav|py)/);
});

test('the Help & Feedback rows are HelpTreeProvider\'s', () => {
  const help = read('src', 'providers', 'HelpTreeProvider.ts');
  const labels = [...help.slice(help.indexOf('HELP_ACTIONS'), help.indexOf('];', help.indexOf('HELP_ACTIONS'))).matchAll(/label: ('([^']+)'|\w+)/g)].map((m) => m[2]
    ?? { TOUR_LABEL: tsConst('src/types/startActions.ts', 'TOUR_LABEL'), SHOW_ME_AROUND_LABEL: tsConst('src/types/onboardingGuide.ts', 'SHOW_ME_AROUND_LABEL') }[m[1]]);
  assert.deepEqual(labels, editor.HELP_ROWS);
  assert.equal(editor.HELP_ROWS[0], cmdTitle('erdStudio.setupAiHelper'));
});

test('the README GIF\'s draft page uses draftModel\'s words: an imported DBML file', () => {
  const dm = read('src', 'services', 'draftModel.ts');
  const wording = read('webview-draft', 'lib', 'wording.ts');
  const { SALES_DRAFT: sales } = editor;
  assert.ok(dm.includes('return `${draftWhat(input)} · ${counts} · not saved`;'));
  assert.ok(dm.includes('parts.push(`Keep saves it as ${name} in the ${layerLabel} layer (${diagramFile}).`);'));
  // Import DBML…'s draft of sales.dbml: Keep as Diagram primary, the rest in the menu
  assert.ok(dm.includes("case 'dbml': return input.origin ? `Draft ${input.origin}` : `Draft from ${input.fileName ?? 'your DBML file'}`;"));
  assert.equal(sales.headline, `Draft from ${sales.file} · ${sales.tables.length} tables, ${sales.rels.length} relationships · not saved`);
  assert.equal(sales.tab, `Draft: ${sales.file.replace(/\.dbml$/, '')}`);
  assert.equal(sales.detail, `Keep saves it as ${sales.file.replace(/\.dbml$/, '')} in the ${NEW_LAYER.label} layer (.erd-studio/${NEW_LAYER.id}/diagrams/${sales.file.replace(/\.dbml$/, '')}.dbml).`);
  assert.ok(dm.includes('keepLabel: KEEP_AS_DIAGRAM,\n        primary: \'keep\' as const,'));
  assert.ok(dm.includes('shownStarts: [],'));
  assert.deepEqual(sales.buttons.map(([l]) => l), [tsConst('src/services/draftModel.ts', 'KEEP_AS_DIAGRAM'), tsConst('webview-draft/lib/wording.ts', 'OTHER_WAYS_TO_START'), tsConst('webview-draft/lib/wording.ts', 'DISCARD')]);
  assert.ok(wording.includes("export const DISCARD = 'Discard';"));
  assert.equal(cmdTitle('erdStudio.importDbml'), 'Import DBML…');
});

test('the watch steps and the Help row call it "Watch the Tour", with no length in its name', () => {
  const tour = tsConst('src/types/startActions.ts', 'TOUR_LABEL');
  assert.equal(tour, 'Watch the Tour');
  for (const id of ['watch', 'watchLogical']) assert.equal(wt.steps.find((s) => s.id === id).title, tour);
  assert.equal(cmdTitle('erdStudio.showGettingStarted'), tour);
  assert.doesNotMatch(JSON.stringify(pkg), /One-Minute|one-minute/);
  assert.doesNotMatch(read('src', 'types', 'gettingStarted.ts'), /one-minute/i);
  assert.doesNotMatch(wt.steps.find((s) => s.id === 'watchLogical').description, /\bdbt\b/i);
  // the dbt project's watch step describes the default cut: bring it in, its files, by hand or with AI, then dbt
  const watch = wt.steps.find((s) => s.id === 'watch').description;
  assert.match(watch, /DBML/);
  assert.match(watch, /by hand or with AI/);
  assert.doesNotMatch(watch, /No AI needed/i);
  // the walkthrough's pictures of a player show each cut's real length: watch.svg the default cut
  // (the dbt project's step), watch-logical.svg the logical cut (watchLogical)
  for (const [step, svg, build] of [['watch', 'watch.svg', 'build'], ['watchLogical', 'watch-logical.svg', 'build-logical']]) {
    assert.equal(wt.steps.find((s) => s.id === step).media.svg, `media/walkthrough/${svg}`);
    const svgTime = read('media', 'walkthrough', svg).match(/>(\d+):(\d\d)</);
    assert.ok(svgTime, `a m:ss duration on ${svg}`);
    const built = join(HERE, '..', build, 'timeline.json');
    if (existsSync(built)) {
      const secs = Math.round(JSON.parse(readFileSync(built, 'utf8')).total);
      assert.equal(`${svgTime[1]}:${svgTime[2]}`, `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, svg);
    }
  }
});

test('the canvas toolbar and the stage tabs use the webview\'s words', () => {
  const toolbar = read('webview', 'components', 'Toolbar', 'Toolbar.tsx');
  assert.ok(toolbar.includes('Layout'), 'Layout button');
  assert.ok(toolbar.includes('{layerLabel} layer'), 'the layer badge\'s label');
  assert.ok(toolbar.includes(`{ label: '${lib.COMPARE_WORDS.physical}', title:`));
  assert.ok(toolbar.includes(`{ label: '${lib.COMPARE_WORDS.logical}', title:`));
  assert.ok(toolbar.includes(`return { label: '${lib.COMPARE_WORDS.stop}',`));
  assert.ok(toolbar.includes('if (!domain || logicalOnly) return [];'), 'no Compare without dbt');
  const tabs = read('webview', 'components', 'Toolbar', 'StageTabs.tsx');
  for (const [stage, label, hint] of lib.STAGE_TABS) assert.ok(tabs.includes(`{ stage: '${stage}', label: '${label}', hint: '${hint}'`), label);
  // the read-only Physical stage has no "+ Add"
  assert.match(toolbar, /\{\/\* Add Dropdown — hidden in read-only mode \*\/\}\s*\{!isReadOnly && \(/);
  const phys = lib.toolbar({ x: 0, y: 0, logicalOnly: false, stage: 'physical', add: 'idle' });
  assert.doesNotMatch(phys, /\+ Add/);
  assert.match(lib.toolbar({ x: 0, y: 0, logicalOnly: false, stage: 'logical', add: 'idle' }), /\+ Add/);
});

test('the end card is short: the name, one line, free to use in VS Code, the extension id', async () => {
  const { LINE, FREE } = await import('../player/scenes/tour/endCard.js');
  // the hook's own idea ("Your data model, in your repo."), in five words
  assert.equal(LINE.replace(/[{}]/g, ''), 'Your data model, in Git.');
  assert.equal(FREE, 'Free to use in VS Code');
  for (const sc of [script, logical]) assert.ok(sc.scenes.at(-1).lines[0].caption.includes(FREE.replace('Free', 'free')));
  // nothing else to read: no steps, no list of facts, nothing about the Confluence app
  const src = readFileSync(join(SCENES, 'tour', 'endCard.js'), 'utf8').replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /STEPS|TAGLINE|FACTS|Confluence|source available/);
  const mod = (await import('../player/scenes/tour/endCard.js')).default;
  const words = mod.render(5).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ');
  assert.ok(words.length <= 14, `${words.length} words on the end card: ${words.join(' ')}`);
  assert.equal(editor.EXTENSION.name, pkg.displayName);
  assert.equal(editor.EXTENSION.publisher, pkg.publisher);
  // the search hint names the Marketplace id, publisher.name
  assert.equal(editor.EXTENSION.id, `${pkg.publisher}.${pkg.name}`);
  assert.ok(readFileSync(join(SCENES, 'tour', 'endCard.js'), 'utf8').includes('${EXTENSION.id}'));
});

test('the files the recording\'s import wrote are the 2.0 layer-first DBML a new folder gets', async () => {
  // what the real take wrote in a new plain folder (record/fixtures.erd.mjs, a copy of it)
  const { DBT_ERD } = await import('../record/fixtures.erd.mjs');
  const L = NEW_LAYER.id;   // main: the layer folder, the schema and the relationships file's name
  const rels = DBT_ERD[`${L}/relationships/${L}.dbml`].split('\n');
  assert.ok(read('packages', 'core', 'src', 'dbmlRichProperties.ts').includes(`'${rels[0]}'`), 'the relationships file header line');
  for (const l of rels.filter((x) => x.startsWith('use '))) assert.match(l, new RegExp(`^use \\{ table ${L}\\.\\w+ \\} +from '\\.\\./tables/${L}/\\w+\\.dbml'$`));
  assert.ok(rels.includes(`Ref: ${L}.fct_order.date_key >? ${L}.dim_date.date_key`));
  assert.match(DBT_ERD[`${L}/tables/${L}/fct_order.dbml`], new RegExp(`^Table ${L}\\.fct_order \\{`));
  assert.match(read('packages', 'core', 'src', 'dbml', 'writeTable.ts'), /\[pk/);
  // the first diagram starting a DBML project writes layers.json and the folder's README.md
  const ext = read('src', 'extension.ts');
  assert.ok(ext.includes('if (createdSemanticDir && dbml) {') && ext.includes('semanticReadmeCreate(fullSemanticDirPath'));
  for (const f of ['layers.json', 'README.md', `${L}/diagrams/sales.dbml`]) assert.ok(DBT_ERD[f], f);
});

test('the README GIF is drawn from the same pieces: a plain folder, no dbt, the layer-first tree', async () => {
  const hero = readFileSync(join(HERE, '..', 'player', 'hero.js'), 'utf8');
  for (const l of hero.split('\n')) assert.doesNotMatch(l, NO_DBT, `hero.js: ${l}`);
  const { HERO_TREE } = await import('../player/hero.js');
  const paths = [];
  const stack = [];
  for (const [d, kind, label] of HERO_TREE) {
    stack[d] = label;
    if (kind !== 'folder') paths.push(stack.slice(0, d + 1).join('/'));
  }
  assert.ok(paths.includes(`.erd-studio/${NEW_LAYER.id}/diagrams/orders.dbml`));
  assert.ok(paths.filter((p) => p.startsWith(`.erd-studio/${NEW_LAYER.id}/tables/${NEW_LAYER.id}/`) && p.endsWith('.dbml')).length >= 3);
  assert.ok(hero.includes(`'Table ${NEW_LAYER.id}.fct_order {'`));
  assert.ok(!paths.some((p) => /dbt_project/.test(p)));
});

test('nothing calls ERD Studio open source (the licence is PolyForm Shield: source-available)', () => {
  assert.match(read('LICENSE'), /PolyForm Shield/);
  const dir = join(HERE, '..', 'player');
  const files = ['thumbnail.html', 'hero.html', 'hero.js', 'editor.js', ...ALL_MODULES.map((m) => `scenes/${m}.js`)];
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /open[ -]source/i, f);
  for (const [file, sc] of Object.entries(SCRIPTS)) assert.doesNotMatch(JSON.stringify(sc), /open[ -]source/i, file);
});

// The DBML the README GIF shows is byte for byte what a user's file holds: the host formats every file it
// writes (src/services/dbmlWriters.ts formatWrittenDbml), so formatting the shown text changes
// nothing. Runs core's formatDbml through the root's tsx; skipped when the root has no node_modules.
test('the DBML text the README GIF shows is already formatted, as ERD Studio writes it', async (t) => {
  const tsx = join(REPO, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) return t.skip('run npm ci at the repo root to check the DBML formatting');
  const { FCT_DBML } = await import('../player/hero.js');
  const texts = [FCT_DBML].map((lines) => `${lines.join('\n')}\n`);
  const { spawnSync } = await import('node:child_process');
  const code = `import { formatDbml } from ${JSON.stringify(join(REPO, 'packages', 'core', 'src', 'dbml', 'format.ts'))};
    const texts = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(texts.map((x) => { const r = formatDbml(x); return { skipped: r.skipped ?? null, same: r.text === x }; })));`;
  const run = spawnSync(tsx, ['--eval', code, JSON.stringify(texts)], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const [i, r] of JSON.parse(run.stdout.trim().split('\n').at(-1)).entries()) {
    assert.equal(r.skipped, null, `text ${i} did not format`);
    assert.ok(r.same, `text ${i} is not what formatDbml writes`);
  }
});

test('a folder without dbt draws no stage colours (the renderer\'s neutral canvas)', () => {
  const theme = read('packages', 'renderer', 'src', 'styles', 'theme.css');
  assert.ok(theme.includes(`--canvas-neutral-line:   var(--vscode-descriptionForeground, ${lib.COLORS.neutralLine});`));
  assert.ok(theme.includes('--canvas-neutral-border: color-mix(in srgb, var(--canvas-neutral-line) 55%, transparent);'));
  assert.ok(read('packages', 'renderer', 'src', 'components', 'Graph', 'ModelNode.css').includes('.editor-canvas--neutral .model-node--logical {\n  border-color: var(--canvas-neutral-border);'));
  // nothing outside the dbt beat asks for a stage colour on a table or a line
  for (const f of ['editor.js', 'hero.js', ...modulesIn('tour').map((m) => `scenes/${m}.js`)]) {
    const code = readFileSync(join(HERE, '..', 'player', f), 'utf8');
    assert.doesNotMatch(code, /stage: '(logical|physical)'|color: COLORS\.logical/, f);
  }
});

test('the README GIF\'s draft matches what the product draws: Show details, no reused table', async () => {
  const { SALES_DRAFT: sales, SHOW_DETAILS } = editor;
  assert.equal(SHOW_DETAILS, tsConst('webview-draft/lib/wording.ts', 'SHOW_DETAILS'));
  assert.ok(read('webview-draft', 'components', 'DraftBanner.tsx').includes('const showSecondLine = banner.changeOptions || counts !== \'\' || hasDetails;'));
  assert.ok(sales.details, 'an import draft always has details');
  // a name already in the library would be reused (dbmlImport.ts) and the detail would say so
  const { HERO_TREE } = await import('../player/hero.js');
  const library = new Set(HERO_TREE.filter(([d, k]) => d === 4 && k === 'dbml').map(([, , l]) => l.replace(/\.dbml$/, '')));
  for (const tb of sales.tables) assert.ok(!library.has(tb.name), `${tb.name} is already in the library`);
});

test('an import in a new folder without dbt asks only the name: one layer', () => {
  const src = read('src', 'commands', 'importDbml.ts');
  assert.ok(src.includes("prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,"));
  // one creatable layer: it is the default and nothing is asked (layerWording.ts)
  assert.ok(read('src', 'services', 'layerWording.ts').includes('if (creatableIds.length === 1) return creatableIds[0];'));
  // the recording saw that prompt in the real product, from Import SQL DDL (record/takes.json)
  assert.ok(takes.importSql.screenText.some((x) => x.startsWith(IMPORT_NAME_PROMPT)));
});

test('the README GIF uses the layer a new folder without dbt really gets (Main), as the recording shows', async () => {
  // layerService.ts NEW_PROJECT_LAYERS_WITHOUT_DBT is one layer
  assert.equal(NEW_LAYER.count, 1);
  const { HERO_TREE } = await import('../player/hero.js');
  assert.ok(HERO_TREE.some(([d, k, l]) => d === 1 && k === 'folder' && l === NEW_LAYER.id));
  // the recording's plain folder got the same one layer: the import's draft and name box say Main
  const shown = Object.values(takes).flatMap((s) => s.take === 'plain' ? s.screenText : []);
  for (const s of [`Keep saves it as sales in the ${NEW_LAYER.label} layer (.erd-studio/${NEW_LAYER.id}/diagrams/sales.dbml).`, IMPORT_NAME_PROMPT]) assert.ok(shown.some((x) => x.startsWith(s)), s);
  // no Silver or Gold anywhere in the player's HTML scenes or the GIF
  for (const f of [...readdirSync(join(HERE, '..', 'player', 'scenes', 'tour')).map((x) => join('scenes', 'tour', x)), 'hero.js', 'editor.js']) {
    assert.doesNotMatch(readFileSync(join(HERE, '..', 'player', f), 'utf8'), /\b(Gold|Silver|GLD|SLV)\b|gold\//, f);
  }
});

test('the README GIF never shows dbt in any frame', async () => {
  const { render, HERO } = await import('../player/hero.js');
  const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  for (let t = 0; t < HERO.loop; t += 0.25) {
    const html = render(t);
    assert.doesNotMatch(strip(html), NO_DBT_ON_SCREEN, `GIF +${t}s`);
    assert.doesNotMatch(html, /class="node" style="[^"]*border-color:#60a5fa/i, `GIF +${t}s: a blue table border`);
  }
});

// ---- the default cut is a recording of the real VS Code (record/) ----------------------------
const takes = JSON.parse(readFileSync(join(HERE, '..', 'record', 'takes.json'), 'utf8'));
const recScenes = script.scenes.filter((s) => s.module.startsWith('rec/'));

test('the default cut films the real VS Code, in its light theme: every scene before Confluence, in one of the takes, at the inset\'s size', async () => {
  const { SCENES: ACTIONS, TAKES } = await import('../record/scenes.mjs');
  const { WINDOW, SETTINGS } = await import('../record/vscode.mjs');
  // every scene but the AI change's still, the pull request, Confluence and the end card (HTML)
  assert.deepEqual(recScenes.map((s) => s.id), script.scenes.map((s) => s.id).filter((id) => !['aiShow', 'pr', 'confluence', 'end'].includes(id)));
  const filmed = Object.values(TAKES).flatMap((t) => t.scenes);
  assert.deepEqual([...filmed].sort(), recScenes.map((s) => s.id).sort(), 'each recorded scene in exactly one take');
  for (const s of recScenes) assert.equal(typeof ACTIONS[s.id]?.run, 'function', `record/scenes.mjs has no ${s.id}`);
  assert.deepEqual(TAKES.dbt.scenes, ['dbt'], 'the dbt beat is its own take, in the dbt project');
  // the window fills the inset exactly (filmed at 1.2x its CSS size), between the headline and the chapter bar
  const { x, y, w, h } = script.recording.inset;
  assert.equal(w / h, WINDOW.width / WINDOW.height);
  assert.ok(x >= 0 && x + w <= 1920 && y >= 230 && y + h <= 965, 'clear of the headline and the chapter bar');
  const css = readFileSync(join(HERE, '..', 'player', 'style.css'), 'utf8');
  assert.match(css, /body\.rec \.headline \{ top: 84px; font-size: 62px; \}/);
  // the frame is light, as the window is: off-white, dark text
  const rec = css.slice(css.indexOf('body.rec {'), css.indexOf('}', css.indexOf('body.rec {')));
  assert.match(rec, /--text: #1f2328;/);
  assert.match(rec, /--bg-1: #f6f7f9;/);
  assert.equal(SETTINGS['workbench.colorTheme'], 'Default Light Modern');
  // a clean, quiet, isolated editor: no telemetry, no AI chat UI, ERD Studio's own telemetry off, DOM menus (CDP films those),
  // the import clicked by hand (no automatic draft), a terminal the privacy check can read
  for (const [k, v] of Object.entries({ 'telemetry.telemetryLevel': 'off', 'erdStudio.telemetry.enabled': false, 'chat.disableAIFeatures': true, 'window.menuStyle': 'custom',
    'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true, 'erdStudio.startSuggestions': false, 'terminal.integrated.gpuAcceleration': 'off',
    'terminal.integrated.shellIntegration.enabled': false })) assert.deepEqual(SETTINGS[k], v, k);
  const vs = readFileSync(join(HERE, '..', 'record', 'vscode.mjs'), 'utf8');
  assert.match(vs, /--use-mock-keychain/);
  assert.doesNotMatch(vs.replace(/^\s*\/\/.*$/gm, ''), /9333/, 'never the shared CDP port');
  assert.match(readFileSync(join(HERE, '..', 'record', 'driver.mjs'), 'utf8'), /CDP_PORT \|\| 9555/);
  // the window keeps its own environment (VSCODE_CLI=1: no login-shell PATH, so no dbt of yours) and HOME
  assert.match(vs, /VSCODE_CLI: '1'/);
  assert.match(vs, /const HOME = join\(PROFILE, 'home'\)/);
});

test('Claude Code runs on the existing login with none of your user config, edits only, and a clean prompt', async () => {
  const { CLAUDE_FLAGS, terminalEnv, SETTINGS } = await import('../record/vscode.mjs');
  const flag = (f) => CLAUDE_FLAGS[CLAUDE_FLAGS.indexOf(f) + 1];
  assert.equal(flag('--setting-sources'), 'project,local');
  assert.ok(CLAUDE_FLAGS.includes('--strict-mcp-config'));
  assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(flag('--permission-mode'), 'acceptEdits');
  assert.equal(flag('--disallowedTools'), 'Bash');
  assert.ok(!CLAUDE_FLAGS.some((f) => /dangerously|bypass/i.test(f)));
  // the terminal: your real HOME (the login lives there; nothing logs in), our own zsh config, prompt "$ "
  const env = terminalEnv();
  assert.ok(env.HOME && env.ZDOTDIR.startsWith('/tmp/erdrec'));
  const vs = readFileSync(join(HERE, '..', 'record', 'vscode.mjs'), 'utf8');
  assert.match(vs, /PS1='\$ '/);
  assert.match(vs, /export IS_DEMO=1/);
  assert.doesNotMatch(vs, /\/login|setup-token|ANTHROPIC_API_KEY/);
  assert.equal(SETTINGS['terminal.integrated.profiles.osx'].tour.path, '/bin/zsh');
  // the banner (it names the plan the login is on) is cleared before the take starts
  assert.match(readFileSync(join(HERE, '..', 'record', 'scenes.mjs'), 'utf8'), /await clearTerminal\(d\);/);
});

test('record/takes.json: every recorded scene was filmed for its scene\'s length, its clicks on time and done before the cut', () => {
  for (const s of recScenes) {
    const take = takes[s.id];
    assert.ok(take, `${s.id} was never recorded (node record/record.mjs)`);
    assert.ok(take.busy <= take.dur, `${s.id}: the clicks ran ${take.busy}s into a ${take.dur}s scene`);
    assert.ok(take.late <= 0.6, `${s.id}: a click ran ${take.late}s late`);
    assert.ok(take.screenText.length > 10, s.id);
    // a fast-forward only where the script asks for one, inside its scene
    if (take.ff) {
      assert.ok(s.props?.fastForward, `${s.id} was sped up without props.fastForward`);
      assert.ok(take.ff.a < take.ff.o && take.ff.o < take.dur && take.ff.b >= take.ff.o, `${s.id}: ${JSON.stringify(take.ff)}`);
    }
  }
  assert.deepEqual(Object.keys(takes).sort(), recScenes.map((s) => s.id).sort());
  // Claude Code's wait is what is sped up
  assert.ok(takes.aiRun.ff && takes.aiRun.ff.b - takes.aiRun.ff.a > takes.aiRun.ff.o - takes.aiRun.ff.a, 'aiRun: Claude Code took longer than its window, so it is sped up');
  // the footage matches the timeline it is laid on, when there is one
  const built = join(HERE, '..', 'build', 'timeline.json');
  if (existsSync(built)) {
    const tl = JSON.parse(readFileSync(built, 'utf8'));
    for (const s of tl.scenes.filter((x) => x.module.startsWith('rec/'))) assert.ok(Math.abs(takes[s.id].dur - s.dur) < 0.01, `${s.id}: filmed ${takes[s.id].dur}s, timeline ${s.dur}s: record again`);
  }
});

test('the terminal never showed an account, a plan, an email or a home folder', () => {
  const rows = Object.values(takes).flatMap((s) => s.terminalText ?? []);
  assert.ok(takes.aiRun.terminalText?.length > 5, 'the aiRun take sampled the terminal');
  const home = process.env.HOME ?? '/Users/';
  for (const r of rows) {
    assert.doesNotMatch(r, /Claude (Max|Pro|Ultra|Team|Enterprise)\b|Organization|@[\w-]+\.\w|\/Users\/|API Usage Billing/i, r);
    assert.ok(!r.includes(home), r);
    assert.doesNotMatch(r, /Claude Code v\d/, `the banner was on camera: ${r}`);
  }
  // what the line says: the request, the skill loaded by itself, the edit to the .dbml files
  const ai = takes.aiRun.terminalText.join('\n');
  assert.match(ai, /Add a dim_customer table, linked to fct_order/);
  assert.match(ai, /Skill\(erd-studio\)/);
  assert.match(ai, /\.erd-studio\/main\/.*\.dbml/);
});

test('the recording shows dbt only in the dbt beat, and there shows what the line says', () => {
  for (const s of recScenes.filter((x) => !isDbtBeat(x))) {
    for (const text of takes[s.id].screenText) assert.doesNotMatch(text, NO_DBT_ON_SCREEN, `${s.id} showed "${text}"`);
  }
  const dbt = new Set(takes.dbt.screenText);
  // "Import from dbt… click Run dbt parse. It writes manifest.json… The Physical tab shows what it describes… Compare with dbt marks every difference"
  for (const [, label, hint] of lib.STAGE_TABS) { assert.ok(dbt.has(label), label); assert.ok(dbt.has(`· ${hint}`), hint); }
  for (const w of ['Run dbt parse', 'Open Physical view', lib.COMPARE_WORDS.logical, lib.COMPARE_WORDS.stop, 'Only in Logical', 'Only in Physical']) assert.ok(dbt.has(w), w);
  assert.ok([...dbt].some((t) => t.startsWith('dbt parse finished.')), 'Run dbt parse ran dbt for real');
  // "Import from dbt turns your models into a diagram": the Diagrams view's New… menu showed it, under the
  // command's own title, and the line uses the start's one label (src/types/startActions.ts)
  assert.ok(dbt.has(cmdTitle('erdStudio.drawFromDbt')), cmdTitle('erdStudio.drawFromDbt'));
  assert.match(read('src', 'types', 'startActions.ts'), /drawFromDbt: 'Import from dbt',/);
  assert.ok(script.scenes.find(isDbtBeat).lines[0].caption.includes('Import from dbt'), 'the dbt beat names Import from dbt');
  assert.match(read('src', 'commands', 'runDbtParse.ts'), /RUN_DBT_PARSE_ACTION = 'Run dbt parse'/);
  // "manifest.json": what dbt parse writes (runDbtParse.ts says so)
  assert.match(read('src', 'commands', 'runDbtParse.ts'), /writes `\{target-path\}\/manifest\.json`/);
});

test('the logical cut plays the default cut\'s plain take: its recorded scenes are script.yaml\'s, minus dbt', async () => {
  const { checkFootage, footageVariant } = await import('../record/composite.mjs');
  assert.equal(logical.recording.footage, 'default');
  assert.equal(footageVariant(logical.recording.footage), '');
  assert.deepEqual(logical.recording.inset, script.recording.inset);
  assert.equal(logical.recording.zoom, undefined, 'the punch-in is the dbt beat\'s');
  // the chapters: script.yaml's without COMPARE, renumbered
  assert.deepEqual(logical.chapters.map((c) => c.replace(/^\d+ · /, '')), script.chapters.map((c) => c.replace(/^\d+ · /, '')).filter((c) => c !== 'COMPARE'));
  const byId = Object.fromEntries(script.scenes.map((s) => [s.id, s]));
  for (const sc of logical.scenes.filter((s) => s.module.startsWith('rec/'))) {
    const d = byId[sc.id];
    // filmed in the plain take, a folder without dbt_project.yml
    assert.equal(takes[sc.id].take, 'plain', sc.id);
    if (sc.id !== 'bring') { assert.deepEqual(sc, d, `${sc.id} is script.yaml's scene`); continue; }
    // the import: its first line names no dbt, its logo row has no dbt mark, and the pause puts `open` back
    const { lines, props, ...rest } = sc;
    const { lines: dl, props: dp, ...drest } = d;
    assert.deepEqual(rest, drest);
    assert.doesNotMatch(lines[0].caption, NO_DBT);
    assert.deepEqual(props.logos.map(([id]) => id), dp.logos.map(([id]) => id).filter((id) => id !== 'dbt'));
    const { pause, ...open } = lines[1];
    const { pause: dpause, ...dopen } = dl[1];
    assert.deepEqual(open, dopen);
    assert.ok(pause > (dpause ?? script.timing.gap), 'b_have is shorter, so the pause is longer');
  }
  // the non-recorded scenes are the default cut's, but for the chapter number
  for (const id of ['aiShow', 'pr', 'confluence', 'end']) {
    const { chapter, ...a } = logical.scenes.find((s) => s.id === id);
    const { chapter: _, ...b } = byId[id];
    assert.deepEqual(a, b, id);
  }
  // with both builds there, the footage fits this cut's clock exactly
  const [bl, bd] = [join(HERE, '..', 'build-logical', 'timeline.json'), join(HERE, '..', 'build', 'timeline.json')];
  if (existsSync(bl) && existsSync(bd)) assert.deepEqual(checkFootage(JSON.parse(readFileSync(bl, 'utf8')), JSON.parse(readFileSync(bd, 'utf8'))), []);
  // and checkFootage catches a beat that moved
  const mk = (t) => ({ scenes: [{ id: 'a', module: 'rec/window', dur: 5, beats: { x: { t } } }, { id: 'e', module: 'tour/endCard', dur: 2, beats: {} }] });
  assert.deepEqual(checkFootage(mk(1), mk(1)), []);
  assert.match(checkFootage(mk(1.2), mk(1)).join(), /a: beat x at 1.2s here, 1s in the footage/);
  // only the default cut is ever recorded
  assert.match(readFileSync(join(HERE, '..', 'record', 'record.mjs'), 'utf8'), /if \(process\.env\.VARIANT\) throw/);
});

test('nothing the logical cut films shows dbt: on screen or in the terminal', () => {
  for (const sc of logical.scenes.filter((s) => s.module.startsWith('rec/'))) {
    for (const text of [...takes[sc.id].screenText, ...(takes[sc.id].terminalText ?? [])]) assert.doesNotMatch(text, NO_DBT_ON_SCREEN, `${sc.id} showed "${text}"`);
  }
  for (const c of logical.chapters) assert.doesNotMatch(c, NO_DBT_ON_SCREEN);
});

test('each recorded scene shows the product labels its narration names', () => {
  const shown = (id) => new Set(takes[id].screenText);
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === id).title;
  const { HAND_TABLE } = { HAND_TABLE: 'dim_promotion' };
  const expect = {
    hook: ['dim_customer.dbml', 'fct_order.dbml', 'sales.dbml', '6 tables'],
    bring: ['sales.sql', 'No diagrams yet. This folder has CREATE TABLE scripts.', START_LABELS.importSqlDdl, tsConst('src/types/startActions.ts', 'MORE_STARTS_LABEL'), START_LABELS.import, tsConst('src/types/startActions.ts', 'IMPORT_GUIDE_LABEL')],
    importSql: ['SQL DDL scripts', 'Power BI or Fabric semantic model', 'Import SQL DDL', 'Databricks / Spark SQL'],
    draft: ['Draft from 1 SQL file (Snowflake) · 4 tables, 3 relationships · not saved', tsConst('src/services/draftModel.ts', 'KEEP_AS_DIAGRAM')],
    files: ['.erd-studio', 'fct_order.dbml', 'pipelines', 'DBML Table'],
    byHand: ['Starter columns (optional)', HAND_TABLE],
    aiSetup: [cmd('erdStudio.setupAiHelper'), ...editor.HELP_ROWS],
    aiRun: ['dim_customer', 'customer_id', '6 tables'],
    dbt: [lib.COMPARE_WORDS.logical, 'Physical', 'NUMBER(18,2)', 'order_status'],
  };
  assert.deepEqual(Object.keys(expect).sort(), recScenes.map((s) => s.id).sort());
  for (const [id, labels] of Object.entries(expect)) for (const l of labels) assert.ok(shown(id).has(l), `${id} never showed "${l}"`);
  // the import picker's rows are importModel.ts's; the dialect was detected
  const picker = read('src', 'commands', 'importModel.ts');
  for (const r of ['SQL DDL scripts', 'DBML file', 'Power BI or Fabric semantic model']) assert.ok(picker.includes(`label: '$(`) && picker.includes(` ${r}'`), r);
  assert.ok([...shown('importSql')].some((t) => /^Snowflake/.test(t)) || [...shown('importSql')].includes('Snowflakedetected') || [...shown('importSql')].includes('detected'), 'the Snowflake row');
  assert.ok([...shown('importSql')].some((t) => t.startsWith(IMPORT_NAME_PROMPT)));
  // Set Up My AI Helper's toast names the assistant it set up
  assert.ok([...shown('aiSetup')].some((t) => /^AI helper ready for Claude Code/.test(t)), 'Set Up My AI Helper\'s toast');
  // the narration's labels are the product's
  const said = script.scenes.flatMap((s) => s.lines.map((l) => l.caption)).join(' ');
  for (const l of [cmd('erdStudio.setupAiHelper'), 'Import', 'Run dbt parse', 'Compare with dbt', 'Physical tab']) assert.ok(said.includes(l), l);
});

test('the AI helper is what the narration says: plain markdown skill files, and in Claude Code a pre-tool hook', () => {
  const svc = read('src', 'services', 'harnessService.ts');
  assert.match(svc, /PreToolUse/);
  assert.match(svc, /enforce-skill\.sh/);
  assert.ok(existsSync(join(REPO, 'src', 'harness', 'claude', 'erd-studio', 'SKILL.md')) || /SKILL\.md/.test(svc), 'the skill is markdown');
  const ai = script.scenes.filter((s) => s.id.startsWith('ai')).flatMap((s) => s.lines.map((l) => l.caption)).join(' ');
  assert.match(ai, /plain markdown files/);
  assert.match(ai, /pre-tool hook/);
});

test('the recorded frame: the window\'s bezel, the hook\'s claims and the import\'s logos, nothing about dbt but its logo, the footage fading only where it starts and ends', async () => {
  const mod = (await import('../player/scenes/rec/window.js')).default;
  const { LOGOS } = await import('../player/scenes/rec/window.js');
  globalThis.TIMELINE = { recording: script.recording };
  const durations = Object.fromEntries(script.scenes.flatMap((s) => s.lines.map((l) => [l.id, 2.5])));
  const tl = buildTimeline(script, durations);
  assert.deepEqual(tl.recording, script.recording);
  const hook = tl.scenes[0];
  const html = mod.render(hook.dur - 0.1, { beats: hook.beats, dur: hook.dur, scene: hook });
  for (const [label] of hook.props.claims) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), NO_DBT_ON_SCREEN);
  const { x, y, w, h } = script.recording.inset;
  assert.ok(html.includes(`left:${x}px;top:${y}px;width:${w}px;height:${h}px`), 'the inset the footage covers');
  // the logos: each one's file is there, vetted in LOGOS.md, and the line names each
  const bring = tl.scenes.find((s) => s.id === 'bring');
  const logoHtml = mod.render(bring.dur - 0.1, { beats: bring.beats, dur: bring.dur, scene: bring });
  const notes = readFileSync(join(HERE, '..', 'player', 'assets', 'logos', 'LOGOS.md'), 'utf8');
  for (const [id] of bring.props.logos) {
    const l = LOGOS[id];
    assert.ok(logoHtml.includes(l.name), l.name);
    // a chip naming two products (Power BI / Fabric) is named word for word in the line, each of them
    for (const name of l.name.split(' / ')) assert.ok(bring.lines[0].caption.includes(name), `the line names ${name}`);
    if (l.file) { assert.ok(existsSync(join(HERE, '..', 'player', 'assets', 'logos', l.file)), l.file); assert.ok(notes.includes(`\`${l.file}\``), `${l.file} in LOGOS.md`); }
  }
  // video/ never loads anything from social-video/ at run time
  for (const f of ['scenes/rec/window.js', 'scenes/tour/confluence.js']) assert.doesNotMatch(readFileSync(join(HERE, '..', 'player', f), 'utf8'), /social-video/, f);
  const main = readFileSync(join(HERE, '..', 'player', 'main.js'), 'utf8');
  assert.match(main, /holdsWindow\(scs\[i - 1\]\) \? 1 : pin\) \* \(holdsWindow\(scs\[i \+ 1\]\) \? 1 : 1 - pout\)/);
  const comp = readFileSync(join(HERE, '..', 'record', 'composite.mjs'), 'utf8');
  assert.match(comp, /holdsWindow\(r\.before\) \? '' : `,fade=t=in:st=\$\{a\.toFixed\(3\)\}:d=\$\{fade\}:alpha=1`/);
  assert.match(comp, /holdsWindow\(r\.after\) \? '' : `,fade=t=out:st=\$\{\(b - fade\)\.toFixed\(3\)\}:d=\$\{fade\}:alpha=1`/);
});

test('the Confluence scene: the real render of the tour\'s diagram, a read-only viewer reading the repo', async () => {
  const src = readFileSync(join(HERE, '..', 'player', 'scenes', 'tour', 'confluence.js'), 'utf8');
  for (const w of ['ERD Studio for Confluence', 'Read-only', 'confluence.svg', 'github.svg', 'confluence-sales.png']) assert.ok(src.includes(w), w);
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\bfree\b|price|\$\d/i);
  assert.ok(existsSync(join(HERE, '..', 'player', 'assets', 'confluence-sales.png')), 'node confluence-shot.mjs');
  const shot = readFileSync(join(HERE, '..', 'confluence-shot.mjs'), 'utf8');
  assert.match(shot, /<ErdCanvas domain=\{domain\} viewer/);
  assert.match(shot, /loadDisplaySubjectArea/);
  // the scene's words are timed to its lines
  const { phraseAt } = await import('../player/scenes/tour/confluence.js');
  const durations = Object.fromEntries(script.scenes.flatMap((s) => s.lines.map((l) => [l.id, 4])));
  const sc = buildTimeline(script, durations).scenes.find((s) => s.id === 'confluence');
  for (const [beat, p] of [['truth', 'just DBML'], ['confluence', 'from GitHub'], ['confluence', 'business users']]) assert.ok(phraseAt(sc, beat, p) > 0);
});

test('composite lays each scene\'s footage on the video clock: the latest painted frame, from the scene\'s own mark', async () => {
  const { framePlan } = await import('../record/composite.mjs');
  const tl = { fps: 10, scenes: [
    { id: 'b', module: 'rec/window', start: 0, dur: 0.5 },   // filmed second in its take, shown first
    { id: 'a', module: 'rec/window', start: 0.5, dur: 0.3 },
    { id: 'end', module: 'tour/endCard', start: 0.8, dur: 1 },
  ] };
  const frames = [0, 0.02, 0.33, 1.0, 1.05, 1.31].map((t, i) => ({ f: `f${i}.jpg`, t: 100 + t }));
  const takes = { plain: { frames, scenes: [{ id: 'a', t0: 100, dur: 0.3 }, { id: 'b', t0: 101, dur: 0.5 }] } };
  const { frames: plan, start, end } = framePlan(tl, takes);
  assert.equal(start, 0); assert.equal(end, 0.8);
  // b: 101.05 101.15 101.25 101.35 101.45 -> f4 f4 f4 f5 f5 ; a: 100.05 100.15 100.25 -> f1 f1 f1
  assert.deepEqual(plan.map((p) => p.file), ['f4.jpg', 'f4.jpg', 'f4.jpg', 'f5.jpg', 'f5.jpg', 'f1.jpg', 'f1.jpg', 'f1.jpg']);
  assert.throws(() => framePlan(tl, { plain: { frames, scenes: [{ id: 'a', t0: 100, dur: 0.3 }] } }), /scene b was never recorded/);
  // b was filmed after a, so the footage jumps where a starts: one cut, two runs that overlap by XFADE frames
  const { cuts, segments } = framePlan(tl, takes);
  const { XFADE } = await import('../record/composite.mjs');
  assert.deepEqual(cuts.map((c) => [c.at, c.before.id, c.after.id]), [[5, 'b', 'a']]);
  assert.equal(segments.reduce((n, sg) => n + sg.frames.length, 0) - XFADE * cuts.length, plan.length, 'the cross-fades keep the length');
  // the outgoing run films b on past its end; the incoming one starts a before its mark (the take's first frame holds)
  assert.equal(segments[0].frames.length, 5 + XFADE / 2);
  assert.deepEqual(segments[1].frames.slice(XFADE / 2).map((f) => f.file), plan.slice(5).map((f) => f.file));
  // one take filmed in order, scene after scene, has no cut
  const inOrder = { plain: { frames, scenes: [{ id: 'b', t0: 100, dur: 0.5 }, { id: 'a', t0: 100.6, dur: 0.3 }] } };
  assert.deepEqual(framePlan(tl, inOrder).cuts, []);
  assert.throws(() => framePlan(tl, { plain: { frames, scenes: [{ id: 'a', t0: 100, dur: 0.3 }, { id: 'b', t0: 101, dur: 0.7 }] } }), /record again/);
});

test('a fast-forward plays the take\'s wait faster, in its window, and the take runs on in real time after it; the badge says so', async () => {
  const { takeClock, framePlan, fastForwards, badgeLabel, pointerTerms, pointerFromTerms, pointerAt } = await import('../record/composite.mjs');
  const ff = { a: 2, b: 22, o: 6 };   // 20 s of waiting in 4 s of video: 5x
  const clock = takeClock(ff);
  assert.equal(clock(1), 1);
  assert.equal(clock(4), 12);
  assert.equal(clock(6), 22);
  assert.equal(clock(8), 24);
  assert.equal(takeClock(null)(3.3), 3.3);
  // the frames: the scene shows its take's frame at clock(u); the next scene follows on from the filmed end
  const tl = { fps: 2, scenes: [{ id: 's', module: 'rec/window', start: 0, dur: 8 }, { id: 'n', module: 'rec/window', start: 8, dur: 1 }] };
  const frames = Array.from({ length: 30 }, (_, i) => ({ f: `f${i}.jpg`, t: 100 + i }));
  const takes = { p: { frames, scenes: [{ id: 's', t0: 100, dur: 8, filmed: 24, ff }, { id: 'n', t0: 124.1, dur: 1 }] } };
  const plan = framePlan(tl, takes);
  assert.equal(plan.frames[8].file, `f${Math.floor(clock(4.25))}.jpg`);
  assert.deepEqual(plan.cuts, [], 'the next scene follows the filmed length, not the video length');
  const [f] = fastForwards(tl, takes);
  assert.deepEqual([f.from, f.to, f.speed], [2, 6, 5]);
  assert.equal(badgeLabel(f.speed), 'Sped up 5×');
  // the real speed, to one decimal: 2.4x footage never reads as 2x
  assert.equal(badgeLabel(2.4017), 'Sped up 2.4×');
  assert.equal(badgeLabel(2.96), 'Sped up 3×');
  // the pointer: real-time glides keep their timing on either side of the fast-forward
  const trail = [{ s: 99, d: 0, x0: 5, y0: 5, x1: 5, y1: 5 }, { s: 100.5, d: 1, x0: 5, y0: 5, x1: 105, y1: 5 }, { s: 122.5, d: 1, x0: 105, y0: 5, x1: 105, y1: 105 }];
  const terms = pointerTerms(tl, takes, { p: trail });
  for (const u of [0.25, 1.25, 1.75, 6.6, 7.2, 7.9]) {
    const want = pointerAt(trail, 100 + clock(u));
    const got = pointerFromTerms(terms, u);
    assert.ok(Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.y) < 1e-6, `u=${u}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
});

test('composite draws the pointer from the driver\'s path, on the video clock: each scene from where its take\'s pointer was', async () => {
  const { pointerAt, pointerTerms, pointerFromTerms } = await import('../record/composite.mjs');
  const tl = { fps: 30, scenes: [
    { id: 'b', module: 'rec/window', start: 0, dur: 1 },     // filmed second, shown first
    { id: 'a', module: 'rec/window', start: 1, dur: 1 },
  ] };
  const takes = { plain: { frames: [{ f: 'f0.jpg', t: 100 }], scenes: [{ id: 'a', t0: 100, dur: 1 }, { id: 'b', t0: 102, dur: 1 }] } };
  const trail = [
    { s: 99, d: 0, x0: 10, y0: 10, x1: 10, y1: 10 },
    { s: 100.2, d: 0.5, x0: 10, y0: 10, x1: 110, y1: 60 },     // a: a glide inside the scene
    { s: 101.8, d: 0.6, x0: 110, y0: 60, x1: 210, y1: 60 },    // before b's mark, into it
    { s: 102.6, d: 0.8, x0: 210, y0: 60, x1: 210, y1: 160 },   // runs past b's end
  ];
  const terms = pointerTerms(tl, takes, { plain: trail });
  // at every frame the expression's position is the take's pointer at the same moment
  for (let i = 0; i < 60; i++) {
    const t = (i + 0.5) / 30;
    const s = t < 1 ? { t0: 102, start: 0 } : { t0: 100, start: 1 };
    const want = pointerAt(trail, s.t0 + t - s.start);
    const got = pointerFromTerms(terms, t);
    assert.ok(Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.y) < 1e-6, `t=${t}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
  // the page draws no pointer of its own (it would judder at the screencast's rate); the ripple stays
  const drv = readFileSync(join(HERE, '..', 'record', 'driver.mjs'), 'utf8');
  assert.match(drv, /PAGE_POINTER \? '' : ';visibility:hidden'/);
  assert.match(drv, /trail\.push\(\{ s: t0 \/ 1000, d: ms \/ 1000/);
  assert.match(readFileSync(join(HERE, '..', 'record', 'record.mjs'), 'utf8'), /pointer\.json/);
});

test('the punch-in on the dbt beat\'s comparison panel stays inside the window and its scene', () => {
  const { zoom, inset } = script.recording;
  assert.equal(zoom.scene, 'dbt');
  const sc = script.scenes.find((s) => s.id === zoom.scene);
  assert.ok(sc.lines.some((l) => l.beat === zoom.beat), zoom.beat);
  assert.ok(zoom.scale > 1 && zoom.scale <= 1.6);
  assert.ok(zoom.focus[0] > 0 && zoom.focus[0] < inset.w && zoom.focus[1] > 0 && zoom.focus[1] < inset.h);
  const built = join(HERE, '..', 'build', 'timeline.json');
  if (existsSync(built)) {
    const s = JSON.parse(readFileSync(built, 'utf8')).scenes.find((x) => x.id === zoom.scene);
    assert.ok(s.beats[zoom.beat].t + zoom.offset + zoom.dur < s.dur - 0.5, 'held for at least half a second');
  }
});

test('the fixtures: a project folder holding Snowflake\'s exported DDL, and a dbt project that differs from the design on purpose', async () => {
  const fx = readFileSync(join(HERE, '..', 'record', 'fixtures.mjs'), 'utf8');
  // the plain folder opens with nothing ERD Studio wrote and no dbt
  const plain = fx.slice(fx.indexOf('const PLAIN = {'), fx.indexOf('};', fx.indexOf('const PLAIN = {')));
  assert.doesNotMatch(plain, /\.erd-studio|dbt_project/);
  const { SALES_SQL, dimCustomerYml, DBT_ERD } = await import('../record/fixtures.mjs');
  // GET_DDL's shape: create or replace TABLE, Snowflake types, declared keys; four tables, three foreign keys
  assert.equal((SALES_SQL.match(/^create or replace TABLE /gm) ?? []).length, 4);
  assert.equal((SALES_SQL.match(/foreign key \(/g) ?? []).length, 3);
  assert.match(SALES_SQL, /NUMBER\(38,0\)/);
  assert.doesNotMatch(SALES_SQL, /\/Users\/|@/);
  // no scratch or home paths in committed code
  for (const f of ['fixtures.mjs', 'scenes.mjs', 'vscode.mjs', 'record.mjs']) assert.doesNotMatch(readFileSync(join(HERE, '..', 'record', f), 'utf8'), /\/Users\/|scratchpad|claude-501/, f);
  // the design the dbt take starts from: the import, the table added by hand, the one Claude Code added
  for (const t of ['fct_order', 'dim_store', 'dim_product', 'dim_date', 'dim_promotion', 'dim_customer']) assert.ok(DBT_ERD[`main/tables/main/${t}.dbml`], t);
  // the dbt project's models differ on purpose: an extra order_status, amount NUMBER(18,2), no dim_promotion
  assert.match(fx, /- name: order_status\n\s+data_type: VARCHAR\(20\)/);
  assert.match(fx, /- name: amount\n\s+data_type: NUMBER\(18,2\)/);
  assert.match(DBT_ERD['main/tables/main/fct_order.dbml'], /amount +"NUMBER\(12,2\)"/);
  assert.doesNotMatch(fx, /- name: dim_promotion/);
  // dim_customer's model follows the design's columns (Claude Code chose them)
  assert.match(dimCustomerYml('Table main.dim_customer {\n  customer_id "NUMBER(38,0)" [pk]\n  email       VARCHAR\n}\n'), /- name: customer_id\n {8}data_type: NUMBER\(38,0\)\n {8}data_tests: \[unique, not_null\]\n {6}- name: email\n {8}data_type: VARCHAR/);
  // Run dbt parse on camera: real dbt Core, pinned, and a profile in the project that connects nowhere
  const { DBT_UVX_ARGS } = await import('../record/vscode.mjs');
  assert.ok(DBT_UVX_ARGS.some((a) => /^dbt-core==\d/.test(a)) && DBT_UVX_ARGS.some((a) => /^dbt-duckdb==\d/.test(a)));
  assert.match(fx, /type: duckdb\\n {6}path: ":memory:"/);
});

test('the design the take wrote is formatted as ERD Studio writes it, but for the files Claude Code edited', async (t) => {
  const tsx = join(REPO, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) return t.skip('run npm ci at the repo root to check the DBML formatting');
  const { DBT_ERD } = await import('../record/fixtures.mjs');
  // ERD Studio formats every file it writes (Claude Code edited fct_order, the relationships and dim_customer; Layout rewrote the diagram after it)
  const ours = ['main/tables/main/dim_store.dbml', 'main/tables/main/dim_product.dbml', 'main/tables/main/dim_date.dbml', 'main/tables/main/dim_promotion.dbml', 'main/diagrams/sales.dbml'];
  const texts = ours.map((f) => DBT_ERD[f]);
  const { spawnSync } = await import('node:child_process');
  const code = `import { formatDbml } from ${JSON.stringify(join(REPO, 'packages', 'core', 'src', 'dbml', 'format.ts'))};
    const texts = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(texts.map((x) => { const r = formatDbml(x); return { skipped: r.skipped ?? null, same: r.text === x }; })));`;
  const run = spawnSync(tsx, ['--eval', code, JSON.stringify(texts)], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const [i, r] of JSON.parse(run.stdout.trim().split('\n').at(-1)).entries()) {
    assert.equal(r.skipped, null, `${ours[i]} did not format`);
    assert.ok(r.same, `${ours[i]} is not what formatDbml writes`);
  }
});

test('the footage is filmed at the inset\'s own size, scaled down from a 2x window, never up', async () => {
  const { WINDOW, DPR } = await import('../record/vscode.mjs');
  const { inset } = parse(readFileSync(join(HERE, '..', 'script.yaml'), 'utf8')).recording;
  // the window renders at DPR (--force-device-scale-factor), so its pixels cover the inset
  assert.ok(WINDOW.width * DPR >= inset.w && WINDOW.height * DPR >= inset.h, `${WINDOW.width}x${WINDOW.height} at ${DPR}x covers ${inset.w}x${inset.h}`);
  assert.equal(WINDOW.width / WINDOW.height, inset.w / inset.h, 'the window and the inset have one aspect ratio');
  assert.match(readFileSync(join(HERE, '..', 'record', 'vscode.mjs'), 'utf8'), /`--force-device-scale-factor=\$\{DPR\}`/);
  // a raw take's frames (when there is one here) are the inset's size: composite never upscales them
  const jpegSize = (buf) => {
    for (let i = 2; i < buf.length;) {
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc2) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  };
  for (const take of ['plain', 'dbt']) {
    const f = join(HERE, '..', 'build', 'rec', take, 'f00010.jpg');
    if (!existsSync(f)) continue;
    assert.deepEqual(jpegSize(readFileSync(f)), { w: inset.w, h: inset.h }, `${take}'s frames`);
  }
});

// ---- the AI change, held; one pull request; the assistants Set Up My AI Helper sets up ----------

test('the AI change is held on a still of the take\'s last frame, showing the lines Claude Code really wrote', async () => {
  const { CHANGE, NEW_TABLE, LINK } = await import('../player/scenes/tour/aiChange.js');
  const { DBT_ERD } = await import('../record/fixtures.erd.mjs');
  for (const sc of [script, logical]) {
    const show = sc.scenes.find((s) => s.id === 'aiShow');
    assert.equal(show.props.still, 'aiRun', 'a still of the AI take');
    assert.ok(show.minDur >= 6, 'held for a while');
  }
  assert.ok(existsSync(join(HERE, '..', 'player', 'assets', 'still-aiRun.jpg')), 'npm run still');
  // the new table's file, whole, and its Ref line, as the take wrote them (record/fixtures.erd.mjs: a copy of it)
  const rel = (p) => p.replace(/^\.erd-studio\//, '');
  assert.equal(DBT_ERD[rel(CHANGE.table.path)].trimEnd(), CHANGE.table.lines.join('\n'));
  assert.ok(DBT_ERD[rel(CHANGE.ref.path)].split('\n').includes(CHANGE.ref.line));
  // and the terminal showed Claude Code writing them
  const term = takes.aiRun.terminalText.join('\n');
  assert.match(term, /Write\(\.erd-studio\/main\/tables\/main\/dim_customer\.dbml\)/);
  assert.match(term, /Update\(\.erd-studio\/main\/relationships\/main\.dbml\)/);
  for (const l of CHANGE.table.lines.slice(1, -1)) assert.ok(term.includes(l.trim()), l);
  // the marks sit inside the window
  const { w, h } = script.recording.inset;
  assert.ok(NEW_TABLE.x + NEW_TABLE.w < w && NEW_TABLE.y + NEW_TABLE.h < h);
  for (const [x, y] of LINK) assert.ok(x >= 0 && x <= w && y >= 0 && y <= h);
  // the narration says what the card shows
  const said = script.scenes.find((s) => s.id === 'aiShow').lines.map((l) => l.caption).join(' ');
  assert.match(said, /new table file/);
  assert.match(said, /the line that links it/);
  // and the relationships file's two added lines (its badge says +2) are both on the card
  assert.ok(DBT_ERD[rel(CHANGE.ref.path)].replace(/ +from/g, ' from').split('\n').includes(CHANGE.ref.use));
});

test('one pull request: the .dbml change and the SQL that builds the table, in the tour folder\'s own code folder', async () => {
  const { DESIGN, CODE, TITLE } = await import('../player/scenes/tour/pullRequest.js');
  const { CHANGE } = await import('../player/scenes/tour/aiChange.js');
  const { CLAUDE_REQUEST } = await import('../record/scenes.mjs');
  assert.equal(TITLE, CLAUDE_REQUEST);
  assert.ok(DESIGN.every((f) => f.path.startsWith('.erd-studio/') && f.path.endsWith('.dbml')));
  assert.deepEqual(DESIGN[0].lines, CHANGE.table.lines);
  assert.ok(DESIGN[1].lines.includes(CHANGE.ref.line));
  // the code: a .sql in pipelines/, the plain folder's code folder (record/fixtures.mjs), building the same table and columns
  assert.match(readFileSync(join(HERE, '..', 'record', 'fixtures.mjs'), 'utf8'), /'pipelines\//);
  assert.match(CODE.path, /^pipelines\/dim_customer\.sql$/);
  assert.match(CODE.lines[0], /table dim_customer/);
  for (const col of ['customer_id', 'customer_name', 'email', 'city', 'region']) assert.ok(CODE.lines.some((l) => l.includes(col)), col);
  // and fct_order's new key has code too: the loader the plain folder already has, one line changed
  const { CODE_ALSO, FILES, ADDED } = await import('../player/scenes/tour/pullRequest.js');
  assert.match(readFileSync(join(HERE, '..', 'record', 'fixtures.mjs'), 'utf8'), new RegExp(`'${CODE_ALSO.path}'`));
  assert.equal(FILES, 6);
  assert.equal(ADDED, 21);
  // no repo address, no user: the GitHub mark only
  const src = readFileSync(join(SCENES, 'tour', 'pullRequest.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /github\.com|@[a-z]/i);
  const pr = script.scenes.find((s) => s.id === 'pr');
  assert.deepEqual(pr.headline, ['One pull request:', 'the {design} and the {code}.']);
  assert.match(pr.lines.map((l) => l.caption).join(' '), /same pull request as the code that builds it/);
});

test('Set Up My AI Helper\'s scene names the assistants it sets up (shown, not said), and claims the hook only for Claude Code', () => {
  const names = [...read('src', 'types', 'aiAssistants.ts').matchAll(/^ {4}name: '([^']+)'/gm)].map((m) => m[1]);
  for (const sc of [script, logical]) {
    const setup = sc.scenes.find((s) => s.id === 'aiSetup');
    assert.deepEqual(setup.props.assistants[2], names);
    assert.ok(setup.lines.some((l) => l.beat === setup.props.assistants[0]));
  }
  const hookLines = script.scenes.flatMap((s) => s.lines).filter((l) => /hook/.test(l.caption));
  assert.ok(hookLines.every((l) => l.id === 'r_hook'), 'the pre-tool hook is said once, about Claude Code');
});

test('composite: HTML scenes between recorded ones hide the footage; a still takes over with no fade', async () => {
  const { framePlan, runsOf, holdsWindow, XFADE } = await import('../record/composite.mjs');
  const tl = { fps: 10, scenes: [
    { id: 'a', module: 'rec/window', start: 0, dur: 1, props: {} },
    { id: 's', module: 'tour/aiChange', start: 1, dur: 1, props: { still: 'a' } },
    { id: 'p', module: 'tour/pullRequest', start: 2, dur: 1, props: {} },
    { id: 'b', module: 'rec/window', start: 3, dur: 1, props: {} },
    { id: 'c', module: 'tour/confluence', start: 4, dur: 1, props: {} },
  ] };
  const runs = runsOf(tl);
  assert.deepEqual(runs.map((r) => [r.from, r.to, r.before?.id ?? null, r.after?.id ?? null]), [[0, 1, null, 's'], [3, 4, 'p', 'c']]);
  assert.ok(holdsWindow(tl.scenes[1]) && !holdsWindow(tl.scenes[2]) && holdsWindow(tl.scenes[0]));
  const frames = Array.from({ length: 60 }, (_, i) => ({ f: `f${i}.jpg`, t: 100 + i / 10 }));
  const takes = { p: { frames, scenes: [{ id: 'a', t0: 100, dur: 1 }, { id: 'b', t0: 103, dur: 1 }] } };
  const plan = framePlan(tl, takes);
  assert.equal(plan.frames.length, 40);
  // the gap holds a's last frame, then b's first; the cut sits in its middle, out of sight
  assert.equal(plan.frames[15].file, 'f9.jpg');
  assert.equal(plan.frames[25].file, 'f30.jpg');
  assert.deepEqual(plan.cuts.map((c) => [c.at, c.gap]), [[20, true]]);
  assert.equal(plan.segments.reduce((n, sg) => n + sg.frames.length, 0) - XFADE * plan.cuts.length, plan.frames.length);
  // a still right after the footage's end: two frames more of the last one, for the overlap
  const tail = { fps: 10, scenes: tl.scenes.slice(0, 2) };
  assert.equal(framePlan(tail, takes).frames.length, 12);
  assert.equal(framePlan(tail, takes).frames.at(-1).file, 'f9.jpg');
});
