// The steps every first-60-seconds story shares (stories 15–22, `realistic:
// true`): VS Code as a person has it (every prompt on, its Welcome page
// open), ERD Studio installed in the window as from the Marketplace, the
// first interruption (or none), the one click to the draft or the next step,
// and the rest of the first minute watched for anything else popping up.
// See docs/dev/onboarding-stories.md → "The first 60 seconds".

import { Noise } from './noise.mjs';

/** Given VS Code with `folder` open (undefined: no folder), before ERD Studio is installed. */
export async function givenVSCode(s, folder, { caption, say } = {}) {
  await s.step(caption ?? (folder ? `Given VS Code as I use it, with my ${folder} folder open` : 'Given VS Code as I use it, with no folder open'), async () => {
    if (folder) await s.eventually(async () => (await s.ui.windowTitle()).includes(folder), { message: `the ${folder} folder did not open` });
    else s.expect(!(await s.ui.windowTitle()).includes(' — '), 'expected an empty window');
    s.expect(!(await s.wb.ev(`!!${s.sel.activity('ERD Studio')}`)), 'ERD Studio should not be installed yet');
    await s.pause(1200);
  }, { say });
}

/** When I install ERD Studio (the interruption clock starts as Install is pressed). */
export async function installStep(s) {
  await s.step('When I install ERD Studio from the Marketplace', async () => {
    await s.installErdStudio();
    await s.wb.highlight(s.sel.activity('ERD Studio'));
    await s.pause(1200);
    await s.wb.unhighlight();
  }, { say: 'When I install ERD Studio. Here, from its package, as the Marketplace would.' });
}

/** The interruption so far must be none (ERD Studio waits until I turn to it). */
export async function nothingPopsUp(s, { wait = 8000, caption = 'Nothing pops up: ERD Studio waits until I turn to it' } = {}) {
  await s.step(caption, async () => {
    await s.noise.until(Math.min(60000, s.noise.elapsed() * 1000 + wait));
    const erd = s.noise.unasked({ origin: 'erd' });
    s.expect(erd.length === 0, `nothing should pop up before I turn to ERD Studio, but: ${Noise.describe(erd)}`);
    await s.pause(800);
  });
}

/** Wait for the one interruption `kind` whose text matches `pattern`; resolves the event. */
export async function theOneInterruption(s, kind, pattern, { timeout = 30000 } = {}) {
  return s.eventually(() => s.noise.events.find((e) => e.kind === kind && !e.asked && pattern.test(e.text)), { timeout, message: `no ${kind} matching ${pattern} (saw: ${Noise.describe(s.noise.events)})` });
}

/** For the rest of the first minute, nothing else: at most one unasked interruption from ERD Studio. */
export async function quietFirstMinute(s, { max = 1 } = {}) {
  let result;
  await s.step('For the rest of its first minute, nothing else interrupts me', async () => {
    result = await s.expectQuietFirstMinute({ max });
  }, { say: max === 0 ? 'For the rest of its first minute, nothing interrupts me.' : 'For the rest of its first minute, nothing else interrupts me.' });
  return result;
}
