/**
 * Ajustes del Markdown de las respuestas, sin interfaz para poder probarlos.
 */
export type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

export const nodeText = (node: HastNode | undefined): string =>
  !node ? "" : node.type === "text" ? node.value ?? "" : (node.children ?? []).map(nodeText).join("");

/**
 * Convierte `> [!NOTE]` (y TIP, IMPORTANT, WARNING, CAUTION) en un aviso:
 * marca la cita con su tipo y quita la etiqueta del texto.
 */
export function rehypeCallouts() {
  const mark = (quote: HastNode): void => {
    const paragraph = quote.children?.find(child => child.type === "element");
    const first = paragraph?.tagName === "p" ? paragraph.children?.[0] : undefined;
    const match = first?.type === "text" ? /^\s*\[!(note|tip|important|warning|caution)\][ \t]*\n?/i.exec(first.value ?? "") : null;
    if (!paragraph || !first || !match) return;
    first.value = (first.value ?? "").slice(match[0].length);
    // Si la etiqueta iba sola en su línea, el párrafo queda vacío y se quita.
    if (!nodeText(paragraph).trim()) quote.children = quote.children?.filter(child => child !== paragraph);
    quote.properties = { ...quote.properties, className: ["chat-callout", match[1].toLowerCase()] };
  };
  const walk = (node: HastNode): void => {
    for (const child of node.children ?? []) {
      if (child.type === "element" && child.tagName === "blockquote") mark(child);
      walk(child);
    }
  };
  return (tree: unknown): void => walk(tree as HastNode);
}

// --- Colores del código ---------------------------------------------------------

/**
 * Lenguaje de `<code class="language-x">` (o `lang-x`), como lo lee
 * rehype-highlight; false con `no-highlight`, que pide no colorear.
 */
export function codeLanguage(node: HastNode | undefined): string | false | undefined {
  const classes = node?.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  let name: string | undefined;
  for (const value of classes.map(String)) {
    if (value === "no-highlight" || value === "nohighlight") return false;
    if (!name && value.startsWith("lang-")) name = value.slice(5);
    if (!name && value.startsWith("language-")) name = value.slice(9);
  }
  return name;
}

// --- Respuestas que siguen llegando ---------------------------------------------

/** Abre o cierra un bloque de código cercado (``` o ~~~, hasta 3 espacios). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Una línea que empieza un elemento de lista: no se corta una lista entre sus elementos. */
const LIST_ITEM = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/**
 * Construcciones que relacionan partes lejanas del texto o que pueden contener
 * líneas en blanco (referencias de enlaces, notas al pie, comentarios y bloques
 * HTML de tipo 1-5): con ellas no se corta nada.
 */
const UNSPLITTABLE = /^ {0,3}(?:\[[^\]\n]+\]:|<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:pre|script|style|textarea)(?:[\s>]|$)))/im;

/**
 * Parte una respuesta en curso en bloques de Markdown independientes para que
 * solo el último se vuelva a interpretar con cada trozo que llega; los
 * anteriores no cambian y no se repintan.
 *
 * Solo se corta en una línea en blanco fuera de un bloque de código cuando la
 * siguiente línea no está sangrada (continuación de un elemento de lista o
 * código sangrado) ni empieza otro elemento de lista: así cada bloque se
 * interpreta igual que dentro del texto completo. Ante cualquier duda (enlaces
 * por referencia, notas al pie, HTML) se devuelve el texto entero.
 */
export function markdownBlocks(text: string): string[] {
  if (!text.includes("\n\n") || UNSPLITTABLE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0, fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = FENCE.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (line.trim() || index === start || index + 1 >= lines.length) continue;
    const next = lines[index + 1];
    if (!next.trim() || /^[ \t]/.test(next) || LIST_ITEM.test(next)) continue;
    blocks.push(lines.slice(start, index).join("\n"));
    start = index + 1;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
