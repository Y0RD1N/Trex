/** Referencias del borrador y etiquetas de las imágenes enviadas al asistente. */
export const imageReference = (index: number): string => `[Imagen ${index + 1}]`;
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

export function insertImageReferences(text: string, selection: TextSelection, first: number, count: number) {
  if (!count) return { text, selection };
  const before = text.slice(0, selection.start), after = text.slice(selection.end);
  const references = Array.from({ length: count }, (_, index) => imageReference(first + index)).join(" ");
  const inserted = `${before && !/\s$/.test(before) ? " " : ""}${references} `;
  const caret = before.length + inserted.length;
  return { text: before + inserted + (after.startsWith(" ") ? after.slice(1) : after), selection: { start: caret, end: caret } };
}

/** Quitar una imagen elimina sus citas y renumera las restantes sin mover el cursor al final. */
export function removeImageReference(text: string, selection: TextSelection, index: number, total: number) {
  const edits: TextEdit[] = [];
  for (const match of text.matchAll(/\[Imagen (\d+)\]( ?)/g)) {
    const number = Number(match[1]);
    if (number <= index || number > total) continue;
    edits.push({ start: match.index, end: match.index + match[0].length,
      text: number === index + 1 ? "" : imageReference(number - 2) + match[2] });
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
