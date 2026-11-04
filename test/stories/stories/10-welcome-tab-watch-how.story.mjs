// A folder of CREATE TABLE scripts, and ERD Studio's Welcome tab. The quick
// look at the folder makes "Import your SQL scripts" the start card's one
// primary button, with its reason line, and the card's "Watch how" slot
// holds the clip for that start (media/onboarding/stories/import-sql-scripts.mp4,
// published from story 04 by `run.mjs --publish`). Proves the tab is reached
// from the empty Diagrams view's "Get started" link, the clip shown is the
// suggestion's, it is silent and waits for a click, and that it really plays
// in VS Code's webview (H.264 decodes: its time moves on), pausing the tour.

import { story } from '../lib/story.mjs';

const CLIP = `doc.querySelector('[data-step="begin"] .gs-howto [data-clip="importSqlDdl"]')`;
const START = 'Import your SQL scripts';

export default story({
  id: 'welcome-tab-watch-how',
  title: 'Watch how to import my SQL scripts',
  persona: 'As someone with a folder of SQL scripts, new to ERD Studio',
  want: 'I want to see how the suggested start works before I try it',
  soThat: 'so that I know what will happen to my files',
  workspace: { name: 'shop-database', add: { database: 'test/fixtures/sql-ddl/postgres' } },
  steps: async (s) => {
    await s.step('Given my project folder with SQL scripts in database/', async () => {
      s.expectNoFile('.erd-studio');
      await s.eventually(async () => (await s.ui.windowTitle()).includes('shop-database'), { message: 'the shop-database folder did not open' });
    });

    await s.step('When I open the ERD Studio sidebar and click "Get started"', async () => {
      await s.ui.openSidebar('ERD Studio');
      await s.expectVisible(s.sel.welcomeLink(START), { what: `the "${START}" button (the suggestion has been published)` });
      const link = s.sel.welcomeLink('Get started');
      await s.expectVisible(link, { what: 'the "Get started" link' });
      // A link in a sentence, not a second button beside the start.
      s.assert.deepEqual(await s.wb.ev(s.sel.welcomeButtons), [START], '"Get started" should be a link, the start the one button');
      await s.wb.highlight(link);
      await s.pause(1000);
      await s.wb.unhighlight();
      await s.wb.click(link);
      await s.ui.waitForActiveTab('Welcome to ERD Studio');
    });

    let welcome;
    await s.step(`Then the Welcome tab leads with "${START}", and says why`, async () => {
      welcome = await s.webview();
      const primary = await welcome.waitFor(`(() => { const b=[...doc.querySelectorAll('[data-step="begin"] .gs-btn--primary')].filter(b => b.offsetParent); return b.length === 1 && b[0].textContent.trim(); })()`, { what: 'the start card\'s one primary button' });
      s.assert.equal(primary, START, `the start card's primary button should be the suggestion, but it is "${primary}"`);
      const reason = await welcome.ev(`[...doc.querySelectorAll('[data-step="begin"] .gs-step__reason')].filter(r => !r.hidden).map(r => r.textContent.trim())`);
      s.assert.deepEqual(reason, ['This folder has CREATE TABLE scripts.']);
      await welcome.ev(`(${CLIP}.closest('[data-step="begin"]').scrollIntoView({ block: 'start' }), true)`);
      await welcome.highlight(`doc.querySelector('[data-step="begin"]')`);
      await s.pause(2000);
      await s.wb.unhighlight();
    });

    await s.step('And "Watch how" shows a short clip of that start, silent, waiting for me', async () => {
      const clip = await welcome.waitFor(`(() => { const v=${CLIP}; return v && !v.closest('[hidden]') && { src: v.currentSrc || v.querySelector('source')?.src || '', muted: v.muted, paused: v.paused, autoplay: v.autoplay }; })()`, { what: 'the SQL clip in the start card' });
      s.expect(clip.src.includes('import-sql-scripts.mp4'), `the clip should be the SQL one, but is ${clip.src}`);
      s.expect(clip.muted && clip.paused && !clip.autoplay, `the clip should wait, silent, for a click: ${JSON.stringify(clip)}`);
      const title = await welcome.ev(`${CLIP}.closest('.gs-howto').querySelector('.gs-howto__title').textContent.trim()`);
      s.assert.equal(title, 'Watch how (a short clip, no sound)');
      // Only the suggestion's clip shows.
      s.assert.equal(await welcome.ev(`[...doc.querySelectorAll('.gs-howto__clip')].filter(v => !v.hidden).length`), 1);
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
      const playing = await welcome.waitFor(`(() => { const v=${CLIP}; return !v.paused && v.currentTime > 1.5 && v.readyState >= 2 && { t: v.currentTime, w: v.videoWidth, h: v.videoHeight }; })()`, { timeout: 20000, what: 'the clip to play (its time to move on)' });
      s.expect(playing.w === 1280, `the clip should be 1280 px wide, but is ${playing.w}`);
      const tourPaused = await welcome.ev(`(() => { const v=${TOUR}; return !!v && v.paused; })()`);
      s.expect(tourPaused, 'playing the clip should pause the tour');
      await s.pause(4000);
    });
  },
});
