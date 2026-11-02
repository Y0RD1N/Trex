// Preserve controls, focused inputs, images and running CSS animations while
// patching agent status. Replacing the root on each update causes visible flashes.
function key(node) {
  if (node.nodeType !== 1) return null;
  for (const name of ['data-key', 'id', 'data-tab', 'data-close', 'data-c', 'data-w', 'data-k'])
    if (node.hasAttribute(name)) return `${node.tagName}:${name}:${node.getAttribute(name)}`;
  return node.classList[0] ? `${node.tagName}:class:${node.classList[0]}` : null;
}
function compatible(a, b) { return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName); }
function patch(node, next) {
  if (node.nodeType !== 1) { if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue; return; }
  const editing = node === node.ownerDocument.activeElement && node.tagName === 'INPUT';
  for (const attribute of [...node.attributes]) {
    if (!next.hasAttribute(attribute.name) && !(editing && attribute.name === 'value')) node.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (editing && attribute.name === 'value') continue;
    if (node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
  }
  if (node.tagName === 'INPUT' && !editing && next.hasAttribute('value') && node.value !== next.getAttribute('value')) node.value = next.getAttribute('value');
  patchChildren(node, next);
}
function patchChildren(parent, next) {
  const old = [...parent.childNodes], used = new Set();
  let cursor = parent.firstChild;
  for (const wanted of [...next.childNodes]) {
    const wantedKey = key(wanted);
    let current = old.find(node => !used.has(node) && compatible(node, wanted) && key(node) === wantedKey);
    if (current) patch(current, wanted); else current = wanted.cloneNode(true);
    used.add(current);
    if (current !== cursor) parent.insertBefore(current, cursor);
    cursor = current.nextSibling;
  }
  for (const node of old) if (!used.has(node)) node.remove();
}
export function patchMarkup(parent, markup) {
  const template = parent.ownerDocument.createElement('template'); template.innerHTML = markup;
  patchChildren(parent, template.content);
}
