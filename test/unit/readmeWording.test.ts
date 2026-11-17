/**
 * The root README and Common questions (docs/faq.md): one idea (logical data modelling in Git,
 * drawn from and stored as DBML), in the order and words docs/dev/onboarding-and-cli.md → "User-facing wording"
 * sets, the start screen's own labels, and links that resolve.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IMPORT_GUIDE_LABEL, START_ACTIONS, START_ACTION_LABELS, TOUR_LABEL } from '../../src/types/startActions';

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
  it('leads with the tagline and keeps its sections in order: the model and its DBML first, dbt last before the links', () => {
    expect(README).toContain('<strong>Design your data model in Git. Let your AI build from it.</strong>');
    const headings = [...README.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Why ERD Studio', 'On the canvas', 'Get started', "What's in your repo", 'Work with your AI assistant', 'Share it', 'Using dbt?', 'Learn more']);
  });

  it('opens with the licence, the hero GIF, then the reader\'s problem and the reviews, with no dbt in our own words (docs/dev/onboarding-and-cli.md → "User-facing wording")', () => {
    const first = README.slice(0, README.indexOf('\n## Why ERD Studio\n'));
    expect(first).toContain('Free to use. Source available under the');
    expect(first).toMatch(/\*\*A data model that lives apart from the code goes stale, and after three months nobody trusts it\.\*\*/);
    // show, then tell: the recording comes before the sentence about the problem
    const gif = 'https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/demo.gif';
    expect(first).toContain(gif);
    expect(first.indexOf(gif)).toBeLessThan(first.indexOf('**A data model that lives apart'));
    expect(first).toContain('> Reviews on the Visual Studio Marketplace');
    // our own words say "data model", not "ERD", and leave dbt to its own section; a quoted review keeps its own words
    const ownWords = prose(first).split('\n').filter((l) => !l.startsWith('>')).join('\n');
    expect(ownWords.replace(/ERD Studio/g, '')).not.toMatch(/\bERDs?\b/);
    expect(ownWords).not.toMatch(/\bdbt\b/);
  });

  it('shows a real screenshot where it says what the canvas does, and names a real command there', () => {
    const canvas = section(README, 'On the canvas');
    const shot = 'media/screenshot-canvas-light.png';
    expect(canvas).toContain(`https://raw.githubusercontent.com/liam-machine/erd-studio/main/${shot}`);
    expect(fs.existsSync(path.join(ROOT, shot))).toBe(true);
    // README-only media stays out of the VSIX (the 60-file cap)
    expect(read('.vscodeignore').split('\n')).toContain(shot);
    const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ title: string }> } };
    expect(pkg.contributes.commands.map((c) => c.title)).toContain('Suggest Relationships…');
    expect(canvas).toContain('**Suggest Relationships…**');
  });

  it('shares by export or by the Confluence app, which is a separate paid app and never "free"', () => {
    const share = section(README, 'Share it');
    const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ title: string }> } };
    expect(pkg.contributes.commands.map((c) => c.title)).toContain('Export Diagram…');
    expect(share).toContain('**Export Diagram…**');
    expect(share).toContain('](https://marketplace.atlassian.com/apps/4177786702/erd-studio-for-confluence)');
    expect(share).toContain('a separate paid app');
    expect(share).not.toMatch(/\bfree\b/i);
  });

  it('closes with who made it: the public GitHub profile, never an employer', () => {
    const last = section(README, 'Learn more');
    expect(last).toContain('Built by a data engineer');
    expect(last).toContain('https://github.com/liam-machine)');
  });

  it('is about 700 words of prose', () => {
    const words = prose(README).match(/[A-Za-z0-9][\w'’.\-/…]*/g) ?? [];
    expect(words.length).toBeGreaterThanOrEqual(600);
    expect(words.length).toBeLessThanOrEqual(800);
  });

  it('names the starts with the start screen\'s own labels, and lists neither Convert nor Import from dbt as a start', () => {
    const starts = section(README, 'Get started');
    for (const label of [
      IMPORT_GUIDE_LABEL, START_ACTION_LABELS.blank, START_ACTION_LABELS.importDbmlFile, START_ACTION_LABELS.importSqlDdl,
      START_ACTION_LABELS.importSemanticModel, START_ACTION_LABELS.example, TOUR_LABEL,
    ]) expect(starts, label).toContain(label);
    // an empty project's first button is the guide, then New Diagram… (CHANGELOG: "An empty project starts with Import Your Data Model…")
    expect(starts.indexOf(`**${IMPORT_GUIDE_LABEL}**`)).toBeLessThan(starts.indexOf(`**${START_ACTION_LABELS.blank}**`));
    expect(starts).not.toContain(START_ACTION_LABELS.convert);
    expect(starts).not.toContain(START_ACTION_LABELS.drawFromDbt);
    expect(starts).not.toMatch(/\bdbt\b/);
  });

  it('lists the three imports in the start screen\'s order (the first that applies leads)', () => {
    const starts = section(README, 'Get started');
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

  it('says "an open format, no lock-in" once, where DBML is introduced, and dbt only in its own section', () => {
    expect(README.split('no lock-in').length - 1).toBe(1);
    expect(section(README, 'Why ERD Studio')).toMatch(/an open format, so there is no lock-in/);
    for (const heading of ['Why ERD Studio', 'On the canvas', 'Get started', "What's in your repo", 'Work with your AI assistant', 'Share it', 'Learn more']) {
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
