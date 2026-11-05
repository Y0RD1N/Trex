/**
 * Archivos que el asistente comparte en el chat.
 *
 * El asistente adjunta un archivo con un enlace Markdown a su ruta local en una
 * línea propia (se lo piden `FILE_SHARING_INSTRUCTIONS`); el chat lo pinta como
 * una tarjeta para verlo, abrirlo o guardarlo. Aquí están las reglas: qué
 * enlace es un archivo local, qué tipo de archivo es y cómo se describe.
 */
import { invoke } from "@tauri-apps/api/core";
import { nodeText, type HastNode } from "./chatMarkdown";

/**
 * Lo que se añade a las instrucciones del asistente para que sepa adjuntar
 * archivos. Una sola línea y sin comillas dobles: viaja como argumento del CLI.
 */
export const FILE_SHARING_INSTRUCTIONS = [
  "You are in trex, a desktop chat app that renders Markdown.",
  "When the user asks for a file or you make one they will want (PDF, image, document, export, asset), attach it:",
  "a Markdown link to its absolute local path on a line of its own, e.g. [CV.pdf](/home/user/cv/CV.pdf);",
  "use angle brackets for paths with spaces: [Report.pdf](</home/u/My Files/Report.pdf>).",
  "trex shows it as a card to preview, open or save. Attach only useful files.",
].join(" ");

export type FileInfo = { path: string; name: string; exists: boolean; isDir: boolean; size: number };
export type FileKind = "image" | "pdf" | "document" | "sheet" | "slides" | "code" | "archive" | "audio" | "video" | "text" | "other";

const KINDS: [FileKind, RegExp][] = [
  ["image", /\.(png|jpe?g|gif|webp)$/i],
  ["pdf", /\.pdf$/i],
  ["document", /\.(docx?|odt|rtf|pages)$/i],
  ["sheet", /\.(xlsx?|ods|csv|tsv|numbers)$/i],
  ["slides", /\.(pptx?|odp|key)$/i],
  ["archive", /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i],
  ["audio", /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i],
  ["video", /\.(mp4|mkv|webm|mov|avi)$/i],
  ["text", /\.(txt|md|markdown|log|rst)$/i],
  ["code", /\.(tsx?|jsx?|mjs|cjs|json|py|rs|go|java|kt|swift|rb|php|c|h|cpp|hpp|cs|css|scss|html?|xml|svg|ya?ml|toml|ini|sh|bash|zsh|ps1|sql|lua)$/i],
];

/** Tipo de archivo según la extensión (para el icono y la vista previa). */
export function fileKind(name: string): FileKind {
  return KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

export const KIND_LABELS: Record<FileKind, string> = {
  image: "Imagen", pdf: "PDF", document: "Documento", sheet: "Hoja de cálculo", slides: "Presentación", code: "Código",
  archive: "Archivo comprimido", audio: "Audio", video: "Vídeo", text: "Texto", other: "Archivo",
};

/** Formatos que se reconocen mejor por su nombre que por su tipo. */
const FORMAT_LABELS: Record<string, string> = {
  md: "Markdown", markdown: "Markdown", html: "Página web", htm: "Página web", svg: "Imagen SVG", json: "JSON", log: "Registro",
};

/** Cómo se describe un archivo en su tarjeta y en el visor: «Markdown», «PDF», «Hoja de cálculo»… */
export function fileKindLabel(name: string): string {
  return FORMAT_LABELS[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? KIND_LABELS[fileKind(name)];
}

/** Tamaño legible: «830 B», «12 KB», «3,4 MB». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1).replace(".", ",").replace(",0", "") : Math.round(value)} ${units[unit]}`;
}

const isWindowsPath = (value: string): boolean => /^[a-z]:[\\/]/i.test(value);
/** Ruta de red de Windows (`\\servidor\carpeta`). */
const isUncPath = (value: string): boolean => /^\\\\[^\\/]/.test(value);

/**
 * Si react-markdown debe conservar el destino de un enlace: además de las webs,
 * los archivos locales. Llega ya codificado (`\` → `%5C`, espacio → `%20`), así
 * que `C:\Users` aparece como `C:%5CUsers`.
 */
export const isLocalFileHref = (url: string): boolean => /^(?:file:|[a-z]:(?:[\\/]|%5c)|(?:\\|%5c){2}[^\\/%])/i.test(url);

/**
 * Ruta local a la que apunta un enlace, o null si es una web, un ancla u otra
 * cosa. Admite `file://`, rutas absolutas (también de Windows y de red), `~/` y
 * rutas relativas al proyecto; quita las referencias a líneas (`:12`, `:12:3`, `#L12`).
 */
export function localFilePath(href: string | undefined | null, cwd: string): string | null {
  if (!href) return null;
  let value = href.trim();
  if (!value || value.startsWith("#")) return null;
  // Se decodifica una vez y antes de mirar qué es: `C:%5CUsers` es `C:\Users`.
  try { value = decodeURIComponent(value); } catch { /* se usa tal cual */ }
  if (/^file:/i.test(value)) {
    const host = /^file:\/\/([^/]+)(\/.*)?$/i.exec(value);
    if (host && host[1].toLowerCase() !== "localhost") value = `\\\\${host[1]}${(host[2] ?? "").replace(/\//g, "\\")}`;
    else value = value.replace(/^file:(\/\/[^/]*)?/i, "");
    if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsPath(value)) {
    return null;
  }
  value = value.replace(/#L\d+(-L?\d+)?$/i, "").replace(/(\.[a-z0-9]+):\d+(:\d+)?$/i, "$1");
  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("~/") || isWindowsPath(value) || isUncPath(value)) return value;
  if (!cwd) return null;
  const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const parts = [...cwd.replace(/[\\/]+$/, "").split(/[\\/]/), ...value.split(/[\\/]/)];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") { if (resolved.length > 1) resolved.pop(); }
    else if (part !== "." && (part !== "" || resolved.length === 0)) resolved.push(part);
  }
  return resolved.join(separator) || null;
}

export type Attachment = { path: string; label: string };

/**
 * Adjuntos de un párrafo o una lista que solo contiene enlaces (o imágenes) a
 * archivos locales; null si hay algo más. Un enlace dentro de una frase es
 * una referencia y se queda en el texto.
 */
export function attachmentsOf(node: HastNode | undefined, cwd: string): Attachment[] | null {
  const found: Attachment[] = [];
  const visit = (child: HastNode): boolean => {
    if (child.type === "text") return !(child.value ?? "").trim() || /^[\s,;·•–—-]*$/.test(child.value ?? "");
    if (child.type !== "element") return true;
    if (child.tagName === "br") return true;
    if (child.tagName === "a" || child.tagName === "img") {
      const target = child.tagName === "a" ? child.properties?.href : child.properties?.src;
      const path = localFilePath(typeof target === "string" ? target : null, cwd);
      if (!path) return false;
      const label = child.tagName === "a" ? nodeText(child).trim() : String(child.properties?.alt ?? "").trim();
      found.push({ path, label: label && label !== path && !label.includes("/") ? label : baseName(path) });
      return true;
    }
    // Listas de adjuntos: cada elemento (o su párrafo) solo tiene enlaces.
    if (["li", "p", "ul", "ol"].includes(child.tagName ?? "")) return (child.children ?? []).every(visit);
    return false;
  };
  if (!node?.children?.length || !node.children.every(visit) || !found.length) return null;
  const seen = new Set<string>();
  return found.filter(item => !seen.has(item.path) && seen.add(item.path));
}

// --- Rutas de Windows en el Markdown ---------------------------------------------

type MdNode = {
  type: string; url?: string; value?: string; alt?: string | null; children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Destino de `[..](destino)` o `[..](<destino>)`, con título opcional, al final del texto original de un enlace. */
const RAW_DESTINATION = /\]\(\s*(?:<([^<>\n]*)>|([^\s<>]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)$/;
const RAW_WINDOWS = /^(?:[a-z]:\\|\\\\[^\\])/i;
/** Una línea que solo es un enlace a un archivo local, lo reconozca Markdown o no. */
const ATTACHMENT_LINE = /^(!?)\[([^\]\n]+)\]\(\s*<?((?:[a-z]:[\\/]|\\\\|~\/|\/|file:)[^\n]*?)>?\s*\)$/i;
/**
 * Enlace a una ruta de Windows con espacios y sin `<…>` dentro de una frase,
 * que Markdown deja como texto. La ruta termina en una extensión (y quizá una
 * línea), así que `captura (1).png` no se corta en el primer paréntesis.
 */
const INLINE_WINDOWS_LINK = /(!?)\[([^\]\n]+)\]\(\s*<?((?:[a-z]:[\\/]|\\\\)[^\n]*?\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?)>?\s*\)/gi;
const unescapeMarkdown = (text: string): string => text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const linkNode = (image: boolean, url: string, label: string): MdNode =>
  image ? { type: "image", url, alt: label } : { type: "link", url, children: [{ type: "text", value: label }] };

/**
 * Plugin de remark: conserva las rutas de archivo tal como las escribió el
 * asistente.
 *
 * En Markdown `\` escapa la puntuación, así que `C:\proyecto\.github\a.md`
 * llegaría como `C:\proyecto.github\a.md`; aquí el destino se vuelve a leer
 * del texto original. Y una línea con `[Informe.pdf](C:\Mis archivos\Informe.pdf)`
 * (espacios sin `<…>`) no es un enlace para Markdown, pero sí un adjunto: se
 * convierte en enlace para que el chat lo pinte como tarjeta.
 */
export function remarkLocalPaths() {
  return (tree: unknown, file?: { value?: unknown }): void => {
    const source = typeof file?.value === "string" ? file.value : "";
    if (!source) return;
    const raw = (node: MdNode): string | null => {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : null;
    };
    /** Párrafo cuyas líneas son, todas, enlaces a archivos locales: se rehace desde el texto original. */
    const attachmentParagraph = (paragraph: MdNode): MdNode[] | null => {
      const text = raw(paragraph);
      if (!text) return null;
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const links: MdNode[] = [];
      for (const line of lines) {
        const match = ATTACHMENT_LINE.exec(line);
        if (!match) return null;
        const url = match[3].replace(/\s+"[^"]*"$/, "").trim();
        const label = unescapeMarkdown(match[2].trim().replace(/^(\*\*|__|\*|_|`)(.+)\1$/, "$2"));
        links.push(linkNode(!!match[1], url, label));
      }
      return links.length ? links.flatMap((link, index) => index ? [{ type: "text", value: "\n" }, link] : [link]) : null;
    };
    /** Texto con enlaces a rutas de Windows que Markdown no reconoció: se parte en texto y enlaces. */
    const inlineLinks = (node: MdNode): MdNode[] | null => {
      const text = raw(node);
      if (!text?.includes("](")) return null;
      const parts: MdNode[] = [];
      let last = 0;
      for (const match of text.matchAll(INLINE_WINDOWS_LINK)) {
        const index = match.index ?? 0;
        if (index > last) parts.push({ type: "text", value: unescapeMarkdown(text.slice(last, index)) });
        parts.push(linkNode(!!match[1], match[3].trim(), unescapeMarkdown(match[2].trim())));
        last = index + match[0].length;
      }
      if (!parts.length) return null;
      if (last < text.length) parts.push({ type: "text", value: unescapeMarkdown(text.slice(last)) });
      return parts;
    };
    const visit = (node: MdNode): void => {
      if (node.type === "paragraph") {
        const rebuilt = attachmentParagraph(node);
        if (rebuilt) { node.children = rebuilt; return; }
      }
      if (node.type === "link" || node.type === "image") {
        const match = RAW_DESTINATION.exec(raw(node) ?? "");
        const destination = match?.[1] ?? match?.[2];
        if (destination && RAW_WINDOWS.test(destination)) node.url = destination;
        return;
      }
      if (node.children?.some(child => child.type === "text")) {
        node.children = node.children.flatMap(child => child.type === "text" ? inlineLinks(child) ?? [child] : [child]);
      }
      node.children?.forEach(visit);
    };
    visit(tree as MdNode);
  };
}

/** Nombre del archivo de una ruta. */
export const baseName = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/**
 * Carpeta del archivo, relativa al proyecto si está dentro y con `~` para la
 * carpeta personal (la más concreta de las dos). En Windows no distingue mayúsculas.
 */
export function folderLabel(path: string, cwd: string, home = ""): string {
  const folder = path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";
  const windows = isWindowsPath(folder) || isUncPath(folder);
  const fold = (value: string): string => windows ? value.toLowerCase() : value;
  /** Lo que queda de `folder` dentro de `base` ("" si es la misma), o null si está fuera. */
  const inside = (base: string): string | null => {
    const root = base.replace(/[\\/]+$/, "");
    if (!root) return null;
    if (fold(folder) === fold(root)) return "";
    const head = fold(folder.slice(0, root.length + 1));
    return head === `${fold(root)}/` || head === `${fold(root)}\\` ? folder.slice(root.length + 1) : null;
  };
  const project = inside(cwd), personal = inside(home);
  const root = cwd.replace(/[\\/]+$/, "");
  const userHome = home.replace(/[\\/]+$/, "");
  if (project !== null && (personal === null || root.length >= userHome.length)) return project || baseName(root);
  if (personal !== null) return `~${personal ? `${folder.includes("\\") ? "\\" : "/"}${personal}` : ""}`;
  return folder;
}

// --- Backend --------------------------------------------------------------------

const infoCache = new Map<string, Promise<FileInfo>>();

/** Datos del archivo; se guardan para no repetir la consulta mientras el texto sigue llegando. */
export function fileInfo(path: string): Promise<FileInfo> {
  let pending = infoCache.get(path);
  if (!pending) {
    pending = invoke<FileInfo[]>("file_info", { paths: [path] }).then(list => list[0]);
    // Un archivo que no estaba puede aparecer después (el asistente lo crea luego).
    pending.then(info => { if (!info?.exists) infoCache.delete(path); }, () => infoCache.delete(path));
    infoCache.set(path, pending);
  }
  return pending;
}

/** Datos actuales, sin la caché: el visor quiere el tamaño de ahora (el asistente pudo reescribirlo). */
export const fileInfoNow = (path: string): Promise<FileInfo | undefined> =>
  invoke<FileInfo[]>("file_info", { paths: [path] }).then(list => list[0]);

export const openFile = (path: string): Promise<void> => invoke("open_file", { path });
export const revealFile = (path: string): Promise<void> => invoke("reveal_file", { path });
export const saveFileCopy = (from: string, to: string): Promise<void> => invoke("save_file_copy", { from, to });
export const saveFileData = (to: string, data: string): Promise<void> => invoke("save_file_data", { to, data });
