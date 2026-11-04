// A folder of CREATE TABLE scripts, and ERD Studio's tour tab ("ERD Studio
// Tour"), opened from the Help & Feedback view's "Watch the One-Minute Tour"
// row. Its "Ways to start, in short videos" section holds a clip per start
// the extension ships (no dbt clip outside a dbt project), the SQL one
// (media/onboarding/stories/import-sql-scripts.mp4, published from story 04
// by `run.mjs --publish`) among them. Proves the clip waits for a click, and
// that it really plays in VS Code's webview with its narration (H.264
// decodes: its time moves on; the MP3 audio decodes: Chromium counts the
// audio bytes it decoded), pausing the tour.

import { story } from '../lib/story.mjs';

const CLIP = `doc.querySelector('.gs-howto [data-clip="importSqlDdl"]')`;
const START = 'Import your SQL scripts';

export default story({
  id: 'welcome-tab-watch-how',
  title: 'Watch how to import my SQL scripts',
  persona: 'As someone with a folder of SQL scripts, new to ERD Studio',
  want: 'I want to see how the suggested start works before I try it',
  soThat: 'so that I know what will happen to my files',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  // The Welcome tab's path: no start-suggestion popup over it.
  settings: { 'erdStudio.startSuggestions': false },
  steps: async (s) => {
    await s.step('Given my project folder with SQL scripts in database/', async () => {
      s.expectNoFile('.erd-studio');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    }, { say: 'Given my project folder, with SQL scripts in a database folder.' });

    const TOUR_ROW = s.sel.sidebarRow('Watch the One-Minute Tour');
    await s.step('When I open the ERD Studio sidebar, Help & Feedback has the tour', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink(START), { what: `the "${START}" button (the suggestion has been published)` });
      // The tour is a row of the Help & Feedback view (expanded here if it is collapsed), never a second button beside the start.
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [START], 'the start should be the empty Diagrams view\'s one button');
      if (!(await s.wb.ev(`!!${TOUR_ROW}`))) await s.wb.click(s.sel.viewHeader('Help & Feedback'));
      await s.expectVisible(TOUR_ROW, { what: 'the "Watch the One-Minute Tour" row of Help & Feedback' });
      await s.wb.highlight(TOUR_ROW);
      await s.pause(1000);
      await s.wb.unhighlight();
      await s.wb.click(TOUR_ROW);
      await s.ui.waitForActiveTab('ERD Studio Tour');
    });

    let welcome;
    await s.step('Its short videos show each way to start, mine among them', async () => {
      welcome = await s.webview();
      await welcome.waitFor(`doc.body.innerText.includes('The one-minute tour') && ${CLIP}`, { what: 'the tour tab with its short videos' });
      const captions = await welcome.ev(`[...doc.querySelectorAll('.gs-howto__item')].filter(f => !f.hidden).map(f => f.querySelector('.gs-howto__caption').textContent.trim())`);
      s.expect(captions.includes(START), `the short videos should include "${START}": ${captions.join(' | ')}`);
      // No dbt video in a folder without dbt_project.yml.
      s.expect(!captions.some((c) => /\bdbt\b/i.test(c)), `no dbt video outside a dbt project: ${captions.join(' | ')}`);
      const title = await welcome.ev(`doc.querySelector('.gs-howto-section .gs-section-title').textContent.trim()`);
      s.assert.equal(title, 'Ways to start, in short videos');
      await welcome.ev(`(${CLIP}.closest('.gs-howto-section').scrollIntoView({ block: 'start' }), true)`);
      await welcome.highlight(`${CLIP}.closest('.gs-howto-section')`);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step(`"${START}" is a short clip, waiting for me`, async () => {
      const clip = await welcome.waitFor(`(() => { const v=${CLIP}; return v && !v.closest('[hidden]') && { src: v.currentSrc || v.querySelector('source')?.src || '', muted: v.muted, paused: v.paused, autoplay: v.autoplay }; })()`, { what: 'the SQL clip' });
      s.expect(clip.src.includes('import-sql-scripts.mp4'), `the clip should be the SQL one, but is ${clip.src}`);
      s.expect(clip.paused && !clip.autoplay, `the clip should wait for a click: ${JSON.stringify(clip)}`);
      s.expect(!clip.muted, `the clip is narrated: it should play with sound, but is muted: ${JSON.stringify(clip)}`);
      await welcome.highlight(CLIP);
      await s.pause(1500);
      await s.wb.unhighlight();
    });

    await s.step('When I press play, it plays, and the tour above stops', async () => {
      // The tour plays on its own on this page (muted when the editor refuses sound).
      // Make sure it is playing now, so the check below proves the clip paused it.
      const TOUR = `doc.querySelector('video:not(.gs-howto__clip)')`;
      await welcome.ev(`(() => { const v=${TOUR}; if (v && v.paused) { v.muted = true; v.play().catch(() => {}); } return true; })()`);
      await welcome.waitFor(`(() => { const v=${TOUR}; return !!v && !v.paused; })()`, { timeout: 10000, what: 'the tour to be playing before the clip starts' });
      // The controls' play button: bottom left of the clip, above its timeline.
      const r = await welcome.rect(CLIP);
      await s.wb.clickAt({ x: r.x + 24, y: r.y + r.height - 48 });
      const playing = await welcome.waitFor(`(() => { const v=${CLIP}; return !v.paused && v.currentTime > 1.5 && v.readyState >= 2 && { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, muted: v.muted, volume: v.volume, audioBytes: v.webkitAudioDecodedByteCount }; })()`, { timeout: 20000, what: 'the clip to play (its time to move on)' });
      s.expect(playing.w === 1280, `the clip should be 1280 px wide, but is ${playing.w}`);
      s.expect(!playing.muted && playing.volume > 0, `the clip should play with sound: ${JSON.stringify(playing)}`);
      // Chromium's count of decoded audio bytes (Electron has it): 0 would mean VS Code could not decode the narration (AAC).
      if (playing.audioBytes !== undefined) s.expect(playing.audioBytes > 0, `the clip's narration should decode in VS Code (MP3), but no audio was decoded: ${JSON.stringify(playing)}`);
      const tourPaused = await welcome.ev(`(() => { const v=${TOUR}; return !!v && v.paused; })()`);
      s.expect(tourPaused, 'playing the clip should pause the tour');
      await s.pause(4000);
    });
  },
});
