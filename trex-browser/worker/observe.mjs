// The compact page model behind browser_snapshot and action change reports.
// It reads Playwright's AI aria snapshot (one call per frame tree: accessible
// names, roles, states, values and stable element refs) and turns it into
// "ref kind name = value [states]" lines plus a diff of what an action changed.

// Elements an agent acts on, and context it reads (headings, alerts, live status).
export const ACTIONABLE = new Set(['button','link','textbox','searchbox','checkbox','radio','switch','combobox','listbox','option','menuitem','menuitemcheckbox','menuitemradio','tab','slider','spinbutton','treeitem']);
const CONTEXT = new Set(['heading','alert','alertdialog','dialog','status']);
export const FIELDS = new Set(['textbox','searchbox','combobox','listbox','checkbox','radio','switch','slider','spinbutton']);
// Containers whose children are elements of their own; other listed elements are leaves.
const CONTAINERS = new Set(['listbox','dialog','alertdialog','treeitem']);
// Roles whose name is their text content (a live region has no accessible name).
const TEXTUAL = new Set(['alert','status','heading']);
const STATE_KEYS = ['checked','selected','expanded','pressed','disabled','invalid'];

export const clean = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const kids = node => node && typeof node === 'object' ? [...(node.text !== undefined ? [node.text] : []), ...(Array.isArray(node.children) ? node.children : [])] : [];

/** Concatenated visible text of an aria JSON node. */
export function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  const own = node.role === 'textbox' || node.role === 'searchbox' ? [] : kids(node).map(textOf);
  return [node.name && !own.join(' ').includes(node.name) ? node.name : '', ...own].filter(Boolean).join(' ');
}

function states(node) {
  const out = [];
  for (const key of STATE_KEYS) {
    const value = node[key];
    if (value === true) out.push(key);
    else if (value === 'mixed') out.push('mixed');
    else if (typeof value === 'string' && value && value !== 'false') out.push(`${key}=${value}`);
  }
  return out;
}

function entryOf(node, framed) {
  const role = node.role;
  let name = clean(TEXTUAL.has(role) ? (node.name || textOf({ ...node, name: '' })) : (node.name || (FIELDS.has(role) ? node.placeholder : textOf(node))), TEXTUAL.has(role) && role !== 'heading' ? 200 : 80);
  let value;
  if (role === 'combobox' || role === 'listbox') {
    const chosen = [];
    const walk = n => { for (const c of kids(n)) if (c && typeof c === 'object') { if (c.role === 'option' && c.selected) chosen.push(clean(c.name || textOf(c))); walk(c); } };
    walk(node);
    value = node.text !== undefined ? clean(node.text) : chosen.length ? chosen.join(', ') : undefined;
  } else if (FIELDS.has(role) && node.text !== undefined) value = clean(node.text);
  return { ref: node.ref, role, name, value, states: states(node), level: node.level, framed, url: role === 'link' ? node.url : undefined };
}

/** Flattens an AI aria snapshot (JSON) into elements and loose text. */
export function flatten(roots) {
  const entries = [], texts = [];
  const visit = (node, framed, quiet, parent) => {
    if (typeof node === 'string') { if (!framed && !quiet) { const t = clean(node, 200); if (t) texts.push(t); } return; }
    if (!node || typeof node !== 'object') return;
    if (node.role === 'iframe') { for (const child of kids(node)) visit(child, true, true, 'iframe'); return; }
    // Options of a native select are its value, not separate lines.
    if (node.role === 'option' && parent === 'combobox') return;
    const listed = (ACTIONABLE.has(node.role) || CONTEXT.has(node.role)) && !!node.ref;
    if (listed) entries.push(entryOf(node, framed));
    // Listed elements' own text is their name; elements nested in them (a link in
    // an alert, a popup list owned by a combobox) are still visited.
    for (const child of kids(node)) visit(child, framed, quiet || listed && !CONTAINERS.has(node.role), node.role);
  };
  for (const root of Array.isArray(roots) ? roots : [roots]) visit(root, false, false, null);
  return { entries, texts };
}

/** Whether a compact view lists an element: named ones, fields and context. */
export const shown = entry => !!entry.name || FIELDS.has(entry.role) || entry.role === 'dialog';

export const kindOf = entry => entry.role === 'heading' && entry.level ? `h${entry.level}` : entry.role;

/** One element as "ref kind name = "value" [states]". */
export function line(entry, tabId, extraStates = []) {
  const all = [...entry.states, ...extraStates];
  return `${tabId}-${entry.ref} ${kindOf(entry)}${entry.name ? ` ${entry.name}` : ''}${entry.value ? ` = ${JSON.stringify(entry.value)}` : ''}${all.length ? ` [${all.join(',')}]` : ''}`;
}

/** The element list an agent reads: shown elements, adjacent duplicates merged, capped. */
export function compact(entries, tabId, { cap = 400, frames = false, extra = new Map() } = {}) {
  const lines = []; let omitted = 0, last = '', more = 0;
  for (const entry of entries) {
    if (entry.framed && !frames || !shown(entry)) { omitted++; continue; }
    const key = ['link', 'button'].includes(entry.role) ? `${entry.name}` : null;
    if (key && key === last) { omitted++; continue; } // the same control repeated (thumbnail + title)
    last = key || '';
    if (lines.length >= cap) { more++; continue; }
    lines.push(line(entry, tabId, extra.get(entry.ref)));
  }
  return { lines, omitted, more };
}

const sameStates = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
function was(before, after) {
  const parts = [];
  if (before.name !== after.name) parts.push(JSON.stringify(before.name));
  if ((before.value || '') !== (after.value || '')) parts.push(before.value ? `= ${JSON.stringify(before.value)}` : 'empty');
  if (!sameStates(before.states, after.states)) parts.push(before.states.length ? `[${before.states.join(',')}]` : 'no state');
  return parts.join(' ');
}

/** What changed between two page models: URL, title, elements and new text. */
export function diff(before, after, tabId, { cap = 30, textCap = 8 } = {}) {
  const effect = {};
  if (before && after.url !== before.url) effect.url = after.url;
  if (before && after.title !== before.title) effect.title = after.title;
  const visible = model => model.entries.filter(e => !e.framed && shown(e));
  if (!before || after.doc !== before.doc) {
    // A new document: every earlier ref is gone; these are the new page's elements.
    if (before) effect.navigated = true;
    const { lines, more } = compact(after.entries, tabId, { cap });
    if (lines.length) effect.added = lines;
    if (more) effect.more = more;
    return effect;
  }
  const old = new Map(visible(before).map(e => [e.ref, e])), now = new Map(visible(after).map(e => [e.ref, e]));
  const added = [], changed = [];
  for (const [ref, entry] of now) {
    const prior = old.get(ref);
    if (!prior) added.push(line(entry, tabId));
    else if (prior.name !== entry.name || (prior.value || '') !== (entry.value || '') || !sameStates(prior.states, entry.states)) changed.push(`${line(entry, tabId)} (was ${was(prior, entry)})`);
  }
  let removed = 0; for (const ref of old.keys()) if (!now.has(ref)) removed++;
  const seen = new Map(); for (const t of before.texts) seen.set(t, (seen.get(t) || 0) + 1);
  const text = [];
  for (const t of after.texts) { const n = seen.get(t) || 0; if (n) seen.set(t, n - 1); else if (!text.includes(t)) text.push(t); }
  let more = Math.max(0, added.length - cap) + Math.max(0, changed.length - cap) + Math.max(0, text.length - textCap);
  if (added.length) effect.added = added.slice(0, cap);
  if (removed) effect.removed = removed;
  if (changed.length) effect.changed = changed.slice(0, cap);
  if (text.length) effect.text = text.slice(0, textCap);
  if (more) effect.more = more;
  return effect;
}

/** Elements that could be meant by a target, best matches first (for errors). */
export function candidates(entries, { role, name } = {}, limit = 5) {
  const wanted = clean(name).toLowerCase(), words = wanted.split(' ').filter(Boolean);
  const scored = [];
  for (const entry of entries) {
    if (entry.framed || !shown(entry) || role && entry.role !== role) continue;
    const have = entry.name.toLowerCase();
    const score = !wanted ? 1 : have === wanted ? 4 : have.includes(wanted) || wanted.includes(have) && have ? 3 : words.filter(w => have.includes(w)).length ? 2 : role ? 1 : 0;
    if (score) scored.push([score, entry]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, entry]) => entry);
}
