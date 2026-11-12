/**
 * The glass sidebar's `when` clause evaluator (`src/providers/glassSidebar/whenClause.ts`):
 * VS Code's grammar and semantics, failing closed on anything it cannot read,
 * and able to read every clause this extension's package.json gives the four
 * sidebar views (so a new clause it cannot read fails here, not silently in
 * the sidebar).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  evaluateWhen,
  isSupportedWhenClause,
  parseWhenClause,
  WhenClauseError,
  type ContextValue,
} from '../../src/providers/glassSidebar/whenClause';

const ROOT = path.join(__dirname, '../..');
const SIDEBAR_VIEWS = ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships', 'erdStudio.help'];

type Ctx = Record<string, ContextValue>;

describe('evaluateWhen: grammar and semantics', () => {
  const cases: Array<[string, string, Ctx, boolean]> = [
    // [name, clause, context, expected]
    ['bare key, truthy', 'a', { a: true }, true],
    ['bare key, string is truthy', 'a', { a: 'x' }, true],
    ['bare key, empty string is falsy', 'a', { a: '' }, false],
    ['bare key, 0 is falsy', 'a', { a: 0 }, false],
    ['bare key, unknown is falsy', 'a', {}, false],
    ['dotted key', 'erdStudio.hasProject', { 'erdStudio.hasProject': true }, true],
    ['true literal', 'true', {}, true],
    ['false literal', 'false', {}, false],
    ['!true', '!true', {}, false],
    ['negation', '!a', { a: false }, true],
    ['negation of unknown', '!a', {}, true],
    ['double negation', '!!a', { a: 1 }, true],
    ['negation with space', '! a', { a: true }, false],

    ['== unquoted', 'view == erdStudio.domainTree', { view: 'erdStudio.domainTree' }, true],
    ['== unquoted, other value', 'view == erdStudio.domainTree', { view: 'erdStudio.modelLibrary' }, false],
    ['== single-quoted', "viewItem == 'domain'", { viewItem: 'domain' }, true],
    ['== double-quoted with spaces', 'k == "a b"', { k: 'a b' }, true],
    ['== quoted empty string', "k == ''", { k: '' }, true],
    ['== unknown key is false', 'k == x', {}, false],
    ['== is case-sensitive', 'k == Yaml', { k: 'yaml' }, false],
    ['== no spaces', 'k==x', { k: 'x' }, true],
    ['=== alias', 'k === x', { k: 'x' }, true],
    ['!= differs', 'erdStudio.storage != dbml', { 'erdStudio.storage': 'yaml' }, true],
    ['!= same', 'erdStudio.storage != dbml', { 'erdStudio.storage': 'dbml' }, false],
    ['!= unknown key is true', 'erdStudio.storage != dbml', {}, true],
    ['!== alias', 'k !== x', { k: 'y' }, true],
    ['!= no spaces', 'k!=x', { k: 'x' }, false],

    ['numeric == 0 with number 0', 'workspaceFolderCount == 0', { workspaceFolderCount: 0 }, true],
    ['numeric == 0 with number 1', 'workspaceFolderCount == 0', { workspaceFolderCount: 1 }, false],
    ['numeric == 0 with unknown key', 'workspaceFolderCount == 0', {}, false],
    ['numeric == 0 with string "0"', 'workspaceFolderCount == 0', { workspaceFolderCount: '0' }, true],
    ['numeric != 0', 'workspaceFolderCount != 0', { workspaceFolderCount: 2 }, true],
    ['numeric == 2.5', 'n == 2.5', { n: 2.5 }, true],
    ['number never equals an empty literal', "n == ''", { n: 0 }, false],

    ['== true is the key', 'a == true', { a: 'yes' }, true],
    ['== true, falsy', 'a == true', { a: 0 }, false],
    ['== false is !key', 'a == false', { a: undefined }, true],
    ['!= true is !key', 'a != true', { a: false }, true],
    ['!= false is the key', 'a != false', { a: true }, true],
    ['== boolean value against text', "a == 'true'", { a: true }, true],

    ['=~ simple', 'k =~ /^dbml$/', { k: 'dbml' }, true],
    ['=~ alternation in parentheses', 'erdStudio.storage =~ /^(dbml|mixed)$/', { 'erdStudio.storage': 'mixed' }, true],
    ['=~ alternation, no match', 'erdStudio.storage =~ /^(dbml|mixed)$/', { 'erdStudio.storage': 'yaml' }, false],
    ['=~ anchors', 'k =~ /^(dbml|mixed)$/', { k: 'dbmlx' }, false],
    ['=~ escaped dot', 'view =~ /^erdStudio\\.(domainTree|modelLibrary)$/', { view: 'erdStudio.modelLibrary' }, true],
    ['=~ escaped dot is not any character', 'view =~ /^erdStudio\\.x$/', { view: 'erdStudioZx' }, false],
    ['=~ escaped slash', 'p =~ /a\\/b/', { p: 'xa/by' }, true],
    ['=~ slash inside a class', 'p =~ /a[/]b/', { p: 'a/b' }, true],
    ['=~ optional group', 'viewItem =~ /^logicalModel(Duplicate|ReadOnly)?$/', { viewItem: 'logicalModel' }, true],
    ['=~ optional group, suffix', 'viewItem =~ /^logicalModel(Duplicate|ReadOnly)?$/', { viewItem: 'logicalModelReadOnly' }, true],
    ['=~ prefix', 'viewItem =~ /^layer/', { viewItem: 'layerCreatable' }, true],
    ['=~ i flag', 'k =~ /^DBML$/i', { k: 'dbml' }, true],
    ['=~ without i flag', 'k =~ /^DBML$/', { k: 'dbml' }, false],
    ['=~ g flag stays stateless', 'k =~ /a/g', { k: 'a' }, true],
    ['=~ unknown key', 'k =~ /.*/', {}, false],
    ['=~ number value as text', 'n =~ /^4/', { n: 42 }, true],
    ['=~ then &&', 'k =~ /^a$/ && b', { k: 'a', b: true }, true],
    ['=~ regex then )', '(k =~ /^(a|b)$/)', { k: 'b' }, true],

    ['&&, both', 'a && b', { a: 1, b: 1 }, true],
    ['&&, one', 'a && b', { a: 1 }, false],
    ['||, one', 'a || b', { b: 1 }, true],
    ['||, none', 'a || b', {}, false],
    ['&& binds tighter than || (left)', 'a || b && c', { a: true }, true],
    ['&& binds tighter than || (right)', 'a || b && c', { b: true }, false],
    ['&& binds tighter than ||, (a && b) || c', 'a && b || c', { c: true }, true],
    ['! binds tighter than &&', '!a && b', { a: false, b: true }, true],
    ['! binds tighter than ||', '!a || b', { a: true, b: false }, false],
    ['parentheses override precedence', '(a || b) && c', { a: true }, false],
    ['parentheses, all', '(a || b) && c', { b: true, c: true }, true],
    ['negated parentheses', '!(a || b)', {}, true],
    ['nested parentheses', '((a))', { a: 1 }, true],
    ['comparison inside &&', 'view == x && viewItem == y', { view: 'x', viewItem: 'y' }, true],

    ['whitespace: tabs and newlines', '\ta\n&&\r\n  b ', { a: 1, b: 1 }, true],
    ['whitespace: none around ops', 'a&&!b||c', { a: 1 }, true],

    ['< number', 'n < 3', { n: 2 }, true],
    ['<= number', 'n <= 2', { n: 2 }, true],
    ['> number', 'n > 2', { n: 2 }, false],
    ['>= number', 'n >= 2', { n: 2 }, true],
    ['> numeric string', 'n > 1', { n: '2' }, true],
    ['> unknown key is false', 'n > 1', {}, false],
    ['< non-numeric value is false', 'n < 1', { n: 'abc' }, false],

    ['in array', 'k in list', { k: 'b', list: ['a', 'b'] }, true],
    ['in array, absent', 'k in list', { k: 'c', list: ['a', 'b'] }, false],
    ['in object own key', 'k in obj', { k: 'a', obj: { a: 1 } }, true],
    ['in object, prototype key is not own', 'k in obj', { k: 'toString', obj: {} }, false],
    ['not in', 'k not in list', { k: 'c', list: ['a'] }, true],
    ['in unknown source', 'k in list', { k: 'a' }, false],
  ];

  it.each(cases)('%s: %s', (_name, clause, ctx, expected) => {
    expect(isSupportedWhenClause(clause)).toBe(true);
    expect(evaluateWhen(clause, ctx)).toBe(expected);
  });

  it('no clause, or a blank one, holds', () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
    expect(evaluateWhen('', {})).toBe(true);
    expect(evaluateWhen('   ', {})).toBe(true);
  });

  it('takes a lookup function, a Map or a plain object', () => {
    const clause = 'view == erdStudio.domainTree && erdStudio.hasProject';
    const values: Ctx = { view: 'erdStudio.domainTree', 'erdStudio.hasProject': true };
    expect(evaluateWhen(clause, (key) => values[key])).toBe(true);
    expect(evaluateWhen(clause, new Map(Object.entries(values)))).toBe(true);
    expect(evaluateWhen(clause, values)).toBe(true);
    expect(evaluateWhen(clause, new Map())).toBe(false);
  });

  it('reads only own keys of a plain-object context (no Object.prototype)', () => {
    expect(evaluateWhen('toString', {})).toBe(false);
    expect(evaluateWhen('constructor', {})).toBe(false);
    expect(evaluateWhen('__proto__', {})).toBe(false);
    expect(evaluateWhen('hasOwnProperty != x', {})).toBe(true);
  });

  it('caches the parse but evaluates against each context afresh', () => {
    const clause = 'erdStudio.relationshipsGrouping == file';
    expect(evaluateWhen(clause, { 'erdStudio.relationshipsGrouping': 'file' })).toBe(true);
    expect(evaluateWhen(clause, { 'erdStudio.relationshipsGrouping': 'table' })).toBe(false);
    expect(parseWhenClause(clause)).toBe(parseWhenClause(clause));
  });
});

describe('evaluateWhen: fails closed', () => {
  const unparseable: Array<[string, string]> = [
    ['dangling &&', 'a &&'],
    ['leading &&', '&& a'],
    ['dangling ||', 'a ||'],
    ['single &', 'a & b'],
    ['single |', 'a | b'],
    ['single =', 'a = b'],
    ['missing )', '(a && b'],
    ['stray )', 'a)'],
    ['empty parentheses', '()'],
    ['missing value after ==', 'a =='],
    ['missing value after !=', 'a != && b'],
    ['=~ without a regex', 'a =~ b'],
    ['unterminated regex', 'a =~ /abc'],
    ['invalid regex body', 'a =~ /(/'],
    ['unknown regex flag', 'a =~ /a/x'],
    ['unterminated string', "a == 'b"],
    ['two keys', 'a b'],
    ['lone !', '!'],
    ['comparison without a number', 'a < b'],
    ['not without in', 'a not b'],
    ['in without a source', 'a in'],
    ['true == x (true is a keyword)', 'true == x'],
  ];

  it.each(unparseable)('%s (%s) is false and never throws', (_name, clause) => {
    expect(isSupportedWhenClause(clause)).toBe(false);
    // Even a context that would make the readable part true leaves the entry hidden.
    expect(() => evaluateWhen(clause, { a: true, b: true, x: true })).not.toThrow();
    expect(evaluateWhen(clause, { a: true, b: true, x: true })).toBe(false);
    // …and asking twice (the cached failure) is still false.
    expect(evaluateWhen(clause, { a: true, b: true })).toBe(false);
  });

  it('parseWhenClause throws a WhenClauseError, every time', () => {
    expect(() => parseWhenClause('a &&')).toThrow(WhenClauseError);
    expect(() => parseWhenClause('a &&')).toThrow(WhenClauseError);
    expect(() => parseWhenClause('a =~ /(/')).toThrow(WhenClauseError);
  });

  it('a lookup that throws is false, not an exception', () => {
    const boom = () => { throw new Error('boom'); };
    expect(evaluateWhen('a', boom)).toBe(false);
  });

  it('a clause that is not a string is false', () => {
    expect(evaluateWhen(42 as unknown as string, {})).toBe(false);
  });
});

/** Every `when` the four sidebar views take from package.json: views, viewsWelcome, view/title, view/item/context and the submenus they open. */
function sidebarWhenClauses(): Array<{ where: string; when: string }> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: {
      views: Record<string, Array<{ id: string; when?: string }>>;
      viewsWelcome: Array<{ view: string; when?: string }>;
      menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>>;
    };
  };
  const c = pkg.contributes;
  const out: Array<{ where: string; when: string }> = [];
  for (const [container, views] of Object.entries(c.views)) {
    for (const v of views) if (SIDEBAR_VIEWS.includes(v.id) && v.when) out.push({ where: `views.${container}.${v.id}`, when: v.when });
  }
  c.viewsWelcome.forEach((w, i) => {
    if (SIDEBAR_VIEWS.includes(w.view) && w.when) out.push({ where: `viewsWelcome[${i}]`, when: w.when });
  });
  const menus = ['view/title', 'view/item/context'];
  const seen = new Set<string>();
  while (menus.length > 0) {
    const menu = menus.shift() as string;
    if (seen.has(menu)) continue;
    seen.add(menu);
    (c.menus[menu] ?? []).forEach((e, i) => {
      if (e.when) out.push({ where: `menus["${menu}"][${i}]`, when: e.when });
      if (e.submenu) menus.push(e.submenu);
    });
  }
  return out;
}

describe("package.json: every sidebar clause is inside the evaluator's grammar", () => {
  const clauses = sidebarWhenClauses();

  it('finds the clauses (the collector reads the real manifest)', () => {
    expect(clauses.some((c) => c.where.startsWith('views.'))).toBe(true);
    expect(clauses.some((c) => c.where.startsWith('viewsWelcome'))).toBe(true);
    expect(clauses.some((c) => c.where.startsWith('menus["view/title"]'))).toBe(true);
    expect(clauses.some((c) => c.where.startsWith('menus["view/item/context"]'))).toBe(true);
    expect(clauses.some((c) => c.where.startsWith('menus["erdStudio.newMenu"]'))).toBe(true);
    expect(clauses.some((c) => c.when.includes('=~'))).toBe(true);
    expect(clauses.some((c) => c.when.includes('workspaceFolderCount == 0'))).toBe(true);
  });

  it.each(clauses.map((c) => [c.where, c.when]))('%s parses: %s', (_where, when) => {
    expect(() => parseWhenClause(when)).not.toThrow();
  });
});

describe('package.json clauses evaluate as VS Code would', () => {
  it('the welcome "Loading diagrams…" clause (parentheses, !=, || inside &&)', () => {
    const clause = 'erdStudio.hasProject && (erdStudio.diagramsLoading || (!erdStudio.hasDbtProject && erdStudio.storage != yaml && erdStudio.storage != mixed && !erdStudio.startIntent))';
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true, 'erdStudio.diagramsLoading': true, 'erdStudio.storage': 'yaml' })).toBe(true);
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true })).toBe(true);
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true, 'erdStudio.storage': 'dbml' })).toBe(true);
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true, 'erdStudio.storage': 'mixed' })).toBe(false);
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true, 'erdStudio.startIntent': 'blank' })).toBe(false);
    expect(evaluateWhen(clause, { 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': true })).toBe(false);
    expect(evaluateWhen(clause, { 'erdStudio.diagramsLoading': true })).toBe(false);
  });

  it('the row-details regex over view ids', () => {
    const clause = 'view =~ /^erdStudio\\.(domainTree|modelLibrary|relationships)$/ && erdStudio.hasProject && erdStudio.sidebarRowDetails != full';
    for (const view of ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships']) {
      expect(evaluateWhen(clause, { view, 'erdStudio.hasProject': true })).toBe(true);
      expect(evaluateWhen(clause, { view, 'erdStudio.hasProject': true, 'erdStudio.sidebarRowDetails': 'full' })).toBe(false);
    }
    expect(evaluateWhen(clause, { view: 'erdStudio.help', 'erdStudio.hasProject': true })).toBe(false);
  });
});
