/**
 * Imágenes adjuntas al chat: se reducen y comprimen en la ventana antes de
 * enviarlas, para respetar el límite de la API (5 MB por imagen) sin gastar
 * contexto en píxeles que el modelo no aprovecha.
 */
import { invoke } from "@tauri-apps/api/core";
import type { OutgoingImage } from "./chatState";

/** Lado más largo con el que se envía una imagen. */
export const MAX_IMAGE_EDGE = 1920;
/** Bytes máximos de una imagen ya codificada (en base64 queda por debajo de 5 MB). */
export const MAX_IMAGE_BYTES = 3_700_000;
/** Imágenes por mensaje. */
export const MAX_IMAGES = 10;
const SENDABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ChatAttachment = OutgoingImage & { id: string; name: string; preview: string };
type ImageData = { mediaType: string; data: string; name: string };

export const readImageFile = (path: string): Promise<ImageData> => invoke("read_image_file", { path });
export const readClipboardImage = (): Promise<ImageData | null> => invoke("read_clipboard_image");

/** Tamaño que cabe en `max` sin deformar la imagen ni ampliarla. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
  reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer la imagen."));
  reader.readAsDataURL(blob);
});

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("No se pudo preparar la imagen.")), type, quality));

let counter = 0;

/** Deja la imagen lista para enviar: reducida, comprimida y con vista previa. */
export async function prepareImage(source: Blob | ImageData, name = "imagen"): Promise<ChatAttachment> {
  const blob = source instanceof Blob ? source
    : await (await fetch(`data:${source.mediaType};base64,${source.data}`)).blob();
  const label = source instanceof Blob ? (source instanceof File && source.name) || name : source.name || name;
  const bitmap = await createImageBitmap(blob).catch(() => { throw new Error(`«${label}» no es una imagen que se pueda abrir.`); });
  let size = fitWithin(bitmap.width, bitmap.height);
  let result: Blob = blob;
  if (size.width !== bitmap.width || blob.size > MAX_IMAGE_BYTES || !SENDABLE.has(blob.type)) {
    const canvas = document.createElement("canvas");
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No se pudo preparar la imagen.");
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      result = await encode(canvas, "image/png");
      if (result.size > MAX_IMAGE_BYTES) result = await encode(canvas, "image/jpeg", 0.86);
      if (result.size <= MAX_IMAGE_BYTES) break;
      size = fitWithin(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.75));
    }
  }
  bitmap.close();
  if (result.size > MAX_IMAGE_BYTES) throw new Error(`«${label}» es demasiado grande para enviarla.`);
  const data = await toBase64(result);
  const mediaType = result.type || blob.type;
  return { id: `img-${Date.now().toString(36)}-${++counter}`, name: label, mediaType, data, preview: `data:${mediaType};base64,${data}` };
}
