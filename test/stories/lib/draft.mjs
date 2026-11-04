// The draft preview (Draft-first, docs/dev/draft-first.md §2): an ERD Studio
// webview tab titled "Draft: <name>" or "Example: <title>", read-only, that
// writes nothing until Keep. Expressions run inside the webview (`doc`); the
// helpers take the story's `s`. Its DOM is ours (webview-draft/), so its
// selectors live here, in one place, as VS Code's do in vscode.mjs.

const q = JSON.stringify;

export const DRAFT = {
  headline: `(doc.querySelector('.draft-banner__headline')?.textContent.trim())`,
  detail: `doc.querySelector('.draft-banner__detail')?.textContent.trim()`,
  links: `(doc.querySelector('.draft-banner__links')?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`,
  notice: `(doc.querySelector('.draft-banner__notice')?.textContent.trim() ?? '')`,
  banner: `doc.querySelector('.draft-banner')`,
  /** The one primary button's label. */
  primary: `[...doc.querySelectorAll('.draft-button--primary')].map(b => b.textContent.trim())`,
  /** Every button of the banner's actions, in order (the menu's caret dropped). */
  buttons: `[...doc.querySelectorAll('.draft-banner__actions > button, .draft-banner__actions .draft-menu__button')].map(b => b.textContent.replace('▾', '').trim())`,
  button: (label) => `[...doc.querySelectorAll('.draft-banner button')].find(b => b.textContent.replace('▾', '').trim() === ${q(label)})`,
  link: (label) => `[...doc.querySelectorAll('.draft-banner__link')].find(b => b.textContent.trim() === ${q(label)})`,
  menuItems: `[...doc.querySelectorAll('.draft-menu__item')].map(b => b.textContent.trim())`,
  menuItem: (label) => `[...doc.querySelectorAll('.draft-menu__item')].find(b => b.textContent.trim() === ${q(label)})`,
  select: `doc.querySelector('.draft-scope__select')`,
  scopeLabel: `doc.querySelector('.draft-scope__label')?.textContent.trim()`,
  scopeOptions: `[...(doc.querySelector('.draft-scope__select')?.options ?? [])].map(o => o.textContent.trim())`,
  scopeCurrent: `(() => { const s=doc.querySelector('.draft-scope__select'); return s ? s.options[s.selectedIndex]?.textContent.trim() : null; })()`,
  /** The tables drawn: their names (the first line of each node). */
  tables: `[...doc.querySelectorAll('.react-flow__node')].map(n => n.innerText.split('\\n')[0].trim())`,
  edges: `doc.querySelectorAll('.react-flow__edge').length`,
  canvas: `doc.querySelector('.draft-canvas')`,
  busy: `doc.querySelector('.draft-app--busy, .draft-canvas__placeholder')`,
  drawer: `doc.querySelector('.draft-drawer')`,
  drawerSections: `[...doc.querySelectorAll('.draft-drawer__title')].map(t => t.textContent.trim())`,
  schemas: `doc.querySelector('.draft-schemas')`,
  schemaItems: `[...doc.querySelectorAll('.draft-schemas__item')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`,
  schemaItem: (name) => `[...doc.querySelectorAll('.draft-schemas__item')].find(b => (b.querySelector('.draft-schemas__name')?.textContent.trim() ?? '') === ${q(name)})`,
  showing: `(doc.querySelector('.draft-schemas__showing')?.textContent.trim() ?? '')`,
};

/**
 * Wait for the draft tab `tab` (e.g. "Draft: sales") to be the active editor
 * and its diagram drawn (laid out, not Drawing…): resolves
 * `{ page, headline, detail, primary, buttons, tables, edges }`.
 */
export async function waitForDraft(s, tab, { timeout = 45000, tables } = {}) {
  await s.ui.waitForActiveTab(tab, { timeout });
  const page = await s.webview({ timeout });
  await page.waitFor(`${DRAFT.headline} && !${DRAFT.busy} && doc.querySelectorAll('.react-flow__node').length > 0${tables !== undefined ? ` && doc.querySelectorAll('.react-flow__node').length === ${tables}` : ''}`, { timeout, what: `the draft "${tab}" drawn` });
  return { page, ...(await draftState(page)) };
}

/** What the draft on show says and draws. */
export async function draftState(page) {
  return page.ev(`({ headline: ${DRAFT.headline}, detail: ${DRAFT.detail}, links: ${DRAFT.links}, notice: ${DRAFT.notice}, primary: ${DRAFT.primary},
    buttons: ${DRAFT.buttons}, tables: ${DRAFT.tables}, edges: ${DRAFT.edges}, scope: ${DRAFT.scopeCurrent}, scopes: ${DRAFT.scopeOptions} })`);
}

/**
 * Choose the switcher's option whose text starts with `label` (a native
 * <select>'s popup cannot be driven over CDP, so it is set as a keyboard
 * would, through React's own change event), after highlighting the switcher.
 */
export async function chooseScope(s, page, label) {
  await page.highlight(DRAFT.select);
  await s.pause(900);
  const ok = await page.ev(`(() => { const sel=doc.querySelector('.draft-scope__select'); const o=[...sel.options].find(o => o.textContent.trim().startsWith(${q(label)}));
    if(!o) return false; const set=Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set; set.call(sel, o.value);
    sel.dispatchEvent(new win.Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`the switcher has no "${label}"`);
  await s.wb.unhighlight();
}

/**
 * Through a step-by-step import that ends in a draft: a name box ("Name the
 * diagram…") is answered with its suggestion (Enter, after `beat` ms for the
 * viewer); any quick input whose title, placeholder or message matches
 * `never` fails (the question it must not ask), and so does a modal dialog
 * (the draft replaced the import's confirm). Resolves `{ tab, named }`: the
 * draft tab's label once it is active, and the name box's value if it asked.
 */
export async function waitForDraftKeepingName(s, { never, beat = 800, timeout = 45000 } = {}) {
  const until = Date.now() + timeout;
  let named;
  for (;;) {
    const tab = (await s.ui.tabs().catch(() => [])).find((t) => t.active && /^(Draft|Example): /.test(t.label));
    if (tab) return { tab: tab.label, named };
    if (await s.wb.ev(`!!${s.sel.dialog}`).catch(() => false)) {
      const d = await s.ui.waitForDialog();
      throw new Error(`a dialog showed instead of the draft: ${d.message}`);
    }
    const box = await s.ui.quickPick().catch(() => null);
    if (box) {
      const text = `${box.title} ${box.placeholder} ${box.message}`;
      if (never && never.test(text)) throw new Error(`it asked what it should not: ${text.trim()}`);
      if (/Name the diagram/.test(box.message) && named === undefined) {
        named = box.value;
        await s.pause(beat);
        await s.wb.press('Enter');
      }
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for the import's draft`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
