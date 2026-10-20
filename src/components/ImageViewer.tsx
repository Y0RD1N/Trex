/**
 * Visor de imágenes a pantalla completa: las del usuario y las que comparte el
 * asistente. Se ajustan a la ventana; la rueda acerca hacia el cursor, se
 * arrastran cuando no caben y las flechas pasan a la siguiente.
 *
 * Uso:
 *   const viewer = useImageViewer();
 *   viewer.open([{ src, name, path }], 0);
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { usePresence } from "../hooks/usePresence";
import { formatError } from "../api";
import { openFile, revealFile, saveFileCopy, saveFileData } from "../sharedFiles";
import { ArrowRightIcon, CloseIcon, DownloadIcon, ExternalIcon, FolderIcon, MinusIcon, PlusIcon } from "./Icons";

export type ViewerImage = {
  /** URL que se muestra (normalmente `data:`). */
  src: string;
  name: string;
  /** Archivo de origen, si lo hay: permite abrirlo y guardarlo tal cual. */
  path?: string;
};

type ViewerApi = { open: (images: ViewerImage[], index?: number) => void };
const ViewerContext = createContext<ViewerApi>({ open: () => undefined });

export const useImageViewer = (): ViewerApi => useContext(ViewerContext);

type Session = { images: ViewerImage[]; index: number; opener: HTMLElement | null };

export default function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const open = useCallback((images: ViewerImage[], index = 0) => {
    if (!images.length) return;
    setSession({ images, index: Math.max(0, Math.min(index, images.length - 1)),
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);
  const api = useMemo(() => ({ open }), [open]);
  return <ViewerContext.Provider value={api}>
    {children}
    <Viewer session={session} onIndex={index => setSession(current => current && { ...current, index })}
      onClose={() => setSession(null)} />
  </ViewerContext.Provider>;
}

const MIN_ZOOM = 0.05, MAX_ZOOM = 8;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Extensión para guardar una imagen sin archivo (data URL). */
function dataParts(src: string): { data: string; extension: string } | null {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(src);
  if (!match) return null;
  const type = match[1].toLowerCase();
  return { data: match[2], extension: type === "jpeg" ? "jpg" : type.replace(/\+.*$/, "") };
}

function Viewer({ session, onIndex, onClose }: { session: Session | null; onIndex: (index: number) => void; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(session, 180, surfaceRef);
  const shown = presence.value;
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const image = shown ? shown.images[shown.index] : null;
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  /** Zoom respecto a los píxeles reales; null = ajustado a la ventana. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);

  // Imagen nueva: vuelve a ajustarse a la ventana.
  useLayoutEffect(() => { setNatural(null); setZoom(null); setOffset({ x: 0, y: 0 }); setError(null); }, [image?.src]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = (): void => setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown !== null]);

  const fit = natural && stage.width
    ? Math.min(1, (stage.width - 48) / natural.width, (stage.height - 48) / natural.height) : 1;
  const scale = zoom ?? fit;
  const width = natural ? natural.width * scale : 0, height = natural ? natural.height * scale : 0;
  /** Desplazamiento permitido: la imagen no puede salir del todo de la vista. */
  const bound = useCallback((x: number, y: number, w = width, h = height) => ({
    x: clamp(x, -Math.max(0, (w - stage.width) / 2 + 24), Math.max(0, (w - stage.width) / 2 + 24)),
    y: clamp(y, -Math.max(0, (h - stage.height) / 2 + 24), Math.max(0, (h - stage.height) / 2 + 24)),
  }), [width, height, stage]);

  /** Cambia el zoom manteniendo fijo el punto `at` (relativo al centro de la vista). */
  const zoomTo = useCallback((next: number, at = { x: 0, y: 0 }) => {
    if (!natural) return;
    const target = clamp(next, Math.min(MIN_ZOOM, fit), MAX_ZOOM);
    const ratio = target / scale;
    setZoom(Math.abs(target - fit) < 0.001 ? null : target);
    setOffset(current => bound(at.x - (at.x - current.x) * ratio, at.y - (at.y - current.y) * ratio,
      natural.width * target, natural.height * target));
  }, [natural, fit, scale, bound]);

  const fitWindow = (): void => { setZoom(null); setOffset({ x: 0, y: 0 }); };

  const step = useCallback((delta: number) => {
    if (!shown || shown.images.length < 2) return;
    onIndex((shown.index + delta + shown.images.length) % shown.images.length);
  }, [shown, onIndex]);

  // Foco: entra en el visor y vuelve al control que lo abrió.
  useEffect(() => {
    if (!session) return;
    closeRef.current?.focus({ preventScroll: true });
    const opener = session.opener;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [session !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return;
    const onKey = (event: KeyboardEvent): void => {
      const keys: Record<string, () => void> = {
        Escape: onClose, ArrowRight: () => step(1), ArrowLeft: () => step(-1),
        "+": () => zoomTo(scale * 1.25), "=": () => zoomTo(scale * 1.25), "-": () => zoomTo(scale / 1.25),
        "0": fitWindow, "1": () => zoomTo(1),
      };
      const action = keys[event.key];
      if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session, onClose, step, zoomTo, scale]);

  if (!shown || !image) return null;

  const relative = (event: { clientX: number; clientY: number }) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const onWheel = (event: ReactWheelEvent): void => {
    if (!natural) return;
    zoomTo(scale * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), relative(event));
  };
  const pannable = width > stage.width || height > stage.height;
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (pannable) setOffset(bound(drag.startX + dx, drag.startY + dy));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    // Un clic sin arrastrar alterna entre ajustada y tamaño real, hacia el punto pulsado.
    if (!drag || drag.moved) return;
    if (zoom === null && fit < 1) zoomTo(1, relative(event));
    else fitWindow();
  };

  const saveImage = async (): Promise<void> => {
    setError(null);
    try {
      const parts = image.path ? null : dataParts(image.src);
      const name = image.path ? image.name : `${image.name.replace(/\.[a-z0-9]+$/i, "") || "imagen"}.${parts?.extension ?? "png"}`;
      const target = await save({ defaultPath: name, title: "Guardar imagen" });
      if (!target) return;
      if (image.path) await saveFileCopy(image.path, target);
      else if (parts) await saveFileData(target, parts.data);
    } catch (reason) {
      setError(formatError(reason));
    }
  };
  const run = (action: () => Promise<void>): void => { setError(null); void action().catch(reason => setError(formatError(reason))); };

  const percent = Math.round(scale * 100);
  return createPortal(
    <div ref={surfaceRef} className={`image-viewer${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}
      inert={presence.leaving} aria-hidden={presence.leaving || undefined}
      role={presence.leaving ? undefined : "dialog"} aria-modal="true" aria-label={`Imagen: ${image.name}`}>
      <div className="image-viewer-bar">
        <div className="image-viewer-title">
          <span className="image-viewer-name" title={image.path ?? image.name}>{image.name}</span>
          <span className="image-viewer-meta">
            {shown.images.length > 1 && `${shown.index + 1} de ${shown.images.length} · `}
            {natural ? `${natural.width} × ${natural.height}` : "Cargando…"}
          </span>
        </div>
        <div className="image-viewer-tools">
          <button type="button" className="image-viewer-btn tip" data-tip="Alejar (−)" aria-label="Alejar"
            disabled={!natural} onClick={() => zoomTo(scale / 1.25)}><MinusIcon size={16} /></button>
          <button type="button" className="image-viewer-zoom tip" data-tip={zoom === null ? "Tamaño real (1)" : "Ajustar a la ventana (0)"}
            disabled={!natural} onClick={() => { if (zoom === null) zoomTo(1); else fitWindow(); }}>{percent} %</button>
          <button type="button" className="image-viewer-btn tip" data-tip="Acercar (+)" aria-label="Acercar"
            disabled={!natural} onClick={() => zoomTo(scale * 1.25)}><PlusIcon size={16} /></button>
          <span className="image-viewer-sep" aria-hidden="true" />
          {image.path && <>
            <button type="button" className="image-viewer-btn tip" data-tip="Abrir con la aplicación del sistema" aria-label="Abrir"
              onClick={() => run(() => openFile(image.path!))}><ExternalIcon size={16} /></button>
            <button type="button" className="image-viewer-btn tip" data-tip="Mostrar en la carpeta" aria-label="Mostrar en la carpeta"
              onClick={() => run(() => revealFile(image.path!))}><FolderIcon size={16} /></button>
          </>}
          <button type="button" className="image-viewer-btn tip" data-tip="Guardar como…" aria-label="Guardar como"
            onClick={() => void saveImage()}><DownloadIcon size={16} /></button>
          <button ref={closeRef} type="button" className="image-viewer-btn tip" data-tip="Cerrar (Esc)" aria-label="Cerrar"
            onClick={onClose}><CloseIcon size={17} /></button>
        </div>
      </div>
      <div ref={stageRef} className="image-viewer-stage" onWheel={onWheel}
        onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        <img src={image.src} alt={image.name} draggable={false}
          className={`${natural ? "ready" : ""}${pannable ? " pannable" : fit < 1 ? " zoomable" : ""}`}
          style={natural ? { width, height, transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` } : undefined}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
          onError={() => setError("No se pudo mostrar la imagen.")}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => { dragRef.current = null; }} />
        {shown.images.length > 1 && <>
          <button type="button" className="image-viewer-nav prev" aria-label="Imagen anterior" onClick={() => step(-1)}><ArrowRightIcon size={18} /></button>
          <button type="button" className="image-viewer-nav next" aria-label="Imagen siguiente" onClick={() => step(1)}><ArrowRightIcon size={18} /></button>
        </>}
        {error && <div className="image-viewer-error" role="alert">{error}</div>}
      </div>
    </div>,
    document.body,
  );
}
