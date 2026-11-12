/**
 * The major update notice's rule and state (src/services/majorUpdateNotice.ts):
 * when it is owed, the one catch-up look, and what is written when. Its
 * place among the window's prompts: `activationPrompts.test.ts`; end to end:
 * `extension.activate.test.ts` → "the major update notice".
 */
import { describe, expect, it } from 'vitest';

import {
  MAJOR_NOTICE_CATCH_UP_KEY,
  MAJOR_NOTICE_NOT_NOW,
  MAJOR_NOTICE_OWED_KEY,
  MAJOR_NOTICE_SHOWN_KEY,
  MARKDOWN_PREVIEW_COMMAND,
  WHATS_NEW_FILE,
  WHATS_NEW_LABEL,
  majorNoticeDue,
  majorOf,
  majorUpdateNoticeMessage,
  majorUpdateOwes,
  markMajorNoticeShown,
  noteMajorUpdate,
  type MajorNoticeState,
  type MajorUpdateEvidence,
} from '../../src/services/majorUpdateNotice';
import { FEATURES } from '../../src/services/telemetryPayload';

const NOTHING: MajorUpdateEvidence = { majorUpdateSeen: false, guideStarted: false };
const SEEN: MajorUpdateEvidence = { majorUpdateSeen: true, guideStarted: false };

function memory(initial: Record<string, unknown> = {}): MajorNoticeState & { map: Map<string, unknown>; writes: string[] } {
  const map = new Map<string, unknown>(Object.entries(initial));
  const writes: string[] = [];
  return {
    map,
    writes,
    get: (key) => map.get(key),
    update: async (key, value) => { writes.push(key); map.set(key, value); },
  };
}

/** A machine that has already run a version with the notice: the catch-up has had its look. */
const LOOKED = { [MAJOR_NOTICE_CATCH_UP_KEY]: true };

describe('majorOf', () => {
  it('reads the major of a released version, a pre-release and a tagged one', () => {
    expect(majorOf('2.0.3')).toBe(2);
    expect(majorOf('1.9.9')).toBe(1);
    expect(majorOf('0.6.47')).toBe(0);
    expect(majorOf('10.2.0')).toBe(10);
    expect(majorOf('3.0.0-beta.1')).toBe(3);
    expect(majorOf('3.0.0+build.7')).toBe(3);
    expect(majorOf(' 2.0.3 ')).toBe(2);
  });

  it('has no major for anything else, and never throws', () => {
    for (const value of [undefined, null, '', ' ', 'garbage', '2', '2.0', '2.x.0', 'v2.0.0', '2.0.0 beta', '-1.0.0', '1e3.0.0', '99999999.0.0',
      2, 2.5, true, {}, [], ['2.0.0'], Symbol('2.0.0'), () => '2.0.0', '2.0.0\n3.0.0']) {
      expect(majorOf(value), String(value)).toBeUndefined();
    }
  });
});

describe('majorUpdateOwes', () => {
  const owes = (previous: unknown, current: unknown, evidence = NOTHING, catchUp = false) => majorUpdateOwes({ previous, current, catchUp, evidence });

  it('an older major last activated owes it; a pre-release of the older major is that major', () => {
    expect(owes('1.7.4', '2.0.3')).toBe(true);
    expect(owes('1.9.9', '2.0.0')).toBe(true);
    expect(owes('0.6.47', '2.0.3')).toBe(true);
    expect(owes('2.4.1', '3.0.0')).toBe(true);
  });

  it('a patch or minor update, the same version, a downgrade and a fresh install do not', () => {
    expect(owes('2.0.2', '2.0.3')).toBe(false);
    expect(owes('2.0.3', '2.1.0')).toBe(false);
    expect(owes('2.0.3', '2.0.3')).toBe(false);
    expect(owes('1.7.4', '1.9.9')).toBe(false);
    expect(owes('3.0.0', '2.0.3')).toBe(false);
    expect(owes(undefined, '2.0.3')).toBe(false);
  });

  it('a version that does not parse, on either side, never owes it', () => {
    for (const bad of ['garbage', '', '2', null, 7, {}, 'v1.0.0']) {
      expect(owes(bad, '2.0.3'), `previous ${String(bad)}`).toBe(false);
      expect(owes(bad, '2.0.3', SEEN, true), `previous ${String(bad)}, catch-up`).toBe(false);
      expect(owes('1.7.4', bad), `current ${String(bad)}`).toBe(false);
    }
  });

  it('the catch-up: already on this major, the machine recorded a major update and never had the guide', () => {
    expect(owes('2.0.2', '2.0.3', SEEN, true)).toBe(true);
    expect(owes('2.0.3', '2.0.3', SEEN, true)).toBe(true);
    // Nothing recorded (telemetry off, or a fresh 2.x install): never guessed.
    expect(owes('2.0.2', '2.0.3', NOTHING, true)).toBe(false);
    // The guide has already started there: the notice has nothing to say.
    expect(owes('2.0.2', '2.0.3', { majorUpdateSeen: true, guideStarted: true }, true)).toBe(false);
    // Only on its one look, only on the same major, never for a fresh install or a downgrade.
    expect(owes('2.0.2', '2.0.3', SEEN, false)).toBe(false);
    expect(owes('3.0.0', '2.0.3', SEEN, true)).toBe(false);
    expect(owes(undefined, '2.0.3', SEEN, true)).toBe(false);
  });
});

describe('noteMajorUpdate, majorNoticeDue and markMajorNoticeShown', () => {
  it('1.7.4 to 2.0.3: owed for 2, kept through later activations until it shows, then never again for 2', async () => {
    const state = memory(LOOKED);
    await noteMajorUpdate(state, '1.7.4', '2.0.3', NOTHING);
    expect(state.map.get(MAJOR_NOTICE_OWED_KEY)).toBe(2);
    expect(state.map.get(MAJOR_NOTICE_SHOWN_KEY)).toBeUndefined();
    expect(majorNoticeDue(state, '2.0.3')).toBe(2);

    // The next windows: the version last activated is 2.0.3 now. It is still due, and nothing is written again.
    state.writes.length = 0;
    await noteMajorUpdate(state, '2.0.3', '2.0.3', NOTHING);
    await noteMajorUpdate(state, '2.0.3', '2.0.4', NOTHING);
    expect(state.writes).toEqual([]);
    expect(majorNoticeDue(state, '2.0.4')).toBe(2);

    expect(await markMajorNoticeShown(state, '2.0.4')).toBe(2);
    expect(state.map.get(MAJOR_NOTICE_SHOWN_KEY)).toBe(2);
    expect(majorNoticeDue(state, '2.0.4')).toBeUndefined();
    // A second mark (the guide run from the notice's own button) has nothing to do.
    state.writes.length = 0;
    expect(await markMajorNoticeShown(state, '2.0.4')).toBeUndefined();
    expect(state.writes).toEqual([]);
    await noteMajorUpdate(state, '2.0.4', '2.1.0', SEEN);
    expect(majorNoticeDue(state, '2.1.0')).toBeUndefined();
  });

  it('a later major owes it again', async () => {
    const state = memory({ ...LOOKED, [MAJOR_NOTICE_OWED_KEY]: 2, [MAJOR_NOTICE_SHOWN_KEY]: 2 });
    await noteMajorUpdate(state, '2.4.0', '3.0.0', NOTHING);
    expect(state.map.get(MAJOR_NOTICE_OWED_KEY)).toBe(3);
    expect(majorNoticeDue(state, '3.0.0')).toBe(3);
    expect(await markMajorNoticeShown(state, '3.0.1')).toBe(3);
    expect(majorNoticeDue(state, '3.0.1')).toBeUndefined();
  });

  it('one owed for 2 and never shown is replaced by 3; back on 2.x after a downgrade nothing is due', async () => {
    const state = memory({ ...LOOKED, [MAJOR_NOTICE_OWED_KEY]: 2 });
    await noteMajorUpdate(state, '2.0.3', '3.0.0', NOTHING);
    expect(state.map.get(MAJOR_NOTICE_OWED_KEY)).toBe(3);
    await noteMajorUpdate(state, '3.0.0', '2.0.3', NOTHING);
    expect(state.map.get(MAJOR_NOTICE_OWED_KEY)).toBe(3);
    expect(majorNoticeDue(state, '2.0.3')).toBeUndefined();
    expect(await markMajorNoticeShown(state, '2.0.3')).toBeUndefined();
  });

  it('2.0.2 to 2.0.3 and a fresh install owe nothing and write only the catch-up mark, once', async () => {
    for (const previous of ['2.0.2', undefined]) {
      const state = memory();
      await noteMajorUpdate(state, previous, '2.0.3', NOTHING);
      expect(state.writes, String(previous)).toEqual([MAJOR_NOTICE_CATCH_UP_KEY]);
      expect(state.map.get(MAJOR_NOTICE_CATCH_UP_KEY)).toBe(true);
      expect(majorNoticeDue(state, '2.0.3')).toBeUndefined();
      await noteMajorUpdate(state, '2.0.3', '2.0.3', NOTHING);
      expect(state.writes).toEqual([MAJOR_NOTICE_CATCH_UP_KEY]);
    }
  });

  it('the catch-up is looked at once: a machine on 2.0.2 that recorded its major update is owed it, a later record changes nothing', async () => {
    const caught = memory();
    await noteMajorUpdate(caught, '2.0.2', '2.0.3', SEEN);
    expect(caught.map.get(MAJOR_NOTICE_OWED_KEY)).toBe(2);
    expect(caught.map.get(MAJOR_NOTICE_CATCH_UP_KEY)).toBe(true);
    expect(majorNoticeDue(caught, '2.0.3')).toBe(2);

    // Nothing recorded on the one look (telemetry off): left out. A record that appears later is not a reason.
    const left = memory();
    await noteMajorUpdate(left, '2.0.2', '2.0.3', NOTHING);
    expect(left.map.get(MAJOR_NOTICE_OWED_KEY)).toBeUndefined();
    await noteMajorUpdate(left, '2.0.3', '2.0.3', SEEN);
    await noteMajorUpdate(left, '2.0.3', '2.0.4', SEEN);
    expect(left.map.get(MAJOR_NOTICE_OWED_KEY)).toBeUndefined();
    expect(majorNoticeDue(left, '2.0.4')).toBeUndefined();

    // A fresh 2.x install that later goes down from 3.x and back never reads as an upgrader from 1.x.
    const fresh = memory();
    await noteMajorUpdate(fresh, undefined, '2.0.3', NOTHING);
    await noteMajorUpdate(fresh, '3.0.0', '2.0.3', SEEN);
    await noteMajorUpdate(fresh, '2.0.3', '2.0.4', SEEN);
    expect(majorNoticeDue(fresh, '2.0.4')).toBeUndefined();
  });

  it('a version that does not parse writes nothing and is never due', async () => {
    for (const bad of ['garbage', '', undefined, null, 3, {}]) {
      const state = memory();
      await expect(noteMajorUpdate(state, '1.7.4', bad, SEEN)).resolves.toBeUndefined();
      expect(state.writes, String(bad)).toEqual([]);
      expect(majorNoticeDue(memory({ [MAJOR_NOTICE_OWED_KEY]: 2 }), bad)).toBeUndefined();
      expect(await markMajorNoticeShown(memory({ [MAJOR_NOTICE_OWED_KEY]: 2 }), bad)).toBeUndefined();
    }
    // A malformed version last activated: no throw, nothing owed.
    for (const bad of ['garbage', '', null, 3, {}, '2.0.0.0.0 beta']) {
      const state = memory(LOOKED);
      await expect(noteMajorUpdate(state, bad, '2.0.3', SEEN)).resolves.toBeUndefined();
      expect(state.writes, String(bad)).toEqual([]);
    }
  });

  it('stored values that are not whole numbers are ignored', () => {
    for (const owed of ['2', 2.5, true, null, {}, -2, Number.NaN]) {
      expect(majorNoticeDue(memory({ [MAJOR_NOTICE_OWED_KEY]: owed }), '2.0.3'), String(owed)).toBeUndefined();
    }
    for (const shown of ['2', 2.5, true, null, {}, Number.NaN, 1]) {
      expect(majorNoticeDue(memory({ [MAJOR_NOTICE_OWED_KEY]: 2, [MAJOR_NOTICE_SHOWN_KEY]: shown }), '2.0.3'), String(shown)).toBe(2);
    }
    expect(majorNoticeDue(memory({ [MAJOR_NOTICE_OWED_KEY]: 2, [MAJOR_NOTICE_SHOWN_KEY]: 3 }), '2.0.3')).toBeUndefined();
  });

  it('state that throws never reaches the caller, and a mark that cannot be saved shows nothing', async () => {
    const broken: MajorNoticeState = {
      get: () => { throw new Error('storage gone'); },
      update: async () => { throw new Error('storage gone'); },
    };
    await expect(noteMajorUpdate(broken, '1.7.4', '2.0.3', SEEN)).resolves.toBeUndefined();
    expect(majorNoticeDue(broken, '2.0.3')).toBeUndefined();
    await expect(markMajorNoticeShown(broken, '2.0.3')).resolves.toBeUndefined();

    const readOnly: MajorNoticeState = {
      get: (key) => (key === MAJOR_NOTICE_OWED_KEY ? 2 : undefined),
      update: async () => { throw new Error('read-only'); },
    };
    expect(majorNoticeDue(readOnly, '2.0.3')).toBe(2);
    // Unmarked, it would show in every window: it is not shown at all.
    await expect(markMajorNoticeShown(readOnly, '2.0.3')).resolves.toBeUndefined();
  });
});

describe('the words and the fixed targets', () => {
  it('one short sentence naming the running major, and calling the guide a guide (the tour is the video)', () => {
    expect(majorUpdateNoticeMessage(2)).toBe('ERD Studio 2.0 has a short guide that shows you around.');
    expect(majorUpdateNoticeMessage(3)).toBe('ERD Studio 3.0 has a short guide that shows you around.');
    expect(majorUpdateNoticeMessage(2)).not.toMatch(/tour|\?|free|AI/i);
    expect(majorUpdateNoticeMessage(2).split('. ')).toHaveLength(1);
  });

  it('the labels, the bundled file and the preview command are constants; the keys are globalState keys of ours', () => {
    expect(WHATS_NEW_LABEL).toBe("What's New");
    expect(MAJOR_NOTICE_NOT_NOW).toBe('Not now');
    expect(WHATS_NEW_FILE).toBe('CHANGELOG.md');
    expect(MARKDOWN_PREVIEW_COMMAND).toBe('markdown.showPreview');
    for (const key of [MAJOR_NOTICE_OWED_KEY, MAJOR_NOTICE_SHOWN_KEY, MAJOR_NOTICE_CATCH_UP_KEY]) expect(key).toMatch(/^erdStudio\.majorUpdateNotice\.[a-zA-Z]+$/);
    expect(new Set([MAJOR_NOTICE_OWED_KEY, MAJOR_NOTICE_SHOWN_KEY, MAJOR_NOTICE_CATCH_UP_KEY]).size).toBe(3);
  });

  it('its three telemetry keys follow the Fabric card\'s, in this order (later keys are appended after them)', () => {
    const at = FEATURES.indexOf('majorUpdateNoticeShown');
    expect(FEATURES[at - 1]).toBe('importFabricOutcomeTimedOut');
    expect(FEATURES.slice(at, at + 3)).toEqual(['majorUpdateNoticeShown', 'majorUpdateNoticeShowMeAround', 'majorUpdateNoticeWhatsNew']);
  });
});
