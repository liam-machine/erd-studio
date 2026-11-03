// VS Code workbench helpers for stories: where things are in the DOM (selector
// expressions) and the few interactions every story needs (a sidebar, a quick
// pick, the command palette, editor tabs). Built on the Workbench actor in act.mjs.
//
// Selectors are VS Code's own DOM, which can change between VS Code releases:
// keep them here, in one place, so a VS Code update is fixed once.

import { PRIMARY, sleep } from './act.mjs';

const q = JSON.stringify;

/** Selector expressions (JS that evaluates to an element, or undefined). */
export const sel = {
  activity: (label) => `document.querySelector('.activitybar [aria-label^=${q(label)}]')`,
  sidebar: `document.querySelector('.part.sidebar:not([style*="display: none"])')`,
  sidebarTitle: `document.querySelector('.part.sidebar .composite.title h2, .part.sidebar .title-label h2')`,
  /** A link or button in a view's welcome content, by its text. */
  welcomeLink: (text) => `[...document.querySelectorAll('.part.sidebar .welcome-view-content a, .part.sidebar .welcome-view-content .monaco-button')].find(a => a.textContent.trim() === ${q(text)})`,
  quickInput: `[...document.querySelectorAll('.quick-input-widget')].find(w => w.style.display !== 'none' && w.offsetParent !== null)`,
  quickInputBox: `document.querySelector('.quick-input-widget .quick-input-box input')`,
  /** A quick pick row whose label starts with `label`. */
  quickPickRow: (label) => `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(r => ((r.querySelector('.label-name')?.textContent ?? r.getAttribute('aria-label') ?? '').trim()).startsWith(${q(label)}))`,
  quickInputButton: (text) => `[...document.querySelectorAll('.quick-input-widget .monaco-button')].find(b => b.textContent.trim() === ${q(text)})`,
  tab: (label) => `[...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').split(',')[0].trim() === ${q(label)})`,
  commandCenter: `document.querySelector('.command-center .command-center-center, .command-center-center')`,
  /** Text on the Get Started (walkthrough) page. */
  walkthroughStep: (title) => `[...document.querySelectorAll('.gettingStartedContainer .getting-started-step')].find(s => s.querySelector('.step-title')?.textContent.trim() === ${q(title)})`,
  /** A link or button in the open (expanded) walkthrough step, by its text. */
  walkthroughLink: (text) => `[...document.querySelectorAll('.gettingStartedContainer .getting-started-step.expanded a, .gettingStartedContainer .getting-started-step.expanded .monaco-button')].find(a => a.textContent.trim() === ${q(text)})`,
};

export class VSCodeUI {
  constructor(wb) {
    this.wb = wb;
  }

  /** Open a view container from the activity bar (e.g. 'ERD Studio'). */
  async openSidebar(label) {
    await this.wb.waitFor(sel.activity(label), { what: `the ${label} icon in the activity bar` });
    const open = await this.wb.ev(`(() => { const a=${sel.activity(label)}; return !!a?.closest('.action-item')?.classList.contains('checked'); })()`);
    if (!open) await this.wb.click(sel.activity(label));
    await this.wb.waitFor(`${sel.sidebar} && (${sel.sidebar}.innerText || '').toUpperCase().includes(${q(label.toUpperCase())})`, { what: `the ${label} sidebar` });
  }

  /** The sidebar's visible text. */
  sidebarText() {
    return this.wb.ev(`${sel.sidebar}?.innerText ?? ''`);
  }

  /** The open quick pick / input box: `{ title, placeholder, value, items: [label], message }`, or null. */
  quickPick() {
    return this.wb.ev(`(() => { const w=${sel.quickInput}; if(!w) return null;
      return { title: w.querySelector('.quick-input-title')?.textContent ?? '',
        placeholder: w.querySelector('.quick-input-box input')?.placeholder ?? '',
        value: w.querySelector('.quick-input-box input')?.value ?? '',
        message: w.querySelector('.quick-input-message')?.textContent ?? '',
        items: [...w.querySelectorAll('.monaco-list-row')].map(r => (r.querySelector('.label-name')?.textContent ?? r.getAttribute('aria-label') ?? '').trim()) }; })()`);
  }

  /** Wait for a quick pick (or input box) to show; with `title`, one whose title contains it. */
  async waitForQuickPick({ title, timeout = 20000 } = {}) {
    await this.wb.waitFor(`${sel.quickInput} && (${title ? `(${sel.quickInput}.querySelector('.quick-input-title')?.textContent ?? '').includes(${q(title)})` : 'true'})`, {
      timeout, what: title ? `a quick pick titled "${title}"` : 'a quick pick',
    });
    await sleep(150);
    return this.quickPick();
  }

  /** Click the quick pick row whose label starts with `label`. */
  async pick(label) {
    await this.wb.waitFor(sel.quickPickRow(label), { what: `"${label}" in the quick pick` });
    await this.wb.click(sel.quickPickRow(label));
  }

  /** Replace the quick input's text with `text` (typed, so it shows). */
  async setQuickInput(text) {
    await this.wb.click(sel.quickInputBox);
    await this.wb.press('a', PRIMARY);
    await this.wb.type(text);
  }

  /** Type `text` at the end of the quick input's text (e.g. a sub-folder in a folder dialog). */
  async appendQuickInput(text) {
    await this.wb.click(sel.quickInputBox);
    await this.wb.press('End');
    await this.wb.type(text);
  }

  /** Click a quick input's button (the simple file dialog's OK button, for one). */
  async quickInputButton(text) {
    await this.wb.waitFor(sel.quickInputButton(text), { what: `the "${text}" button` });
    await this.wb.click(sel.quickInputButton(text));
  }

  /**
   * Run a command from the Command Palette, as a person would: open it from
   * the Command Center (F1 does not reach it while a webview has focus), type,
   * and pick the row whose label starts with `label` (default: `text`).
   */
  async runCommand(text, label = text) {
    await this.wb.click(sel.commandCenter);
    await this.waitForQuickPick();
    await this.wb.type(`>${text}`);
    await this.wb.waitFor(sel.quickPickRow(label), { what: `"${label}" in the Command Palette` });
    await this.wb.click(sel.quickPickRow(label));
  }

  /** Editor tabs: `[{ label, active }]`. */
  tabs() {
    return this.wb.ev(`[...document.querySelectorAll('.tabs-container .tab')].map(t => ({ label: (t.getAttribute('aria-label') ?? '').split(',')[0].trim(), active: t.classList.contains('active') }))`);
  }

  async waitForActiveTab(label, { timeout = 30000 } = {}) {
    await this.wb.waitFor(`${sel.tab(label)}?.classList.contains('active')`, { timeout, what: `the "${label}" editor tab to be active` });
  }

  /** The visible notification toasts' messages. */
  notifications() {
    return this.wb.ev(`[...document.querySelectorAll('.notification-toast-container .notification-list-item-message')].map(n => n.textContent.trim())`);
  }

  windowTitle() {
    return this.wb.ev('document.title');
  }
}
