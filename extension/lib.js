// Piezas puras de la extensión (sin APIs del navegador): se prueban con `npm test`.

/** Grupo común: lo que la persona comparte desde la ventanita, para cualquier chat. */
export const GROUP_TITLE = "trex";
/** Cada chat tiene su propio grupo: «trex · Claude 2». */
export const CHAT_PREFIX = "trex · ";
export const GENERIC_CHAT = "Chat";
export const MAX_LABEL = 24;
export const COMMON_COLOR = "orange";
/** Color de un grupo cuyo chat terminó: sus pestañas siguen ahí, pero ya no son de nadie. */
export const ENDED_COLOR = "grey";
/** Colores de los grupos de chat (sin el naranja del común ni el gris de los terminados). */
export const CHAT_COLORS = ["blue", "green", "purple", "cyan", "pink", "yellow", "red"];
export const DEFAULT_PORT = 7341;
/** Tope de texto que vuelve de una página si el agente no pide otro. */
export const DEFAULT_PAGE_CHARS = 20000;
export const MAX_PAGE_CHARS = 100000;
export const MAX_TEXT = 20000;
export const MAX_FORM_FIELDS = 50;
export const MAX_FORM_CHARS = 100000;
export const MAX_UPLOADS = 10;
export const DEFAULT_WAIT_SECONDS = 10;
export const MAX_WAIT_SECONDS = 30;

/** Solo páginas web: nada de `file:`, `chrome:`, `javascript:` ni extensiones. */
export function webUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  let text = value.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Lo que escribe la persona en el campo del código: sin guiones ni espacios y en mayúsculas. */
export const normalizeCode = value => String(value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 12);

export function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

// --- Chats y grupos -----------------------------------------------------------------

/** Caracteres de control y de dirección del texto: en un título de grupo solo sirven para engañar. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Título del grupo de un chat. Lo manda trex ya hecho; aquí se vuelve a limpiar y recortar,
 * y nunca sale «trex» a secas, que es el grupo común.
 */
export function chatTitle(value) {
  // Saltos de línea y tabuladores cuentan como espacios; lo demás invisible, fuera.
  let label = String(value ?? "").replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
  if (label.startsWith(CHAT_PREFIX)) label = label.slice(CHAT_PREFIX.length).trim();
  label = clip(label, MAX_LABEL);
  return `${CHAT_PREFIX}${label || GENERIC_CHAT}`;
}

export function chatColor(owner) {
  const seed = Number.parseInt(String(owner ?? "").slice(0, 8), 16);
  return CHAT_COLORS[(Number.isFinite(seed) ? seed : 0) % CHAT_COLORS.length];
}

/**
 * El chat de una orden de trex: `owner` es un id opaco de la sesión (no su token) y `group`,
 * el título de su grupo. Sin `owner` válido no se hace nada.
 */
export function chatOf(params) {
  const owner = params?.owner;
  if (typeof owner !== "string" || !/^[0-9a-f]{16,64}$/.test(owner)) return null;
  return { owner, title: chatTitle(params.group), color: chatColor(owner) };
}

const NO_GROUP = -1;

/**
 * Qué es una pestaña para un chat, según su grupo: «propia» (de su grupo), «comun» (del
 * grupo «trex», la puede reclamar), «ajena» (de otro chat) o «fuera» (no compartida).
 * `owners` va de id de grupo a `{ owner, title }`; `common`, los ids de los grupos comunes.
 */
export function tabAccess(groupId, owners, owner, common) {
  if (!Number.isInteger(groupId) || groupId === NO_GROUP) return "fuera";
  const holder = owners?.[groupId];
  if (holder) return holder.owner === owner ? "propia" : "ajena";
  return common.has(groupId) ? "comun" : "fuera";
}

/** Las pestañas que ve un chat: las suyas y las del grupo común. Las de otros chats no existen para él. */
export function splitTabs(tabs, owners, owner, common) {
  const own = [], shared = [];
  for (const tab of tabs) {
    const access = tabAccess(tab.groupId, owners, owner, common);
    if (access === "propia") own.push(tab);
    else if (access === "comun") shared.push(tab);
  }
  return { own, common: shared };
}

/** Los chats con grupo vivo, para elegir en la ventanita con cuál compartir. */
export function knownChats(owners, liveGroupIds) {
  const chats = new Map();
  for (const [id, entry] of Object.entries(owners ?? {})) {
    if (!liveGroupIds.has(Number(id)) || !entry?.owner) continue;
    chats.set(entry.owner, { owner: entry.owner, title: chatTitle(entry.title) });
  }
  return [...chats.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// --- Teclas ---------------------------------------------------------------------------

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9, ""], escape: ["Escape", "Escape", 27, ""], esc: ["Escape", "Escape", 27, ""],
  backspace: ["Backspace", "Backspace", 8, ""], delete: ["Delete", "Delete", 46, ""], space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38, ""], arrowdown: ["ArrowDown", "ArrowDown", 40, ""], arrowleft: ["ArrowLeft", "ArrowLeft", 37, ""],
  arrowright: ["ArrowRight", "ArrowRight", 39, ""], pageup: ["PageUp", "PageUp", 33, ""], pagedown: ["PageDown", "PageDown", 34, ""],
  home: ["Home", "Home", 36, ""], end: ["End", "End", 35, ""],
};

/**
 * «ctrl+a», «Enter», «shift+Tab»… a lo que pide el protocolo de depuración.
 * Devuelve null si no es una tecla que se pueda pulsar.
 */
export function parseKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 40) return null;
  const parts = value.trim() === "+" ? ["+"] : value.trim().split("+").map(part => part.trim());
  const name = parts.pop();
  if (!name) return null;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) return null;
    modifiers |= bit;
  }
  const known = KEYS[name.toLowerCase()];
  if (known) {
    const [key, code, keyCode, text] = known;
    // Con Ctrl, Alt o Meta la tecla es un atajo: no escribe nada.
    return { key, code, keyCode, modifiers, text: modifiers & 7 ? "" : text };
  }
  if (/^f([1-9]|1[0-2])$/i.test(name)) {
    const number = Number(name.slice(1));
    return { key: `F${number}`, code: `F${number}`, keyCode: 111 + number, modifiers, text: "" };
  }
  if ([...name].length !== 1) return null;
  const upper = name.toUpperCase();
  const letter = /^[a-z]$/i.test(name), digit = /^[0-9]$/.test(name);
  return {
    key: modifiers & 8 && letter ? upper : name,
    code: letter ? `Key${upper}` : digit ? `Digit${name}` : "",
    keyCode: letter || digit ? upper.charCodeAt(0) : 0,
    modifiers,
    text: modifiers & 7 ? "" : modifiers & 8 && letter ? upper : name,
  };
}

// --- Campos que el agente no rellena --------------------------------------------------

const PAYMENT = "No escribo datos de pago (número de tarjeta, caducidad, CVC). Pide a la persona que los introduzca ella.";
const PAYMENT_WORDS = [/card.?(num|no\b)/i, /cardnumber/i, /\b(cvc|cvv2?|csc)\b/i, /security.?code/i, /n[uú]mero de (la )?tarjeta/i,
  /c[oó]digo de seguridad/i, /\bcc.?(num|number|exp|csc|cvv|cvc)/i, /(card|tarjeta).?(exp|caducidad|vencimiento)/i];

/**
 * Si un campo es de los que solo rellena la persona, el motivo; si no, null.
 * `field` es lo que devuelve `fieldInfo` (page.js): tipo, autocomplete, name, id, etiqueta…
 */
export function fieldBlock(field) {
  if (!field) return null;
  if (field.type === "password") return "No escribo en campos de contraseña. Pide a la persona que la introduzca ella.";
  if (field.kind === "frame") return "El foco está dentro de un marco de la página y no puedo ver qué campo es (podría ser una contraseña). Escribe con la referencia ref_N del campo, de read_page.";
  const autocomplete = String(field.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (autocomplete.some(token => token.startsWith("cc-"))) return PAYMENT;
  if (autocomplete.includes("one-time-code")) return "No escribo códigos de verificación. Pide a la persona que lo introduzca ella.";
  const names = [field.name, field.id, field.label, field.placeholder].filter(Boolean).join(" ");
  return PAYMENT_WORDS.some(pattern => pattern.test(names)) ? PAYMENT : null;
}

/** Un texto que es, entero, un número de tarjeta (13 a 19 cifras que cumplen Luhn). */
export function looksLikeCard(text) {
  const value = String(text ?? "").trim();
  if (!/^\d[\d -]{11,24}\d$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}
export const CARD_REFUSAL = "Eso parece un número de tarjeta: no lo escribo. Pide a la persona que lo introduzca ella.";

// --- Argumentos de las herramientas ----------------------------------------------------

export const validRef = value => typeof value === "string" && /^ref_\d{1,6}$/.test(value.trim()) ? value.trim() : null;

/** Los campos de fill_form: `{ ref, value }` (texto u opción) o `{ ref, checked }` (casillas). */
export function formFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new Error("Falta «fields»: una lista de { ref, value } o { ref, checked }.");
  if (fields.length > MAX_FORM_FIELDS) throw new Error(`Como mucho ${MAX_FORM_FIELDS} campos por llamada.`);
  const seen = new Set();
  let total = 0;
  const clean = fields.map((field, index) => {
    const ref = validRef(field?.ref);
    if (!ref) throw new Error(`Campo ${index + 1}: falta su referencia ref_N (de read_page).`);
    if (seen.has(ref)) throw new Error(`${ref} aparece dos veces.`);
    seen.add(ref);
    const hasValue = typeof field.value === "string", hasChecked = typeof field.checked === "boolean";
    if (hasValue === hasChecked) throw new Error(`${ref}: indica «value» (texto u opción) o «checked» (casillas y opciones), uno de los dos.`);
    if (!hasValue) return { ref, checked: field.checked };
    if (field.value.length > MAX_TEXT) throw new Error(`${ref}: el texto es demasiado largo.`);
    total += field.value.length;
    return { ref, value: field.value };
  });
  if (total > MAX_FORM_CHARS) throw new Error("Demasiado texto para un solo formulario.");
  return clean;
}

/** La opción de un `<select>` que se pide, por valor o por el texto que se ve. -1 si no hay. */
export function pickOption(options, wanted) {
  const target = String(wanted ?? "");
  const usable = (options ?? []).map((option, index) => ({ ...option, index })).filter(option => !option.disabled);
  const folded = target.trim().toLocaleLowerCase();
  const match = usable.find(option => option.value === target)
    ?? usable.find(option => option.text.trim() === target.trim())
    ?? usable.find(option => option.text.trim().toLocaleLowerCase() === folded)
    ?? usable.find(option => option.value.toLocaleLowerCase() === folded);
  return match ? match.index : -1;
}

export function listOptions(options) {
  const names = (options ?? []).filter(option => !option.disabled).map(option => `«${clip(option.text || option.value, 40)}»`);
  return names.length > 20 ? `${names.slice(0, 20).join(", ")}… (${names.length} en total)` : names.join(", ") || "(ninguna)";
}

/** Qué espera wait_for: una sola condición y como mucho 30 s. */
export function waitSpec({ text, ref, selector, load, gone, timeout } = {}) {
  const wanted = { text: typeof text === "string" && text.trim() !== "", ref: ref !== undefined && ref !== null && ref !== "", selector: typeof selector === "string" && selector.trim() !== "", load: load === true };
  if (Object.values(wanted).filter(Boolean).length !== 1) throw new Error("Indica una sola condición: text, ref, selector o load.");
  if (gone !== undefined && typeof gone !== "boolean") throw new Error("«gone» es true o false.");
  const seconds = timeout === undefined || timeout === null ? DEFAULT_WAIT_SECONDS : Number(timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("«timeout» son segundos, de 1 a 30.");
  const timeoutMs = Math.round(Math.min(Math.max(seconds, 0.5), MAX_WAIT_SECONDS) * 1000);
  if (wanted.load) {
    if (gone) throw new Error("«gone» no vale con «load».");
    return { kind: "load", value: "", gone: false, timeoutMs };
  }
  if (wanted.ref) {
    const clean = validRef(ref);
    if (!clean) throw new Error("La referencia es ref_N, de read_page.");
    return { kind: "ref", value: clean, gone: !!gone, timeoutMs };
  }
  const value = (wanted.text ? text : selector).trim();
  if (value.length > 500) throw new Error("El texto o el selector es demasiado largo.");
  return { kind: wanted.text ? "text" : "selector", value, gone: !!gone, timeoutMs };
}

/** Cómo terminó una espera, para el agente. */
export function waitResult(spec, met) {
  const what = spec.kind === "text" ? `«${clip(spec.value, 80)}»` : spec.kind === "ref" ? spec.value : `«${clip(spec.value, 80)}»`;
  const seconds = Math.round(spec.timeoutMs / 1000);
  if (spec.kind === "text") return met ? (spec.gone ? `${what} ya no está en la página.` : `${what} ya está en la página.`)
    : `Pasaron ${seconds} s y ${what} ${spec.gone ? "sigue en la página" : "no apareció"}.`;
  return met ? (spec.gone ? `El elemento ${what} ya no se ve.` : `El elemento ${what} ya se ve.`)
    : `Pasaron ${seconds} s y el elemento ${what} ${spec.gone ? "sigue a la vista" : "no apareció"}.`;
}

/** Las rutas de upload_file que llegan de trex, que ya las comprobó: aquí solo la forma. */
export function uploadPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_UPLOADS) return null;
  const absolute = path => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
  return paths.every(path => typeof path === "string" && path.length <= 4096 && !path.includes("\0") && absolute(path)) ? [...paths] : null;
}

// --- Capturas --------------------------------------------------------------------------------
//
// `Page.captureScreenshot` recibe un `clip` en píxeles CSS del documento y una escala: la
// imagen mide «CSS × scale × devicePixelRatio». Aquí se decide esa escala, se traducen las
// zonas y los puntos de una captura anterior y se describe lo que cambió tras una acción.

/** Lado largo de una captura si el agente no pide otro: unos 1 000 tokens en Claude. */
export const DEFAULT_EDGE = 1280;
export const MIN_EDGE = 256;
/** Lo más que aprovecha un modelo: Claude 5 ve hasta 2576 px de lado largo. */
export const MAX_EDGE = 2576;
/** Si lo que cambió ocupa más que esto de la vista, se enseña la vista entera. */
export const LARGE_CHANGE = 0.35;
/** Lo que se espera a que la página deje de cambiar tras una acción, y el tope. */
export const QUIET_MS = 300;
export const SETTLE_MAX_MS = 1500;
/** En segundo plano, los temporizadores de la página van con hasta un segundo de retraso: se espera más. */
export const HIDDEN_SETTLE_MS = 1100;
export const HIDDEN_SETTLE_MAX_MS = 2500;
const MIN_REGION = 8;
/** Qué se puede pedir tras una acción: lo que cambió, la vista entera o nada. */
export const CAPTURE_MODES = ["changed", "full", "none"];

/** Qué captura pide el agente: la vista, un elemento (`ref`) o una zona de su última captura. */
export function captureSpec({ ref, region, maxEdge, fullResolution, labels } = {}) {
  const hasRef = ref !== undefined && ref !== null && ref !== "";
  const hasRegion = region !== undefined && region !== null;
  if (hasRef && hasRegion) throw new Error("Indica «ref» o «region», no las dos.");
  const clean = hasRef ? validRef(ref) : null;
  if (hasRef && !clean) throw new Error("La referencia es ref_N, de read_page.");
  let area = null;
  if (hasRegion) {
    const values = ["x", "y", "width", "height"].map(key => region?.[key]);
    if (!values.every(Number.isFinite)) throw new Error("«region» es { x, y, width, height } en píxeles de tu última captura de esta pestaña.");
    const [x, y, width, height] = values.map(Math.round);
    if (x < 0 || y < 0 || width < MIN_REGION || height < MIN_REGION) throw new Error(`«region» empieza en x, y ≥ 0 y mide al menos ${MIN_REGION}×${MIN_REGION} px.`);
    area = { x, y, width, height };
  }
  if (maxEdge !== undefined && maxEdge !== null && (!Number.isInteger(maxEdge) || maxEdge < MIN_EDGE || maxEdge > MAX_EDGE)) {
    throw new Error(`«maxEdge» es un número entero de ${MIN_EDGE} a ${MAX_EDGE}.`);
  }
  for (const [name, value] of [["fullResolution", fullResolution], ["labels", labels]]) {
    if (value !== undefined && value !== null && typeof value !== "boolean") throw new Error(`«${name}» es true o false.`);
  }
  return { ref: clean, region: area, maxEdge: fullResolution === true ? MAX_EDGE : maxEdge ?? DEFAULT_EDGE, labels: labels === true };
}

/**
 * El tamaño de la imagen de `area` (px CSS) para que no pase de `maxEdge` de lado largo. El
 * navegador la captura a la resolución de la pantalla («CSS × devicePixelRatio») y aquí solo
 * se reduce, nunca se amplía: ampliar no añade detalle y cuesta más tokens. Devuelve la escala
 * sobre esa captura, los píxeles de imagen por píxel CSS y el tamaño final.
 */
export function captureScale(area, dpr, maxEdge) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const long = Math.max(area.width, area.height, 1);
  const scale = Math.min(maxEdge / (long * ratio), 1);
  const pxPerCss = scale * ratio;
  return { scale, pxPerCss, width: Math.max(1, Math.round(area.width * pxPerCss)), height: Math.max(1, Math.round(area.height * pxPerCss)) };
}

const NO_SHOT = "Aún no hay ninguna captura de esta pestaña, o es de otra página: haz una con screenshot y usa los píxeles de esa imagen.";

/**
 * Una zona en píxeles de la última captura (`shot`: origen en el documento, escala y tamaño
 * de la imagen) → la misma zona en píxeles CSS del documento.
 */
export function regionArea(region, shot, view) {
  if (!shot || (view && shot.url !== view.url)) throw new Error(NO_SHOT);
  if (region.x >= shot.width || region.y >= shot.height) throw new Error(`Esa zona está fuera de la captura (${shot.width}×${shot.height} px).`);
  const width = Math.min(region.width, shot.width - region.x), height = Math.min(region.height, shot.height - region.y);
  return { x: shot.x + region.x / shot.pxPerCss, y: shot.y + region.y / shot.pxPerCss, width: width / shot.pxPerCss, height: height / shot.pxPerCss };
}

/** Un punto en píxeles de la última captura → el mismo punto en la vista de ahora (px CSS). */
export function capturePoint(x, y, shot, view) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Indica «x» e «y»: píxeles de tu última captura de esta pestaña.");
  if (!shot || shot.url !== view.url) throw new Error(NO_SHOT);
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Error(`(${x}, ${y}) está fuera de la captura (${shot.width}×${shot.height} px).`);
  const point = { x: shot.x + x / shot.pxPerCss - view.x, y: shot.y + y / shot.pxPerCss - view.y };
  if (point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) {
    throw new Error("Ese punto ya no está a la vista: la página se desplazó desde la captura. Haz otra.");
  }
  return point;
}

/**
 * La caja que abarca lo que cambió (rectángulos en px CSS de la vista), con un margen y
 * recortada a la vista, y qué parte de la vista ocupa. `null` si nada cae en la vista.
 */
export function changedArea(rects, view) {
  let box = null;
  for (const rect of rects ?? []) {
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const right = Math.min(view.width, rect.x + rect.width), bottom = Math.min(view.height, rect.y + rect.height);
    if (right - left < 1 || bottom - top < 1) continue;
    box = box ? { left: Math.min(box.left, left), top: Math.min(box.top, top), right: Math.max(box.right, right), bottom: Math.max(box.bottom, bottom) }
      : { left, top, right, bottom };
  }
  if (!box) return null;
  const pad = 12;
  const x = Math.max(0, box.left - pad), y = Math.max(0, box.top - pad);
  const width = Math.min(view.width, box.right + pad) - x, height = Math.min(view.height, box.bottom + pad) - y;
  return { x, y, width, height, fraction: (width * height) / Math.max(1, view.width * view.height) };
}

/** Ancho y alto de un JPEG en base64, leídos de su cabecera (marcador SOF). `null` si no se encuentra. */
export function jpegSize(base64) {
  const text = String(base64 ?? ""), take = Math.min(text.length, 16384);
  let bytes;
  try { bytes = Uint8Array.from(atob(text.slice(0, take - (take % 4))), c => c.charCodeAt(0)); } catch { return null; }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: (bytes[at + 7] << 8) | bytes[at + 8], height: (bytes[at + 5] << 8) | bytes[at + 6] };
    }
    at += 2 + length;
  }
  return null;
}

const round = value => Math.round(value);

/** El texto que acompaña a una captura. */
export function describeCapture({ title, url, tabId, width, height, view, part, masked = 0, labels = null }) {
  const where = part ? `una zona de la página (${part})` : `la zona visible, desplazada ${round(view.y)} de ${round(Math.max(0, view.docHeight - view.height))} px`;
  const lines = [`Captura ${width}×${height} de «${clip(title || "Sin título", 120)}» (tabId ${tabId} · ${clip(url, 300)}): ${where}.`];
  if (masked) lines.push(`${masked === 1 ? "Un campo sensible tapado" : `${masked} campos sensibles tapados`} (contraseñas, tarjetas, códigos o marcos de pago).`);
  if (labels) lines.push(labels.length
    ? `Cada número de la imagen es la referencia ref_N de ese elemento (las referencias anteriores ya no valen):\n${labels.join("\n")}`
    : "No hay elementos con los que interactuar en esa zona.");
  lines.push("Coordenadas para region y click_at: píxeles de esta imagen.");
  return lines.join("\n");
}

/**
 * Lo que cambió tras una acción, en una o dos líneas. `report` es lo que devuelve
 * `changesReport` (page.js). El desplazamiento solo se cuenta si lo pidió la acción
 * (`scroll`): hacer clic o escribir ya traen el elemento a la vista, y eso no es noticia.
 */
export function describeChange(report, area, view, { scroll = false } = {}) {
  if (!report) return `Qué cambió: cargó otra página: «${clip(view?.title || "Sin título", 120)}» · ${clip(view?.url ?? "", 300)}.`;
  const parts = [];
  if (report.urlChanged) parts.push(`la dirección es ahora ${clip(report.url, 300)}`);
  if (report.titleChanged) parts.push(`el título es «${clip(report.title, 120)}»`);
  if (report.added.length) parts.push(`apareció ${report.added.map(text => `«${clip(text, 120)}»`).join(", ")}`);
  if (report.removed.length) parts.push(`desapareció ${report.removed.map(text => `«${clip(text, 80)}»`).join(", ")}`);
  if (report.scrolled && scroll) parts.push(`la vista se desplazó (ahora en ${round(report.scrollY)} px)`);
  if (report.focus) parts.push(`el foco está en ${report.focus}`);
  if (area) parts.push(`cambió una zona de ${round(area.width)}×${round(area.height)} px CSS (en ${round(area.x)},${round(area.y)} de la vista de ${round(view.width)}×${round(view.height)})`);
  return parts.length ? `Qué cambió: ${parts.join("; ")}.` : "Qué cambió: nada visible en la página.";
}

// --- Textos para el agente ------------------------------------------------------------------

const DIALOGS ={ alert: "un aviso (alert)", confirm: "una confirmación (confirm)", prompt: "una pregunta (prompt)", beforeunload: "un aviso de salir de la página (beforeunload)" };

/** Un diálogo abierto: la página está parada hasta que se acepte o se descarte. */
export function describeDialog(dialog) {
  const kind = DIALOGS[dialog?.type] ?? "un diálogo";
  const proposal = dialog?.type === "prompt" && dialog.defaultPrompt ? ` Valor propuesto: «${clip(dialog.defaultPrompt, 200)}».` : "";
  return `La página abrió ${kind}: «${clip(dialog?.message || "(sin texto)", 500)}».${proposal} Está parada hasta que lo resuelvas con handle_dialog (accept true o false).`;
}

const tabText = tab => `tabId ${tab.id}${tab.active ? " (activa)" : ""} · ${clip(tab.title || "Sin título", 80)} · ${clip(tab.url || "", 200)}`;

/** Una línea por pestaña, para que el agente la lea sin esfuerzo. */
export function describeTabs(own, common = []) {
  if (!own.length && !common.length) return "Aún no tienes pestañas. Abre una con tab_open, o pide a la persona que comparta la suya desde el botón de la extensión.";
  const lines = own.length ? ["Tus pestañas:", ...own.map(tabText)] : ["Aún no tienes pestañas propias."];
  if (common.length) {
    lines.push("", "Compartidas por la persona en el grupo común «trex». Si usas una, pasa a tu grupo y ningún otro chat la alcanza; tómala solo si encaja con lo que te pidió:");
    lines.push(...common.map(tabText));
  }
  return lines.join("\n");
}

export function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Lo que devuelve `collect` (page.js), en texto para el agente. */
export function describePage(page) {
  const lines = [`Título: ${clip(page.title, 200)}`, `Dirección: ${clip(page.url, 500)}`, ""];
  if (page.elements.length) {
    lines.push("Elementos (usa su referencia con click, type, fill_form, select_option o scroll):");
    for (const element of page.elements) lines.push(`${element.ref} ${element.role}${element.name ? ` «${element.name}»` : ""}${element.value ? ` = ${element.value}` : ""}`);
    if (page.moreElements) lines.push(`… y ${page.moreElements} elementos más que no caben. Desplaza la página y vuelve a leer.`);
    lines.push("");
  }
  lines.push("Texto visible:", page.text || "(sin texto)");
  if (page.truncated) lines.push("", "… el texto sigue. Pide más con maxChars o desplaza la página.");
  return lines.join("\n");
}

/** Nombre del navegador para la lista de trex. */
export function browserName(brands, brave) {
  if (brave) return "Brave";
  const names = (brands ?? []).map(brand => brand.brand);
  if (names.includes("Microsoft Edge")) return "Edge";
  if (names.includes("Opera")) return "Opera";
  if (names.includes("Vivaldi")) return "Vivaldi";
  if (names.includes("Google Chrome")) return "Chrome";
  return "Chromium";
}
