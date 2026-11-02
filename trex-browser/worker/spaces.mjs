import path from 'node:path';
import { jsonRead, writePrivate } from './security.mjs';

/** Host-only allocation. Models never choose a different client or profile. */
export function ensureSpaces(service, ctx, members) {
  if (!Array.isArray(members) || !members.length || members.length > 9) throw new Error('Expected 1..9 browser space members');
  const seen = new Set();
  for (const member of members) {
    if (!member || Object.keys(member).some(key => !['clientId','label','model'].includes(key))
      || member.model !== undefined && (typeof member.model !== 'string' || member.model.length > 60 || /[\x00-\x1f\x7f]/.test(member.model))
      || typeof member.clientId !== 'string' || !member.clientId.length || member.clientId.length > 128 || /[\x00-\x1f\x7f]/.test(member.clientId)
      || typeof member.label !== 'string' || !member.label.trim() || member.label.length > 100 || /[\x00-\x1f\x7f]/.test(member.label)
      || seen.has(member.clientId)) throw new Error('Invalid or duplicate browser space member');
    seen.add(member.clientId);
  }
  const profiles = service.profiles(ctx), used = new Set(profiles.map(profile => profile.id));
  const available = Array.from({length:98}, (_,i) => `BROWSER${i+2}`).filter(id => !used.has(id));
  const planned = members.map(member => {
    const owned = profiles.find(profile => profile.space?.clientId === member.clientId);
    const profile = owned?.id || available.shift();
    if (!profile) throw new Error('No free browser profiles remain in this project; existing profiles are preserved');
    return {...member, profile};
  });
  for (const space of planned) {
    const binding = {...ctx,profile:space.profile}; service.createProfile(binding);
    const file = path.join(service.profileDir(binding),'profile.json');
    const manifest = jsonRead(file, {});
    writePrivate(file, JSON.stringify({...manifest,space:{clientId:space.clientId,label:space.label,...(space.model?{model:space.model}:{})}}));
    // A running space shows the new label/model right away (e.g. the user switched model).
    const live = service.sessions.get(service.key(binding));
    if (live) { live.spaceLabel = service.displayLabel(space.label) || binding.profile; live.spaceModel = space.model || ''; service.notifyShell(live); }
  }
  return {spaces:planned.map(({clientId,label,profile}) => ({clientId,label,profile}))};
}

/** Project-scoped host overview. It never creates sessions, launches Chrome, or changes ownership. */
export function listSpaces(service, ctx) {
  const live = new Map();
  for (const operation of service.operations.values()) if (operation.ctx.projectId === ctx.projectId && operation.started && !operation.finishedAt && !operation.controller.signal.aborted) live.set(operation.ctx.profile, operation);
  return {spaces:service.profiles(ctx).flatMap(profile => {
    const state=service.sessions.get(service.key({...ctx,profile:profile.id}));
    const member=profile.space;
    const clientId=member?.clientId ?? state?.owner ?? `manual-${profile.id}`;
    if (typeof clientId !== 'string' || !clientId.length) return [];
    const page=state?.tabs.get(state.selected),operation=live.get(profile.id);
    const capture=state?.capture?.kind;
    return [{clientId,profile:profile.id,label:member?.label ?? `Manual · ${profile.id}`,
      running:!!state?.browser,inUse:!!state?.browser||!!state?.opening||!!service.shellHosts?.get(ctx.projectId)?.host?.loaded.has(profile.id),paused:state?.paused===true,active:!!operation||!!capture,tabCount:state?.tabs.size??0,
      currentTool:operation?.name ?? (capture==='video'?'browser_start_video':null),
      url:String(page?.url()??'').slice(0,1024)}];
  })};
}
