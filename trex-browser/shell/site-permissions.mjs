// What Trex Browser may remember about a site's permissions. No Electron in here: main.mjs owns the file, the
// prompt bar and the screen chooser, and asks this module what can be kept, where, and for how long.

/** Kept for good once the person allows them: the only names trex-permissions.json may hold. */
export const PERSISTABLE = new Set(['notifications', 'geolocation', 'clipboard-read', 'midi']);
/** Allowed at most until the browser restarts; never written to disk. */
export const SESSION_ONLY = new Set(['media', 'openExternal']);
// 'display-capture' is in neither set: an allow is never remembered, every request goes through the chooser.
const CANCELS_BEFORE_BLOCK = 3;

/** The same key older versions wrote, so saved low-risk allows keep working. */
export const permissionKey = (profile, origin, permission) => `${profile ? profile + '|' : ''}${origin}|${permission}`;
const permissionOf = key => key.slice(key.lastIndexOf('|') + 1);

/** What a saved file may contain: allows of persistable permissions. Everything else is dropped — the screen,
 * camera, microphone and external-app allows older versions wrote, and anything that is not a plain `true`. */
export function sanitizeSaved(raw) {
  const saved = {}; let dropped = 0;
  for (const [key, value] of raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : []) {
    if (value === true && PERSISTABLE.has(permissionOf(key))) saved[key] = true; else dropped++;
  }
  return { saved, dropped };
}

/** The file's content plus this run's memory, which starts empty with every browser start. `dropped` tells the
 * caller the file held entries that must go, so it rewrites it. */
export function permissionState(raw) {
  return { ...sanitizeSaved(raw), granted: new Set(), blocked: new Set(), cancels: new Map() };
}

/** true (allowed), false (blocked until restart) or undefined (ask the person). A risky permission is answered
 * from this run's memory only, whatever the saved map holds. */
export function decisionFor(state, key) {
  if (state.blocked.has(key)) return false;
  if (state.granted.has(key) || state.saved[key] === true && PERSISTABLE.has(permissionOf(key))) return true;
  return undefined;
}
/** The synchronous check path (permissions.query and friends): granted or not, never a prompt. */
export const isGranted = (state, key) => decisionFor(state, key) === true;

/** Record the person's answer to a prompt. Returns true when the saved map changed and the file must be written. */
export function recordDecision(state, key, allow) {
  const permission = permissionOf(key);
  if (!allow) { state.blocked.add(key); return false; }
  if (PERSISTABLE.has(permission)) { state.saved[key] = true; return true; }
  if (SESSION_ONLY.has(permission)) state.granted.add(key);
  return false;
}

/** The person closed the screen chooser without sharing. A site that keeps asking is blocked until restart
 * (or until its permissions are forgotten); returns true once it is. */
export function chooserCancelled(state, key) {
  const count = (state.cancels.get(key) ?? 0) + 1;
  if (count < CANCELS_BEFORE_BLOCK) { state.cancels.set(key, count); return false; }
  state.cancels.delete(key); state.blocked.add(key); return true;
}
export const chooserAnswered = (state, key) => { state.cancels.delete(key); };

// Keys of exactly this origin in exactly this profile: the rest of the key must be a bare permission name.
const ofSite = (profile, origin) => { const prefix = permissionKey(profile, origin, ''); return key => key.startsWith(prefix) && !key.includes('|', prefix.length); };

/** Whether anything is remembered (saved or for this run) about an origin in a profile. */
export function hasSiteDecisions(state, profile, origin) {
  return !!origin && [...Object.keys(state.saved), ...state.granted, ...state.blocked].some(ofSite(profile, origin));
}

/** Forget everything decided for one origin in one profile. Returns true when the file must be rewritten. */
export function forgetSite(state, profile, origin) {
  if (!origin) return false;
  const mine = ofSite(profile, origin); let rewrite = false;
  for (const key of Object.keys(state.saved)) if (mine(key)) { delete state.saved[key]; rewrite = true; }
  for (const memory of [state.granted, state.blocked, state.cancels]) for (const key of [...memory.keys()]) if (mine(key)) memory.delete(key);
  return rewrite;
}
