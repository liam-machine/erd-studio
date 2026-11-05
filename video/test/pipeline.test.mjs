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
/** tour/: the logical cut's HTML scenes (no dbt anywhere; the end card is both cuts'). rec/: the frame the default cut's recorded footage plays in. */
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

const TOUR = ['tour/hook', 'tour/install', 'tour/newDiagram', 'tour/tables', 'tour/files', 'tour/importDbml', 'tour/enrich'];

test('the two cuts: the same tour, scene for scene; the default cut is recorded and adds one dbt beat before its end card', () => {
  assert.deepEqual(logical.scenes.map((s) => s.module), [...TOUR, 'tour/endCard']);
  // the default cut: the same scenes (ids, chapters, headlines) as real footage, then the dbt beat
  assert.deepEqual(script.scenes.map((s) => s.id), [...logical.scenes.slice(0, -1).map((s) => s.id), 'dbt', 'end']);
  assert.deepEqual(script.scenes.map((s) => s.module), [...Array(TOUR.length + 1).fill('rec/window'), 'tour/endCard']);
  for (const sc of logical.scenes) {
    const twin = script.scenes.find((s) => s.id === sc.id);
    assert.deepEqual([twin.chapter, twin.headline, twin.accent], [sc.chapter, sc.headline, sc.accent], sc.id);
    // the same words: a line may be split in two (tables: the link is spoken as the real dialog opens);
    // the one line that differs is the default cut's setup line, which names what its toast says
    // ("start the guided setup") where the logical cut shows /erd-studio-setup typed
    const said = (lines) => lines.filter((l) => l.id !== 'e_setup').map((l) => l.caption).join(' ');
    assert.equal(said(twin.lines), said(sc.lines), `${sc.id}: the two cuts say the same`);
    for (const l of sc.lines) assert.equal(twin.lines.find((x) => x.id === l.id)?.beat, l.beat, `${sc.id}: ${l.id}`);
  }
  const setupLine = (sc) => sc.scenes.find((s) => s.id === 'enrich').lines.find((l) => l.id === 'e_setup').caption;
  assert.match(setupLine(logical), /type \/erd-studio-setup in your assistant/);
  assert.match(setupLine(script), /start the guided setup in your assistant/);
  // the end card is the same scene in both
  assert.deepEqual(script.scenes.at(-1).lines, logical.scenes.at(-1).lines);
  assert.deepEqual(logical.voice, script.voice);
  assert.deepEqual(logical.timing, script.timing);
  assert.deepEqual(logical.chapters, script.chapters);
  // no unused modules, and nothing left at the top of scenes/
  assert.deepEqual(modulesIn(), []);
  assert.deepEqual(modulesIn('tour').sort(), [...TOUR, 'tour/endCard'].sort());
  assert.deepEqual(modulesIn('rec'), ['rec/window']);
  assert.equal(existsSync(join(SCENES, 'dbt')) && readdirSync(join(SCENES, 'dbt')).length > 0, false, 'the HTML dbt beat is gone: the default cut films the real one');
  // one-minute videos: the scenes' minimum lengths alone already fit (so a script edit fails here
  // even without a build), and a rendered timeline, when there is one, is 50–60 s with the dbt beat
  // 7.5–10 s
  for (const [sc, cut] of [[script, CUTS['']], [logical, CUTS.logical]]) {
    assert.ok(sc.maxDuration <= 65);
    const floor = sc.scenes.reduce((n, s) => n + s.minDur, 0);
    assert.ok(floor <= 60 && floor <= sc.maxDuration, `${cut.build}: the minDurs add up to ${floor}s`);
    const dbtScene = sc.scenes.find(isDbtBeat);
    if (dbtScene) assert.ok(dbtScene.minDur >= 7.5 && dbtScene.minDur <= 10, `dbt beat minDur ${dbtScene.minDur}`);
    const built = join(HERE, '..', cut.build, 'timeline.json');
    if (!existsSync(built)) continue;
    const tl = JSON.parse(readFileSync(built, 'utf8'));
    assert.ok(tl.total >= 50 && tl.total <= 60, `${cut.build}: ${tl.total}s`);
    const beat = tl.scenes.find(isDbtBeat);
    if (beat) assert.ok(beat.dur >= 7.5 && beat.dur <= 10, `dbt beat ${beat.dur}s`);
  }
});

// dbt is an add-on: no dbt in the logical cut at all, and in the default cut only in its dbt beat.
const NO_DBT = /\bdbt\b|Physical|manifest/i;
const NO_DBT_ON_SCREEN = /\bdbt\b|Physical|manifest|\bDiff\b|sample project/i;
/** The default cut's dbt beat: its own take, in a dbt project, the one scene that may name dbt. */
const isDbtBeat = (sc) => sc.id === 'dbt';

test('no line of script.logical.yaml or of a tour scene module names dbt; script.yaml only in its dbt beat', () => {
  // only the leading header comment may name them (it lists the words to keep out)
  const lines = logicalSrc.split('\n');
  const body = lines.slice(lines.findIndex((l) => !l.startsWith('#')));
  for (const l of body) assert.doesNotMatch(l, NO_DBT, `script.logical.yaml: ${l}`);
  for (const m of modulesIn('tour')) {
    sceneSrc(m).split('\n').forEach((l, i) => assert.doesNotMatch(l, NO_DBT, `${m}.js:${i + 1}: ${l}`));
  }
  for (const sc of script.scenes.filter((s) => !isDbtBeat(s))) {
    assert.doesNotMatch(JSON.stringify(sc), NO_DBT, `script.yaml scene ${sc.id}`);
  }
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

test('the extension listing, ERD Studio\'s side bar and its start entry use the real package.json copy', () => {
  const { EXTENSION, ERD_VIEWS, SIDEBAR_START, NEW_MENU } = editor;
  assert.equal(EXTENSION.name, pkg.displayName);
  assert.equal(EXTENSION.publisher, pkg.publisher);
  // the listing's own sentences, up to the first one that names dbt
  const short = editor.descriptionWithoutDbt();
  assert.ok(pkg.description.startsWith(short) && short.length > 40, short);
  assert.doesNotMatch(short, /\bdbt\b/i);
  assert.deepEqual(pkg.contributes.views['erd-studio'].map((v) => v.name), ERD_VIEWS);
  // the Diagrams view's start entry in a folder with nothing to import
  const entry = pkg.contributes.viewsWelcome.find((w) => w.view === 'erdStudio.domainTree' && /startIntent == blank/.test(w.when));
  const [text, button, more] = entry.contents.split('\n\n');
  assert.equal(text, SIDEBAR_START.text);
  assert.equal(button.match(/^\[([^\]]+)\]\(command:erdStudio\.start\?/)[1], SIDEBAR_START.button);
  assert.ok(decodeURIComponent(button).includes('"action":"blank"'));
  const m = more.match(/^(\w+:) \[([^\]]+)\]/);
  assert.equal(`${m[1]} ${m[2]}`, `${SIDEBAR_START.or} ${SIDEBAR_START.more}`);
  assert.equal(SIDEBAR_START.button, START_LABELS.blank);
  assert.equal(SIDEBAR_START.more, tsConst('src/types/startActions.ts', 'MORE_STARTS_LABEL'));
  // the automatic draft: a blank folder's first visit opens the example (draftTriggers.ts)
  assert.match(read('src', 'services', 'draftTriggers.ts'), /if \(intent === 'blank'\) \{\s*return input\.exampleShownOnMachine \? undefined : 'example';/);
  // the walkthrough opens by itself only in an empty window: a folder starts in the side bar
  assert.match(read('src', 'services', 'draftTriggers.ts'), /return input\.owed && !input\.hasFolder;/);
  // the + (New…) menu, as a folder without dbt shows it
  const menu = pkg.contributes.menus['erdStudio.newMenu'].filter((e) => !/hasDbtProject/.test(e.when)).map((e) => cmdTitle(e.command));
  assert.deepEqual(menu, NEW_MENU);
  assert.ok(pkg.contributes.menus['view/title'].some((e) => e.submenu === 'erdStudio.newMenu' && /domainTree/.test(e.when)));
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

test('the draft pages use draftModel\'s words: the coffee-shop example and an imported DBML file', () => {
  const dm = read('src', 'services', 'draftModel.ts');
  const wording = read('webview-draft', 'lib', 'wording.ts');
  const { EXAMPLE_DRAFT: ex, SALES_DRAFT: sales } = editor;
  const example = read('src', 'commands', 'openExampleDiagram.ts');
  const dbml = example.slice(example.indexOf('EXAMPLE_DBML = `'), example.indexOf('`;', example.indexOf('EXAMPLE_DBML = `')));
  const tables = (dbml.match(/^Table /gm) ?? []).length;
  const rels = (dbml.match(/ref: >/g) ?? []).length + (dbml.match(/^Ref/gm) ?? []).length;
  assert.equal(ex.tab, `Example: ${tsConst('src/services/draftModel.ts', 'EXAMPLE_COFFEE_SHOP_LABEL')}`);
  assert.ok(dm.includes("case 'example': return 'Example: a coffee-shop star schema';"));
  assert.ok(dm.includes('return `${draftWhat(input)} · ${counts} · not saved`;'));
  assert.equal(ex.headline, `Example: a coffee-shop star schema · ${tables} tables, ${rels} relationships · not saved`);
  assert.equal(ex.tables.length, tables);
  assert.ok(dm.includes('parts.push(`Keep saves it as ${name} in the ${layerLabel} layer (${diagramFile}).`);'));
  assert.match(dbml, /`Project "coffee-shop" \{/);
  // a new folder without dbt has one layer, Main, so the example (EXAMPLE_LAYER 'gold' only when the project has it) goes there
  assert.ok(example.includes("EXAMPLE_LAYER = 'gold'") && example.includes('...(hasExampleLayer ? { layer: EXAMPLE_LAYER } : {})'));
  assert.equal(ex.detail, `Keep saves it as coffee-shop in the ${NEW_LAYER.label} layer (.erd-studio/${NEW_LAYER.id}/diagrams/coffee-shop.dbml).`);
  assert.equal(ex.scope.value, `${tsConst('src/services/draftModel.ts', 'EXAMPLE_COFFEE_SHOP_LABEL')} · ${dm.match(/EXAMPLE_COFFEE_SHOP_TABLES = (\d+)/)[1]} tables`);
  assert.ok(dm.includes("return { label: 'Example',"));
  // the example in a folder: New Diagram… primary, the guide beside it, Keep quiet, the menu, Discard
  assert.ok(dm.includes("keepLabel: KEEP_THIS_EXAMPLE, primary: 'blank', changeOptions: false, shownStarts: ['guide']"));
  assert.deepEqual(ex.buttons, [[START_LABELS.blank, 'primary'], [tsConst('src/types/startActions.ts', 'IMPORT_GUIDE_LABEL'), 'secondary'],
    [tsConst('src/services/draftModel.ts', 'KEEP_THIS_EXAMPLE'), 'quiet'], [tsConst('webview-draft/lib/wording.ts', 'OTHER_WAYS_TO_START'), 'menu'], [tsConst('webview-draft/lib/wording.ts', 'DISCARD'), 'secondary']]);
  // Import DBML…'s draft of sales.dbml: Keep as Diagram primary, the rest in the menu
  assert.ok(dm.includes("case 'dbml': return input.origin ? `Draft ${input.origin}` : `Draft from ${input.fileName ?? 'your DBML file'}`;"));
  assert.equal(sales.headline, `Draft from ${sales.file} · ${sales.tables.length} tables, ${sales.rels.length} relationships · not saved`);
  assert.equal(sales.tab, `Draft: ${sales.file.replace(/\.dbml$/, '')}`);
  assert.equal(sales.detail, `Keep saves it as ${sales.file.replace(/\.dbml$/, '')} in the ${NEW_LAYER.label} layer (.erd-studio/${NEW_LAYER.id}/diagrams/${sales.file.replace(/\.dbml$/, '')}.dbml).`);
  assert.ok(dm.includes('keepLabel: KEEP_AS_DIAGRAM,\n        primary: \'keep\' as const,'));
  assert.ok(dm.includes('shownStarts: [],'));
  assert.deepEqual(sales.buttons.map(([l]) => l), [tsConst('src/services/draftModel.ts', 'KEEP_AS_DIAGRAM'), tsConst('webview-draft/lib/wording.ts', 'OTHER_WAYS_TO_START'), tsConst('webview-draft/lib/wording.ts', 'DISCARD')]);
  assert.ok(wording.includes("export const DISCARD = 'Discard';"));
  // the quick path's layer: the file's, else New Diagram's default (the last creatable layer, Gold)
  assert.ok(read('src', 'commands', 'importDbml.ts').includes("the layer the file names, else New Diagram's default (the last creatable layer)"));
  assert.equal(cmdTitle('erdStudio.importDbml'), editor.NEW_MENU[1]);
});

test('the watch steps and the Help row call these the One-Minute Tour', () => {
  const tour = tsConst('src/types/startActions.ts', 'TOUR_LABEL');
  assert.match(tour, /One-Minute/);
  for (const id of ['watch', 'watchLogical']) assert.equal(wt.steps.find((s) => s.id === id).title, tour);
  assert.equal(cmdTitle('erdStudio.showGettingStarted'), tour);
  assert.ok(script.maxDuration <= 65 && logical.maxDuration <= 65, 'one-minute videos');
  assert.match(read('media', 'walkthrough', 'watch.svg'), />1:0\d</);
  assert.doesNotMatch(wt.steps.find((s) => s.id === 'watchLogical').description, /\bdbt\b/i);
  // The dbt project's watch step describes the default cut: the DBML tour, with dbt last.
  assert.doesNotMatch(wt.steps.find((s) => s.id === 'watch').description, /Draw your dbt project/);
  assert.match(wt.steps.find((s) => s.id === 'watch').description, /DBML/);
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

test('the enrich scene types the real setup command and replies in the skill\'s words', async () => {
  const { PROMPT, REPLY } = await import('../player/scenes/tour/enrich.js');
  assert.ok(read('src', 'types', 'aiAssistants.ts').includes(`'${PROMPT}'`), 'setup prompt');
  const route = flat(read('src', 'harness', 'claude', 'erd-studio-setup', 'references', 'without-dbt.md'));
  // the reference's example names its own diagram: the sales diagram (6 tables)
  const said = REPLY.replace(/<\/?b>/g, '**').replace('**orders** diagram (2 tables)', '**sales** diagram (6 tables)');
  assert.ok(route.includes(said), 'the Without dbt route\'s "Enriching existing tables" opening line');
  const { TABLES } = await import('../player/scenes/tour/tables.js');
  assert.match(REPLY, new RegExp(`\\(${TABLES.length} tables\\)`));
  // the logical cut shows the command typed and says it; the recorded cut says what its toast says
  const line = logical.scenes.find((s) => s.id === 'enrich').lines.find((l) => l.beat === 'setup');
  assert.ok(line.caption.includes(PROMPT) && line.caption.includes(editor.HELP_ROWS[0]));
});

test('the end card names the real steps and the tagline', async () => {
  const { STEPS, TAGLINE, FACTS } = await import('../player/scenes/tour/endCard.js');
  assert.equal(STEPS[0], `Install ${pkg.displayName}`);
  assert.equal(STEPS[1], wt.steps.find((s) => s.id === 'openProject').title);
  assert.equal(STEPS[2], START_LABELS.blank);
  assert.equal(TAGLINE.join(' '), wt.description);
  assert.equal(FACTS[0], 'Free to use');
  // the search hint names the Marketplace id, publisher.name
  assert.equal(editor.EXTENSION.id, `${pkg.publisher}.${pkg.name}`);
  assert.ok(readFileSync(join(SCENES, 'tour', 'endCard.js'), 'utf8').includes('${EXTENSION.id}'));
});

test('New Diagram, the empty canvas, New Table and New Relationship use the product\'s words', async () => {
  const ext = read('src', 'extension.ts');
  const errors = read('src', 'services', 'diagramCommandErrors.ts');
  const { NEW_DIAGRAM } = editor;
  assert.ok(errors.includes(`NEW_DIAGRAM_TITLE = '${NEW_DIAGRAM.title}'`), 'name box title');
  assert.ok(ext.includes(`placeHolder: '${NEW_DIAGRAM.placeholder}'`), 'name box placeholder');
  // a new folder without dbt: one layer (Main), no layer question, and the prompt says where
  assert.ok(ext.includes(': `Name the diagram. It is saved in the ${layerLabel} layer.`,'));
  assert.ok(ext.includes('layerService.useDefaultLayers(NEW_PROJECT_LAYERS_WITHOUT_DBT);'));
  assert.equal(NEW_DIAGRAM.prompt, `Name the diagram. It is saved in the ${NEW_LAYER.label} layer.`);
  assert.ok(read('src', 'commands', 'diagramName.ts').includes('{ message: `Saved as ${slug}`, severity: vscode.InputBoxValidationSeverity.Info }'), 'the Info line');
  assert.equal(NEW_DIAGRAM.savedAs('orders'), 'Saved as orders');
  assert.equal(NEW_DIAGRAM.file, `.erd-studio/${NEW_LAYER.id}/diagrams/${NEW_DIAGRAM.name.toLowerCase()}.dbml`);
  assert.equal(cmdTitle('erdStudio.createDomain'), `${NEW_DIAGRAM.title}…`);

  const { EMPTY_CANVAS, NEW_TABLE, ADD_MENU, NEW_RELATIONSHIP, TABLES } = await import('../player/scenes/tour/tables.js');
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
  const preview = read('src', 'types', 'schemaFolder.ts');
  assert.ok(preview.includes("return `${dir ? `${dir}/` : ''}${layer}/tables/${listed}/${name}.dbml`;"));
  assert.equal(NEW_TABLE.creates('dim_customer'), `Creates .erd-studio/${NEW_LAYER.id}/tables/${NEW_LAYER.id}/dim_customer.dbml`);
  assert.equal(NEW_TABLE.schemaValue, NEW_LAYER.id);

  const tb = read('webview', 'components', 'Toolbar', 'Toolbar.tsx');
  assert.ok(flat(tb).includes('+ Add <span'), '+ Add');
  for (const item of ADD_MENU) assert.ok(flat(tb).includes(`> ${item} </button>`), item);
  assert.ok(tb.includes('{!logicalOnly && <StageTabs'), 'no stage tabs without dbt');

  const fk = flat(read('webview', 'components', 'NewFkDialog', 'NewFkDialog.tsx'));
  const rel = read('webview', 'lib', 'relationshipDialog.ts');
  assert.ok(rel.includes("return `${editing ? 'Edit' : 'New'} ${pairCount > 1 ? 'Composite ' : ''}Relationship`;"));
  assert.equal(NEW_RELATIONSHIP.title, 'New Relationship');
  for (const [label, , emptyOpt] of NEW_RELATIONSHIP.fields.slice(0, 4)) {
    assert.ok(fk.includes(`> ${label} </label>`), label);
    assert.ok(fk.includes(`>${emptyOpt}</option>`), emptyOpt);
  }
  assert.ok(rel.includes(`HOW_MANY_LABEL = '${NEW_RELATIONSHIP.fields[4][0]}'`));
  assert.ok(rel.includes("text: named ? `Many ${from} rows → one ${to}` : 'Many → one'"));
  assert.equal(NEW_RELATIONSHIP.fields[4][1], 'Many fct_order rows → one dim_customer');
  for (const s of [`>${NEW_RELATIONSHIP.preview}<`, `'${NEW_RELATIONSHIP.create}'`, `> ${NEW_RELATIONSHIP.cancel} </button>`]) assert.ok(fk.includes(s), s);
});

test('the files are the 2.0 layer-first DBML a new project writes', async () => {
  const { FILES, TREE } = await import('../player/scenes/tour/files.js');
  const { TABLES } = await import('../player/scenes/tour/tables.js');
  const header = read('packages', 'core', 'src', 'dbmlRichProperties.ts');
  const L = NEW_LAYER.id;   // main: the layer folder, the schema and the relationships file's name
  const rels = FILES[`${L}/relationships/${L}.dbml`];
  assert.ok(header.includes(`'${rels[0]}'`), 'the relationships file header line');
  // the shape (header, use lines, Ref) is the native fixture's, in its gold layer
  const fixture = read('test', 'fixtures', 'dbml-native', '.erd-studio', 'gold', 'relationships', 'gold.dbml');
  assert.ok(fixture.startsWith(rels[0]));
  for (const l of rels.filter((x) => x.startsWith('use '))) assert.match(l, new RegExp(`^use \\{ table ${L}\\.\\w+ \\} +from '\\.\\./tables/${L}/\\w+\\.dbml'$`));
  assert.match(fixture, /^Ref: gold\.fct_order\.customer_key >\? gold\.dim_customer\.customer_key$/m);
  assert.equal(rels.at(-1), `Ref: ${L}.fct_order.customer_key >? ${L}.dim_customer.customer_key`);
  // and what the real recording's take wrote in a new plain folder (record/fixtures.mjs mirrors it)
  assert.ok(read('video', 'record', 'fixtures.mjs').includes(`Ref: ${L}.fct_order.date_key >? ${L}.dim_date.date_key`));
  const fct = FILES[`${L}/tables/${L}/fct_order.dbml`];
  assert.equal(fct[0], `Table ${L}.fct_order {`);
  assert.equal(fct.length, TABLES[1].cols.length + 2);
  TABLES[1].cols.forEach((c, i) => assert.match(fct[i + 1], new RegExp(`^  ${c.name} +${(/\W/.test(c.type) ? `"${c.type}"` : c.type).replace(/[()]/g, '\\$&')}`), c.name));
  assert.match(read('packages', 'core', 'src', 'dbml', 'writeTable.ts'), /\[pk/);
  // New Diagram starting a DBML project writes layers.json and the folder's README.md
  const ext = read('src', 'extension.ts');
  assert.ok(ext.includes('if (createdSemanticDir && dbml) {') && ext.includes('semanticReadmeCreate(fullSemanticDirPath'));
  // the Explorer lists exactly these files, at their 2.0 paths
  const paths = [];
  const stack = [];
  for (const [d, kind, label] of TREE) {
    stack[d] = label;
    if (kind !== 'folder') paths.push(stack.slice(1, d + 1).join('/'));
  }
  assert.deepEqual(paths.sort(), ['README.md', `${L}/diagrams/orders.dbml`, `${L}/relationships/${L}.dbml`, `${L}/tables/${L}/dim_customer.dbml`, `${L}/tables/${L}/fct_order.dbml`, 'layers.json'].sort());
  assert.ok(Object.keys(FILES).every((f) => paths.includes(f)));
});

test('the Export Diagram pick uses the command\'s real rows', async () => {
  const { EXPORT_PICK } = await import('../player/scenes/tour/importDbml.js');
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

// The DBML on screen is byte for byte what a user's file holds: the host formats every file it
// writes (src/services/dbmlWriters.ts formatWrittenDbml), so formatting the shown text changes
// nothing. Runs core's formatDbml through the root's tsx; skipped when the root has no node_modules.
test('the DBML text on screen is already formatted, as ERD Studio writes it', async (t) => {
  const tsx = join(REPO, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) return t.skip('run npm ci at the repo root to check the DBML formatting');
  const { FILES } = await import('../player/scenes/tour/files.js');
  const { FCT_DBML } = await import('../player/hero.js');
  const texts = [...Object.values(FILES), FCT_DBML].map((lines) => `${lines.join('\n')}\n`);
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

test('the side bar is the product\'s: views only once .erd-studio exists, every layer, New Diagram… and New Layer… rows', () => {
  const views = pkg.contributes.views['erd-studio'];
  for (const name of ['Table Library', 'Relationships']) assert.equal(views.find((v) => v.name === name).when, 'erdStudio.hasLogicalModelsDir', name);
  assert.equal(views.find((v) => v.name === 'Table Library').visibility, undefined, 'Table Library opens expanded');
  assert.equal(views.find((v) => v.name === 'Relationships').visibility, 'collapsed');
  // no Table Library or Relationships header before the first diagram writes .erd-studio
  const start = editor.erdSide().html;
  assert.doesNotMatch(start, /TABLE LIBRARY|RELATIONSHIPS/);
  const after = editor.erdSide({ diagrams: editor.ORDERS_TREE }).html;
  assert.match(after, /TABLE LIBRARY/);
  // the Diagrams header's actions: + (New…) and Filter Diagrams… whenever a folder is open
  const titles = pkg.contributes.menus['view/title'];
  assert.ok(titles.some((e) => e.submenu === 'erdStudio.newMenu' && e.when === 'view == erdStudio.domainTree && erdStudio.hasProject'));
  assert.ok(titles.some((e) => e.command === 'erdStudio.filterDiagrams' && /hasProject && !erdStudio\.diagramsFiltered/.test(e.when)));
  // DomainTreeProvider's rows: every layer (a new folder without dbt has one, Main), New Diagram… under an empty one, New Layer… last
  const tree = read('src', 'providers', 'DomainTreeProvider.ts');
  for (const s of ["'New Diagram…',", "item.description = 'none in this layer yet';", "new vscode.TreeItem('New Layer…'", "? 'Layer'", "{ type: 'newLayer' }]"]) assert.ok(tree.includes(s), s);
  assert.deepEqual(editor.ORDERS_TREE.map(([l]) => l), Object.keys(editor.LAYERS));
  const layers = read('src', 'services', 'layerService.ts');
  for (const [label, colour] of Object.entries(editor.LAYERS)) assert.match(layers, new RegExp(`label: '${label}', abbreviation: '\\w+', color: '${colour}'`), label);
  assert.ok(after.includes('New Layer…'));
  // a layer with no diagram yet gets the New Diagram… row
  const empty = editor.erdSide({ diagrams: [[editor.ORDERS_TREE[0][0], []]] }).html;
  for (const s of ["New Diagram…", "none in this layer yet", "New Layer…"]) assert.ok(empty.includes(s), s);
  // an empty library shows its welcome text
  const welcome = pkg.contributes.viewsWelcome.find((w) => w.view === 'erdStudio.modelLibrary' && w.when === '!erdStudio.tablesLoading');
  assert.equal(welcome.contents, editor.LIBRARY_EMPTY.join('\n\n'));
  assert.match(editor.erdSide({ diagrams: editor.ORDERS_TREE, tables: [] }).html, /No tables yet\./);
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

test('the draft pages match what the product draws: Show details, all eight example relationships, no reused table', async () => {
  const { EXAMPLE_DRAFT: ex, SALES_DRAFT: sales, SHOW_DETAILS } = editor;
  assert.equal(SHOW_DETAILS, tsConst('webview-draft/lib/wording.ts', 'SHOW_DETAILS'));
  assert.ok(read('webview-draft', 'components', 'DraftBanner.tsx').includes('const showSecondLine = banner.changeOptions || counts !== \'\' || hasDetails;'));
  assert.ok(ex.details && sales.details, 'an import draft (the example is one) always has details');
  const example = read('src', 'commands', 'openExampleDiagram.ts');
  const fk = (table) => (example.slice(example.indexOf(`Table ${table} `), example.indexOf('\n}', example.indexOf(`Table ${table} `))).match(/ref: >/g) ?? []).length;
  assert.equal(ex.rels.length, fk('fct_orders') + fk('fct_order_items'));
  for (const name of ['fct_orders', 'fct_order_items']) {
    const tb = ex.tables.find((x) => x.name === name);
    assert.equal(tb.cols.filter(([k]) => k === 'FK').length, fk(name), name);
  }
  // a name already in the library would be reused (dbmlImport.ts) and the detail would say so
  const { HERO_TREE } = await import('../player/hero.js');
  const { TABLES } = await import('../player/scenes/tour/tables.js');
  const library = new Set([...TABLES.map((x) => x.name), ...HERO_TREE.filter(([d, k]) => d === 4 && k === 'dbml').map(([, , l]) => l.replace(/\.dbml$/, ''))]);
  for (const tb of sales.tables) assert.ok(!library.has(tb.name), `${tb.name} is already in the library`);
});

test('Import DBML… asks only the name: a new folder without dbt has one layer', async () => {
  const { IMPORT_STEPS } = await import('../player/scenes/tour/importDbml.js');
  const src = read('src', 'commands', 'importDbml.ts');
  assert.ok(src.includes(`const TITLE = '${IMPORT_STEPS.title}';`));
  assert.ok(src.includes("prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,"));
  assert.equal(IMPORT_STEPS.namePrompt, `Name the diagram. It is saved in the ${NEW_LAYER.label} layer.`);
  assert.ok(!('layers' in IMPORT_STEPS) && !('layerPlaceholder' in IMPORT_STEPS), 'no layer pick with one layer');
  assert.equal(`${IMPORT_STEPS.name}.dbml`, editor.SALES_DRAFT.file);
  // one creatable layer: it is the default and nothing is asked (layerWording.ts)
  assert.ok(read('src', 'services', 'layerWording.ts').includes('if (creatableIds.length === 1) return creatableIds[0];'));
  // the recording saw the same prompt in the real product (record/takes.json)
  assert.ok(takes.importDbml.screenText.some((x) => x.startsWith(IMPORT_STEPS.namePrompt)));
});

test('the HTML mocks use the layer a new folder without dbt really gets (Main), as the recording shows', async () => {
  // layerService.ts NEW_PROJECT_LAYERS_WITHOUT_DBT is one layer
  assert.equal(NEW_LAYER.count, 1);
  assert.deepEqual(Object.keys(editor.LAYERS), [NEW_LAYER.label]);
  assert.deepEqual(editor.ORDERS_TREE.map(([l]) => l), [NEW_LAYER.label]);
  assert.deepEqual(editor.ORDERS_LIBRARY.map(([l]) => l), [NEW_LAYER.label]);
  const shown = Object.values(takes).flatMap((s) => s.take === 'plain' ? s.screenText : []);
  for (const s of [editor.EXAMPLE_DRAFT.detail, editor.SALES_DRAFT.detail, editor.NEW_DIAGRAM.prompt]) assert.ok(shown.some((x) => x.startsWith(s)), s);
  // no Silver or Gold anywhere in the player's tour scenes or the GIF
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

test('the default cut films the real VS Code: every scene but the end card, in one of the takes, at the inset\'s size', async () => {
  const { SCENES: ACTIONS, TAKES } = await import('../record/scenes.mjs');
  const { WINDOW, SETTINGS } = await import('../record/vscode.mjs');
  assert.deepEqual(recScenes.map((s) => s.id), script.scenes.slice(0, -1).map((s) => s.id));
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
  // a clean, quiet, isolated editor: no telemetry, no AI chat UI, ERD Studio's own telemetry off, DOM menus (CDP films those)
  for (const [k, v] of Object.entries({ 'telemetry.telemetryLevel': 'off', 'erdStudio.telemetry.enabled': false, 'chat.disableAIFeatures': true, 'window.menuStyle': 'custom', 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true })) assert.deepEqual(SETTINGS[k], v, k);
  const vs = readFileSync(join(HERE, '..', 'record', 'vscode.mjs'), 'utf8');
  assert.match(vs, /--use-mock-keychain/);
  assert.doesNotMatch(vs.replace(/^\s*\/\/.*$/gm, ''), /9333/, 'never the shared CDP port');
  assert.match(readFileSync(join(HERE, '..', 'record', 'driver.mjs'), 'utf8'), /CDP_PORT \|\| 9555/);
});

test('record/takes.json: every recorded scene was filmed for its scene\'s length, its clicks on time and done before the cut', () => {
  for (const s of recScenes) {
    const take = takes[s.id];
    assert.ok(take, `${s.id} was never recorded (node record/record.mjs)`);
    assert.ok(take.busy <= take.dur, `${s.id}: the clicks ran ${take.busy}s into a ${take.dur}s scene`);
    assert.ok(take.late <= 0.6, `${s.id}: a click ran ${take.late}s late`);
    assert.ok(take.screenText.length > 10, s.id);
  }
  assert.deepEqual(Object.keys(takes).sort(), recScenes.map((s) => s.id).sort());
  // the footage matches the timeline it is laid on, when there is one
  const built = join(HERE, '..', 'build', 'timeline.json');
  if (existsSync(built)) {
    const tl = JSON.parse(readFileSync(built, 'utf8'));
    for (const s of tl.scenes.filter((x) => x.module.startsWith('rec/'))) assert.ok(Math.abs(takes[s.id].dur - s.dur) < 0.01, `${s.id}: filmed ${takes[s.id].dur}s, timeline ${s.dur}s: record again`);
  }
});

test('the recording shows dbt only in the dbt beat, and there shows what the line says', () => {
  for (const s of recScenes.filter((x) => !isDbtBeat(x))) {
    for (const text of takes[s.id].screenText) assert.doesNotMatch(text, NO_DBT_ON_SCREEN, `${s.id} showed "${text}"`);
  }
  const dbt = new Set(takes.dbt.screenText);
  // "a Physical tab shows what dbt has", "Click Compare with dbt to mark every difference"
  for (const [, label, hint] of lib.STAGE_TABS) { assert.ok(dbt.has(label), label); assert.ok(dbt.has(`· ${hint}`), hint); }
  for (const w of [lib.COMPARE_WORDS.logical, lib.COMPARE_WORDS.stop, 'only here', 'Only in Logical', 'Only in Physical']) assert.ok(dbt.has(w), w);
});

test('each recorded scene shows the product labels its narration names', () => {
  const shown = (id) => new Set(takes[id].screenText);
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === id).title;
  const expect = {
    install: [pkg.displayName, editor.SIDEBAR_START.text, START_LABELS.blank, tsConst('src/services/draftModel.ts', 'KEEP_THIS_EXAMPLE')],
    newDiagram: [tsConst('src/services/diagramCommandErrors.ts', 'NEW_DIAGRAM_TITLE'), 'orders', 'This diagram is empty', 'New Table'],
    tables: ['New Table', 'Create Table', 'Starter columns (optional)', 'New Relationship', 'Create Relationship', 'dim_date', 'fct_order', '1 relationship'],
    files: ['tables', 'dim_date.dbml', 'fct_order.dbml', 'DBML Table'],
    hook: ['dim_date.dbml', 'fct_order.dbml', 'orders.dbml', '2 tables', '1 relationship'],
    importDbml: [cmd('erdStudio.exportDiagram'), 'Mermaid', 'DBML', 'Rich DBML', cmd('erdStudio.importDbml'), 'sales.dbml', tsConst('src/services/draftModel.ts', 'KEEP_AS_DIAGRAM'), '5 tables'],
    enrich: [cmd('erdStudio.setupAiHelper'), ...editor.HELP_ROWS],
    dbt: [lib.COMPARE_WORDS.logical, 'Physical', 'NUMBER(12,2)', 'order_status'],
  };
  assert.deepEqual(Object.keys(expect).sort(), recScenes.map((s) => s.id).sort());
  for (const [id, labels] of Object.entries(expect)) for (const l of labels) assert.ok(shown(id).has(l), `${id} never showed "${l}"`);
  // the setup line's command is the one the helper's toast and the setup skill use
  const setup = script.scenes.find((s) => s.id === 'enrich').lines.find((l) => l.beat === 'setup');
  assert.ok(setup.caption.includes(cmd('erdStudio.setupAiHelper')));
  // "…then start the guided setup in your assistant": what the helper's toast on screen says
  assert.ok(setup.caption.includes('start the guided setup'));
  assert.ok([...shown('enrich')].some((t) => /^AI helper ready for .*Start the guided setup/.test(t)), 'the toast says to start the guided setup');
  assert.ok([...shown('enrich')].some((t) => /^AI helper ready for /.test(t)), 'Set Up My AI Helper\'s toast');
});

test('the recorded frame: the window\'s bezel and the hook\'s claims, nothing about dbt, the footage fading only where it starts and ends', async () => {
  const mod = (await import('../player/scenes/rec/window.js')).default;
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
  const main = readFileSync(join(HERE, '..', 'player', 'main.js'), 'utf8');
  assert.match(main, /isRec\(scs\[i - 1\]\) \? 1 : pin\) \* \(isRec\(scs\[i \+ 1\]\) \? 1 : 1 - pout\)/);
  const comp = readFileSync(join(HERE, '..', 'record', 'composite.mjs'), 'utf8');
  assert.match(comp, /fade=t=in:st=\$\{start\}:d=\$\{fade\}:alpha=1,fade=t=out:st=\$\{\(end - fade\)/);
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

test('the fixtures are what ERD Studio writes, and the import scene\'s file is new to the library', async () => {
  const fx = readFileSync(join(HERE, '..', 'record', 'fixtures.mjs'), 'utf8');
  // the plain folder opens with nothing to import: sales.dbml arrives just before its scene
  const plain = fx.slice(fx.indexOf('const PLAIN = {'), fx.indexOf('};', fx.indexOf('const PLAIN = {')));
  assert.doesNotMatch(plain, /\.dbml|dbt_project/);
  const { SALES_DBML } = await import('../record/fixtures.mjs');
  for (const t of ['dim_date', 'fct_order']) assert.doesNotMatch(SALES_DBML, new RegExp(`Table ${t} `));
  // every ref optional, as ERD Studio saves them: the draft shows no note about it
  assert.equal((SALES_DBML.match(/\[ref: >\? /g) ?? []).length, 4);
  assert.doesNotMatch(SALES_DBML, /\[ref: > /);
  // the dbt project's design differs from its schema yml on purpose: Compare with dbt has differences to mark
  assert.match(fx, /- name: order_status\n\s+data_type: VARCHAR/);
  assert.match(fx, /amount {10}"DECIMAL\(18,2\)"/);
  assert.match(fx, /data_type: NUMBER\(12,2\)/);
});

test('the fixtures\' DBML is formatted as ERD Studio writes it', async (t) => {
  const tsx = join(REPO, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) return t.skip('run npm ci at the repo root to check the DBML formatting');
  const fx = readFileSync(join(HERE, '..', 'record', 'fixtures.mjs'), 'utf8');
  const texts = [...fx.matchAll(/'\.erd-studio\/main\/[^']+\.dbml': `([\s\S]*?)`,\n/g)].map((m) => m[1].replace(/\\`/g, '`'));
  assert.equal(texts.length, 4);
  const { spawnSync } = await import('node:child_process');
  const code = `import { formatDbml } from ${JSON.stringify(join(REPO, 'packages', 'core', 'src', 'dbml', 'format.ts'))};
    const texts = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(texts.map((x) => { const r = formatDbml(x); return { skipped: r.skipped ?? null, same: r.text === x }; })));`;
  const run = spawnSync(tsx, ['--eval', code, JSON.stringify(texts)], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const [i, r] of JSON.parse(run.stdout.trim().split('\n').at(-1)).entries()) {
    assert.equal(r.skipped, null, `fixture text ${i} did not format`);
    assert.ok(r.same, `fixture text ${i} is not what formatDbml writes`);
  }
});
