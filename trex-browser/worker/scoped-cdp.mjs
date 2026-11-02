// A private CDP connection for one set of native tabs. Each Playwright client
// sees only its own targets and its own persistent Electron session.
export class ScopedCdp {
  constructor(root, { browserContextId, targets = [], createTarget, storage, manualDownloads = false, traceControl } = {}) {
    this.root = root; this.browserContextId = browserContextId; this.targets = new Set(targets);
    this.rootChannels = new Set(); this.pendingAttachments = new Map(); this.sequence = 0;
    this.sessions = new Map(); this.frames = new Set(); this.targetFrames = new Map(); this.downloads = new Set(); this.createTarget = createTarget; this.storage = storage; this.manualDownloads = manualDownloads; this.closed = false;
    this.traceControl = traceControl; this.traceRequests = new Set();
    root.on('Target.attachedToTarget', params => {
      if (!this.ownsTarget(params.targetInfo?.targetId)) return;
      const channel = this.pendingAttachments.get(params.targetInfo.targetId)?.shift()?.channel;
      this.sessions.set(params.sessionId, { parent: params.sessionId, target: params.targetInfo.targetId, channel });
      this.emit({ method: 'Target.attachedToTarget', params, ...(channel ? { sessionId: channel } : {}) });
    });
    root.on('Target.detachedFromTarget', params => {
      if (!this.sessions.has(params.sessionId)) return;
      const channel = this.sessions.get(params.sessionId).channel;
      for (const [id, session] of this.sessions) if (session.parent === params.sessionId) this.sessions.delete(id);
      this.emit({ method: 'Target.detachedFromTarget', params, ...(channel ? { sessionId: channel } : {}) });
    });
    root.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
      if (!this.sessions.has(sessionId)) return;
      const packet = JSON.parse(message), current = packet.sessionId || sessionId;
      if ((packet.id && this.traceRequests.delete(packet.id) && packet.error) || packet.method === 'Tracing.tracingComplete') this.traceControl?.('end');
      if (packet.method === 'Target.attachedToTarget') this.sessions.set(packet.params.sessionId, { parent: sessionId, target: packet.params.targetInfo.targetId });
      if (packet.method === 'Target.detachedFromTarget') this.sessions.delete(packet.params.sessionId);
      if (packet.method === 'Page.frameNavigated') { this.frames.add(packet.params.frame.id);if(!packet.params.frame.parentId)this.targetFrames.set(this.sessions.get(current)?.target,packet.params.frame.id); }
      if (packet.method === 'Page.frameAttached') this.frames.add(packet.params.frameId);
      this.emit({ ...packet, sessionId: current });
    });
    root.on('Browser.downloadWillBegin', params => {
      if (this.manualDownloads || !this.frames.has(params.frameId)) return;
      this.downloads.add(params.guid); this.emit({ method: 'Browser.downloadWillBegin', params });
    });
    root.on('Browser.downloadProgress', params => { if (!this.manualDownloads && this.downloads.has(params.guid)) this.emit({ method: 'Browser.downloadProgress', params }); });
    root.on('close', () => this.close());
  }
  emit(message) { queueMicrotask(() => { if (!this.closed) this.onmessage?.(message); }); }
  ownsTarget(targetId) { return this.targets.has(targetId) || [...this.sessions.values()].some(session => session.target === targetId); }
  removeTarget(targetId) { this.targets.delete(targetId); this.targetFrames.delete(targetId); this.pendingAttachments.delete(targetId); }
  download(message) {
    if (message.phase === 'begin') {
      const frameId=this.targetFrames.get(message.targetId);if(!frameId)return;
      this.downloads.add(message.guid);this.emit({method:'Browser.downloadWillBegin',params:{frameId,guid:message.guid,url:message.url,suggestedFilename:message.suggestedFilename}});
    } else if(this.downloads.has(message.guid))this.emit({method:'Browser.downloadProgress',params:message});
  }
  async addTarget(targetId) {
    if (this.closed || this.targets.has(targetId)) return;
    this.targets.add(targetId);
    if (this.autoAttach) await this.attach(targetId);
  }
  async attach(targetId,channel) {
    const queue=this.pendingAttachments.get(targetId)||[];queue.push({channel});this.pendingAttachments.set(targetId,queue);
    return this.root.send('Target.attachToTarget',{targetId,flatten:false});
  }
  send(message) {
    if (this.closed) return;
    void this.dispatch(message).catch(error => this.emit({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: String(error.message || error) } }));
  }
  async dispatch(message) {
    const { id, method, sessionId } = message; let params = message.params || {};
    const rootChannel = sessionId && this.rootChannels.has(sessionId);
    const session = sessionId && !rootChannel ? this.sessions.get(sessionId) : null;
    if (sessionId && !rootChannel && !session) throw new Error('Session is outside this agent space');
    // Apply ownership checks before forwarding page sessions too: CDP accepts
    // browser commands on page connections, not only on its root connection.
    const intercepted = ['Target.attachToBrowserTarget', 'Target.createTarget', 'Target.getTargets', 'Target.attachToTarget', 'Target.closeTarget', 'Target.detachFromTarget',
      'Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Browser.setDownloadBehavior', 'Browser.cancelDownload', 'Browser.grantPermissions', 'Browser.resetPermissions'].includes(method)
      || method === 'Target.getTargetInfo' && params.targetId;
    if (session && !intercepted) {
      if (method.startsWith('Browser.') || method.startsWith('Storage.') || method.startsWith('Target.') && !['Target.setAutoAttach', 'Target.getTargetInfo'].includes(method))
        throw new Error('Browser-wide control is not available inside an agent space');
      if (method === 'Tracing.start') { this.traceControl?.('start'); this.traceRequests.add(id); }
      try { await this.root.send('Target.sendMessageToTarget', { sessionId: session.parent, message: JSON.stringify({ id, method, params, ...(sessionId !== session.parent ? { sessionId } : {}) }) }); }
      catch (error) { if (this.traceRequests.delete(id)) this.traceControl?.('end'); throw error; }
      return;
    }
    let result;
    if (method === 'Target.setAutoAttach') {
      this.autoAttach = params.autoAttach;
      if (params.autoAttach) await Promise.all([...this.targets].map(targetId => this.attach(targetId,rootChannel?sessionId:undefined)));
      result = {};
    } else if(method==='Target.attachToBrowserTarget') {
      const channel=`scoped-browser-${++this.sequence}`;this.rootChannels.add(channel);result={sessionId:channel};
    } else if (method === 'Target.createTarget') {
      const created = await this.createTarget(params); await this.addTarget(created.targetId); result = { targetId: created.targetId };
    } else if (method === 'Target.getTargets') {
      const all = await this.root.send(method, params); result = { targetInfos: all.targetInfos.filter(target => this.ownsTarget(target.targetId)) };
    } else if (method === 'Target.attachToTarget' || method === 'Target.closeTarget' || method === 'Target.getTargetInfo' && params.targetId) {
      if (!this.ownsTarget(params.targetId)) throw new Error('Target is outside this agent space');
      result = method==='Target.attachToTarget'?await this.attach(params.targetId,sessionId):await this.root.send(method,params);
    } else if (method === 'Target.detachFromTarget') {
      if(this.rootChannels.has(params.sessionId)){this.rootChannels.delete(params.sessionId);this.emit({method:'Target.detachedFromTarget',params});result={};}
      else {if (!this.sessions.has(params.sessionId)) throw new Error('Session is outside this agent space');result = await this.root.send(method, params);}
    } else {
      if (['Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Browser.setDownloadBehavior', 'Browser.cancelDownload', 'Browser.grantPermissions', 'Browser.resetPermissions'].includes(method))
        result = this.storage ? await this.storage(method,params) : await this.root.send(method,{...params,browserContextId:this.browserContextId});
      else if (method === 'Browser.getVersion' || method === 'Target.getTargetInfo' && !params.targetId) result = await this.root.send(method, params);
      else throw new Error('Browser-wide control is not available inside an agent space');
    }
    this.emit({ id, result, ...(sessionId?{sessionId}:{}) });
  }
  close() { if (this.closed) return; this.closed = true; this.traceControl?.('end'); void this.root.detach().catch(() => {}); this.onclose?.(); }
}
