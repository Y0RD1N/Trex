/**
 * Miniaturas de lo que vio el agente en «Tu navegador» (capturas de `trex_chrome`), para que la
 * persona sepa qué imagen se envió al proveedor del modelo.
 *
 * Los bytes de las imágenes no entran en el estado del chat, que pesaría demasiado: aquí cada
 * captura se reduce a una miniatura en memoria, con un tope, y el chat guarda solo su huella
 * (un artefacto `capture:…`). Al reabrir trex no hay miniatura: queda la etiqueta «Captura».
 */
import type { BrowserArtifact } from "./browser";

const MAX_PREVIEWS = 40;
/** Lo bastante grande para verla en el visor; en el chat se muestra pequeña. */
const PREVIEW_EDGE = 1024;
/** Una captura de la extensión no pasa de unos pocos MiB en base64. */
const MAX_DATA = 12 * 1024 * 1024;

export type CapturePreview = { url: string; width: number; height: number };
const previews = new Map<string, CapturePreview | null>();
const listeners = new Set<() => void>();

const notify = (): void => { for (const listener of listeners) listener(); };

/** Para `useSyncExternalStore`: avisa cuando hay una miniatura nueva. */
export function subscribeCapturePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** La miniatura de una captura, si ya está hecha. */
export const capturePreview = (id: string): CapturePreview | null => previews.get(id) ?? null;

/** Huella de una imagen en base64: FNV-1a de 32 bits más su longitud. */
function fingerprint(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index++) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `capture:${hash.toString(16).padStart(8, "0")}-${data.length.toString(36)}`;
}

/** Guarda (la más reciente al final) y olvida las más viejas pasado el tope. */
function keep(id: string, value: CapturePreview | null): void {
  previews.delete(id);
  previews.set(id, value);
  while (previews.size > MAX_PREVIEWS) {
    previews.delete(previews.keys().next().value as string);
  }
}

function remember(id: string, value: CapturePreview): void {
  keep(id, value);
  notify();
}

/** Reduce la imagen a una vista previa JPEG. Sin APIs de imagen (las pruebas), no hace nada. */
async function thumbnail(id: string, mimeType: string, data: string): Promise<void> {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return; }
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const original = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    if (!previews.has(id)) return;
    // Como `data:`, el visor de imágenes de trex también puede guardarla.
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    remember(id, { url, ...original });
  } catch {
    // Una imagen que no se puede leer se queda sin miniatura: la etiqueta basta.
  }
}

/** Para el resultado de una herramienta de `trex_chrome`: `{ artifacts }` si trae capturas, y si no, nada. */
export function chromeCaptures(content: unknown): { artifacts?: BrowserArtifact[] } {
  const artifacts = capturePreviewArtifacts(content);
  return artifacts.length ? { artifacts } : {};
}

/**
 * Las capturas de un resultado MCP (`[{ type: "image", mimeType, data }, …]`) como artefactos
 * del chat, sin sus bytes. Empieza a hacer sus miniaturas.
 */
export function capturePreviewArtifacts(content: unknown): BrowserArtifact[] {
  if (!Array.isArray(content)) return [];
  const artifacts: BrowserArtifact[] = [];
  for (const block of content.slice(0, 8)) {
    if (!block || typeof block !== "object") continue;
    const { type, mimeType, data } = block as Record<string, unknown>;
    if (type !== "image" || (mimeType !== "image/jpeg" && mimeType !== "image/png") || typeof data !== "string" || !data || data.length > MAX_DATA) continue;
    const id = fingerprint(data);
    artifacts.push({ id, mimeType, kind: "capture", storage: "local", provenance: null });
    if (!previews.has(id)) {
      keep(id, null);
      if (typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") void thumbnail(id, mimeType, data);
    }
  }
  return artifacts;
}
