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
  /**
   * The welcome view's buttons, visible ones, by text: VS Code draws a link
   * alone on its line as a full-width button, every other link inline.
   */
  welcomeButtons: `[...document.querySelectorAll('.part.sidebar .welcome-view-content .monaco-button')].filter(b => b.offsetParent).map(b => b.textContent.trim())`,
  /** A view's title-bar action (an icon), by its command title. */
  viewAction: (title) => `[...document.querySelectorAll('.part.sidebar .actions .action-label, .part.sidebar .title-actions .action-label')].find(a => (a.getAttribute('aria-label') ?? '').startsWith(${q(title)}))`,
  /** The buttons (not inline links) of the open walkthrough step, by text. */
  walkthroughButtons: `[...document.querySelectorAll('.gettingStartedContainer .getting-started-step.expanded .monaco-button')].filter(b => b.offsetParent).map(b => b.textContent.trim())`,
  quickInput: `[...document.querySelectorAll('.quick-input-widget')].find(w => w.style.display !== 'none' && w.offsetParent !== null)`,
  quickInputBox: `document.querySelector('.quick-input-widget .quick-input-box input')`,
  /** A quick pick row whose label starts with `label`. */
  quickPickRow: (label) => `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(r => ((r.querySelector('.label-name')?.textContent ?? r.getAttribute('aria-label') ?? '').trim()).startsWith(${q(label)}))`,
  quickInputButton: (text) => `[...document.querySelectorAll('.quick-input-widget .monaco-button')].find(b => b.textContent.trim() === ${q(text)})`,
  tab: (label) => `[...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').split(',')[0].trim() === ${q(label)})`,
  commandCenter: `document.querySelector('.command-center .command-center-center, .command-center-center')`,
  /** A row of a tree in the side bar (the Diagrams view, the Table Library, the Explorer), by its label. */
  sidebarRow: (label) => `[...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${q(label)})`,
  /** A modal dialog (window.dialogStyle: custom draws it in the page). */
  dialog: `[...document.querySelectorAll('.monaco-dialog-box')].find(d => d.offsetParent !== null)`,
  dialogButton: (text) => `[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => b.textContent.trim() === ${q(text)})`,
  /** A notification toast whose message contains `text`. */
  notification: (text) => `[...document.querySelectorAll('.notification-toast-container .notification-list-item')].find(n => (n.querySelector('.notification-list-item-message')?.textContent ?? '').includes(${q(text)}))`,
  /** A button of the notification toast whose message contains `text`, by its label. */
  notificationButton: (text, label) => `[...document.querySelectorAll('.notification-toast-container .notification-list-item')].filter(n => (n.querySelector('.notification-list-item-message')?.textContent ?? '').includes(${q(text)})).flatMap(n => [...n.querySelectorAll('.monaco-button')]).find(b => b.textContent.trim() === ${q(label)})`,
  /** The active editor group's editor area (to highlight what opened). */
  activeEditor: `document.querySelector('.editor-group-container.active .editor-container')`,
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

  /**
   * Wait for the notification toast whose message contains `text`:
   * `{ message, buttons }` (the message in full, the button labels).
   */
  async waitForNotification(text, { timeout = 20000 } = {}) {
    await this.wb.waitFor(sel.notification(text), { timeout, what: `a notification saying "${text}"` });
    await sleep(150);
    return this.wb.ev(`(() => { const n=${sel.notification(text)}; return { message: n.querySelector('.notification-list-item-message')?.textContent.trim() ?? '',
      buttons: [...n.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()).filter(Boolean) }; })()`);
  }

  /** Press a button of the notification toast whose message contains `text`. */
  async notificationButton(text, label) {
    await this.wb.waitFor(sel.notificationButton(text, label), { what: `the "${label}" button of the notification "${text}"` });
    await this.wb.click(sel.notificationButton(text, label));
  }

  /**
   * The Command Palette's rows for `text` (opened from the Command Center and
   * left open, so the viewer sees them): resolves the labels once a row
   * starting with `expect` shows (or after `settleMs` without one).
   */
  async paletteItems(text, { expect, settleMs = 1500 } = {}) {
    await this.wb.click(sel.commandCenter);
    await this.waitForQuickPick();
    await this.wb.type(`>${text}`);
    if (expect) await this.wb.waitFor(sel.quickPickRow(expect), { what: `"${expect}" in the Command Palette` });
    else await sleep(settleMs);
    await sleep(300);
    return (await this.quickPick())?.items ?? [];
  }

  /** Reload the window from the Command Palette and wait for the new page. */
  async reloadWindow() {
    const tag = await this.wb.tagPage();
    await this.runCommand('Developer: Reload Window');
    await this.wb.waitForReload(tag);
  }

  /** Wait for a modal dialog: `{ message, detail, buttons }`. */
  async waitForDialog({ timeout = 20000 } = {}) {
    await this.wb.waitFor(sel.dialog, { timeout, what: 'a dialog' });
    await sleep(150);
    return this.wb.ev(`(() => { const d=${sel.dialog}; return { message: d.querySelector('.dialog-message-text')?.textContent.trim() ?? '',
      detail: d.querySelector('.dialog-message-detail')?.innerText.trim() ?? '',
      buttons: [...d.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()).filter(Boolean) }; })()`);
  }

  /**
   * Wait for a modal dialog, failing if a quick pick, input box or file
   * dialog shows first: the quick path asks nothing before its one confirm.
   */
  async waitForDialogAskingNothingFirst({ timeout = 30000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const state = await this.wb.ev(`(() => { if (${sel.dialog}) return 'dialog'; const w=${sel.quickInput};
        return w ? 'asked: ' + ((w.querySelector('.quick-input-title')?.textContent ?? '') + ' ' + (w.querySelector('.quick-input-box input')?.placeholder ?? '') + ' ' + (w.querySelector('.quick-input-message')?.textContent ?? '')).trim() : ''; })()`).catch(() => '');
      if (state === 'dialog') return this.waitForDialog();
      if (state.startsWith('asked: ')) throw new Error(`the quick path asked a question before its one confirm (${state.slice(7)})`);
      if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for the import's confirm`);
      await sleep(100);
    }
  }

  /**
   * Wait for a modal dialog through a step-by-step import: a name box
   * ("Name the diagram…") is answered with its suggestion (Enter, after
   * `beat` ms for the viewer); any quick input whose title, placeholder or
   * message matches `never` fails (the question it must not ask).
   * Resolves `{ dialog, named }`: the dialog, and the name box's value if it asked.
   */
  async waitForDialogKeepingName({ never, beat = 800, timeout = 30000 } = {}) {
    const until = Date.now() + timeout;
    let named;
    for (;;) {
      if (await this.wb.ev(`!!${sel.dialog}`).catch(() => false)) return { dialog: await this.waitForDialog(), named };
      const box = await this.quickPick().catch(() => null);
      if (box) {
        const text = `${box.title} ${box.placeholder} ${box.message}`;
        if (never && never.test(text)) throw new Error(`it asked what it should not: ${text.trim()}`);
        if (/Name the diagram/.test(box.message) && named === undefined) {
          named = box.value;
          await sleep(beat);
          await this.wb.press('Enter');
        }
      }
      if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for the import's confirm`);
      await sleep(150);
    }
  }

  /** Press a dialog's button. */
  async dialogButton(text) {
    await this.wb.waitFor(sel.dialogButton(text), { what: `the dialog's "${text}" button` });
    await this.wb.click(sel.dialogButton(text));
  }

  /** In VS Code's own file dialog: type `rel` after the folder it shows, then press its `button`. */
  async chooseInFileDialog(rel, button) {
    if (rel) await this.appendQuickInput(rel);
    await this.wb.waitFor(`${sel.quickInputBox}?.value.endsWith(${q(rel ?? '')})`, { what: `the file dialog to hold ${rel}` });
    await sleep(300);
    await this.quickInputButton(button);
  }

  /**
   * The clipboard's text, as a paste gets it: proves a Copy button copied
   * what it says. The page may not read the clipboard (navigator.clipboard
   * is denied), so this pastes (the browser's own paste command, sent over
   * CDP) into an off-screen textarea of the workbench and takes it out again.
   */
  async clipboardText() {
    const id = '__clipboardProbe';
    await this.wb.ev(`(() => { document.getElementById('${id}')?.remove(); const t=document.createElement('textarea'); t.id='${id}';
      t.style.cssText='position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0'; document.body.appendChild(t); t.focus(); return document.activeElement === t; })()`);
    for (const type of ['keyDown', 'keyUp']) {
      await this.wb.send('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', modifiers: PRIMARY, ...(type === 'keyDown' ? { commands: ['paste'] } : {}) });
    }
    await sleep(100);
    return this.wb.ev(`(() => { const t=document.getElementById('${id}'); const v=t?.value ?? ''; t?.remove(); return v; })()`);
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
