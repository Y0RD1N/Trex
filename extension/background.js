// «trex para tu navegador»: conexión con la app de trex y manejo de las pestañas compartidas.
//
// Regla que lo ordena todo: los agentes solo alcanzan las pestañas del grupo «trex»
// (las que abren ellos y las que la persona comparte). Cada orden que nombra una pestaña
// pasa por `sharedTab`, que lo comprueba aquí, en el navegador, y no solo en trex.
import { GROUP_TITLE, DEFAULT_PORT, DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS, webUrl, normalizeCode, validPort, parseKey, describeTabs, describePage, browserName } from "./lib.js";
import { collect, locate, ensureClicked, focusRef, activePassword, scrollPage } from "./page.js";

const VERSION = chrome.runtime.getManifest().version;
const RECONNECT_MS = 4000;
const LOAD_TIMEOUT_MS = 25000;
const CAPTURE_TIMEOUT_MS = 12000;
/** Lo que se espera a que el navegador entregue un clic de ratón antes de darlo directamente. */
const MOUSE_TIMEOUT_MS = 1500;
/** Sin órdenes durante este tiempo se suelta el depurador (y desaparece el aviso de Chrome). */
const IDLE_DETACH_MS = 2 * 60 * 1000;
const MAX_ELEMENTS = 400;

let socket = null;
let state = "sin-emparejar"; // sin-emparejar | conectando | conectado | sin-trex | rechazado
let lastError = "";
let reconnectTimer = null;
let lastCallAt = 0;
/** Pestañas con el depurador puesto → contexto del mundo aislado (o null si hay que crearlo). */
const attached = new Map();

const stored = () => chrome.storage.local.get({ token: "", port: DEFAULT_PORT, name: "" });
const setState = (next, error = "") => { state = next; lastError = error; chrome.runtime.sendMessage({ type: "state" }).catch(() => {}); };

// --- Conexión con trex -----------------------------------------------------------

async function connect() {
  clearTimeout(reconnectTimer);
  const { token, port } = await stored();
  if (!token) { setState("sin-emparejar"); return; }
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  setState("conectando");
  let opened;
  try { opened = new WebSocket(`ws://127.0.0.1:${port}/ws`); } catch { scheduleReconnect(); return; }
  socket = opened;
  opened.onopen = () => opened.send(JSON.stringify({ type: "hello", token, version: VERSION }));
  opened.onmessage = event => { void onMessage(opened, event.data); };
  opened.onclose = () => {
    if (socket !== opened) return;
    socket = null;
    void detachAll();
    if (state !== "rechazado" && state !== "sin-emparejar") { setState("sin-trex"); scheduleReconnect(); }
  };
  opened.onerror = () => { /* onclose se encarga */ };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), RECONNECT_MS);
}

async function onMessage(from, data) {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message.type === "ready") { setState("conectado"); return; }
  if (message.type === "denied") {
    // trex ya no reconoce este navegador: el token no sirve y hay que emparejar de nuevo.
    await chrome.storage.local.remove("token");
    setState("rechazado", message.error || "");
    from.close();
    return;
  }
  if (message.type === "ping") {
    from.send(JSON.stringify({ type: "pong" }));
    if (attached.size && Date.now() - lastCallAt > IDLE_DETACH_MS) void detachAll();
    return;
  }
  if (message.type !== "call" || typeof message.id !== "number") return;
  lastCallAt = Date.now();
  let reply;
  try {
    const value = await run(message.method, message.params?.arguments ?? {});
    reply = { type: "result", id: message.id, ok: true, value };
  } catch (error) {
    reply = { type: "result", id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 1500) };
  }
  if (from.readyState === WebSocket.OPEN) from.send(JSON.stringify(reply));
}

// --- El grupo «trex» ----------------------------------------------------------------

const groupIds = async () => (await chrome.tabGroups.query({ title: GROUP_TITLE })).map(group => group.id);

async function sharedTabs() {
  const ids = new Set(await groupIds());
  if (!ids.size) return [];
  return (await chrome.tabs.query({})).filter(tab => ids.has(tab.groupId));
}

/** La pestaña, solo si está en el grupo «trex». Es la puerta de todas las herramientas. */
async function sharedTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Falta tabId. Consulta las pestañas con tabs_list.");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const inGroup = tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    && (await chrome.tabGroups.get(tab.groupId).catch(() => null))?.title === GROUP_TITLE;
  if (!inGroup) throw new Error("Esa pestaña no está en el grupo «trex»: no la puedo ver ni manejar. Usa tabs_list.");
  return tab;
}

/** Mete una pestaña en el grupo «trex» (lo crea si no existe en esa ventana). */
async function share(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const existing = (await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId }))[0];
  const groupId = await chrome.tabs.group(existing ? { tabIds: tabId, groupId: existing.id } : { tabIds: tabId });
  if (!existing) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange" });
  return groupId;
}

async function unshare(tabId) {
  await detach(tabId);
  await chrome.tabs.ungroup(tabId);
}

// --- Depurador ------------------------------------------------------------------------

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const text = String(error?.message ?? error);
    if (/already attached|Another debugger/i.test(text)) throw new Error("Esa pestaña tiene abiertas las herramientas de desarrollador u otro depurador. Ciérralo para que trex pueda manejarla.");
    throw new Error(`No se pudo conectar con la pestaña: ${text}`);
  }
  attached.set(tabId, null);
}

async function detach(tabId) {
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const detachAll = () => Promise.all([...attached.keys()].map(detach));

const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) attached.delete(source.tabId); });
// La pestaña navegó: el mundo aislado y sus referencias ya no existen.
chrome.debugger.onEvent.addListener((source, method) => {
  if (source.tabId !== undefined && method === "Runtime.executionContextsCleared" && attached.has(source.tabId)) attached.set(source.tabId, null);
});
chrome.tabs.onRemoved.addListener(tabId => { attached.delete(tabId); });
// Sale del grupo «trex»: se suelta al momento.
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.groupId !== undefined && attached.has(tabId)) void sharedTab(tabId).catch(() => detach(tabId)); });

/** Ejecuta en la pestaña una función de page.js, dentro de un mundo aislado de la página. */
async function inPage(tabId, fn, ...args) {
  await attach(tabId);
  const expression = `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(", ")})`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let contextId = attached.get(tabId);
    if (!contextId) {
      await send(tabId, "Runtime.enable").catch(() => {});
      const { frameTree } = await send(tabId, "Page.getFrameTree");
      ({ executionContextId: contextId } = await send(tabId, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "trex" }));
      attached.set(tabId, contextId);
    }
    try {
      const result = await send(tabId, "Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "La página rechazó la lectura.");
      return result.result.value;
    } catch (error) {
      // El contexto se perdió (navegación): se crea otro y se reintenta una vez.
      if (attempt === 0 && /context|Cannot find/i.test(String(error?.message ?? error))) { attached.set(tabId, null); continue; }
      throw error;
    }
  }
  throw new Error("No se pudo leer la página.");
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, change) => { if (id === tabId && change.status === "complete") done(); };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    // Puede que ya hubiera terminado antes de escuchar.
    chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") done(); }).catch(done);
  });
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tabLine(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return `tabId ${tab.id} · ${tab.title || "Sin título"} · ${tab.url || ""}`;
}

// --- Herramientas -------------------------------------------------------------------------

async function pressKey(tabId, parsed) {
  const base = { modifiers: parsed.modifiers, key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.keyCode, nativeVirtualKeyCode: parsed.keyCode };
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: parsed.text ? "keyDown" : "rawKeyDown", ...(parsed.text ? { text: parsed.text } : {}) });
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const TOOLS = {
  async tabs_list() {
    return { text: describeTabs(await sharedTabs()) };
  },

  async read_page({ tabId, maxChars }) {
    await sharedTab(tabId);
    const limit = Math.min(MAX_PAGE_CHARS, Math.max(1000, Number.isInteger(maxChars) ? maxChars : DEFAULT_PAGE_CHARS));
    return { text: describePage(await inPage(tabId, collect, limit, MAX_ELEMENTS)) };
  },

  async screenshot({ tabId }) {
    const tab = await sharedTab(tabId);
    await attach(tabId);
    const capture = send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 72, fromSurface: true });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(tab.active
      ? "El navegador no entregó la captura a tiempo."
      : "No se puede capturar una pestaña que está en segundo plano. Pide a la persona que la ponga delante, o usa read_page.")), CAPTURE_TIMEOUT_MS));
    const { data } = await Promise.race([capture, timeout]);
    return { text: `Captura de ${tab.title || tab.url || "la pestaña"}.`, image: { mimeType: "image/jpeg", data } };
  },

  async tab_open({ url }) {
    const target = webUrl(url);
    if (!target) throw new Error("Solo se pueden abrir direcciones http o https.");
    const window = (await sharedTabs())[0]?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    // Sin robar el foco: la persona sigue en su pestaña.
    const tab = await chrome.tabs.create({ url: target, windowId: window, active: false });
    await share(tab.id);
    await waitForLoad(tab.id);
    return { text: `Abierta. ${await tabLine(tab.id)}` };
  },

  async navigate({ tabId, url }) {
    await sharedTab(tabId);
    if (url === "back") await chrome.tabs.goBack(tabId).catch(() => { throw new Error("No hay página anterior."); });
    else if (url === "forward") await chrome.tabs.goForward(tabId).catch(() => { throw new Error("No hay página siguiente."); });
    else {
      const target = webUrl(url);
      if (!target) throw new Error("Solo se puede ir a direcciones http o https, o usar «back» y «forward».");
      await chrome.tabs.update(tabId, { url: target });
    }
    await settle(150);
    await waitForLoad(tabId);
    return { text: `Cargada. ${await tabLine(tabId)}` };
  },

  async click({ tabId, ref }) {
    await sharedTab(tabId);
    const point = await inPage(tabId, locate, String(ref), true);
    if (!point) throw new Error("Esa referencia ya no existe. Vuelve a leer la página con read_page.");
    // El ratón de verdad solo sirve si la página se está pintando y el punto es del elemento.
    // Con la ventana minimizada o tapada, o la pestaña detrás, el navegador retiene esos
    // eventos varios segundos y la página puede haberse movido cuando llegan.
    if (!point.hidden && !point.covered) {
      const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      const pressed = (async () => {
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mouseMoved", button: "none" });
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
      })();
      pressed.catch(() => {});
      await Promise.race([pressed, settle(MOUSE_TIMEOUT_MS)]).catch(() => {});
      await settle(60);
    }
    // Si el elemento no recibió el clic, se le da directamente (y si la página ya navegó, no hay nada que hacer).
    await inPage(tabId, ensureClicked).catch(() => "perdido");
    await settle(250);
    return { text: `Clic hecho en ${ref}. Si la página cambió, vuelve a leerla.` };
  },

  async type({ tabId, ref, text, submit }) {
    await sharedTab(tabId);
    if (typeof text !== "string" || text.length > 20000) throw new Error("Falta el texto, o es demasiado largo.");
    const field = ref ? await inPage(tabId, focusRef, String(ref)) : { password: await inPage(tabId, activePassword) };
    if (!field) throw new Error("Esa referencia ya no existe. Vuelve a leer la página con read_page.");
    // Barrera, no solo consejo: las contraseñas las escribe la persona.
    if (field.password) throw new Error("No escribo en campos de contraseña. Pide a la persona que la introduzca ella.");
    await send(tabId, "Input.insertText", { text });
    if (submit) await pressKey(tabId, parseKey("Enter"));
    await settle(submit ? 400 : 100);
    return { text: submit ? "Texto escrito y enviado con Intro. Vuelve a leer la página." : "Texto escrito." };
  },

  async key({ tabId, key }) {
    await sharedTab(tabId);
    const parsed = parseKey(key);
    if (!parsed) throw new Error("No reconozco esa tecla. Ejemplos: Enter, Escape, Tab, ArrowDown, ctrl+a.");
    await attach(tabId);
    await pressKey(tabId, parsed);
    await settle(150);
    return { text: `Tecla ${key} pulsada.` };
  },

  async scroll({ tabId, direction, ref }) {
    await sharedTab(tabId);
    if (ref) {
      if (!await inPage(tabId, locate, String(ref))) throw new Error("Esa referencia ya no existe. Vuelve a leer la página con read_page.");
      return { text: `${ref} está a la vista.` };
    }
    const where = await inPage(tabId, scrollPage, ["up", "down", "top", "bottom"].includes(direction) ? direction : "down");
    return { text: `Desplazado. Posición ${where.y} de ${where.max}.${where.y >= where.max ? " Es el final de la página." : ""}` };
  },

  async tab_close({ tabId }) {
    await sharedTab(tabId);
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return { text: "Pestaña cerrada." };
  },
};

async function run(method, args) {
  const tool = Object.hasOwn(TOOLS, method) ? TOOLS[method] : null;
  if (!tool) throw new Error("Herramienta desconocida.");
  return tool(args && typeof args === "object" ? args : {});
}

// --- Ventanita de la extensión ---------------------------------------------------------------

async function pair(code, portText) {
  const port = validPort(portText);
  if (!port) throw new Error("El puerto no es válido.");
  const clean = normalizeCode(code);
  if (clean.length < 6) throw new Error("Escribe el código de 6 caracteres que muestra trex.");
  const name = browserName(navigator.userAgentData?.brands, !!navigator.brave);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: clean, name }) });
  } catch {
    throw new Error("No encuentro trex. Ábrelo y activa «Tu navegador» en Ajustes › Conexiones › Navegador.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string") throw new Error(body.error || "trex rechazó el emparejado.");
  await chrome.storage.local.set({ token: body.token, port, name: body.browser?.name ?? name });
  socket?.close();
  socket = null;
  await connect();
}

async function unpair() {
  await chrome.storage.local.remove("token");
  socket?.close();
  socket = null;
  await detachAll();
  setState("sin-emparejar");
}

async function popupState() {
  const { token, port, name } = await stored();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const shared = active ? await sharedTab(active.id).then(() => true, () => false) : false;
  return {
    paired: !!token, state: token ? state : "sin-emparejar", error: lastError, port, name, version: VERSION,
    tab: active ? { id: active.id, shared, shareable: !!webUrl(active.url ?? "") } : null,
    sharedCount: (await sharedTabs()).length,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const actions = {
    status: () => popupState(),
    pair: () => pair(message.code, message.port).then(popupState),
    unpair: () => unpair().then(popupState),
    share: () => share(message.tabId).then(popupState),
    unshare: () => unshare(message.tabId).then(popupState),
    retry: () => connect().then(popupState),
  };
  const action = Object.hasOwn(actions, message?.type) ? actions[message.type] : null;
  if (!action) return false;
  action().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: String(error?.message ?? error) }));
  return true;
});

// --- Arranque -------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
// Chrome duerme este script cuando no hay nada que hacer: una alarma lo despierta para reconectar.
chrome.alarms.create("trex-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "trex-reconnect") void connect(); });
void connect();
