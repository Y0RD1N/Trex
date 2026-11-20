// Piezas puras de la extensión (sin APIs del navegador): se prueban con `npm test`.

export const GROUP_TITLE = "trex";
export const DEFAULT_PORT = 7341;
/** Tope de texto que vuelve de una página si el agente no pide otro. */
export const DEFAULT_PAGE_CHARS = 20000;
export const MAX_PAGE_CHARS = 100000;

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

/** Una línea por pestaña, para que el agente la lea sin esfuerzo. */
export function describeTabs(tabs) {
  if (!tabs.length) return "No hay pestañas en el grupo «trex». Abre una con tab_open, o pide a la persona que comparta la suya desde el botón de la extensión.";
  return tabs.map(tab => `tabId ${tab.id}${tab.active ? " (activa)" : ""} · ${clip(tab.title || "Sin título", 80)} · ${clip(tab.url || "", 200)}`).join("\n");
}

export function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Lo que devuelve `collect` (page.js), en texto para el agente. */
export function describePage(page) {
  const lines = [`Título: ${clip(page.title, 200)}`, `Dirección: ${clip(page.url, 500)}`, ""];
  if (page.elements.length) {
    lines.push("Elementos (usa su referencia con click, type o scroll):");
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
