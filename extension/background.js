// «trex para tu navegador»: conexión con la app de trex y manejo de las pestañas compartidas.
//
// Regla que lo ordena todo: cada chat de trex solo alcanza las pestañas de SU grupo
// («trex · <nombre del chat>»): las que abre él y las que la persona le da. Cada orden de
// trex dice de qué chat viene (un id opaco, no su token) y cada orden que nombra una
// pestaña pasa por `ownTab`, que lo comprueba aquí, en el navegador, y no solo en trex.
//
// Pestañas de la persona: lo que comparte desde la ventanita va al grupo común «trex»
// (o, si lo elige, al grupo de un chat concreto). Cualquier chat ve las del grupo común;
// la primera que use una se la queda: pasa a su grupo y deja de estar al alcance de los
// demás hasta que la persona la saque de ahí.
import {
  GROUP_TITLE, COMMON_COLOR, ENDED_COLOR, DEFAULT_PORT, DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS, MAX_TEXT, CARD_REFUSAL,
  webUrl, normalizeCode, validPort, parseKey, describeTabs, describePage, describeDialog, browserName, chatOf, chatTitle, chatColor,
  tabAccess, splitTabs, knownChats, fieldBlock, looksLikeCard, validRef, formFields, pickOption, listOptions, waitSpec, waitResult,
  uploadPaths, clip, DEFAULT_EDGE, LARGE_CHANGE, QUIET_MS, SETTLE_MAX_MS, HIDDEN_SETTLE_MS, HIDDEN_SETTLE_MAX_MS, CAPTURE_MODES, captureSpec, captureScale, regionArea, capturePoint,
  changedArea, describeCapture, describeChange, jpegSize,
} from "./lib.js";
import {
  collect, locate, ensureClicked, focusRef, fieldInfo, setValue, setChecked, chooseOption, probe, refElement, scrollPage,
  viewInfo, shieldResize, refArea, sensitiveRects, labelRects, watchChanges, changesQuiet, changesReport, pointAt, clickedAt,
} from "./page.js";

const VERSION = chrome.runtime.getManifest().version;
const RECONNECT_MS = 4000;
const LOAD_TIMEOUT_MS = 25000;
/** Con la pestaña delante, una captura tarda menos de medio segundo; si no llega, se prueba como con la pestaña detrás. */
const VISIBLE_CAPTURE_MS = 4000;
/** Con la pestaña detrás: lo que se espera a cada petición antes de pedir otra (ver `shootHidden`). */
const HIDDEN_WAITS_MS = [250, 1500, 3000];
const JPEG_QUALITY = 80;
/** Elementos numerados como mucho en una captura con «labels». */
const MAX_LABELS = 150;
/** Tras una acción que lleva a otra página, lo que se espera a que cargue antes de capturarla. */
const AFTER_LOAD_MS = 8000;
/** Lo que se espera a que el navegador entregue un clic de ratón antes de darlo directamente. */
const MOUSE_TIMEOUT_MS = 1500;
/** Sin órdenes durante este tiempo se suelta el depurador (y desaparece el aviso de Chrome). */
const IDLE_DETACH_MS = 2 * 60 * 1000;
const MAX_ELEMENTS = 400;
/** wait_for mira la página cada tanto; una mirada que tarda más se da por «aún no». */
const WAIT_STEP_MS = 250;
const PROBE_TIMEOUT_MS = 2000;
const OWNERS_KEY = "owners";
const GONE = "Esa referencia ya no existe. Vuelve a leer la página con read_page.";
const FILE_ACCESS = "Para subir archivos, la persona tiene que activar «Permitir el acceso a las URL de archivo» en los detalles de la extensión (chrome://extensions). Pídeselo.";

let socket = null;
let state = "sin-emparejar"; // sin-emparejar | conectando | conectado | sin-trex | rechazado
let lastError = "";
let reconnectTimer = null;
let lastCallAt = 0;
/** Pestañas con el depurador puesto → contexto del mundo aislado (o null si hay que crearlo). */
const attached = new Map();
/** Diálogos (alert, confirm, prompt) abiertos ahora, por pestaña. */
const dialogs = new Map();
/** Quien espera a que se abra un diálogo en una pestaña. */
const dialogWaiters = new Map();
/**
 * La última captura de cada pestaña: dónde empieza en el documento, su escala y su tamaño.
 * Con ella, `region` y `click_at` traducen píxeles de esa imagen a la página. Solo números:
 * la imagen no se guarda.
 */
const shots = new Map();

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
  // Un chat terminó: sus grupos dejan de ser suyos (las pestañas se quedan, son de la persona).
  if (message.type === "release") {
    const chat = chatOf({ owner: message.owner });
    if (chat) void release(chat.owner);
    return;
  }
  if (message.type !== "call" || typeof message.id !== "number") return;
  lastCallAt = Date.now();
  let reply;
  try {
    const value = await run(message.method, message.params);
    reply = { type: "result", id: message.id, ok: true, value };
  } catch (error) {
    reply = { type: "result", id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 1500) };
  }
  if (from.readyState === WebSocket.OPEN) from.send(JSON.stringify(reply));
}

// --- Grupos: uno por chat, y el común «trex» ---------------------------------------------
//
// De quién es cada grupo se apunta aquí, por id de grupo, en chrome.storage.session: aguanta
// que Chrome duerma este script y se borra al cerrar el navegador (los ids de grupo tampoco
// sobreviven a eso). El título no da ni quita nada: la persona puede renombrar el grupo de un
// chat y sigue siendo de ese chat; un grupo que se llame como otro no es de nadie.

const readOwners = async () => (await chrome.storage.session.get({ [OWNERS_KEY]: {} }))[OWNERS_KEY] ?? {};
const writeOwners = owners => chrome.storage.session.set({ [OWNERS_KEY]: owners });

let queue = Promise.resolve();
/** Los cambios de grupo van de uno en uno: dos chats no pueden reclamar a la vez la misma pestaña. */
function exclusive(work) {
  const turn = queue.then(work);
  queue = turn.catch(() => {});
  return turn;
}

/** Los grupos comunes: titulados «trex» y sin dueño. */
async function commonGroups(owners) {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return new Set(groups.filter(group => group.title === GROUP_TITLE && !owners[group.id]).map(group => group.id));
}

/** Las pestañas que ve un chat: las suyas y las del grupo común. */
async function visibleTabs(chat) {
  const owners = await readOwners();
  return splitTabs(await chrome.tabs.query({}), owners, chat.owner, await commonGroups(owners));
}

/** El grupo de un chat en una ventana, si ya lo tiene. Olvida de paso los grupos que ya no existen. */
async function chatGroupIn(chat, windowId, owners) {
  for (const [id, entry] of Object.entries(owners)) {
    if (entry.owner !== chat.owner) continue;
    const group = await chrome.tabGroups.get(Number(id)).catch(() => null);
    if (!group) { delete owners[id]; continue; }
    if (group.windowId === windowId) return group.id;
  }
  return null;
}

/** Mete una pestaña en el grupo del chat en su ventana (lo crea si no existe). Va dentro de `exclusive`. */
async function intoChatGroup(chat, tabId, owners) {
  const tab = await chrome.tabs.get(tabId);
  const existing = await chatGroupIn(chat, tab.windowId, owners);
  if (existing !== null) {
    await chrome.tabs.group({ groupId: existing, tabIds: tabId });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: chat.title, color: chat.color });
    owners[groupId] = { owner: chat.owner, title: chat.title };
  }
  await writeOwners(owners);
}

/**
 * Si el chat cambió de nombre, su grupo también; salvo que la persona lo haya renombrado a
 * mano (el título ya no es el que puso la extensión): entonces se respeta el suyo.
 */
async function retitle(chat, groupId, owners) {
  const entry = owners[groupId];
  if (!entry || entry.title === chat.title) return;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (group && group.title === entry.title) await chrome.tabGroups.update(groupId, { title: chat.title });
  owners[groupId] = { ...entry, title: chat.title };
  await writeOwners(owners);
}

/**
 * La pestaña, solo si es de este chat. Si está en el grupo común, la reclama: pasa al grupo
 * del chat. Es la puerta de todas las herramientas que nombran una pestaña.
 */
function ownTab(chat, tabId) {
  if (!Number.isInteger(tabId)) return Promise.reject(new Error("Falta tabId. Consulta tus pestañas con tabs_list."));
  return exclusive(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const owners = await readOwners();
    const access = tab ? tabAccess(tab.groupId, owners, chat.owner, await commonGroups(owners)) : "fuera";
    if (access === "ajena") throw new Error("Esa pestaña es de otro chat: no la puedo ver ni manejar. Usa tabs_list para ver las tuyas.");
    if (access === "fuera") throw new Error("Esa pestaña no está compartida con este chat: no la puedo ver ni manejar. Usa tabs_list.");
    if (access === "comun") {
      await intoChatGroup(chat, tabId, owners);
      return chrome.tabs.get(tabId);
    }
    await retitle(chat, tab.groupId, owners);
    return tab;
  });
}

/** Si una pestaña sigue en algún grupo de trex (de un chat o el común). */
async function stillShared(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !Number.isInteger(tab.groupId) || tab.groupId < 0) return false;
  const owners = await readOwners();
  return !!owners[tab.groupId] || (await commonGroups(owners)).has(tab.groupId);
}

/** Desde la ventanita: al grupo común «trex», o al de un chat concreto que ya tenga grupo. */
function share(tabId, owner) {
  return exclusive(async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!webUrl(tab.url ?? "")) throw new Error("Solo se pueden compartir páginas web.");
    const owners = await readOwners();
    if (owner) {
      const known = Object.values(owners).find(entry => entry.owner === owner);
      if (!known) throw new Error("Ese chat ya no tiene grupo. Comparte la pestaña en el grupo común «trex».");
      await intoChatGroup({ owner, title: chatTitle(known.title), color: chatColor(owner) }, tabId, owners);
      return;
    }
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    const existing = groups.find(group => group.title === GROUP_TITLE && !owners[group.id]);
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: tabId });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: COMMON_COLOR });
    }
  });
}

async function unshare(tabId) {
  await detach(tabId);
  await chrome.tabs.ungroup(tabId);
}

/**
 * El chat terminó. Sus pestañas no se cierran ni se desagrupan (son de la persona, y así las
 * puede cerrar todas de una vez): su grupo se queda, gris y sin dueño, y ningún chat lo alcanza.
 */
function release(owner) {
  return exclusive(async () => {
    const owners = await readOwners();
    for (const [id, entry] of Object.entries(owners)) {
      if (entry.owner !== owner) continue;
      delete owners[id];
      await chrome.tabGroups.update(Number(id), { color: ENDED_COLOR }).catch(() => {});
      for (const tab of await chrome.tabs.query({ groupId: Number(id) }).catch(() => [])) await detach(tab.id);
    }
    await writeOwners(owners);
  });
}

chrome.tabGroups.onRemoved.addListener(group => {
  void exclusive(async () => {
    const owners = await readOwners();
    if (!owners[group.id]) return;
    delete owners[group.id];
    await writeOwners(owners);
  });
});

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
  // Para enterarse de los diálogos (alert, confirm, prompt) que abra la página.
  await send(tabId, "Page.enable").catch(() => {});
}

async function detach(tabId) {
  dialogs.delete(tabId);
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const detachAll = () => Promise.all([...attached.keys()].map(detach));

const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  dialogs.delete(source.tabId);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !attached.has(tabId)) return;
  // La pestaña navegó: el mundo aislado, sus referencias y la última captura ya no valen.
  if (method === "Runtime.executionContextsCleared") { attached.set(tabId, null); shots.delete(tabId); }
  if (method === "Page.javascriptDialogOpening") {
    const dialog = { type: params?.type, message: String(params?.message ?? ""), defaultPrompt: String(params?.defaultPrompt ?? "") };
    dialogs.set(tabId, dialog);
    for (const wake of dialogWaiters.get(tabId) ?? []) wake(dialog);
    dialogWaiters.delete(tabId);
  }
  if (method === "Page.javascriptDialogClosed") dialogs.delete(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => { attached.delete(tabId); dialogs.delete(tabId); shots.delete(tabId); });
// Sale de los grupos de trex: se suelta al momento. Va en turno con los cambios de grupo, para
// no soltarla mientras pasa del grupo común al de un chat.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.groupId === undefined || !attached.has(tabId)) return;
  void exclusive(async () => { if (!await stillShared(tabId)) await detach(tabId); });
});

// --- Diálogos ----------------------------------------------------------------------------

/** Una herramienta no puede seguir: la página está parada en un diálogo. */
class DialogOpen extends Error {
  constructor(dialog) { super(describeDialog(dialog)); this.dialog = dialog; }
}

/**
 * `opened` se resuelve cuando hay un diálogo abierto en la pestaña (al momento, si ya lo hay).
 * Quien deja de esperar llama a `stop`, para no ir acumulando esperas.
 */
function dialogOpened(tabId) {
  if (dialogs.has(tabId)) return { opened: Promise.resolve(dialogs.get(tabId)), stop() {} };
  let wake;
  const opened = new Promise(resolve => { wake = resolve; });
  const waiting = dialogWaiters.get(tabId) ?? new Set();
  waiting.add(wake);
  dialogWaiters.set(tabId, waiting);
  const stop = () => {
    waiting.delete(wake);
    if (!waiting.size && dialogWaiters.get(tabId) === waiting) dialogWaiters.delete(tabId);
  };
  return { opened, stop };
}

/** Antes de tocar la página: con un diálogo abierto, cualquier orden se quedaría colgada. */
function idle(tabId) {
  if (dialogs.has(tabId)) throw new DialogOpen(dialogs.get(tabId));
}

/** Espera a `work`, salvo que la página abra un diálogo: entonces deja de esperar y lo dice. */
async function unlessDialog(tabId, work) {
  const done = Promise.resolve(work).then(value => ({ value }));
  done.catch(() => {});
  const watch = dialogOpened(tabId);
  try {
    const outcome = await Promise.race([done, watch.opened.then(dialog => ({ dialog }))]);
    if (outcome.dialog) throw new DialogOpen(outcome.dialog);
    return outcome.value;
  } finally {
    watch.stop();
  }
}

/** Para las acciones que ya se hicieron: si después saltó un diálogo, se añade al resultado. */
async function andDialog(tabId, work) {
  try {
    await unlessDialog(tabId, work);
    return "";
  } catch (error) {
    if (error instanceof DialogOpen) return ` ${error.message}`;
    throw error;
  }
}

// --- En la página --------------------------------------------------------------------------

/** Evalúa en la pestaña una función de page.js, dentro de un mundo aislado de la página. */
async function evaluate(tabId, fn, args, byValue) {
  idle(tabId);
  await attach(tabId);
  const expression = `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(", ")})`;
  return unlessDialog(tabId, (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let contextId = attached.get(tabId);
      if (!contextId) {
        await send(tabId, "Runtime.enable").catch(() => {});
        const { frameTree } = await send(tabId, "Page.getFrameTree");
        ({ executionContextId: contextId } = await send(tabId, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "trex" }));
        attached.set(tabId, contextId);
      }
      try {
        const result = await send(tabId, "Runtime.evaluate", { expression, contextId, returnByValue: byValue, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "La página rechazó la lectura.");
        return result.result;
      } catch (error) {
        // El contexto se perdió (navegación): se crea otro y se reintenta una vez.
        if (attempt === 0 && /context|Cannot find/i.test(String(error?.message ?? error))) { attached.set(tabId, null); continue; }
        throw error;
      }
    }
    throw new Error("No se pudo leer la página.");
  })());
}

const inPage = async (tabId, fn, ...args) => (await evaluate(tabId, fn, args, true)).value;

/** Espera a que la pestaña termine de cargar. `false` si se acaba el tiempo. */
function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise(resolve => {
    const done = loaded => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(loaded); };
    const listener = (id, change) => { if (id === tabId && change.status === "complete") done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Puede que ya hubiera terminado antes de escuchar.
    chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") done(true); }).catch(() => done(true));
  });
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tabLine(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return `tabId ${tab.id} · ${tab.title || "Sin título"} · ${tab.url || ""}`;
}

async function pressKey(tabId, parsed) {
  const base = { modifiers: parsed.modifiers, key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.keyCode, nativeVirtualKeyCode: parsed.keyCode };
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: parsed.text ? "keyDown" : "rawKeyDown", ...(parsed.text ? { text: parsed.text } : {}) });
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

/** Escribe en el campo que tiene el foco, sustituyendo lo seleccionado. Vacío: lo borra. */
async function writeText(tabId, text) {
  idle(tabId);
  if (text) await send(tabId, "Input.insertText", { text });
  else await pressKey(tabId, parseKey("Backspace"));
}

/**
 * Subir archivos con el depurador exige que la persona haya activado «Permitir el acceso a las
 * URL de archivo» para la extensión. Si no se puede saber, se intenta y el navegador lo dirá.
 */
async function fileAccess() {
  try { return await chrome.extension.isAllowedFileSchemeAccess() !== false; } catch { return true; }
}

/** Barrera, no solo consejo: contraseñas, códigos de verificación y datos de pago los escribe la persona. */
function refuseSensitive(field, text) {
  const reason = fieldBlock(field) ?? (looksLikeCard(text) ? CARD_REFUSAL : null);
  if (reason) throw new Error(reason);
}

// --- Capturas -------------------------------------------------------------------------------
//
// Solo con el depurador de la pestaña del chat (`Page.captureScreenshot`): nunca
// `captureVisibleTab` ni nada que vea otras pestañas, la ventana o la pantalla.

const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
function toBase64(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** Una captura con tiempo límite: sus datos, o `null` si no llega. Si salta un diálogo, lo dice. */
async function shoot(tabId, params, timeoutMs) {
  const work = unlessDialog(tabId, send(tabId, "Page.captureScreenshot", params));
  work.catch(() => {});
  const result = await Promise.race([work, settle(timeoutMs).then(() => null)]);
  return result?.data ?? null;
}

/**
 * Capturas de una pestaña que no se está pintando. Medido en Brave: una petición se queda sin
 * respuesta hasta que llega la siguiente, y entonces responden las dos; la otra mitad de las
 * veces responde a la primera. Así que se pide, y si no llega pronto, se pide otra vez
 * (con más margen cada vez) y vale la primera que conteste.
 */
async function shootHidden(tabId, params) {
  const never = new Promise(() => {});
  const asked = [];
  for (const waitMs of HIDDEN_WAITS_MS) {
    const request = unlessDialog(tabId, send(tabId, "Page.captureScreenshot", params));
    request.catch(() => {});
    asked.push(request.then(result => result?.data ? result.data : never, error => error instanceof DialogOpen ? Promise.reject(error) : never));
    const data = await Promise.race([...asked, settle(waitMs).then(() => null)]);
    if (data) return data;
  }
  return null;
}

/**
 * La vista entera de la pestaña, a la resolución de la pantalla. Se pide siempre lo mismo, sin
 * `clip` ni escala: con ellos el navegador cambia la vista por dentro para capturar y, si una
 * captura no llega, la deja así (la siguiente sale a otra escala o del tamaño del recorte).
 * Recortar y reducir se hace después, en `finish`.
 *
 * Con la pestaña delante, la captura de siempre. Con la pestaña detrás o la ventana minimizada
 * el navegador no la pinta y esa captura no llega nunca: fijar la vista a su mismo tamaño
 * (`setDeviceMetricsOverride`) la hace pintar para la ocasión, sin cambiar cómo se ve. La
 * página recibiría un aviso de cambio de tamaño, que `shieldResize` le oculta.
 */
async function grab(tabId, view) {
  const params = { format: "jpeg", quality: JPEG_QUALITY, fromSurface: true };
  if (!view.hidden) {
    const data = await shoot(tabId, params, VISIBLE_CAPTURE_MS);
    if (data) return data;
  }
  await glance(tabId, shieldResize, true);
  try {
    await send(tabId, "Emulation.setDeviceMetricsOverride", { width: view.outerWidth, height: view.outerHeight, deviceScaleFactor: 0, mobile: false });
    const data = await shootHidden(tabId, params);
    if (data) return data;
  } finally {
    await send(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await glance(tabId, shieldResize, false).catch(() => {});
  }
  throw new Error("El navegador no entregó la captura. Inténtalo otra vez en un momento, o usa read_page.");
}

/**
 * La imagen final, a partir de la vista entera: recortada a `area`, reducida a `size`, con lo
 * sensible tapado y, si se piden, los elementos numerados. Se dibuja sobre la imagen, nunca en
 * la página. Si no hay nada que hacer, la de origen tal cual.
 */
async function finish(data, view, area, size, masks, boxes) {
  const bitmap = await createImageBitmap(new Blob([fromBase64(data)], { type: "image/jpeg" }));
  // La captura cubre la vista con sus barras de desplazamiento: de ahí sale su escala real.
  const k = bitmap.width / view.outerWidth;
  const source = [(area.x - view.x) * k, (area.y - view.y) * k, area.width * k, area.height * k];
  const whole = source[0] < 1 && source[1] < 1 && Math.abs(source[2] - bitmap.width) < 2 && Math.abs(source[3] - bitmap.height) < 2;
  if (whole && bitmap.width <= size.width + 1 && !masks.length && !boxes.length) { bitmap.close(); return data; }
  const canvas = new OffscreenCanvas(Math.max(1, Math.min(size.width, Math.round(source[2]))), Math.max(1, Math.min(size.height, Math.round(source[3]))));
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, ...source, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const sx = canvas.width / area.width, sy = canvas.height / area.height;
  const place = rect => [(rect.x - area.x) * sx, (rect.y - area.y) * sy, rect.width * sx, rect.height * sy];
  const font = Math.max(11, Math.round(12 * Math.min(sx, 2)));
  context.font = `bold ${font}px sans-serif`;
  context.textBaseline = "top";
  for (const box of boxes) {
    const [x, y, width, height] = place(box);
    context.strokeStyle = "#ffd400";
    context.lineWidth = 2;
    context.strokeRect(x, y, width, height);
    const label = box.ref.slice(4);
    const labelWidth = context.measureText(label).width + 6, labelHeight = font + 4;
    const left = Math.min(Math.max(0, x), canvas.width - labelWidth), top = y - labelHeight >= 0 ? y - labelHeight : Math.max(0, y);
    context.fillStyle = "#ffd400";
    context.fillRect(left, top, labelWidth, labelHeight);
    context.fillStyle = "#000";
    context.fillText(label, left + 3, top + 2);
  }
  context.fillStyle = "#1b1b1b";
  for (const mask of masks) context.fillRect(...place(mask));
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY / 100 });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Si la pestaña sigue siendo de este chat (la persona puede sacarla del grupo mientras tanto). */
async function stillOwn(chat, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const owners = await readOwners();
  return tabAccess(tab.groupId, owners, chat.owner, await commonGroups(owners)) === "propia";
}

/**
 * Captura `area` (px CSS del documento) de una pestaña del chat: a la escala que toca, con lo
 * sensible tapado y, con `page` (una lectura recién hecha), los elementos numerados. Apunta
 * la captura para que `region` y `click_at` puedan usar sus píxeles.
 */
async function captureArea(chat, tabId, view, wanted, maxEdge, page = null) {
  // Solo se captura lo que está a la vista.
  const left = Math.max(wanted.x, view.x), top = Math.max(wanted.y, view.y);
  const right = Math.min(wanted.x + wanted.width, view.x + view.width), bottom = Math.min(wanted.y + wanted.height, view.y + view.height);
  if (right - left < 4 || bottom - top < 4) throw new Error("Esa zona ya no está a la vista: la página se desplazó. Haz otra captura.");
  const area = { x: left, y: top, width: right - left, height: bottom - top };
  const size = captureScale(area, view.dpr, maxEdge);
  const masks = await inPage(tabId, sensitiveRects, area);
  const boxes = page ? await inPage(tabId, labelRects, area, MAX_LABELS) : [];
  const data = await finish(await grab(tabId, view), view, area, size, masks, boxes);
  // Si la pestaña dejó de ser de este chat mientras se capturaba, la imagen no sale.
  if (!await stillOwn(chat, tabId)) throw new Error("La pestaña dejó de estar compartida con este chat mientras la capturaba: no envío la imagen.");
  const real = jpegSize(data) ?? size;
  shots.set(tabId, { x: area.x, y: area.y, pxPerCss: real.width / area.width, width: real.width, height: real.height, url: view.url });
  const byRef = new Map((page?.elements ?? []).map(element => [element.ref, element]));
  const labels = page ? boxes.map(box => byRef.get(box.ref)).filter(Boolean)
    .map(element => `${element.ref.slice(4)} = ${element.ref} ${element.role}${element.name ? ` «${element.name}»` : ""}`) : null;
  return { width: real.width, height: real.height, masked: masks.length, labels, image: { mimeType: "image/jpeg", data } };
}

/** Lo que dice una acción al terminar, sin la coletilla de «vuelve a leer» cuando ya va lo que cambió. */
const withoutHint = text => String(text ?? "").replace(/ (Si la página cambió, vuelve a leerla|Vuelve a leer la página)\.$/, "");

/** Una mirada a la página con tiempo límite: `undefined` si no contesta (está cambiando de página). */
async function glance(tabId, fn, ...args) {
  try {
    return await Promise.race([inPage(tabId, fn, ...args), settle(PROBE_TIMEOUT_MS).then(() => undefined)]);
  } catch (error) {
    if (error instanceof DialogOpen) throw error;
    return undefined;
  }
}

/**
 * Espera a que la página deje de cambiar tras una acción y recoge lo que cambió. `null` si la
 * pestaña cargó otra página (entonces espera a que cargue). En segundo plano el navegador
 * retrasa los temporizadores de la página hasta un segundo: lo que hace «al momento» puede
 * tardar eso, y se espera algo más.
 */
async function settleChanges(tabId, touched, hidden) {
  const start = Date.now();
  const least = hidden ? HIDDEN_SETTLE_MS : 0, most = hidden ? HIDDEN_SETTLE_MAX_MS : SETTLE_MAX_MS;
  await settle(120);
  for (;;) {
    // `undefined`: la página no contestó a tiempo (está ocupada); -1: ya es otra página.
    const quiet = await glance(tabId, changesQuiet);
    if (quiet !== undefined && quiet < 0) break;
    const waited = Date.now() - start;
    if ((quiet !== undefined && quiet >= QUIET_MS && waited >= least) || waited >= most) {
      const report = await glance(tabId, changesReport, touched);
      if (report) return report;
      if (report === undefined) throw new Error("la página no contestó a tiempo");
      break;
    }
    await settle(100);
  }
  await unlessDialog(tabId, waitForLoad(tabId, AFTER_LOAD_MS));
  return null;
}

/**
 * Tras una acción, si la persona lo activó en Ajustes (`after`: «text» o «image»), le dice al
 * agente qué cambió: en texto y, con «image», con una captura de solo esa zona (o de la vista
 * entera si cambió casi todo, si cargó otra página o si lo pide con `capture: "full"`). El
 * agente puede saltárselo en cada acción con `capture: "none"`. Lo de después de la acción
 * nunca hace fallar la acción, que ya se hizo.
 */
async function withChanges(chat, tabId, after, captureMode, touched, work, { full = false, scroll = false } = {}) {
  const mode = after && captureMode !== "none" ? (CAPTURE_MODES.includes(captureMode) ? captureMode : "changed") : "none";
  if (mode === "none") return work();
  idle(tabId);
  const watching = await glance(tabId, watchChanges);
  const result = await work();
  if (!watching || dialogs.has(tabId)) return result;
  let text = withoutHint(result.text);
  try {
    const report = await settleChanges(tabId, touched, watching.hidden);
    const view = await inPage(tabId, viewInfo);
    const area = report && !full && mode !== "full" ? changedArea(report.rects, view) : null;
    text += `\n${describeChange(report, area, view, { scroll })}`;
    if (after !== "image") return { ...result, text };
    const whole = { x: view.x, y: view.y, width: view.width, height: view.height };
    const target = !report || full || mode === "full" || report.urlChanged || (area && area.fraction > LARGE_CHANGE) ? whole
      : area ? { x: area.x + view.x, y: area.y + view.y, width: area.width, height: area.height } : null;
    if (!target) return { ...result, text };
    const shot = await captureArea(chat, tabId, view, target, DEFAULT_EDGE);
    text += `\nImagen: ${target === whole ? "la vista entera" : "solo la zona que cambió"}, ${shot.width}×${shot.height} px`
      + `${shot.masked ? `, con ${shot.masked} ${shot.masked === 1 ? "campo sensible tapado" : "campos sensibles tapados"}` : ""}`
      + ". Coordenadas para region y click_at: píxeles de esta imagen.";
    return { ...result, text, image: shot.image };
  } catch (error) {
    if (error instanceof DialogOpen) return { ...result, text: `${text} ${error.message}` };
    return { ...result, text: `${text}\n(No pude ver qué cambió: ${String(error?.message ?? error).slice(0, 300)})` };
  }
}

// --- Herramientas -------------------------------------------------------------------------
//
// Cada una recibe primero el chat que la pide; las que nombran una pestaña empiezan por
// `ownTab`. Orden: las que solo miran (OBSERVE_TOOLS en browser_bridge.rs) y después las que
// actúan (ACTION_TOOLS).

const TOOLS = {
  async tabs_list(chat) {
    const { own, common } = await visibleTabs(chat);
    return { text: describeTabs(own, common) };
  },

  async read_page(chat, { tabId, maxChars }) {
    await ownTab(chat, tabId);
    const limit = Math.min(MAX_PAGE_CHARS, Math.max(1000, Number.isInteger(maxChars) ? maxChars : DEFAULT_PAGE_CHARS));
    return { text: describePage(await inPage(tabId, collect, limit, MAX_ELEMENTS)) };
  },

  async screenshot(chat, { tabId, ref, region, maxEdge, fullResolution, labels }) {
    await ownTab(chat, tabId);
    const spec = captureSpec({ ref, region, maxEdge, fullResolution, labels });
    idle(tabId);
    await attach(tabId);
    // El elemento, antes de numerar: numerar vuelve a leer la página y cambia las referencias.
    let area = null, part = null;
    if (spec.ref) {
      area = await inPage(tabId, refArea, spec.ref);
      if (!area) throw new Error(GONE);
      part = `el elemento ${spec.ref}`;
    }
    const page = spec.labels ? await inPage(tabId, collect, 1000, MAX_ELEMENTS) : null;
    const view = await inPage(tabId, viewInfo);
    if (spec.region) {
      area = regionArea(spec.region, shots.get(tabId), view);
      part = `la zona x=${spec.region.x} y=${spec.region.y} ${spec.region.width}×${spec.region.height} de tu captura anterior`;
    }
    area ??= { x: view.x, y: view.y, width: view.width, height: view.height };
    const shot = await captureArea(chat, tabId, view, area, spec.maxEdge, page);
    return {
      text: describeCapture({ title: view.title, url: view.url, tabId, width: shot.width, height: shot.height, view, part, masked: shot.masked, labels: shot.labels }),
      image: shot.image,
    };
  },

  async wait_for(chat, { tabId, text, ref, selector, load, gone, timeout }) {
    await ownTab(chat, tabId);
    const spec = waitSpec({ text, ref, selector, load, gone, timeout });
    if (spec.kind === "load") {
      idle(tabId);
      await attach(tabId);
      const loaded = await unlessDialog(tabId, waitForLoad(tabId, spec.timeoutMs));
      if (!loaded) throw new Error(`Pasaron ${Math.round(spec.timeoutMs / 1000)} s y la página sigue cargando.`);
      return { text: `Cargada. ${await tabLine(tabId)}` };
    }
    const deadline = Date.now() + spec.timeoutMs;
    for (;;) {
      let seen;
      try {
        seen = await Promise.race([inPage(tabId, probe, spec.kind, spec.value), settle(PROBE_TIMEOUT_MS).then(() => undefined)]);
      } catch (error) {
        if (error instanceof DialogOpen) throw error;
        seen = undefined; // La página está cambiando: se vuelve a mirar.
      }
      if (seen === "selector-no-valido") throw new Error("Ese selector CSS no es válido.");
      if (typeof seen === "boolean" && seen !== spec.gone) return { text: waitResult(spec, true) };
      if (Date.now() >= deadline) throw new Error(waitResult(spec, false));
      await settle(WAIT_STEP_MS);
    }
  },

  async tab_open(chat, { url }) {
    const target = webUrl(url);
    if (!target) throw new Error("Solo se pueden abrir direcciones http o https.");
    const { own } = await visibleTabs(chat);
    const windowId = own[0]?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    // Sin robar el foco: la persona sigue en su pestaña.
    const tab = await chrome.tabs.create({ url: target, windowId, active: false });
    await exclusive(async () => intoChatGroup(chat, tab.id, await readOwners()));
    // Con el depurador puesto desde el principio, un aviso al cargar no la deja esperando.
    await attach(tab.id).catch(() => {});
    const dialog = await andDialog(tab.id, waitForLoad(tab.id));
    return { text: `Abierta. ${await tabLine(tab.id)}${dialog}` };
  },

  async navigate(chat, { tabId, url }) {
    await ownTab(chat, tabId);
    idle(tabId);
    // Con el depurador puesto se sabe si la página pregunta antes de irse.
    await attach(tabId);
    if (url === "back") await chrome.tabs.goBack(tabId).catch(() => { throw new Error("No hay página anterior."); });
    else if (url === "forward") await chrome.tabs.goForward(tabId).catch(() => { throw new Error("No hay página siguiente."); });
    else {
      const target = webUrl(url);
      if (!target) throw new Error("Solo se puede ir a direcciones http o https, o usar «back» y «forward».");
      await chrome.tabs.update(tabId, { url: target });
    }
    const dialog = await andDialog(tabId, settle(150).then(() => waitForLoad(tabId)));
    if (dialog) return { text: `Aún no ha cambiado de página.${dialog}` };
    return { text: `Cargada. ${await tabLine(tabId)}` };
  },

  async click(chat, { tabId, ref }) {
    await ownTab(chat, tabId);
    const point = await inPage(tabId, locate, String(ref), true);
    if (!point) throw new Error(GONE);
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
      const watch = dialogOpened(tabId);
      await Promise.race([pressed, settle(MOUSE_TIMEOUT_MS), watch.opened]).catch(() => {});
      watch.stop();
      if (!dialogs.has(tabId)) await settle(60);
    }
    // Si el elemento no recibió el clic, se le da directamente (y si la página ya navegó, no hay nada que hacer).
    const dialog = await andDialog(tabId, inPage(tabId, ensureClicked).catch(error => { if (error instanceof DialogOpen) throw error; return "perdido"; }));
    if (dialog) return { text: `Clic hecho en ${ref}.${dialog}` };
    await settle(250);
    return { text: `Clic hecho en ${ref}. Si la página cambió, vuelve a leerla.` };
  },

  async click_at(chat, { tabId, x, y }) {
    await ownTab(chat, tabId);
    idle(tabId);
    await attach(tabId);
    const view = await inPage(tabId, viewInfo);
    const point = capturePoint(x, y, shots.get(tabId), view);
    const target = await inPage(tabId, pointAt, point.x, point.y, true);
    if (!target) throw new Error("En ese punto no hay nada de la página.");
    if (target.frame && target.hidden) {
      throw new Error("Ese punto cae dentro de un marco (iframe) y la pestaña está en segundo plano: así no le llega el clic. Pide a la persona que la ponga delante, o busca el elemento con read_page.");
    }
    const what = `${target.role}${target.name ? ` «${target.name}»` : ""}`;
    // Como en `click`: el ratón de verdad si la página se está pintando, y si no le llegó, el clic directo.
    if (!target.hidden) {
      const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      const pressed = (async () => {
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mouseMoved", button: "none" });
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
        await send(tabId, "Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
      })();
      pressed.catch(() => {});
      const watch = dialogOpened(tabId);
      await Promise.race([pressed, settle(MOUSE_TIMEOUT_MS), watch.opened]).catch(() => {});
      watch.stop();
      if (!dialogs.has(tabId)) await settle(60);
    }
    const dialog = target.frame ? await andDialog(tabId, settle(100))
      : await andDialog(tabId, inPage(tabId, clickedAt).catch(error => { if (error instanceof DialogOpen) throw error; return "perdido"; }));
    if (dialog) return { text: `Clic hecho en (${x}, ${y}): ${what}.${dialog}` };
    await settle(250);
    return { text: `Clic hecho en (${x}, ${y}): ${what}. Si la página cambió, vuelve a leerla.` };
  },

  async type(chat, { tabId, ref, text, submit }) {
    await ownTab(chat, tabId);
    if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error("Falta el texto, o es demasiado largo.");
    const field = await inPage(tabId, fieldInfo, ref ? String(ref) : null);
    if (ref && !field) throw new Error(GONE);
    refuseSensitive(field, text);
    if (ref && !await inPage(tabId, focusRef, String(ref))) throw new Error(GONE);
    let dialog = await andDialog(tabId, writeText(tabId, text));
    if (dialog) return { text: `Texto escrito.${dialog}` };
    if (submit) dialog = await andDialog(tabId, pressKey(tabId, parseKey("Enter")));
    if (dialog) return { text: `Texto escrito y enviado con Intro.${dialog}` };
    await settle(submit ? 400 : 100);
    return { text: submit ? "Texto escrito y enviado con Intro. Vuelve a leer la página." : "Texto escrito." };
  },

  async fill_form(chat, { tabId, fields }) {
    await ownTab(chat, tabId);
    const wanted = formFields(fields);
    // Primero se mira todo: si algún campo no se puede rellenar, no se toca ninguno.
    const plan = [];
    for (const field of wanted) {
      const info = await inPage(tabId, fieldInfo, field.ref);
      if (!info) throw new Error(`${field.ref}: ${GONE}`);
      try { refuseSensitive(info, field.value); } catch (error) { throw new Error(`${field.ref}: ${error.message}`); }
      if (info.disabled || info.readOnly) throw new Error(`${field.ref}: el campo está desactivado o es de solo lectura.`);
      const checked = typeof field.checked === "boolean" ? field.checked : /^(true|false)$/i.test(field.value ?? "") ? /^true$/i.test(field.value) : undefined;
      if (info.kind === "check") {
        if (checked === undefined) throw new Error(`${field.ref} es una casilla o un botón de opción: usa «checked»: true o false.`);
        if (!checked && info.type === "radio" && info.checked) throw new Error(`${field.ref}: un botón de opción no se desmarca; marca otro del mismo grupo.`);
        plan.push({ ...field, kind: "check", checked });
      } else if (info.kind === "select") {
        if (typeof field.value !== "string") throw new Error(`${field.ref} es un desplegable: indica en «value» la opción.`);
        const index = pickOption(info.options, field.value);
        if (index < 0) throw new Error(`${field.ref}: no hay ninguna opción «${clip(field.value, 80)}». Opciones: ${listOptions(info.options)}.`);
        plan.push({ ...field, kind: "select", index });
      } else if (info.kind === "text" || info.kind === "value") {
        if (typeof field.value !== "string") throw new Error(`${field.ref} es un campo de texto: indica el texto en «value».`);
        plan.push({ ...field, kind: info.kind });
      } else if (info.kind === "file") {
        throw new Error(`${field.ref} es un campo de archivo: usa upload_file.`);
      } else {
        throw new Error(`${field.ref} no es un campo que se pueda rellenar (es ${info.tag}${info.type ? ` ${info.type}` : ""}).`);
      }
    }
    const done = [];
    for (const step of plan) {
      let dialog = "";
      if (step.kind === "text") {
        if (!await inPage(tabId, focusRef, step.ref)) throw new Error(`${step.ref}: ${GONE}`);
        dialog = await andDialog(tabId, writeText(tabId, step.value));
        done.push(`${step.ref} = «${clip(step.value, 60)}»`);
      } else if (step.kind === "value") {
        let set;
        dialog = await andDialog(tabId, inPage(tabId, setValue, step.ref, step.value).then(value => { set = value; }));
        if (!dialog && set === null) throw new Error(`${step.ref}: ${GONE}`);
        done.push(`${step.ref} = «${clip(step.value, 60)}»`);
      } else if (step.kind === "select") {
        let chosen = null;
        dialog = await andDialog(tabId, inPage(tabId, chooseOption, step.ref, step.index).then(value => { chosen = value; }));
        if (!dialog && chosen === null) throw new Error(`${step.ref}: ${GONE}`);
        done.push(`${step.ref}: elegida «${clip(chosen ?? step.value, 60)}»`);
      } else {
        dialog = await andDialog(tabId, inPage(tabId, setChecked, step.ref, step.checked));
        done.push(`${step.ref} ${step.checked ? "marcada" : "desmarcada"}`);
      }
      if (dialog) return { text: `Rellenado a medias: ${done.join("; ")}.${dialog}` };
    }
    await settle(100);
    return { text: `Rellenado (sin enviar): ${done.join("; ")}.` };
  },

  async select_option(chat, { tabId, ref, value }) {
    await ownTab(chat, tabId);
    const clean = validRef(ref);
    if (!clean) throw new Error("Falta la referencia ref_N del desplegable, de read_page.");
    if (typeof value !== "string" || value.length > 1000) throw new Error("Falta «value»: el valor o el texto de la opción.");
    const info = await inPage(tabId, fieldInfo, clean);
    if (!info) throw new Error(GONE);
    if (info.kind !== "select") throw new Error("Ese elemento no es un desplegable <select>. Si es un menú hecho a mano, ábrelo con click y elige la opción con click.");
    if (info.disabled) throw new Error("Ese desplegable está desactivado.");
    const index = pickOption(info.options, value);
    if (index < 0) throw new Error(`No hay ninguna opción «${clip(value, 80)}». Opciones: ${listOptions(info.options)}.`);
    let chosen = null;
    const dialog = await andDialog(tabId, inPage(tabId, chooseOption, clean, index).then(text => { chosen = text; }));
    if (!dialog && chosen === null) throw new Error(GONE);
    return { text: `Elegida «${clip(chosen ?? value, 80)}» en ${clean}.${dialog}` };
  },

  async key(chat, { tabId, key }) {
    await ownTab(chat, tabId);
    const parsed = parseKey(key);
    if (!parsed) throw new Error("No reconozco esa tecla. Ejemplos: Enter, Escape, Tab, ArrowDown, ctrl+a.");
    idle(tabId);
    await attach(tabId);
    const dialog = await andDialog(tabId, pressKey(tabId, parsed));
    if (dialog) return { text: `Tecla ${key} pulsada.${dialog}` };
    await settle(150);
    return { text: `Tecla ${key} pulsada.` };
  },

  async scroll(chat, { tabId, direction, ref }) {
    await ownTab(chat, tabId);
    if (ref) {
      if (!await inPage(tabId, locate, String(ref))) throw new Error(GONE);
      return { text: `${ref} está a la vista.` };
    }
    const where = await inPage(tabId, scrollPage, ["up", "down", "top", "bottom"].includes(direction) ? direction : "down");
    return { text: `Desplazado. Posición ${where.y} de ${where.max}.${where.y >= where.max ? " Es el final de la página." : ""}` };
  },

  async upload_file(chat, { tabId, ref, paths }) {
    await ownTab(chat, tabId);
    // Las rutas ya las comprobó trex (dentro de la carpeta del chat, sin enlaces, tamaño); aquí solo la forma.
    const files = uploadPaths(paths);
    if (!files) throw new Error("Faltan las rutas de los archivos (de 1 a 10).");
    const clean = validRef(ref);
    if (!clean) throw new Error("Falta la referencia ref_N del campo de archivo, de read_page.");
    if (!await fileAccess()) throw new Error(FILE_ACCESS);
    const info = await inPage(tabId, fieldInfo, clean);
    if (!info) throw new Error(GONE);
    if (info.kind !== "file") throw new Error("Ese elemento no es un campo para subir archivos (<input type=file>).");
    if (info.disabled) throw new Error("Ese campo de archivo está desactivado.");
    if (files.length > 1 && !info.multiple) throw new Error("Ese campo solo admite un archivo.");
    const element = await evaluate(tabId, refElement, [clean], false);
    if (!element?.objectId) throw new Error(GONE);
    try {
      await unlessDialog(tabId, send(tabId, "DOM.setFileInputFiles", { files, objectId: element.objectId }));
    } catch (error) {
      if (/not allowed/i.test(String(error?.message ?? error))) throw new Error(FILE_ACCESS);
      throw error;
    } finally {
      await send(tabId, "Runtime.releaseObject", { objectId: element.objectId }).catch(() => {});
    }
    return { text: `${files.length === 1 ? "Archivo puesto" : `${files.length} archivos puestos`} en ${clean}. Aún no se ha enviado nada.` };
  },

  async handle_dialog(chat, { tabId, accept, promptText }) {
    await ownTab(chat, tabId);
    if (typeof accept !== "boolean") throw new Error("Indica «accept»: true para aceptar, false para descartar.");
    if (promptText !== undefined && (typeof promptText !== "string" || promptText.length > 5000)) throw new Error("«promptText» es un texto de hasta 5000 caracteres.");
    if (promptText && looksLikeCard(promptText)) throw new Error(CARD_REFUSAL);
    await attach(tabId);
    const dialog = dialogs.get(tabId);
    try {
      await send(tabId, "Page.handleJavaScriptDialog", { accept, ...(accept && promptText !== undefined ? { promptText } : {}) });
    } catch (error) {
      dialogs.delete(tabId);
      if (/no dialog/i.test(String(error?.message ?? error))) throw new Error("No hay ningún diálogo abierto que yo pueda manejar en esa pestaña. Si la persona ve uno, pídele que lo cierre ella.");
      throw error;
    }
    dialogs.delete(tabId);
    // Aceptar puede abrir otro diálogo, o navegar.
    const next = await andDialog(tabId, settle(200));
    const what = dialog ? ` «${clip(dialog.message || "(sin texto)", 120)}»` : "";
    return { text: `${accept ? "Aceptado" : "Descartado"} el diálogo${what}.${next || " Vuelve a leer la página si cambió."}` };
  },

  async tab_close(chat, { tabId }) {
    await ownTab(chat, tabId);
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return { text: "Pestaña cerrada." };
  },
};

/**
 * Las acciones tras las que se puede enseñar qué cambió, y qué tocaron: escribir o elegir
 * no cambia el DOM, así que esos campos cuentan como cambiados («focus»: el que tiene el foco;
 * «point»: lo que hay donde se hizo clic, por si es un lienzo).
 */
const OBSERVED = {
  navigate: () => [],
  click: args => [String(args.ref ?? "")],
  click_at: () => ["point"],
  type: args => [args.ref ? String(args.ref) : "focus"],
  fill_form: args => Array.isArray(args.fields) ? args.fields.map(field => String(field?.ref ?? "")) : [],
  select_option: args => [String(args.ref ?? "")],
  key: () => ["focus"],
  scroll: () => [],
};

async function run(method, params) {
  const tool = Object.hasOwn(TOOLS, method) ? TOOLS[method] : null;
  if (!tool) throw new Error("Herramienta desconocida.");
  const chat = chatOf(params);
  if (!chat) throw new Error("La orden no dice de qué chat viene. Actualiza trex.");
  const raw = params?.arguments;
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  // Lo que cambió tras cada acción, solo si la persona lo activó en Ajustes (trex manda `after`).
  const after = params?.after === "text" || params?.after === "image" ? params.after : null;
  if (after && Object.hasOwn(OBSERVED, method)) {
    // Antes de mirar la página: solo las pestañas de este chat.
    await ownTab(chat, args.tabId);
    return withChanges(chat, args.tabId, after, args.capture, OBSERVED[method](args), () => tool(chat, args), { full: method === "scroll", scroll: method === "scroll" || method === "key" });
  }
  return tool(chat, args);
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
  const owners = await readOwners();
  const common = await commonGroups(owners);
  const live = new Set((await chrome.tabGroups.query({})).map(group => group.id));
  let tab = null;
  if (active) {
    const holder = owners[active.groupId];
    const where = holder ? "chat" : common.has(active.groupId) ? "comun" : "fuera";
    const group = holder ? (await chrome.tabGroups.get(active.groupId).catch(() => null))?.title || chatTitle(holder.title) : "";
    tab = { id: active.id, where, group, shareable: !!webUrl(active.url ?? "") };
  }
  const tabs = await chrome.tabs.query({});
  return {
    paired: !!token, state: token ? state : "sin-emparejar", error: lastError, port, name, version: VERSION, tab,
    sharedCount: tabs.filter(each => owners[each.groupId] || common.has(each.groupId)).length,
    chats: knownChats(owners, live),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const actions = {
    status: () => popupState(),
    pair: () => pair(message.code, message.port).then(popupState),
    unpair: () => unpair().then(popupState),
    share: () => share(message.tabId, typeof message.owner === "string" && message.owner ? message.owner : null).then(popupState),
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
