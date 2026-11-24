// Lo que la extensión ejecuta DENTRO de una pestaña compartida con un chat.
//
// Estas funciones se serializan con `toString()` y se evalúan en un mundo aislado de la
// página (sus scripts no las ven ni pueden tocarlas), así que no pueden usar nada de
// fuera de su propio cuerpo.

/**
 * Lee la página: texto visible y elementos con los que se puede interactuar. A cada uno
 * le da una referencia `ref_N`, que vale hasta la siguiente lectura.
 */
export function collect(maxChars, maxElements) {
  const SELECTOR = "a[href], button, input, textarea, select, summary, [contenteditable=''], [contenteditable='true'], [onclick], [tabindex]:not([tabindex='-1']), " +
    "[role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=textbox], [role=combobox], [role=searchbox]";
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const roleOf = element => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return element.type === "password" ? "contraseña" : element.type || "text";
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    if (tag === "summary") return "summary";
    if (element.isContentEditable) return "editor";
    return "button";
  };
  const nameOf = element => {
    const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean).join(" ");
    const label = element.labels?.[0]?.innerText;
    return clip(element.getAttribute("aria-label") || labelled || label || element.getAttribute("placeholder") || element.innerText
      || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("name") || "", 90);
  };
  const valueOf = element => {
    const tag = element.tagName.toLowerCase();
    // Lo que hay escrito en un campo de contraseña no se lee nunca.
    if (tag === "input" && element.type === "password") return element.value ? "(oculto)" : "";
    if (tag === "input" && (element.type === "checkbox" || element.type === "radio")) return element.checked ? "marcado" : "sin marcar";
    if (tag === "input" || tag === "textarea") return clip(element.value, 90);
    if (tag === "select") return clip(element.selectedOptions?.[0]?.innerText, 90);
    if (element.getAttribute("aria-checked")) return element.getAttribute("aria-checked") === "true" ? "marcado" : "sin marcar";
    return "";
  };

  const refs = new Map();
  const elements = [];
  let more = 0;
  for (const element of document.querySelectorAll(SELECTOR)) {
    if (element.disabled || element.getAttribute("aria-hidden") === "true" || !visible(element)) continue;
    if (elements.length >= maxElements) { more++; continue; }
    const ref = `ref_${elements.length + 1}`;
    refs.set(ref, element);
    elements.push({ ref, role: roleOf(element), name: nameOf(element), value: valueOf(element) });
  }
  globalThis.__trexRefs = refs;
  const text = (document.body?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: document.title, url: location.href, elements, moreElements: more,
    text: text.slice(0, maxChars), truncated: text.length > maxChars,
  };
}

/**
 * Lleva a la vista el elemento de una referencia y da su centro en la ventana, para hacer
 * clic ahí. `null` si la referencia ya no existe (hay que volver a leer la página).
 *
 * Con `arm`, además deja anotado si el elemento llega a recibir el clic (lo comprueba
 * `ensureClicked`) y avisa de cuándo no conviene usar el ratón: la página no se está
 * pintando (`hidden`) o hay otra cosa encima de ese punto (`covered`).
 */
export function locate(ref, arm) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1);
  const point = { x, y, password: element.tagName === "INPUT" && element.type === "password" };
  if (!arm) return point;
  const hit = document.elementFromPoint(x, y);
  const pending = { element, clicked: false };
  element.addEventListener("click", () => { pending.clicked = true; }, { capture: true, once: true });
  globalThis.__trexClick = pending;
  return { ...point, hidden: document.visibilityState !== "visible", covered: !hit || !(element.contains(hit) || hit.contains(element)) };
}

/**
 * Tras intentar el clic con el ratón: si el elemento no lo recibió (la página se movió, la
 * ventana no se pinta, había algo encima), se lo da directamente. Dice cómo quedó.
 */
export function ensureClicked() {
  const pending = globalThis.__trexClick;
  globalThis.__trexClick = null;
  if (!pending) return "perdido";
  if (pending.clicked) return "raton";
  if (!pending.element.isConnected) return "perdido";
  pending.element.click();
  return "directo";
}

/**
 * Pone el foco en un campo antes de escribir en él y selecciona lo que ya tiene, para que
 * lo escrito lo sustituya. `null` si la referencia ya no existe.
 */
export function focusRef(ref) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();
  if (typeof element.select === "function" && element.tagName !== "SELECT") {
    try { element.select(); } catch { /* campos sin selección */ }
  } else if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

/**
 * Cómo es un campo: qué clase de control es y lo que hace falta para saber si lo debe
 * rellenar la persona (tipo, autocomplete, nombre, etiqueta). Sin `ref`, el que tiene el foco.
 * Nunca devuelve lo que hay escrito.
 */
export function fieldInfo(ref) {
  let element = ref === null ? document.activeElement : globalThis.__trexRefs?.get(ref);
  // El foco puede estar dentro de un componente con su propio DOM (shadow DOM abierto).
  while (ref === null && element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element || !element.isConnected || element === document.body || element === document.documentElement) return null;
  const tag = element.tagName.toLowerCase();
  const type = tag === "input" ? String(element.type || "text").toLowerCase() : "";
  // Dentro de un marco no se ve qué campo tiene el foco: puede ser una contraseña.
  const kind = ["iframe", "frame", "object", "embed"].includes(tag) ? "frame"
    : tag === "select" ? "select"
    : tag === "textarea" ? "text"
    : tag === "input" ? (type === "checkbox" || type === "radio" ? "check" : type === "file" ? "file"
      : ["date", "time", "datetime-local", "month", "week", "range", "color"].includes(type) ? "value"
      : ["submit", "button", "reset", "image", "hidden"].includes(type) ? "other" : "text")
    : element.isContentEditable ? "text" : "other";
  const cut = value => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    tag, type, kind,
    name: cut(element.getAttribute("name")), id: cut(element.id), autocomplete: cut(element.getAttribute("autocomplete")),
    label: cut(element.labels?.[0]?.innerText || element.getAttribute("aria-label")), placeholder: cut(element.getAttribute("placeholder")),
    checked: !!element.checked, multiple: !!element.multiple, disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
    readOnly: !!element.readOnly,
    options: tag === "select" ? [...element.options].slice(0, 500).map(option => ({ value: option.value, text: cut(option.text), disabled: option.disabled })) : [],
  };
}

/** Fechas, horas, rangos y colores: no se escriben tecla a tecla, se les da el valor. */
export function setValue(ref, value) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value === value;
}

/**
 * Marca o desmarca una casilla, o marca un botón de opción, con un clic de verdad (así la
 * página se entera como si lo hiciera la persona). Devuelve cómo quedó, o «radio» si se
 * pidió desmarcar un botón de opción, que solo se desmarca eligiendo otro.
 */
export function setChecked(ref, checked) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  if (element.checked === checked) return checked;
  if (!checked && element.type === "radio") return "radio";
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.click();
  return element.checked;
}

/** Elige la opción `index` de un `<select>` y avisa a la página. Devuelve su texto. */
export function chooseOption(ref, index) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected || element.tagName !== "SELECT" || !element.options[index]) return null;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();
  element.selectedIndex = index;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return String(element.options[index].text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Para wait_for: si ya se cumple la condición (un texto en la página, o un elemento por
 * referencia o selector que se ve). «selector-no-valido» si el selector no se entiende.
 */
export function probe(kind, value) {
  const shown = element => {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  if (kind === "text") return (document.body?.innerText ?? "").replace(/\s+/g, " ").includes(value.replace(/\s+/g, " "));
  if (kind === "ref") return shown(globalThis.__trexRefs?.get(value));
  try {
    return shown(document.querySelector(value));
  } catch {
    return "selector-no-valido";
  }
}

/** El elemento de una referencia, tal cual (para upload_file, que lo necesita como objeto). */
export function refElement(ref) {
  const element = globalThis.__trexRefs?.get(ref);
  return element && element.isConnected ? element : null;
}

export function scrollPage(direction) {
  const step = Math.round(innerHeight * 0.85);
  if (direction === "top") scrollTo({ top: 0, behavior: "instant" });
  else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  else scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
  return { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
}
