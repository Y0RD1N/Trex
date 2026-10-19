/**
 * Archivos adjuntos al chat (cualquier tipo, no solo imágenes). No se envía su
 * contenido: el mensaje lleva su ruta y el asistente los lee con sus
 * herramientas. Los que llegan sin ruta (arrastrados o pegados) se guardan
 * antes en la carpeta de la app.
 */
import { invoke } from "@tauri-apps/api/core";

/** Archivos por mensaje. */
export const MAX_FILES = 10;

export type ChatFile = { id: string; name: string; path: string; size: number; preparing?: boolean };

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
export const isImagePath = (path: string): boolean => IMAGE_PATH.test(path);

/** Último componente de una ruta de Windows o Unix. */
export const pathName = (path: string): string => path.split(/[\/]/).filter(Boolean).pop() ?? path;

/** Guarda un archivo sin ruta y devuelve dónde quedó. */
export async function saveAttachment(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<string>("save_attachment", bytes, { headers: { "x-file-name": encodeURIComponent(file.name || "archivo") } });
}
