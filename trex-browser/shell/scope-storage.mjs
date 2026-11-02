import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Electron's persistent sessions are not CDP-created incognito contexts. */
export async function storageCommand(scope, method, params = {}) {
  if (method === 'Storage.getCookies') {
    const cookies = await scope.session.cookies.get({});
    return { cookies: cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expirationDate ?? -1, size: cookie.name.length + cookie.value.length, httpOnly: cookie.httpOnly, secure: cookie.secure,
      session: cookie.session, sameSite: ({ strict: 'Strict', lax: 'Lax', no_restriction: 'None', unspecified: 'None' })[cookie.sameSite] || 'None', priority: 'Medium',
      sourceScheme: cookie.secure ? 'Secure' : 'NonSecure', sourcePort: -1 })) };
  }
  if (method === 'Storage.setCookies') {
    for (const cookie of params.cookies || []) {
      const url = cookie.url || `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`;
      await scope.session.cookies.set({ url, name: cookie.name, value: cookie.value, ...(cookie.domain ? { domain: cookie.domain } : {}), path: cookie.path || '/',
        secure: !!cookie.secure, httpOnly: !!cookie.httpOnly,
        sameSite: ({ Strict: 'strict', Lax: 'lax', None: 'no_restriction' })[cookie.sameSite] || 'unspecified',
        ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}) });
    }
    return {};
  }
  if (method === 'Storage.clearCookies') { await scope.session.clearStorageData({ storages: ['cookies'] }); return {}; }
  if (method === 'Browser.setDownloadBehavior') return {};
  if (method === 'Browser.cancelDownload') {
    const item = scope.downloadIds?.get(params.guid);
    if (!item) throw new Error('Download is outside this agent space');
    item.cancel(); return {};
  }
  if (method === 'Browser.resetPermissions') { scope.permissions = new Map(); return {}; }
  if (method === 'Browser.grantPermissions') {
    const supported = new Set(['geolocation', 'notifications', 'midi', 'midiSysex', 'clipboardReadWrite', 'clipboardSanitizedWrite']);
    if ((params.permissions || []).some(permission => !supported.has(permission))) throw new Error('This native permission cannot be granted automatically');
    scope.permissions ??= new Map(); scope.permissions.set(params.origin || '*', new Set(params.permissions)); return {};
  }
  throw new Error('Unsupported scoped session command');
}

export function grantedPermission(scope, permission, origin) {
  const name = ({ 'clipboard-read': 'clipboardReadWrite', 'clipboard-sanitized-write': 'clipboardSanitizedWrite', midiSysex: 'midiSysex' })[permission] || permission;
  const grants = scope?.permissions;
  return !!(grants?.get(origin)?.has(name) || grants?.get('*')?.has(name));
}

export function scopedDownload(scope, item, webContents, folder, targetIdOf, emit) {
  const guid = randomUUID(); item.setSavePath(path.join(folder, guid));
  scope.downloads ??= new Set(); scope.downloads.add(item);
  scope.downloadIds ??= new Map(); scope.downloadIds.set(guid, item);
  const beginning = targetIdOf(webContents).then(targetId => emit({ type: 'scope-download', profile: scope.profile, phase: 'begin', targetId,
    guid, url: item.getURL(), suggestedFilename: item.getFilename() }));
  const progress = state => { const data = { type: 'scope-download', profile: scope.profile, phase: 'progress', guid,
    state: state === 'completed' ? 'completed' : state === 'cancelled' || state === 'interrupted' ? 'canceled' : 'inProgress', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() };
    void beginning.then(() => emit(data)).catch(() => {}); };
  item.on('updated', (_event, state) => progress(state));
  item.once('done', (_event, state) => { scope.downloads.delete(item); scope.downloadIds.delete(guid); progress(state); });
}
