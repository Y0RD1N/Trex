import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ShellLink } from './shell.mjs';
import { ScopedCdp } from './scoped-cdp.mjs';
import { guardBrowser } from './guard.mjs';
import { childEnvironment, safePath } from './security.mjs';

/** One native window per private Browser home; scoped CDP clients never see one another's tabs. */
export class SharedShell {
  static async launch({ root, executablePath, artifacts, projectLabel, onEvent, onFailure, onClosed }) {
    const host = new SharedShell(); host.onClosed = onClosed; host.artifacts = artifacts;
    const userData = path.join(root, 'browser-window', 'user-data'); safePath(userData, { allowMissing: true }); fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    const args = ['--disable-component-update'];
    if (process.platform === 'linux' && process.env.TREX_BROWSER_HEADLESS === '1' && process.env.DISPLAY) args.push('--ozone-platform=x11');
    host.context = await chromium.launchPersistentContext(userData, {
      executablePath, headless: process.env.TREX_BROWSER_HEADLESS === '1', chromiumSandbox: true,
      acceptDownloads: true, viewport: null, timeout: 20000, downloadsPath: artifacts, args,
      env: { ...childEnvironment(), TREX_SHARED_BROWSER_ROOT: root, TREX_PROJECT_LABEL: projectLabel,
        ...(process.env.TREX_BROWSER_DEV === '1' && process.env.TREX_SHELL_DEV === '1' ? { TREX_SHELL_DEV: '1' } : {}) },
    });
    // This supervisor connection also discovers the native page targets. It
    // must leave dialogs to the owning scoped client, rather than Playwright's
    // default automatic dismissal racing that client's explicit response.
    host.context.on('dialog', () => {});
    try {
      host.guard = await guardBrowser(host.context, executablePath, () => {}, error => { host.failure = error; onFailure(error); });
      host.link = await ShellLink.connect(host.context, message => {
        if (message?.type === 'scope-target') {
          const ids = host.targets.get(message.profile) ?? new Set(); ids.add(message.targetId); host.targets.set(message.profile, ids);
          void host.scopes.get(message.profile)?.transport?.addTarget(message.targetId).catch(() => {}); return;
        }
        if(message?.type==='scope-download'){host.scopes.get(message.profile)?.transport?.download(message);return;}
        if(message?.type==='scope-target-close'){host.targets.get(message.profile)?.delete(message.targetId);host.scopes.get(message.profile)?.transport?.removeTarget(message.targetId);return;}
        return onEvent(message);
      });
      const hello = await host.link.call('hello');
      if (hello.scopeProtocol !== 1) throw new Error('Actualiza Trex Browser para compartir una ventana entre agentes.');
      // The shell hides the tabs of idle agent spaces and shows them while the agent acts (see BrowserService.syncLive).
      host.idleTabs = hello.idleTabs === true;
      host.context.on('close', () => {
        host.closed = true; for (const scope of host.scopes.values()) scope.transport?.close();
        onClosed(host);
        if (!host.closing) void host.guard?.stop().catch(() => {});
      });
      return host;
    } catch (error) { await host.shutdown().catch(() => {}); throw error; }
  }
  constructor() { this.scopes = new Map(); this.targets = new Map(); this.loaded = new Set(); this.humanScopes = new Set(); }
  async open({ profile, label, model, clientId, project }) {
    if (this.closed || this.closing || this.failure) throw new Error('The shared browser window is unavailable; close it before reconnecting');
    if (this.scopes.has(profile)) throw new Error('This browser space is already open');
    if(this.traceOwner)throw new Error('Finish the active performance trace before opening another browser space');
    const scope = { profile };
    scope.ready = new Promise((resolve, reject) => { scope.resolve = resolve; scope.reject = reject; });
    scope.ready.catch(() => {}); this.scopes.set(profile, scope);
    try {
      const info = await this.link.call('openScope', { profile, label, model, clientId, project }); this.loaded.add(profile);
      const root = await this.context.browser().newBrowserCDPSession();
      const transport = new ScopedCdp(root, { browserContextId: info.browserContextId,
        targets: [...new Set([info.targetId, ...(this.targets.get(profile) || [])])],
        createTarget: args => this.link.call('newTab', { url: args.url, profile, activate: false }),
        storage: (method,params) => this.link.call('scopeStorage',{profile,method,params}),manualDownloads:true,
        traceControl: phase=>{
          if(phase==='start'){if(this.humanScopes.size||this.scopes.size>1||this.traceOwner&&this.traceOwner!==profile)throw new Error('Performance tracing requires exclusive use of the browser window, without personal tabs; stop it before opening other spaces');this.traceOwner=profile;}
          else if(this.traceOwner===profile)this.traceOwner=null;
        },
      });
      scope.transport = transport;
      scope.browser = await chromium.connectOverCDP(transport, { isLocal: true, artifactsDir:this.artifacts, timeout: 10000 });
      scope.context = scope.browser.contexts()[0]; scope.context.setDefaultTimeout(10000); scope.context.setDefaultNavigationTimeout(15000);
      scope.link = new SpaceLink(this.link, scope.context, profile, transport);
      scope.link.selectedTarget = info.targetId;
      // Download policy is scoped to this Electron session, never to peer tabs.
      scope.resolve(); return scope;
    } catch (error) {
      scope.reject(error);
      this.scopes.delete(profile); scope.transport?.close(); await scope.browser?.close().catch(() => {});
      await this.link.call('closeScope', { profile }).catch(() => {}); if (!this.scopes.size && !this.humanScopes.size) await this.shutdown().catch(() => {}); throw error;
    }
  }
  async openHuman({profile,label,project='',url}) {
    if(this.closed||this.closing||this.failure)throw new Error('The browser window is unavailable');
    if(this.traceOwner)throw new Error('Finish the active performance trace before opening personal tabs');
    const reused=this.loaded.has(profile),wasHuman=this.humanScopes.has(profile);
    // Reserve the human scope before awaiting IPC: the last agent can finish
    // while a person is opening the window, and must not shut that window down.
    this.humanScopes.add(profile);
    try {
      const agent=this.scopes.get(profile);
      if(agent)await agent.ready;
      else {
        await this.link.call('openScope',{profile,label,project,clientId:'human'});
        this.loaded.add(profile);
      }
      if(url)await this.link.call('newTab',{profile,url,activate:true});
      await this.link.call('focusWindow',{profile});
      return {opened:true,reused};
    } catch(error) {
      if(!wasHuman)this.humanScopes.delete(profile);
      if(!this.scopes.size&&!this.humanScopes.size)await this.shutdown().catch(()=>{});
      throw error;
    }
  }

  release(profile) {
    // Native sessions share the process: complete each profile's storage flush
    // before the last release shuts that process down, including host shutdown.
    this.releaseQueue = (this.releaseQueue || Promise.resolve()).catch(() => {}).then(() => this.releaseScope(profile));
    return this.releaseQueue;
  }
  async releaseScope(profile) {
    const scope = this.scopes.get(profile); if (!scope) return;
    this.scopes.delete(profile); if(!this.humanScopes.has(profile))this.targets.delete(profile);
    if (!this.humanScopes.has(profile)) await this.link.call('closeScope', { profile }).catch(() => {});
    else await this.link.call('setAgent', { profile, state: 'idle', tool: '', detail: '' }).catch(() => {});
    await scope.browser?.close().catch(() => {}); scope.transport?.close();
    if (!this.scopes.size && !this.humanScopes.size) await this.shutdown();
  }
  async shutdown() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      for (const scope of this.scopes.values()) scope.transport?.close(); this.scopes.clear();
      const closed = this.context?.browser()?.close({ reason: 'Trex project browser closed' });
      let timer;
      try { if (closed) await Promise.race([closed.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); }
      await this.guard?.stop(); await closed?.catch(() => {}); this.closed = true;
    })();
    return this.closing;
  }
}

class SpaceLink {
  constructor(parent, context, profile, transport) { this.parent = parent; this.context = context; this.profile = profile; this.transport = transport; this.uiPage = parent.uiPage; this.ui = parent.ui; this.shared = true; }
  isUi(page) { return this.parent.isUi(page); }
  call(name, args = {}) { return this.parent.call(name, { ...args, profile: this.profile }); }
  push(name, args) {
    if (name === 'setSpaces') return this.parent.push(name, args.map(({ self, ...space }) => space));
    void this.call(name, args).catch(() => {});
  }
  async newTab(url) {
    const { targetId } = await this.call('newTab', { url, activate: false }); await this.transport.addTarget(targetId);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      for (const page of this.context.pages()) {
        const cdp = await this.context.newCDPSession(page);
        try { if ((await cdp.send('Target.getTargetInfo')).targetInfo.targetId === targetId) { this.selectedTarget = targetId; await this.select(page); return page; } }
        finally { await cdp.detach().catch(() => {}); }
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('New agent tab did not attach');
  }
  async select(page) {
    const cdp = await this.context.newCDPSession(page);
    try { this.selectedTarget = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach().catch(() => {}); }
    return this.call('selectTarget', { targetId: this.selectedTarget, background: true });
  }
  async focus() { try { return await this.call('focusWindow', { ...(this.selectedTarget ? { targetId: this.selectedTarget } : {}) }) || await this.call('focusWindow'); } catch { return false; } }
}
