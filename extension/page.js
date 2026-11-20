// Lo que la extensión ejecuta DENTRO de una pestaña del grupo «trex».
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

/** Pone el foco en un campo antes de escribir en él. */
export function focusRef(ref) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();
  if (typeof element.select === "function" && element.tagName !== "SELECT") { try { element.select(); } catch { /* campos sin selección */ } }
  return { password: element.tagName === "INPUT" && element.type === "password" };
}

/** El campo con el foco, por si se escribe sin referencia. */
export function activePassword() {
  const element = document.activeElement;
  return !!element && element.tagName === "INPUT" && element.type === "password";
}

export function scrollPage(direction) {
  const step = Math.round(innerHeight * 0.85);
  if (direction === "top") scrollTo({ top: 0, behavior: "instant" });
  else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  else scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
  return { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
}
