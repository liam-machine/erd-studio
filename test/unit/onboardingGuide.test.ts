/**
 * The onboarding guide's pure part (Show Me Around, src/types/onboardingGuide.ts):
 * the steps built from the draft on show (phase A) and from the diagram on
 * the canvas (phase B), with the user's own names; the guide's progress
 * flags; and the action ids a page may send.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  DRAFT_GUIDE_ACTIONS,
  GUIDE_ACTIONS,
  canvasGuideSteps,
  draftGuideSteps,
  draftSourcePhrase,
  guideCanvasDue,
  guideCanvasOwed,
  guideCounts,
  guideDraftDue,
  guideProgress,
  guideRelationship,
  guideTable,
  isCanvasGuideStart,
  isGuideStatus,
  parseGuideAction,
  type GuideStep,
} from '../../src/types/onboardingGuide';
import { draftFrom, draftHeadline } from '../../src/services/draftModel';
import type { DraftView } from '../../src/types/draft';
import type { DisplayRelationship, DisplaySubjectArea, DisplayTable } from '../../src/types/display';

const FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;

const texts = (steps: readonly GuideStep[]): string => steps.map((s) => `${s.title} ${s.text}`).join('\n');
const DBT_WORD = /\bdbt\b/i;

/** A find's draft view: the small fixture with another source and headline. */
function findView(source: DraftView['source'], headline: string, from?: string): DraftView {
  const view = fixture('small');
  return { ...view, source, banner: { ...view.banner, headline, ...(from ? { from } : {}) } };
}

/** The coffee shop in a folder: New Diagram… is the primary, Keep This Example a quiet button. */
function exampleInFolder(): DraftView {
  const view = fixture('example-no-folder');
  return {
    ...view,
    banner: { ...view.banner, keepLabel: 'Keep This Example', primary: 'blank', shownStarts: ['guide'], detail: 'Keep saves it as coffee_shop in the Gold layer (.erd-studio/gold/diagrams/coffee_shop.dbml).' },
    otherStarts: [
      { id: 'blank', label: 'New Diagram…' },
      { id: 'guide', label: 'Import Your Data Model…' },
      { id: 'import', label: 'Import…' },
    ],
  };
}

describe('phase A: the steps on the draft page, per kind of draft', () => {
  it('a SQL find: its own source and counts, More ways to start, then Keep (waiting for the click)', () => {
    const steps = draftGuideSteps({ view: findView('sqlDdl', 'Draft from 2 SQL files (PostgreSQL) · 4 tables, 3 relationships · not saved') });
    expect(steps.map((s) => s.id)).toEqual(['draftBanner', 'draftMoreWays', 'draftKeep']);
    expect(steps[0].text).toBe('This is a draft of your model, drawn from 2 SQL files (PostgreSQL): 3 tables, 2 relationships. Nothing is saved yet.');
    expect(steps[1].text).toBe('Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML. Import Your Data Model… shows how to get it out of Databricks, Snowflake, SQL Server, Fabric and more, into an open format.');
    expect(steps[2].text).toBe('Keep as Diagram makes it your first logical model: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
    expect(steps[2].waitsForClick).toBe(true);
    expect(steps.slice(0, 2).every((s) => !s.waitsForClick)).toBe(true);
    expect(steps[2].anchor).toEqual({ kind: 'target', targets: ['draft-keep', 'draft-primary'] });
  });

  it('prefers the banner\'s own source phrase over the headline', () => {
    const steps = draftGuideSteps({ view: findView('sqlDdl', 'Draft from something else · 3 tables, 2 relationships · not saved', 'from 7 SQL files (MySQL)') });
    expect(steps[0].text).toContain('drawn from 7 SQL files (MySQL): 3 tables, 2 relationships.');
  });

  it('a semantic model', () => {
    const steps = draftGuideSteps({ view: findView('semanticModel', 'Draft from the semantic model Sales · 3 tables, 2 relationships · not saved') });
    expect(steps[0].text).toBe('This is a draft of your model, drawn from the semantic model Sales: 3 tables, 2 relationships. Nothing is saved yet.');
    expect(steps).toHaveLength(3);
  });

  it('a DBML file', () => {
    const steps = draftGuideSteps({ view: findView('dbml', 'Draft from sales.dbml · 3 tables, 2 relationships · not saved') });
    expect(steps[0].text).toBe('This is a draft of your model, drawn from sales.dbml: 3 tables, 2 relationships. Nothing is saved yet.');
  });

  it('a dbt draft: its folder; More ways to start names only what it offers (no import guide)', () => {
    const steps = draftGuideSteps({ view: fixture('dbt'), semanticDir: '.erd-studio' });
    expect(steps[0].text).toBe('This is a draft of your model, drawn from your dbt models in marts/finance: 2 tables, 1 relationship. Nothing is saved yet.');
    expect(steps[1].text).toBe('Is your data model somewhere else? Import… reads SQL scripts, Power BI and Fabric models, and DBML.');
    expect(steps[2].text).toContain('Keep as Diagram makes it your first logical model');
  });

  it('the example, in a folder where nothing was found: says so, and Keep This Example is the step to press', () => {
    const steps = draftGuideSteps({ view: exampleInFolder(), nothingFound: true });
    expect(steps.map((s) => s.id)).toEqual(['draftBanner', 'draftMoreWays', 'draftKeep']);
    expect(steps[0].text).toBe('Nothing here to draw from yet, so this is an example: 2 tables, 1 relationship. Nothing is saved yet.');
    expect(steps[1].anchor).toEqual({ kind: 'target', targets: ['draft-more', 'draft-start-guide'] });
    expect(steps[2].text).toBe('Keep This Example makes it a diagram in this folder: one DBML file per table in .erd-studio/, ready to commit. Press it to continue.');
    expect(steps[2].waitsForClick).toBe(true);
  });

  it('the example the user asked for (not nothing found) does not say nothing was found', () => {
    const steps = draftGuideSteps({ view: exampleInFolder() });
    expect(steps[0].text).toBe('This is an example data model: 2 tables, 1 relationship. Nothing is saved yet.');
  });

  it('the example with no folder open: two steps, the second on Open Folder…, waiting for the click', () => {
    const steps = draftGuideSteps({ view: fixture('example-no-folder'), nothingFound: true });
    expect(steps.map((s) => s.id)).toEqual(['draftBanner', 'draftKeep']);
    expect(steps[0].text).toBe('No folder is open, so this is an example: 2 tables, 1 relationship. Nothing is saved yet.');
    expect(steps[1].text).toMatch(/^Open Folder… opens the folder your data model lives in\./);
    expect(steps[1].anchor).toEqual({ kind: 'target', targets: ['draft-primary'] });
    expect(steps[1].waitsForClick).toBe(true);
  });

  it('a bundled example project: Save This Example… is the step to press', () => {
    const view = fixture('example-no-folder');
    const steps = draftGuideSteps({ view: { ...view, source: 'exampleProject', banner: { ...view.banner, keepLabel: 'Save This Example…', primary: 'keep' } } });
    expect(steps.at(-1)?.text).toBe('Save This Example… copies it to a folder of its own and opens it there, ready to explore. Press it to continue.');
  });

  it('names the semantic dir the project uses', () => {
    const steps = draftGuideSteps({ view: fixture('small'), semanticDir: 'design/erd' });
    expect(steps.at(-1)?.text).toContain('one DBML file per table in design/erd/, ready to commit');
  });

  it('says no dbt word in a guide for a draft that is not dbt', () => {
    for (const view of [fixture('small'), findView('semanticModel', 'Draft from the semantic model Sales · 1 table, no relationships · not saved'), exampleInFolder(), fixture('example-no-folder')]) {
      for (const nothingFound of [false, true]) expect(texts(draftGuideSteps({ view, nothingFound }))).not.toMatch(DBT_WORD);
    }
  });
});

describe('the source phrase and counts', () => {
  it('draftFrom is the headline\'s source part, for finds only', () => {
    expect(draftFrom({ source: 'sqlDdl', tables: 4, relationships: 3, origin: 'from 2 SQL files (PostgreSQL)' })).toBe('from 2 SQL files (PostgreSQL)');
    expect(draftFrom({ source: 'dbt', tables: 2, relationships: 1, folder: 'marts' })).toBe('from your dbt models in marts');
    expect(draftFrom({ source: 'dbml', tables: 2, relationships: 1, fileName: 'sales.dbml' })).toBe('from sales.dbml');
    expect(draftFrom({ source: 'example', tables: 6, relationships: 6 })).toBeUndefined();
    expect(draftHeadline({ source: 'dbml', tables: 2, relationships: 1, fileName: 'sales.dbml' })).toBe('Draft from sales.dbml · 2 tables, 1 relationship · not saved');
  });

  it('draftSourcePhrase falls back to the headline, and is undefined for an example', () => {
    expect(draftSourcePhrase(fixture('small'))).toBe('from 4 SQL files (PostgreSQL)');
    expect(draftSourcePhrase(fixture('example-no-folder'))).toBeUndefined();
  });

  it('counts as the banner does', () => {
    expect(guideCounts(1, 0)).toBe('1 table, no relationships');
    expect(guideCounts(1204, 1)).toBe('1,204 tables, 1 relationship');
    expect(guideProgress(1, 7)).toBe('2 of 7');
  });
});

// ---------------------------------------------------------------------------
// Phase B
// ---------------------------------------------------------------------------

const table = (name: string): DisplayTable => ({ name, columns: [] } as unknown as DisplayTable);
const rel = (fromModel: string, toModel: string, extra: Partial<DisplayRelationship> = {}): DisplayRelationship => ({
  fromModel, fromColumn: `${toModel}_id`, toModel, toColumn: 'id', cardinality: 'many-to-one', ...extra,
});
function display(models: string[], relationships: DisplayRelationship[] = []): Pick<DisplaySubjectArea, 'models' | 'relationships'> {
  return { models: models.map(table), relationships };
}

describe('phase B: the steps on the canvas', () => {
  const shop = display(['dim_customer', 'dim_product', 'fct_order_line'], [rel('fct_order_line', 'dim_customer'), rel('fct_order_line', 'dim_product')]);

  it('names a real table (the best-connected), a real relationship, and ends with the star', () => {
    const steps = canvasGuideSteps({ display: shop, hasDbt: false, dbml: true });
    expect(steps.map((s) => s.id)).toEqual(['canvasTable', 'canvasRelationship', 'canvasToolbar', 'canvasSidebar', 'canvasFiles', 'canvasFinish']);
    expect(steps.filter((s) => s.note).map((s) => [s.id, s.note])).toEqual([['canvasFinish', 'Show Me Around in Help & Feedback runs this guide again.']]);
    expect(steps[0].text).toMatch(/^fct_order_line is one of your 3 tables\. Click a table to change its columns, types and keys/);
    expect(steps[0].anchor).toEqual({ kind: 'table', table: 'fct_order_line' });
    expect(steps[1].text).toBe('fct_order_line → dim_customer (many-to-one). Press and hold a column, then drag it onto a column of another table to add a relationship.');
    expect(steps[1].anchor).toEqual({ kind: 'relationship', from: 'fct_order_line', to: 'dim_customer' });
    expect(steps[3]).toMatchObject({ anchor: { kind: 'leftEdge' }, onShow: 'revealSidebar' });
    expect(steps[3].text).toContain('Diagrams lists your diagrams, Table Library every table, Relationships every link.');
    expect(steps[4].text).toBe('Your model is plain DBML in .erd-studio/ — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.');
    expect(steps[4].buttons).toEqual([{ action: 'aiHelper', label: 'Set Up My AI Helper' }]);
    expect(steps[5]).toMatchObject({ finish: true, anchor: { kind: 'none' }, buttons: [{ action: 'star', label: 'Star on GitHub' }] });
    expect(steps[5].text).toBe("You're set up. If ERD Studio helps you, a star on GitHub helps other modellers find it.");
  });

  it('in a dbt project, adds the Logical / Physical step', () => {
    const steps = canvasGuideSteps({ display: shop, hasDbt: true, dbml: true });
    expect(steps.map((s) => s.id)).toContain('canvasStages');
    expect(steps.find((s) => s.id === 'canvasStages')?.text).toBe('Logical is your design. Physical is what your dbt project builds; switch to compare them and sync the differences.');
  });

  it('says no dbt word outside a dbt project', () => {
    expect(texts(canvasGuideSteps({ display: shop, hasDbt: false, dbml: true }))).not.toMatch(DBT_WORD);
    expect(texts(canvasGuideSteps({ display: shop, hasDbt: false, dbml: false }))).not.toMatch(DBT_WORD);
  });

  it('with no relationship, skips the relationship step', () => {
    const steps = canvasGuideSteps({ display: display(['a', 'b']), hasDbt: false, dbml: true });
    expect(steps.map((s) => s.id)).toEqual(['canvasTable', 'canvasToolbar', 'canvasSidebar', 'canvasFiles', 'canvasFinish']);
    expect(steps).toHaveLength(5);
  });

  it('one table, and an empty diagram', () => {
    expect(canvasGuideSteps({ display: display(['only']), hasDbt: false, dbml: true })[0].text).toMatch(/^only is your one table so far\./);
    const empty = canvasGuideSteps({ display: display([]), hasDbt: false, dbml: true });
    expect(empty.map((s) => s.id)).toEqual(['canvasToolbar', 'canvasSidebar', 'canvasFiles', 'canvasFinish']);
    expect(empty[0].text).toMatch(/^\+ Add puts your first table on the diagram/);
  });

  it('a project from before 2.0 is not called DBML', () => {
    const files = canvasGuideSteps({ display: shop, hasDbt: false, dbml: false, semanticDir: 'model' }).find((s) => s.id === 'canvasFiles')!;
    expect(files.text).toBe('Your model is plain text files in model/ — commit them with your code. Your AI assistant can read and edit them; Set Up My AI Helper teaches it the format.');
  });

  it('prefers a table in view, and a relationship of that table', () => {
    expect(guideTable(shop, ['dim_product'])).toBe('dim_product');
    expect(guideTable(shop, [])).toBe('fct_order_line');
    expect(guideTable(shop, ['not_here'])).toBe('fct_order_line');
    expect(guideRelationship(shop, 'dim_product')).toMatchObject({ fromModel: 'fct_order_line', toModel: 'dim_product' });
    expect(canvasGuideSteps({ display: shop, hasDbt: false, dbml: true, visibleTables: ['dim_product'] })[1].text).toMatch(/^fct_order_line → dim_product/);
  });

  it('counts a composite relationship once', () => {
    const composite = display(['a', 'b'], [rel('a', 'b', { compositeKey: 'k', fromColumn: 'x' }), rel('a', 'b', { compositeKey: 'k', fromColumn: 'y' }), rel('b', 'a')]);
    expect(guideTable(composite)).toBe('a');
  });
});

describe('the guide\'s progress on this machine', () => {
  it('phase A on the first draft only; again when the command asks', () => {
    expect(guideDraftDue(undefined, false)).toBe(true);
    for (const status of ['draft', 'canvas', 'done', 'skipped'] as const) {
      expect(guideDraftDue(status, false)).toBe(false);
      expect(guideDraftDue(status, true)).toBe(true);
    }
  });

  it('phase B on the first diagram after phase A only; again when the command asks; skip ends it', () => {
    expect(guideCanvasDue('draft', false)).toBe(true);
    for (const status of [undefined, 'canvas', 'done', 'skipped'] as const) expect(guideCanvasDue(status, false)).toBe(false);
    expect(guideCanvasDue('skipped', true)).toBe(true);
    expect(guideCanvasOwed('draft')).toBe(true);
    expect(guideCanvasOwed('skipped')).toBe(false);
  });

  it('reads only the statuses it writes', () => {
    expect(['draft', 'canvas', 'done', 'skipped'].every(isGuideStatus)).toBe(true);
    expect([undefined, 'started', 1, null].some(isGuideStatus)).toBe(false);
  });
});

describe('what a page may send', () => {
  it('accepts each fixed action, rebuilt from its checked fields', () => {
    expect(GUIDE_ACTIONS).toEqual(['step', 'skip', 'complete', 'star', 'aiHelper', 'revealSidebar']);
    for (const action of ['skip', 'complete', 'star', 'aiHelper', 'revealSidebar']) expect(parseGuideAction({ action })).toEqual({ action });
    expect(parseGuideAction({ action: 'step', step: 'canvasTable' })).toEqual({ action: 'step', step: 'canvasTable' });
    expect(parseGuideAction({ action: 'star', url: 'https://evil.example' })).toEqual({ action: 'star' });
  });

  it.each([
    undefined, null, [], 'star', {}, { action: 'open' }, { action: 'runCommand', command: 'x' },
    { action: 'step' }, { action: 'step', step: 'nope' }, { action: 'skip', step: 'canvasTable' }, { action: 1 },
  ])('refuses %j', (raw) => {
    expect(parseGuideAction(raw)).toBeUndefined();
  });

  it('the draft page may send only step and skip', () => {
    expect(DRAFT_GUIDE_ACTIONS).toEqual(['step', 'skip']);
    expect(parseGuideAction({ action: 'star' }, DRAFT_GUIDE_ACTIONS)).toBeUndefined();
    expect(parseGuideAction({ action: 'skip' }, DRAFT_GUIDE_ACTIONS)).toEqual({ action: 'skip' });
  });

  it('a canvas start says how the project stores its files, nothing else', () => {
    expect(isCanvasGuideStart({ dbml: true, semanticDir: '.erd-studio' })).toBe(true);
    expect(isCanvasGuideStart({ dbml: 'yes', semanticDir: '.erd-studio' })).toBe(false);
    expect(isCanvasGuideStart({ dbml: true })).toBe(false);
    expect(isCanvasGuideStart(null)).toBe(false);
  });
});
