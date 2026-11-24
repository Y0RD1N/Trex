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

// --- Textos para el agente ------------------------------------------------------------------

const DIALOGS = { alert: "un aviso (alert)", confirm: "una confirmación (confirm)", prompt: "una pregunta (prompt)", beforeunload: "un aviso de salir de la página (beforeunload)" };

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
