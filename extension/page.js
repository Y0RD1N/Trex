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

// --- Capturas -------------------------------------------------------------------------------

/**
 * Dónde está la vista: desplazamiento y tamaño (px CSS, sin las barras de desplazamiento),
 * la escala de la pantalla y si la pestaña se está pintando.
 */
export function viewInfo() {
  const root = document.documentElement;
  return {
    x: scrollX, y: scrollY, width: root.clientWidth || innerWidth, height: root.clientHeight || innerHeight,
    outerWidth: innerWidth, outerHeight: innerHeight, dpr: devicePixelRatio || 1, hidden: document.visibilityState !== "visible",
    docHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0), title: document.title, url: location.href,
  };
}

/**
 * Mientras se captura una pestaña en segundo plano, que la página no se entere del aviso de
 * cambio de tamaño que hace falta para que el navegador la pinte (un menú que se cierra al
 * redimensionar seguiría abierto). Con `on` false se quita con el siguiente aviso, que llega
 * con retraso, o al rato si no llega ninguno.
 */
export function shieldResize(on) {
  const targets = [globalThis, globalThis.visualViewport].filter(Boolean);
  const shield = globalThis.__trexShield ??= {
    closing: false, timer: 0,
    remove() { for (const target of targets) target.removeEventListener("resize", shield.stop, true); shield.closing = false; },
    stop(event) { event.stopImmediatePropagation(); if (shield.closing) { clearTimeout(shield.timer); shield.remove(); } },
  };
  clearTimeout(shield.timer);
  shield.closing = !on;
  if (on) for (const target of targets) target.addEventListener("resize", shield.stop, true);
  else shield.timer = setTimeout(() => shield.remove(), 1500);
  return true;
}

/**
 * La zona de un elemento por su referencia, en px CSS del documento y con un margen. Si no se
 * ve entero, antes lo trae a la vista. `null` si la referencia ya no existe o no se ve.
 */
export function refArea(ref) {
  const element = globalThis.__trexRefs?.get(ref);
  if (!element || !element.isConnected) return null;
  const root = document.documentElement;
  const width = root.clientWidth || innerWidth, height = root.clientHeight || innerHeight;
  let rect = element.getBoundingClientRect();
  if (rect.top < 0 || rect.left < 0 || rect.bottom > height || rect.right > width) {
    element.scrollIntoView({ block: rect.height > height ? "start" : "center", inline: "nearest", behavior: "instant" });
    rect = element.getBoundingClientRect();
  }
  const pad = 8;
  const left = Math.max(0, rect.left - pad), top = Math.max(0, rect.top - pad);
  const right = Math.min(width, rect.right + pad), bottom = Math.min(height, rect.bottom + pad);
  if (rect.width < 1 || rect.height < 1 || right - left < 1 || bottom - top < 1) return null;
  return { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top };
}

/**
 * Lo que se tapa en una captura antes de que salga del navegador (px CSS del documento, solo lo
 * que cae en `area`): contraseñas, campos de tarjeta y de códigos de verificación, y marcos de
 * pago. Mira también dentro de los componentes con DOM propio (shadow DOM abierto).
 */
export function sensitiveRects(area) {
  const PAYMENT = [/card.?(num|no\b)/i, /cardnumber/i, /\b(cvc|cvv2?|csc)\b/i, /security.?code/i, /n[uú]mero de (la )?tarjeta/i,
    /c[oó]digo de seguridad/i, /\bcc.?(num|number|exp|csc|cvv|cvc)/i, /(card|tarjeta).?(exp|caducidad|vencimiento)/i, /\b(iban|otp)\b/i];
  const PAYMENT_HOSTS = /(^|\.)(stripe\.com|stripe\.network|paypal\.com|paypalobjects\.com|braintreegateway\.com|braintree-api\.com|adyen\.com|adyenpayments\.com|checkout\.com|squareup\.com|squarecdn\.com|klarna\.com|mercadopago\.com|redsys\.es|worldpay\.com|authorize\.net|recurly\.com|chargebee\.com)$/i;
  const sensitive = element => {
    const tag = element.tagName;
    if (tag === "IFRAME" || tag === "FRAME" || tag === "EMBED" || tag === "OBJECT") {
      if (/\bpayment\b/i.test(element.getAttribute("allow") ?? "")) return true;
      try { return PAYMENT_HOSTS.test(new URL(element.getAttribute("src") || element.getAttribute("data") || "", location.href).hostname); } catch { return false; }
    }
    if (tag === "INPUT" && element.type === "password") return true;
    const autocomplete = String(element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (autocomplete.some(token => token.startsWith("cc-")) || ["one-time-code", "current-password", "new-password"].some(token => autocomplete.includes(token))) return true;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
    const names = [element.getAttribute("name"), element.id, element.labels?.[0]?.innerText, element.getAttribute("aria-label"), element.getAttribute("placeholder")].filter(Boolean).join(" ");
    return PAYMENT.some(pattern => pattern.test(names));
  };
  const found = [];
  const visit = (root, depth) => {
    for (const element of root.querySelectorAll("input, textarea, iframe, frame, embed, object, [autocomplete]")) {
      if (found.length >= 200 || !sensitive(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const x = rect.left + scrollX - 2, y = rect.top + scrollY - 2, width = rect.width + 4, height = rect.height + 4;
      if (x + width <= area.x || y + height <= area.y || x >= area.x + area.width || y >= area.y + area.height) continue;
      found.push({ x, y, width, height });
    }
    if (depth < 4) for (const host of root.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot, depth + 1);
  };
  visit(document, 0);
  return found;
}

/** Dónde están, en px CSS del documento, los elementos de la última lectura que caen en `area`. */
export function labelRects(area, max) {
  const boxes = [];
  for (const [ref, element] of globalThis.__trexRefs ?? []) {
    if (boxes.length >= max || !element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const x = rect.left + scrollX, y = rect.top + scrollY;
    if (x + rect.width <= area.x || y + rect.height <= area.y || x >= area.x + area.width || y >= area.y + area.height) continue;
    boxes.push({ ref, x, y, width: rect.width, height: rect.height });
  }
  return boxes;
}

/**
 * Empieza a anotar lo que cambia en la página (antes de una acción): qué elementos aparecen,
 * desaparecen o cambian de clase, estilo o estado. Lo recoge `changesReport`.
 */
export function watchChanges() {
  globalThis.__trexChanges?.observer.disconnect();
  const state = {
    url: location.href, title: document.title, scrollX, scrollY, focus: document.activeElement,
    targets: new Set(), added: [], removed: [], last: performance.now(), observer: null,
  };
  const note = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (element && state.targets.size < 500) state.targets.add(element);
  };
  state.observer = new MutationObserver(records => {
    state.last = performance.now();
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) { note(node); if (state.added.length < 60) state.added.push(node); }
        if (record.removedNodes.length) {
          note(record.target);
          for (const node of record.removedNodes) if (state.removed.length < 20) state.removed.push(String(node.textContent ?? ""));
        }
      } else if (record.target !== document.documentElement && record.target !== document.body) {
        // Las clases de <html> y <body> cambian por cualquier cosa (foco, desplazamiento): no cuentan.
        note(record.target);
      }
    }
  });
  state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "src", "disabled", "aria-expanded", "aria-hidden", "aria-selected", "aria-checked", "aria-pressed"] });
  globalThis.__trexChanges = state;
  return { hidden: document.visibilityState !== "visible" };
}

/** Cuánto lleva la página sin cambiar (ms). -1 si no se está anotando: la pestaña cargó otra página. */
export function changesQuiet() {
  const state = globalThis.__trexChanges;
  return state ? performance.now() - state.last : -1;
}

/**
 * Lo que cambió desde `watchChanges`, y deja de anotar: dónde (rectángulos en px CSS de la
 * vista), el texto que apareció o desapareció, la dirección, el título y el foco. `touched`
 * son las referencias de los campos que tocó la acción (escribir no cambia el DOM). `null` si
 * no se estaba anotando: la pestaña cargó otra página.
 */
export function changesReport(touched) {
  const state = globalThis.__trexChanges;
  if (!state) return null;
  state.observer.disconnect();
  globalThis.__trexChanges = null;
  const clip = (value, max) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
  const shown = element => {
    if (!element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const style = getComputedStyle(element);
    return style.visibility === "hidden" || style.display === "none" ? null : rect;
  };
  const rects = [];
  const add = element => { const rect = shown(element); if (rect) rects.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }); };
  for (const element of state.targets) add(element);
  // Lo que cambia sin tocar el DOM: lo escrito en un campo, una casilla, o lo que pinta un lienzo.
  const silent = element => /^(INPUT|TEXTAREA|SELECT|CANVAS|VIDEO|IFRAME|EMBED|OBJECT)$/.test(element.tagName) || element.isContentEditable
    || /^(checkbox|radio|switch|option|slider|spinbutton|combobox|textbox|searchbox)$/.test(element.getAttribute("role") ?? "");
  for (const entry of touched ?? []) {
    const element = entry === "focus" ? document.activeElement : entry === "point" ? globalThis.__trexPoint : globalThis.__trexRefs?.get(entry);
    if (element?.nodeType === 1 && element.isConnected && silent(element)) add(element);
  }
  // Texto nuevo: el de lo que apareció, sin repetir lo que está dentro de otro aparecido.
  const added = [];
  const elements = state.added.map(node => node.nodeType === 1 ? node : node.parentElement).filter(Boolean);
  let total = 0;
  for (const element of elements) {
    if (added.length >= 3 || total > 300 || !element.isConnected || elements.some(other => other !== element && other.contains(element))) continue;
    if (!shown(element)) continue;
    const text = clip(element.innerText, 160);
    if (text && !added.includes(text)) { added.push(text); total += text.length; }
  }
  const removed = [...new Set(state.removed.map(text => clip(text, 100)).filter(Boolean))].slice(0, 2);
  const active = document.activeElement;
  let focus = null;
  if (active && active !== state.focus && active !== document.body && active !== document.documentElement) {
    const tag = active.tagName.toLowerCase();
    const name = clip(active.getAttribute("aria-label") || active.labels?.[0]?.innerText || active.getAttribute("placeholder") || active.getAttribute("title")
      || (tag === "input" || tag === "textarea" ? "" : active.innerText), 60);
    focus = `${active.getAttribute("role") || (tag === "input" ? active.type || "text" : tag)}${name ? ` «${name}»` : ""}`;
  }
  return {
    url: location.href, title: document.title, urlChanged: location.href !== state.url, titleChanged: document.title !== state.title,
    scrolled: Math.abs(scrollX - state.scrollX) > 1 || Math.abs(scrollY - state.scrollY) > 1, scrollY: Math.round(scrollY),
    rects: rects.slice(0, 300), added, removed, focus,
  };
}

/**
 * Qué hay en un punto de la vista (px CSS), sin leer valores. Con `arm`, deja anotado si ese
 * elemento llega a recibir el clic (lo completa `clickedAt`).
 */
export function pointAt(x, y, arm) {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;
  const tag = element.tagName.toLowerCase();
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const name = text(element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder")
    || (tag === "input" || tag === "textarea" ? "" : element.innerText));
  const frame = ["iframe", "frame", "object", "embed"].includes(tag);
  globalThis.__trexPoint = element;
  if (arm && !frame) {
    const pending = { element, x, y, clicked: false };
    element.addEventListener("click", () => { pending.clicked = true; }, { capture: true, once: true });
    globalThis.__trexClick = pending;
  }
  return { tag, role: element.getAttribute("role") || tag, name, frame, hidden: document.visibilityState !== "visible" };
}

/**
 * Tras intentar el clic con el ratón en un punto: si el elemento no lo recibió (pestaña en
 * segundo plano), se le da directamente, con las coordenadas (un lienzo las necesita).
 */
export function clickedAt() {
  const pending = globalThis.__trexClick;
  globalThis.__trexClick = null;
  if (!pending) return "perdido";
  if (pending.clicked) return "raton";
  if (!pending.element.isConnected) return "perdido";
  const options = { bubbles: true, cancelable: true, composed: true, clientX: pending.x, clientY: pending.y, button: 0, view: window };
  pending.element.dispatchEvent(new PointerEvent("pointerdown", { ...options, pointerId: 1, isPrimary: true }));
  pending.element.dispatchEvent(new MouseEvent("mousedown", options));
  pending.element.dispatchEvent(new PointerEvent("pointerup", { ...options, pointerId: 1, isPrimary: true }));
  pending.element.dispatchEvent(new MouseEvent("mouseup", options));
  pending.element.dispatchEvent(new MouseEvent("click", { ...options, detail: 1 }));
  return "directo";
}
