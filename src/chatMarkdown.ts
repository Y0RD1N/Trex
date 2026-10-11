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
