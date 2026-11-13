// An in-memory page for BrowserService unit tests: an AI aria snapshot tree,
// a document identity (time origin) and aria-ref locators, without a browser.
import { EventEmitter } from 'node:events';

const walk = (nodes, visit) => { for (const node of nodes || []) if (node && typeof node === 'object') { visit(node); walk(node.children, visit); } };

export function fakePage({ tree = [], url = 'http://localhost/', title = 'Fixture', doc = 1 } = {}) {
  const page = new EventEmitter();
  Object.assign(page, { tree, url, title, doc, actions: [], fields: new Map(), read: null, removed: new Set() });
  const refs = () => { const found = new Set(); walk(page.tree, node => { if (node.ref && !page.removed.has(node.ref)) found.add(node.ref); }); return found; };
  const locatorFor = (ref, matches = () => refs().has(ref)) => ({
    count: async () => matches() ? 1 : 0,
    first() { return this; },
    nth() { return this; },
    click: async () => { page.actions.push(['click', ref]); await page.onAction?.('click', ref); },
    hover: async () => { page.actions.push(['hover', ref]); },
    fill: async value => { page.actions.push(['fill', ref, value]); page.fields.set(ref, page.transform ? page.transform(value) : value); await page.onAction?.('fill', ref, value); },
    setChecked: async value => { page.actions.push(['check', ref, value]); page.fields.set(ref, value); },
    press: async key => { page.actions.push(['press', ref, key]); },
    selectOption: async values => { page.actions.push(['select', ref, values]); page.fields.set(ref, values); },
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    // Pre-checks of the real locator API: the fake element is always visible, enabled and editable.
    waitFor: async () => {},
    isEnabled: async () => true,
    isEditable: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    // Read-back of a field and "required": answered from page.fields / page.required.
    evaluate: async fn => {
      const source = String(fn);
      if (source.includes('required')) { page.requiredReads = (page.requiredReads || 0) + 1; return page.required?.has(ref) || false; }
      if (source.includes('selectedOptions')) return (page.fields.get(ref) || []).map(v => page.labels?.[v] ?? v);
      // fill_form asks what kind of field it is; the select pre-check lists its options; read-back asks what is chosen.
      if (source.includes('tag:e.tagName')) return page.kinds?.get(ref) ?? {};
      if (source.includes('label:(o.label')) return page.options?.get(ref) ?? null;
      if (source.includes('o.selected') && page.kinds?.get(ref)?.tag === 'SELECT') return { value: '', chosen: [].concat(page.fields.get(ref) || []).flatMap(v => [v, page.labels?.[v] ?? v]) };
      const value = page.fields.get(ref);
      return typeof value === 'boolean' ? { checked: value, value: 'on' } : { value: value ?? '', password: page.password?.has(ref) };
    },
    ariaSnapshotJSON: async () => { const found = []; walk(page.tree, node => { if (node.ref === ref) found.push(node); }); return found; },
  });
  const frame = {
    url: () => page.url,
    page: () => page,
    isDetached: () => false,
    evaluate: async (fn, arg) => {
      const source = String(fn);
      if (source.includes('MutationObserver')) return undefined;
      if (source.includes('location.href')) return [page.doc, page.url, page.title];
      if (source.includes('timeOrigin')) return page.doc;
      return page.evaluate ? page.evaluate(fn, arg) : undefined;
    },
    locator: selector => ({
      first() { return this; },
      ariaSnapshotJSON: async () => { const tree = page.read ? await page.read : page.tree; return selector === 'body' ? tree : page.scoped?.(selector) ?? tree; },
      ariaSnapshot: async () => '- tree',
      // The one-read check for "does this page have a required field at all" (worker/browser.mjs REQUIRED_FIELD).
      count: async () => selector.includes('required') ? page.required?.size ?? 0 : page.selectors?.[selector]?.length ?? 0,
      nth: i => locatorFor(page.selectors?.[selector]?.[i]),
      click: async () => { page.actions.push(['click', selector]); },
      fill: async value => { page.actions.push(['fill', selector, value]); },
    }),
    getByRole: (role, { name } = {}) => {
      const matches = []; walk(page.tree, node => { if (node.role === role && (name === undefined || (name instanceof RegExp ? name.test(node.name || '') : node.name === name))) matches.push(node.ref); });
      const loc = locatorFor(matches[0], () => true);
      return { ...loc, count: async () => matches.length, nth: i => locatorFor(matches[i]) };
    },
  };
  Object.assign(page, {
    mainFrame: () => frame,
    getByRef: ref => locatorFor(ref),
    isClosed: () => false,
    waitForLoadState: async () => {},
  });
  // url and title are data here (tests change them), not Playwright's url()/title() methods.
  return page;
}
