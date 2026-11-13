import { describe, expect, it, vi } from 'vitest';

import { convertNoticeMessage, convertOfferApplies, convertRowShows } from '../../src/services/convertOffer';

const yaml = { storage: 'yaml' as const, declined: false, offerSetting: true };

describe('where a project from before 2.0 is offered Convert', () => {
  it('the sidebar row: a YAML or mixed project, unless turned down here or everywhere', () => {
    expect(convertRowShows(yaml)).toBe(true);
    expect(convertRowShows({ ...yaml, storage: 'mixed' })).toBe(true);
    expect(convertRowShows({ ...yaml, storage: 'dbml' })).toBe(false);
    expect(convertRowShows({ ...yaml, declined: true })).toBe(false);
    expect(convertRowShows({ ...yaml, offerSetting: false })).toBe(false);
  });

  it('the opening notice: the canvas offer\'s checks, the file listing only once the cheap ones pass', () => {
    const candidates = vi.fn(() => ({ files: 2, tablesDirIsLayer: false }));
    const goesNowhere = vi.fn(() => false);
    expect(convertOfferApplies({ ...yaml, candidates, goesNowhere })).toBe(true);
    expect(convertOfferApplies({ ...yaml, candidates: () => ({ files: 0, tablesDirIsLayer: false }), goesNowhere })).toBe(false);
    expect(convertOfferApplies({ ...yaml, candidates: () => ({ files: 3, tablesDirIsLayer: true }), goesNowhere })).toBe(false);
    expect(convertOfferApplies({ ...yaml, candidates, goesNowhere: () => true })).toBe(false);
    candidates.mockClear();
    expect(convertOfferApplies({ ...yaml, declined: true, candidates, goesNowhere })).toBe(false);
    expect(convertOfferApplies({ ...yaml, storage: 'dbml', candidates, goesNowhere })).toBe(false);
    expect(candidates).not.toHaveBeenCalled();
  });

  it('the canvas\'s information button (#305): the same rule, case by case', () => {
    const candidates = () => ({ files: 4, tablesDirIsLayer: false });
    const goesNowhere = () => false;
    const shows = (over: Partial<Parameters<typeof convertOfferApplies>[0]> = {}): boolean =>
      convertOfferApplies({ ...yaml, candidates, goesNowhere, ...over });
    expect(shows()).toBe(true);
    expect(shows({ storage: 'mixed' })).toBe(true);
    expect(shows({ storage: 'dbml' })).toBe(false);
    expect(shows({ declined: true })).toBe(false);
    expect(shows({ offerSetting: false })).toBe(false);
    expect(shows({ candidates: () => ({ files: 0, tablesDirIsLayer: false }) })).toBe(false);
    expect(shows({ candidates: () => ({ files: 4, tablesDirIsLayer: true }) })).toBe(false);
    // A refused run with nothing changed since: the button would lead to the same refusal (the sidebar row stays).
    expect(shows({ goesNowhere: () => true })).toBe(false);
    expect(convertRowShows({ ...yaml })).toBe(true);
  });

  it('says what the project has, that DBML is an open format, and that the diagrams stay', () => {
    expect(convertNoticeMessage(1)).toBe('This project has 1 ERD Studio diagram, from an older ERD Studio. Convert it once to DBML, an open format: your diagrams stay as they are.');
    expect(convertNoticeMessage(3)).toMatch(/^This project has 3 ERD Studio diagrams, /);
    expect(convertNoticeMessage(3)).not.toMatch(/open standard|\bdbt\b|YAML|JSON/);
  });
});
