/**
 * Visor de un archivo compartido: una lámina sobre la app con el documento.
 *
 * Markdown se lee como en el chat, el código lleva números de línea y colores,
 * un CSV se ve como tabla, el HTML y el SVG se pintan aislados (sin scripts ni
 * red) y el PDF usa el visor del navegador. Los que tienen dos vistas pasan de
 * «Vista» a «Código». Arriba, como en las tarjetas: abrir con el sistema,
 * mostrar en la carpeta y guardar una copia.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { formatError, writeClipboard } from "../api";
import { usePresence } from "../hooks/usePresence";
import { fileInfoNow, fileKindLabel, folderLabel, formatBytes, openFile, revealFile, saveFileCopy } from "../sharedFiles";
import {
  HIGHLIGHT_CHARS, MARKDOWN_RENDER_CHARS, PDF_PREVIEW_BYTES, TEXT_PREVIEW_BYTES, decodePreview, hasSourceView, isolatedHtml,
  numericColumns, parseDelimited, previewKind, previewLanguage, readPreview, tableDelimiter, type PreviewKind,
} from "../filePreview";
import Markdown, { useHighlightedCode } from "./chat/Markdown";
import { FileBadge, SharedFilesContext, useHome } from "./chat/SharedFiles";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, DownloadIcon, ExternalIcon, FolderIcon } from "./Icons";
import type { FileViewerSession } from "./FileViewer";
import "./FileViewer.css";
import { formatNumber } from "../intl";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "unsupported"; message: string; size: number }
  | { status: "ready"; kind: PreviewKind; text: string; url: string | null; size: number; read: number };

type Mode = "view" | "source";

const folderOf = (path: string): string => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");

/** Lee el archivo según su tipo; la URL de un PDF o un SVG se libera al cerrar. */
function usePreview(path: string | null): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    if (!path) return;
    let alive = true, url: string | null = null;
    setLoaded({ status: "loading" });
    const kind = previewKind(path) ?? "text";
    const load = async (): Promise<Loaded> => {
      const info = await fileInfoNow(path);
      if (!info?.exists) return { status: "error", message: "El archivo ya no existe." };
      if (info.isDir) return { status: "error", message: "Es una carpeta: ábrela con el explorador." };
      if (kind === "pdf" && info.size > PDF_PREVIEW_BYTES) {
        return { status: "unsupported", size: info.size, message: `El PDF pesa ${formatBytes(info.size)}: es demasiado grande para verlo aquí.` };
      }
      const bytes = await readPreview(path, kind === "pdf" ? PDF_PREVIEW_BYTES : TEXT_PREVIEW_BYTES);
      if (kind === "pdf") {
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        return { status: "ready", kind, text: "", url, size: info.size, read: bytes.length };
      }
      const decoded = decodePreview(bytes);
      if (decoded.binary) return { status: "unsupported", size: info.size, message: "No es un archivo de texto: ábrelo con la aplicación del sistema." };
      if (kind === "svg" && bytes.length >= info.size) url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/svg+xml" }));
      return { status: "ready", kind, text: decoded.text, url, size: info.size, read: bytes.length };
    };
    load().then(result => {
      if (alive) setLoaded(result);
      else if (url) URL.revokeObjectURL(url);
    }, error => { if (alive) setLoaded({ status: "error", message: formatError(error) }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return path ? loaded : { status: "loading" };
}

/** Código con números de línea; el texto plano se ajusta a la ventana. */
function CodeView({ text, language, wrap }: { text: string; language: string | null; wrap?: boolean }) {
  const body = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, ""), [text]);
  const highlighted = useHighlightedCode(!wrap && body.length <= HIGHLIGHT_CHARS ? language : null, body);
  const numbers = useMemo(() => {
    if (wrap) return "";
    let lines = 1;
    for (let index = body.indexOf("\n"); index !== -1; index = body.indexOf("\n", index + 1)) lines++;
    return Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  }, [body, wrap]);
  if (wrap) return <pre className="file-viewer-text">{body}</pre>;
  return <div className="file-viewer-code">
    <pre className="file-viewer-gutter" aria-hidden="true">{numbers}</pre>
    <pre className="file-viewer-source"><code className="hljs">{highlighted ?? body}</code></pre>
  </div>;
}

function TableView({ text, path }: { text: string; path: string }) {
  const { rows, total } = useMemo(() => parseDelimited(text, tableDelimiter(path, text)), [text, path]);
  const [head = [], ...body] = rows;
  const columns = useMemo(() => rows.reduce((most, row) => Math.max(most, row.length), 0), [rows]);
  // Las columnas de cifras se alinean a la derecha, como en una hoja de cálculo.
  const numeric = useMemo(() => numericColumns(rows.slice(1), columns), [rows, columns]);
  const cells = (row: string[]): string[] => row.length < columns ? [...row, ...Array<string>(columns - row.length).fill("")] : row;
  if (!rows.length) return <div className="file-viewer-state">La tabla está vacía.</div>;
  return <div className="file-viewer-table-wrap">
    <table className="file-viewer-table">
      <thead><tr><th className="num" aria-label="Fila" />{cells(head).map((cell, index) => <th key={index} className={numeric[index] ? "n" : undefined}>{cell}</th>)}</tr></thead>
      <tbody>{body.map((row, index) => <tr key={index}><td className="num">{index + 1}</td>
        {cells(row).map((cell, column) => <td key={column} className={numeric[column] ? "n" : undefined}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {total > rows.length && <p className="file-viewer-foot">Se muestran {formatNumber(rows.length - 1)} de {formatNumber(total - 1)} filas.</p>}
  </div>;
}

function Body({ loaded, mode, path, name }: { loaded: Loaded; mode: Mode; path: string; name: string }) {
  const filesContext = useMemo(() => ({ cwd: folderOf(path), streaming: false }), [path]);
  if (loaded.status === "loading") return <div className="file-viewer-state"><span className="file-viewer-spinner" aria-hidden="true" />Cargando…</div>;
  if (loaded.status !== "ready") {
    return <div className="file-viewer-state">
      <AlertIcon size={18} />
      <p>{loaded.message}</p>
      {loaded.status === "unsupported" && <button type="button" className="btn" onClick={() => void openFile(path).catch(() => undefined)}>
        <ExternalIcon size={14} />Abrir con la aplicación del sistema
      </button>}
    </div>;
  }
  const { kind, text, url } = loaded;
  if (kind === "pdf" && url) return <iframe className="file-viewer-frame pdf" src={url} title={name} />;
  if (mode === "source" || kind === "code" || kind === "text") {
    return <CodeView text={text} language={kind === "text" ? null : previewLanguage(path)} wrap={kind === "text"} />;
  }
  if (kind === "markdown") {
    return <article className="file-viewer-doc">
      <SharedFilesContext.Provider value={filesContext}><Markdown text={text} /></SharedFilesContext.Provider>
    </article>;
  }
  if (kind === "table") return <TableView text={text} path={path} />;
  if (kind === "html") return <iframe className="file-viewer-frame html" sandbox="" srcDoc={isolatedHtml(text)} title={name} />;
  if (kind === "svg" && url) return <div className="file-viewer-picture"><img src={url} alt={name} /></div>;
  return <CodeView text={text} language={previewLanguage(path)} />;
}

const VIEW_LABELS: Partial<Record<PreviewKind, string>> = { markdown: "Lectura", table: "Tabla", html: "Página", svg: "Imagen" };

export default function FileViewerDialog({ session, onClose }: { session: FileViewerSession | null; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(session, 180, surfaceRef);
  const shown = presence.value;
  const loaded = usePreview(shown?.path ?? null);
  const home = useHome();
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"copied" | "saved" | null>(null);

  // Archivo nuevo: vista interpretada, salvo un Markdown enorme, que empieza en su texto.
  useLayoutEffect(() => { setMode("view"); setError(null); setNotice(null); }, [shown?.path]);
  useEffect(() => {
    if (loaded.status === "ready" && loaded.kind === "markdown" && loaded.text.length > MARKDOWN_RENDER_CHARS) setMode("source");
  }, [loaded]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Foco: entra en el documento (para desplazarlo con el teclado) y vuelve a quien lo abrió.
  useEffect(() => {
    if (!session) return;
    bodyRef.current?.focus({ preventScroll: true });
    const opener = session.opener;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [session?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;
  const { path, name } = shown;
  const kind = loaded.status === "ready" ? loaded.kind : previewKind(path);
  const size = loaded.status === "ready" || loaded.status === "unsupported" ? loaded.size : null;
  const meta = [fileKindLabel(path), size !== null ? formatBytes(size) : "", folderLabel(path, shown.cwd, home)].filter(Boolean).join(" · ");
  const truncated = loaded.status === "ready" && loaded.read < loaded.size;
  const text = loaded.status === "ready" && kind !== "pdf" ? loaded.text : "";

  const run = (action: () => Promise<void>): void => { setError(null); void action().catch(reason => setError(formatError(reason))); };
  const saveCopy = (): void => run(async () => {
    const target = await save({ defaultPath: name, title: `Guardar ${name}` });
    if (!target) return;
    await saveFileCopy(path, target);
    setNotice("saved");
  });
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return createPortal(
    <div ref={surfaceRef} className={`file-viewer${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}
      inert={presence.leaving} aria-hidden={presence.leaving || undefined} onKeyDown={onKeyDown}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="file-viewer-sheet" role={presence.leaving ? undefined : "dialog"} aria-modal="true" aria-label={`Archivo: ${name}`}>
        <header className="file-viewer-bar">
          <FileBadge name={path} dir={false} />
          <div className="file-viewer-title">
            <span className="file-viewer-name" title={path}>{name}</span>
            <span className={`file-viewer-meta${error ? " error" : ""}`} title={error ?? path}>{error ?? meta}</span>
          </div>
          {kind && hasSourceView(kind) && loaded.status === "ready" && <div className="file-viewer-modes" role="group" aria-label="Vista del archivo">
            <button type="button" aria-pressed={mode === "view"} onClick={() => setMode("view")}>{VIEW_LABELS[kind] ?? "Vista"}</button>
            <button type="button" aria-pressed={mode === "source"} onClick={() => setMode("source")}>Código</button>
          </div>}
          <div className="file-viewer-tools">
            {!!text && <button type="button" className="file-viewer-btn tip" data-tip={notice === "copied" ? "Copiado" : truncated ? "Copiar lo que se ve" : "Copiar el contenido"}
              aria-label="Copiar el contenido" onClick={() => run(async () => { await writeClipboard(text); setNotice("copied"); })}>
              {notice === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>}
            <button type="button" className="file-viewer-btn tip" data-tip="Abrir con la aplicación del sistema" aria-label={`Abrir ${name} con la aplicación del sistema`}
              onClick={() => run(() => openFile(path))}><ExternalIcon size={16} /></button>
            <button type="button" className="file-viewer-btn tip" data-tip="Mostrar en la carpeta" aria-label={`Mostrar ${name} en la carpeta`}
              onClick={() => run(() => revealFile(path))}><FolderIcon size={16} /></button>
            <button type="button" className="file-viewer-btn tip" data-tip={notice === "saved" ? "Guardado" : "Guardar como…"} aria-label={`Guardar ${name} como`}
              onClick={saveCopy}>{notice === "saved" ? <CheckIcon size={16} /> : <DownloadIcon size={16} />}</button>
            <span className="file-viewer-sep" aria-hidden="true" />
          </div>
          <button type="button" className="file-viewer-btn file-viewer-close tip" data-tip="Cerrar (Esc)" aria-label="Cerrar" onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </header>
        {truncated && loaded.status === "ready" && <div className="file-viewer-note" role="note">
          <span>Vista previa de los primeros {formatBytes(loaded.read)} de {formatBytes(loaded.size)}.</span>
          <button type="button" onClick={() => run(() => openFile(path))}>Abrir completo</button>
        </div>}
        <div ref={bodyRef} className="file-viewer-body" data-kind={kind ?? "text"} data-mode={mode} tabIndex={0}>
          <Body loaded={loaded} mode={mode} path={path} name={name} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
