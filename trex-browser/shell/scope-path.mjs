import path from 'node:path';

// Identifiers are global to the private Browser home; profile numbers remain
// project-local on disk, so existing cookies and storage need no migration.
export function scopePath(root, id) {
  if (id === 'personal') return path.join(root, 'personal', 'user-data');
  const match = /^([a-f0-9]{24})\/(BROWSER[1-9][0-9]?)$/.exec(id);
  if (!match) throw new Error('Invalid browser space');
  return path.join(root, 'projects', match[1], match[2], 'user-data');
}
