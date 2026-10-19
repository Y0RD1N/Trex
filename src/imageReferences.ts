/** Referencias del borrador y etiquetas de las imágenes y archivos enviados al asistente. */
export type ReferenceKind = "Imagen" | "Archivo";
export const reference = (kind: ReferenceKind, index: number): string => `[${kind} ${index + 1}]`;
export const imageReference = (index: number): string => reference("Imagen", index);
export const fileReference = (index: number): string => reference("Archivo", index);
export type TextSelection = { start: number; end: number };
type TextEdit = { start: number; end: number; text: string };

function moveOffset(offset: number, edits: TextEdit[]): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset <= edit.start) break;
    if (offset < edit.end) return edit.start + shift + Math.min(offset - edit.start, edit.text.length);
    shift += edit.text.length - (edit.end - edit.start);
  }
  return offset + shift;
}

/** Una lectura nativa puede terminar después de que la persona haya seguido escribiendo. */
export function moveSelection(before: string, after: string, selection: TextSelection): TextSelection {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const edits = [{ start, end, text: after.slice(start, nextEnd) }];
  return { start: moveOffset(selection.start, edits), end: moveOffset(selection.end, edits) };
}

export function insertImageReferences(text: string, selection: TextSelection, first: number, count: number, kind: ReferenceKind = "Imagen") {
  if (!count) return { text, selection };
  const before = text.slice(0, selection.start), after = text.slice(selection.end);
  const references = Array.from({ length: count }, (_, index) => reference(kind, first + index)).join(" ");
  const inserted = `${before && !/\s$/.test(before) ? " " : ""}${references} `;
  const caret = before.length + inserted.length;
  return { text: before + inserted + (after.startsWith(" ") ? after.slice(1) : after), selection: { start: caret, end: caret } };
}

/** Quitar un adjunto elimina sus citas y renumera las restantes sin mover el cursor al final. */
export function removeImageReference(text: string, selection: TextSelection, index: number, total: number, kind: ReferenceKind = "Imagen") {
  const edits: TextEdit[] = [];
  for (const match of text.matchAll(new RegExp(`\\[${kind} (\\d+)\\]( ?)`, "g"))) {
    const number = Number(match[1]);
    if (number <= index || number > total) continue;
    edits.push({ start: match.index, end: match.index + match[0].length,
      text: number === index + 1 ? "" : reference(kind, number - 2) + match[2] });
  }
  let value = text;
  for (const edit of [...edits].reverse()) value = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { text: value, selection: { start: moveOffset(selection.start, edits), end: moveOffset(selection.end, edits) } };
}

/** El historial conserva el texto original, sin repetir las etiquetas del transporte. */
export function withoutImageLabels<T extends { type?: unknown; text?: unknown }>(content: T[]): T[] {
  let end = 0;
  while (content[end]?.type === "text" && content[end].text === imageReference(end / 2)
    && ["image", "localImage"].includes(String(content[end + 1]?.type))) end += 2;
  return content.filter((_, index) => index >= end || index % 2 === 1);
}

export type TextPart = { text: string } | { kind: ReferenceKind; index: number; text: string };

/** Trozos del texto con las citas separadas, para pintarlas como etiquetas. */
export function referenceParts(text: string, counts: Partial<Record<ReferenceKind, number>> = {}): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(Imagen|Archivo) (\d+)\]/g)) {
    const kind = match[1] as ReferenceKind, index = Number(match[2]) - 1;
    const limit = counts[kind];
    if (index < 0 || (limit !== undefined && index >= limit)) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ kind, index, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Los archivos viajan como rutas al final del mensaje: el asistente los lee con
 * sus herramientas y el historial los recupera sin guardar nada aparte.
 */
export const FILES_HEADER = "Archivos adjuntos:";

export function withAttachedFiles(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const list = paths.map((path, index) => `${fileReference(index)}: ${path}`).join("\n");
  return `${text}${text ? "\n\n" : ""}${FILES_HEADER}\n${list}`;
}

export function splitAttachedFiles(text: string): { text: string; files: string[] } {
  const match = /(?:^|\n\n)Archivos adjuntos:\n((?:\[Archivo \d+\]: [^\n]+(?:\n|$))+)\s*$/.exec(text);
  if (!match) return { text, files: [] };
  const files = match[1].trim().split("\n").map(line => line.replace(/^\[Archivo \d+\]: /, "").trim());
  return { text: text.slice(0, match.index), files };
}
