/**
 * The root README and Common questions (docs/faq.md): one idea (logical data modelling in Git,
 * stored as DBML), in the order and words docs/dev/onboarding-and-cli.md → "User-facing wording"
 * sets, the start screen's own labels, and links that resolve.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IMPORT_GUIDE_LABEL, MORE_STARTS_LABEL, START_ACTIONS, START_ACTION_LABELS, TOUR_LABEL } from '../../src/types/startActions';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const README = read('README.md');
const FAQ = read('docs/faq.md');

/** The README's prose: no code blocks, no HTML tags (badge and alt text), no link targets. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\]\([^)]*\)/g, ']');
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('the README', () => {
  it('leads with the tagline and keeps its sections in order', () => {
    expect(README).toContain('<strong>Design your data model in Git. Let your AI build from it.</strong>');
    const headings = [...README.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['What it is', 'The ways to start', "What's in your repo", 'Work with your AI assistant', 'Using dbt?', 'Learn more']);
  });

  it('is about 700 words of prose', () => {
    const words = prose(README).match(/[A-Za-z0-9][\w'’.\-/…]*/g) ?? [];
    expect(words.length).toBeGreaterThanOrEqual(600);
    expect(words.length).toBeLessThanOrEqual(800);
  });

  it('names the starts with the start screen\'s own labels, and lists neither Convert nor Draw from dbt as a start', () => {
    const starts = section(README, 'The ways to start');
    for (const label of [
      START_ACTION_LABELS.blank, START_ACTION_LABELS.importDbmlFile, START_ACTION_LABELS.importSqlDdl,
      START_ACTION_LABELS.importSemanticModel, START_ACTION_LABELS.example, START_ACTION_LABELS.import,
      MORE_STARTS_LABEL, IMPORT_GUIDE_LABEL, TOUR_LABEL,
    ]) expect(starts, label).toContain(label);
    expect(starts).not.toContain(START_ACTION_LABELS.convert);
    expect(starts).not.toContain(START_ACTION_LABELS.drawFromDbt);
    expect(starts).not.toMatch(/\bdbt\b/);
  });

  it('lists the three imports in the start screen\'s order (the first that applies leads)', () => {
    const starts = section(README, 'The ways to start');
    const imports = START_ACTIONS.filter((a) => ['importSemanticModel', 'importSqlDdl', 'importDbmlFile'].includes(a));
    expect(imports).toHaveLength(3);
    const at = imports.map((a) => starts.indexOf(`**${START_ACTION_LABELS[a]}**`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('says a YAML/JSON project from before 2.0 keeps working, which the Marketplace description leaves out', () => {
    expect(section(README, "What's in your repo")).toMatch(/YAML\/JSON project from before 2\.0\? It keeps working\./);
    expect(FAQ).toContain('A YAML/JSON project from before 2.0 keeps working');
  });

  it('says "an open format, no lock-in" once, and dbt only in its own section and the links', () => {
    expect(README.split('no lock-in').length - 1).toBe(1);
    for (const heading of ['What it is', 'The ways to start', "What's in your repo"]) {
      expect(prose(section(README, heading)), heading).not.toMatch(/\bdbt\b/);
    }
    expect(section(README, 'Using dbt?')).toContain('](docs/dbt.md)');
  });

  it('follows the wording rules: no telemetry, no "open source" or "open standard", no "harness"', () => {
    for (const [name, text] of [['README.md', README], ['docs/faq.md', FAQ]]) {
      expect(text, name).not.toMatch(/telemetry/i);
      expect(text, name).not.toMatch(/open standard/i);
      expect(text, name).not.toMatch(/open[- ]source(?! schema language)/i);
      expect(text, name).not.toMatch(/harness/i);
    }
  });

  it('links only the AAC copy of the getting-started video, on jsDelivr', () => {
    expect(README).toContain('https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/getting-started.mp4');
    expect(README).not.toContain('media/onboarding/');
    expect([...README.matchAll(/[\w/.@:-]+\.mp4/g)].map((m) => m[0])).toEqual([
      'https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/getting-started.mp4',
    ]);
  });

  it('every relative link resolves, in the README and in Common questions', () => {
    const missing: string[] = [];
    for (const [file, text] of [['README.md', README], ['docs/faq.md', FAQ]]) {
      for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        if (!fs.existsSync(path.join(ROOT, path.dirname(file), m[1]))) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps dbt in the Marketplace keywords', () => {
    const pkg = JSON.parse(read('package.json')) as { keywords: string[] };
    expect(pkg.keywords).toContain('dbt');
  });
});

describe('Common questions (docs/faq.md)', () => {
  it('has the upgrade questions and the everyday ones', () => {
    expect([...FAQ.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['Upgrading to 2.0', 'Everyday']);
    const upgrading = section(FAQ, 'Upgrading to 2.0');
    for (const q of ['Do I have to convert my project to DBML?', 'How do I go back?', 'Can teammates on an older ERD Studio open it?']) {
      expect(upgrading).toContain(`**${q}**`);
    }
    const everyday = section(FAQ, 'Everyday');
    expect(everyday).toContain('**How do I move a table to another schema or layer?**');
    expect(everyday).toContain('**Something is slow or not working. Where do I look?**');
  });

  it('names commands by their real titles', () => {
    const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ title: string }> } };
    const titles = new Set(pkg.contributes.commands.map((c) => c.title));
    for (const title of ['Convert Project to DBML', 'Move Table…', 'Move Diagram to Layer…', 'Organise Table Library by Layer', 'Show Logs', 'Set Up My AI Helper', 'Send Feedback']) {
      expect(titles.has(title), title).toBe(true);
      expect(FAQ).toContain(title);
    }
  });
});
