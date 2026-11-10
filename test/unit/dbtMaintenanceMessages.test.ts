/**
 * The words for Refresh Manifest and Strip Legacy Domain Tags (#263): each
 * says whose problem it is and offers the button that moves it on.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';

import { RUN_DBT_PARSE_ACTION } from '../../src/commands/runDbtParse';
import {
  RUN_DBT_PARSE_BUTTON,
  manifestStaleNotice,
  manifestTimeoutFeedbackPrefill,
  skippedFileItems,
  stripTagsSummary,
} from '../../src/services/dbtMaintenanceMessages';

const shown = 'target/manifest.json';

describe('Refresh Manifest on a stale manifest', () => {
  it('says dbt is still writing it on the first try, when there is an earlier copy to show', () => {
    expect(manifestStaleNotice('malformed', { shown, hasLastKnownGood: true, retried: false })).toEqual({
      level: 'warning',
      message: 'dbt is still writing target/manifest.json. Diagrams show the last version ERD Studio could read.',
      buttons: ['Try Again'],
    });
    expect(manifestStaleNotice('midWrite', { shown, hasLastKnownGood: true, retried: false }).buttons).toEqual(['Try Again']);
  });

  it('says the file dbt wrote is the problem once the retry fails, and never "try again shortly"', () => {
    const notice = manifestStaleNotice('malformed', { shown, hasLastKnownGood: true, retried: true });
    expect(notice.message).toContain("ERD Studio can't read target/manifest.json: it isn't valid JSON.");
    expect(notice.message).toContain('not in your diagrams');
    expect(notice.message).toContain('Run dbt parse');
    expect(notice.message).toContain('the last version ERD Studio could read');
    expect(notice.message).not.toMatch(/shortly/);
    expect(notice.buttons).toEqual(['Run dbt parse', 'Open File']);
  });

  it('never claims to show the last good data when there is none', () => {
    const notice = manifestStaleNotice('malformed', { shown, hasLastKnownGood: false, retried: false });
    expect(notice.message).toContain('isn\'t valid JSON');
    expect(notice.message).toContain('no dbt manifest data until it is rebuilt');
    expect(notice.message).not.toContain('last version');
    expect(notice.buttons).toEqual(['Run dbt parse', 'Open File']);
  });

  it('says a manifest that stays empty lists no models, rather than that it is not JSON', () => {
    const notice = manifestStaleNotice('midWrite', { shown, hasLastKnownGood: true, retried: true });
    expect(notice.message).toContain('lists no dbt models');
    expect(notice.message).not.toContain('valid JSON');
  });

  it('says a timeout is ERD Studio\'s limit, with Try Again and Send Feedback', () => {
    const notice = manifestStaleNotice('timeout', { shown, hasLastKnownGood: true, retried: true });
    expect(notice.level).toBe('error');
    expect(notice.message).toContain('This is a limit in ERD Studio, not a problem with your project.');
    expect(notice.buttons).toEqual(['Try Again', 'Send Feedback']);
    expect(JSON.stringify(manifestTimeoutFeedbackPrefill())).not.toMatch(/[/\\\\]Users|[A-Z]:\\\\/);
  });

  it('labels Run dbt parse exactly as the rest of ERD Studio does', () => {
    expect(RUN_DBT_PARSE_BUTTON).toBe(RUN_DBT_PARSE_ACTION);
  });
});

describe('Strip Legacy Domain Tags summary', () => {
  const root = path.join(path.sep, 'work', 'shop');
  const skipped = [
    { path: path.join(root, 'models', 'a.yml'), reason: 'parse' as const },
    { path: path.join(root, 'models', 'b.yml'), reason: 'write' as const },
  ];

  it('offers Show Modified Files alone when nothing was skipped', () => {
    expect(stripTagsSummary({ filesScanned: 9, filesModified: 2, tagsRemoved: 3, skipped: [] })).toEqual({
      level: 'info',
      message: 'Removed 3 tags from 2 files. Review the diff before committing.',
      buttons: ['Show Modified Files'],
    });
  });

  it('says how many files were left alone, without "see Output", and offers Show Skipped Files', () => {
    const notice = stripTagsSummary({ filesScanned: 9, filesModified: 1, tagsRemoved: 1, skipped });
    expect(notice.message).toBe("Removed 1 tag from 1 file. Review the diff before committing. 2 files couldn't be changed; nothing in them was touched.");
    expect(notice.message).not.toMatch(/Output/);
    expect(notice.buttons).toEqual(['Show Modified Files', 'Show Skipped Files']);
  });

  it('says nothing was removed but files were skipped, with Show Skipped Files', () => {
    const notice = stripTagsSummary({ filesScanned: 9, filesModified: 0, tagsRemoved: 0, skipped });
    expect(notice.level).toBe('warning');
    expect(notice.buttons).toEqual(['Show Skipped Files']);
  });

  it('says no tags were found when there was nothing to skip', () => {
    expect(stripTagsSummary({ filesScanned: 1, filesModified: 0, tagsRemoved: 0, skipped: [] })).toEqual({
      level: 'info', message: 'No legacy domain tags found. Scanned 1 YAML file.', buttons: [],
    });
  });

  it('lists each skipped file project-relative, with why and whose to fix', () => {
    const items = skippedFileItems(skipped, root);
    expect(items.map((i) => i.label)).toEqual(['models/a.yml', 'models/b.yml']);
    expect(items[0].description).toBe('not valid YAML. Fix it and run the command again.');
    expect(items[1].description).toContain("couldn't be written");
    expect(items[1].fullPath).toBe(skipped[1].path);
  });
});
