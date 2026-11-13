// Reapplying native view geometry/visibility invalidates render surfaces on
// some platforms. Agent status and cursor updates must not resize page views.
export function setBounds(view, bounds) {
  const previous = view.getBounds();
  if (['x', 'y', 'width', 'height'].every(key => previous[key] === bounds[key])) return;
  view.setBounds(bounds);
}

export function setVisible(view, visible) {
  if (view.getVisible() !== visible) view.setVisible(visible);
}

/** Whether the window's client area can be laid out: a minimized window on Windows reports 0x0. */
export function usableArea({ width, height }, minimized) {
  return !minimized && width > 0 && height > 0;
}

/** Reorder attached views in place, only when the foreground actually changes. */
export function keepOnTop(parent, views) {
  const children = parent.children, offset = children.length - views.length;
  if (offset >= 0 && views.every((view, index) => children[offset + index] === view)) return;
  for (const view of views) {
    if (parent.children.at(-1) !== view) parent.addChildView(view);
  }
}

/** Whether a page view is on screen.
 * A window of its own shows its active tab only. In the shared window every agent's tab used to stay visible under
 * the foreground page so that it always had a render surface, which made a tab nobody looks at animate at full rate.
 * With `hideIdle`, the tabs of a space that announced support (`eligible`) are shown only while its agent acts
 * (`live`), when they are the foreground page, or while the agents center (which draws their thumbnails) is open.
 * Tabs of a space that never announced it (an older worker, the person's own tabs) stay visible as before. */
export function tabShown({ shared, hideIdle, tab, activeTab, centerOpen, live, eligible }) {
  if (!shared) return tab.id === activeTab && !centerOpen;
  if (!hideIdle || centerOpen || tab.id === activeTab) return true;
  return !eligible.has(tab.profile) || live.has(tab.profile);
}
