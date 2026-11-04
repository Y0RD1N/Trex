const ACTIONS = new Set(['focus', 'pause', 'resume', 'takeover', 'screenshot']);
/** A native control only succeeds once the worker has applied it. */
export function humanControls(send, { timeoutMs = 15000 } = {}) {
  const pending = new Map(); let sequence = 0, closed = false;
  const finish = (id, error, result) => {
    const request = pending.get(id); if (!request) return false;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(result); return true;
  };
  return {
    request({ action, clientId = 'self', profile } = {}) {
      if (!ACTIONS.has(action) || typeof clientId !== 'string' || !clientId || clientId.length > 256
        || profile != null && (typeof profile !== 'string' || !/^(?:[a-f0-9]{24}\/)?BROWSER[1-9][0-9]?$/.test(profile)))
        return Promise.reject(new Error('Control de navegador no válido.'));
      if (closed || pending.size >= 20) return Promise.reject(new Error('El navegador no está disponible. Vuelve a abrir el panel.'));
      return new Promise((resolve, reject) => {
        const requestId = `control-${++sequence}`;
        const timer = setTimeout(() => finish(requestId, new Error('El navegador no confirmó la acción. Comprueba que el agente y Trex Browser sigan conectados.')), timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try { send({ type: 'control', action, clientId, ...(profile ? { profile } : {}), requestId }); }
        catch (error) { finish(requestId, error); }
      });
    },
    complete({ requestId, result } = {}) {
      if (typeof requestId !== 'string' || !pending.has(requestId)) return false;
      return finish(requestId, result?.ok === true ? null : new Error(String(result?.error || 'No se pudo aplicar el control del navegador.').slice(0, 1000)), result);
    },
    close() { closed = true; for (const id of pending.keys()) finish(id, new Error('La ventana del navegador se cerró.')); },
  };
}
