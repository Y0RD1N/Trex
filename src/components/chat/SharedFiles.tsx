/**
 * Archivos que el asistente comparte en sus respuestas.
 *
 * Un enlace a un archivo local en una línea propia es un adjunto: una tarjeta
 * con su tipo, tamaño y carpeta, y botones para abrirlo, mostrarlo en su
 * carpeta o guardarlo donde se quiera. Al pulsarla, los documentos, el código,
 * las tablas y los PDF se leen en el visor de la app (`FileViewer`) y las
 * imágenes se amplían en el de imágenes; el resto se abre con el sistema. Un
 * enlace dentro de una frase es una referencia: queda en el texto y se abre igual.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { formatError, getAppInfo } from "../../api";
import { readImageFile } from "../../chatImages";
import { previewKind } from "../../filePreview";
import {
  baseName, fileInfo, fileKind, fileKindLabel, folderLabel, formatBytes, openFile, revealFile, saveFileCopy,
  type Attachment, type FileInfo,
} from "../../sharedFiles";
import { useFileViewer } from "../FileViewer";
import { useImageViewer, type ViewerImage } from "../ImageViewer";
import { CheckIcon, DownloadIcon, ExternalIcon, FileIcon, FolderIcon } from "../Icons";

/** Carpeta del proyecto (para las rutas relativas) y si la respuesta aún está llegando. */
export const SharedFilesContext = createContext<{ cwd: string; streaming: boolean }>({ cwd: "", streaming: false });

let homeDir: Promise<string> | null = null;
const home = (): Promise<string> => homeDir ??= getAppInfo().then(info => info.homeDir).catch(() => "");

/** Carpeta personal del usuario (vacía mientras llega), para describir dónde está un archivo. */
export function useHome(): string {
  const [value, setValue] = useState("");
  useEffect(() => { void home().then(setValue); }, []);
  return value;
}

function useFileInfo(path: string): FileInfo | null {
  const [info, setInfo] = useState<FileInfo | null>(null);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    void fileInfo(path).then(result => { if (alive) setInfo(result ?? null); }).catch(() => undefined);
    return () => { alive = false; };
  }, [path]);
  return info;
}

/** Imágenes ya leídas, para no repetir la lectura al volver a pintar el hilo. */
const imageCache = new Map<string, Promise<string>>();
const IMAGE_CACHE_SIZE = 40;

function loadImage(path: string): Promise<string> {
  let pending = imageCache.get(path);
  if (!pending) {
    pending = readImageFile(path).then(image => `data:${image.mediaType};base64,${image.data}`);
    pending.catch(() => imageCache.delete(path));
    imageCache.set(path, pending);
    if (imageCache.size > IMAGE_CACHE_SIZE) imageCache.delete(imageCache.keys().next().value!);
  }
  return pending;
}

function useImage(path: string, enabled: boolean): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadImage(path).then(src => { if (alive) setState({ src, failed: false }); },
      () => { if (alive) setState({ src: null, failed: true }); });
    return () => { alive = false; };
  }, [path, enabled]);
  return state;
}

const extension = (name: string): string => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? "";

/** Icono del archivo: su extensión sobre el color de su tipo. */
export function FileBadge({ name, dir }: { name: string; dir: boolean }) {
  const kind = dir ? "folder" : fileKind(name);
  const ext = extension(name);
  return <span className="chat-file-badge" data-kind={kind} aria-hidden="true">
    {dir ? <FolderIcon size={17} /> : ext && ext.length <= 4 ? ext : <FileIcon size={17} />}
  </span>;
}

/** Botones de la tarjeta: abrir, mostrar en la carpeta y guardar como. */
function FileActions({ path, name, dir, onError }: { path: string; name: string; dir: boolean; onError: (message: string | null) => void }) {
  const [saved, setSaved] = useState(false);
  const run = (action: () => Promise<void>): void => {
    onError(null);
    void action().catch(error => onError(formatError(error)));
  };
  return <span className="chat-file-actions">
    <button type="button" className="chat-file-btn tip" data-tip={dir ? "Abrir la carpeta" : "Abrir con la aplicación del sistema"}
      aria-label={`Abrir ${name}`} onClick={event => { event.stopPropagation(); run(() => openFile(path)); }}><ExternalIcon size={15} /></button>
    <button type="button" className="chat-file-btn tip" data-tip="Mostrar en la carpeta" aria-label={`Mostrar ${name} en la carpeta`}
      onClick={event => { event.stopPropagation(); run(() => revealFile(path)); }}><FolderIcon size={15} /></button>
    {!dir && <button type="button" className="chat-file-btn tip" data-tip={saved ? "Guardado" : "Guardar como…"} aria-label={`Guardar ${name} como`}
      onClick={event => {
        event.stopPropagation();
        run(async () => {
          const target = await save({ defaultPath: name, title: `Guardar ${name}` });
          if (!target) return;
          await saveFileCopy(path, target);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1600);
        });
      }}>{saved ? <CheckIcon size={15} /> : <DownloadIcon size={15} />}</button>}
  </span>;
}

function FileCard({ item, gallery }: { item: Attachment; gallery: Attachment[] }) {
  const { cwd, streaming } = useContext(SharedFilesContext);
  const homePath = useHome();
  const info = useFileInfo(item.path);
  const viewer = useImageViewer();
  const files = useFileViewer();
  const [error, setError] = useState<string | null>(null);
  const name = item.label || baseName(item.path);
  const dir = !!info?.isDir;
  const isImage = !dir && fileKind(item.path) === "image";
  const readable = !dir && !!files && previewKind(item.path) !== null;
  const image = useImage(item.path, isImage && !!info?.exists);
  const missing = info !== null && !info.exists;
  const pending = info === null || (missing && streaming);

  const show = (): void => {
    if (!info?.exists) return;
    if (isImage && image.src) {
      // Las imágenes del mismo grupo se recorren con las flechas del visor.
      const images = gallery.filter(entry => fileKind(entry.path) === "image");
      const items: ViewerImage[] = images.map(entry => ({ src: entry.path === item.path ? image.src! : "", name: entry.label || baseName(entry.path), path: entry.path }));
      void Promise.all(items.map((entry, index) => entry.src ? entry.src : loadImage(images[index].path).catch(() => "")))
        .then(sources => {
          const ready = items.map((entry, index) => ({ ...entry, src: sources[index] })).filter(entry => entry.src);
          viewer.open(ready, Math.max(0, ready.findIndex(entry => entry.path === item.path)));
        });
      return;
    }
    setError(null);
    if (readable && files) files.open({ path: item.path, name, cwd });
    else void openFile(item.path).catch(reason => setError(formatError(reason)));
  };

  const details = missing && !pending ? "No se encuentra el archivo"
    : [dir ? "Carpeta" : fileKindLabel(item.path), info && !dir && info.exists ? formatBytes(info.size) : "",
      folderLabel(item.path, cwd, homePath)].filter(Boolean).join(" · ");

  return <div className={`chat-file${isImage ? " image" : ""}${missing && !pending ? " missing" : ""}${pending ? " pending" : ""}`}
    title={item.path}>
    {isImage && !missing && <button type="button" className="chat-file-preview" aria-label={`Ver ${name}`} onClick={show} disabled={!image.src}>
      {image.src ? <img src={image.src} alt={name} /> : <span className="chat-file-preview-empty">{image.failed ? "Sin vista previa" : ""}</span>}
    </button>}
    <div className="chat-file-row">
      <button type="button" className="chat-file-main" onClick={show} disabled={!info?.exists}
        aria-label={isImage || readable ? `Ver ${name}` : `Abrir ${name}`}>
        {!isImage && <FileBadge name={item.path} dir={dir} />}
        <span className="chat-file-text">
          <span className="chat-file-name">{name}</span>
          <span className="chat-file-detail">{error ?? details}</span>
        </span>
      </button>
      {info?.exists && <FileActions path={item.path} name={baseName(item.path)} dir={dir} onError={setError} />}
    </div>
  </div>;
}

/** Adjuntos de una respuesta: una tarjeta por archivo. */
export function FileCards({ items }: { items: Attachment[] }) {
  return <div className="chat-files">{items.map(item => <FileCard key={item.path} item={item} gallery={items} />)}</div>;
}

/** Enlace a un archivo dentro de una frase: se abre (o se ve, si es una imagen) al pulsarlo. */
export function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const viewer = useImageViewer();
  const files = useFileViewer();
  const { cwd } = useContext(SharedFilesContext);
  const [failed, setFailed] = useState(false);
  const open = (): void => {
    setFailed(false);
    if (fileKind(path) === "image") {
      void loadImage(path).then(src => viewer.open([{ src, name: baseName(path), path }]))
        .catch(() => openFile(path).catch(() => setFailed(true)));
    } else if (files && previewKind(path)) {
      // Una carpeta o un archivo que ya no está no tienen vista previa: se intenta con el sistema.
      void fileInfo(path).then(info => {
        if (info?.exists && !info.isDir) files.open({ path, name: baseName(path), cwd });
        else return openFile(path);
      }).catch(() => setFailed(true));
    } else void openFile(path).catch(() => setFailed(true));
  };
  return <a href={path} className={`chat-file-link${failed ? " failed" : ""}`} title={failed ? `No se pudo abrir ${path}` : path}
    onClick={event => { event.preventDefault(); open(); }}>
    <FileIcon size={13} />{children}
  </a>;
}
