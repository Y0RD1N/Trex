/** Reutiliza el contenido original sin perder las imágenes ni las opciones del perfil. */
import type { UserItem } from "./chatState";
import type { ChatAttachment } from "./chatImages";
import { splitProfileArgs } from "./codexChat";

export function messageAttachments(item: UserItem): ChatAttachment[] {
  if (item.images !== item.previews.length) throw new Error("Las imágenes de este mensaje ya no están disponibles.");
  return item.previews.map((preview, index) => {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(preview);
    if (!match) throw new Error("No se pudo recuperar una imagen de este mensaje.");
    return { id: `${item.id}-image-${index}`, name: `Imagen ${index + 1}`, mediaType: match[1], data: match[2], preview };
  });
}

/** La regeneración elige su propia sesión; las demás opciones siguen siendo las del perfil. */
export function withoutConversationArgs(args: string | null): string | null {
  const tokens = splitProfileArgs(args ?? "");
  if (!tokens) throw new Error("No se pudieron interpretar las opciones del perfil.");
  const result: string[] = [];
  const valued = new Set(["--resume", "-r", "--session-id", "--resume-session-at", "--resume-drops-turn"]);
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index].split("=", 1)[0];
    if (valued.has(name)) { if (!tokens[index].includes("=")) index++; continue; }
    if (["--continue", "-c", "--fork-session"].includes(name)) continue;
    result.push(tokens[index]);
  }
  return result.length ? result.map(value => /^[^\s"'\\]+$/.test(value) ? value : JSON.stringify(value)).join(" ") : null;
}
