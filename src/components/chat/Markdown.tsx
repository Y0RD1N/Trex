/**
 * Markdown de las respuestas del asistente (Claude Code y Codex).
 *
 * react-markdown genera elementos de React (nunca HTML crudo), así que el
 * texto del modelo no puede inyectar scripts en la ventana de la app. Los
 * enlaces se abren en el navegador del sistema y las imágenes remotas no se
 * cargan: se muestran como enlace. Los enlaces a archivos locales son archivos
 * compartidos (ver `SharedFiles`). Los bloques de código llevan colores de
 * sintaxis y los avisos `> [!NOTE]` (como en GitHub) se pintan destacados.
 *
 * Rendimiento: interpretar Markdown cuesta más cuanto más largo es el texto.
 * El texto se parte en bloques (`markdownBlocks`) memorizados: mientras una
 * respuesta llega solo se vuelve a interpretar el último. Los colores se
 * calculan por bloque de código y se memorizan, con un resaltador que se carga
 * aparte y se crea una sola vez (`chatHighlight`).
 */
import { createElement, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeLanguage, markdownBlocks, nodeText, rehypeCallouts, type HastNode } from "../../chatMarkdown";
import { attachmentsOf, localFilePath } from "../../sharedFiles";
import { FileCards, FileLink, SharedFilesContext } from "./SharedFiles";
import { AlertIcon, CheckIcon, CopyIcon, InfoIcon, SparkIcon } from "../Icons";
import { writeClipboard } from "../../api";

const safeUrl = (href: string | undefined): string | null =>
  href && /^(https?:|mailto:)/i.test(href) ? href : null;

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hint = status === "copied" ? "Copiado" : status === "error" ? "No se pudo copiar" : label;
  return <button type="button" className={`chat-copy tip${status === "copied" ? " copied" : ""}`} aria-label={hint} data-tip={hint} disabled={!text}
    onClick={() => {
      void writeClipboard(text).then(() => setStatus("copied"), () => setStatus("error")).finally(() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setStatus("idle"), 1600);
      });
    }}>
    {status === "copied" ? <CheckIcon size={14} /> : status === "error" ? <AlertIcon size={14} /> : <CopyIcon size={14} />}
  </button>;
}

// --- Bloques de código -----------------------------------------------------

/** Nombre legible y color (el de GitHub) de cada lenguaje. */
const LANGUAGES: Record<string, [name: string, color: string]> = {
  ts: ["TypeScript", "#3178c6"], typescript: ["TypeScript", "#3178c6"], tsx: ["TSX", "#3178c6"],
  js: ["JavaScript", "#f1e05a"], javascript: ["JavaScript", "#f1e05a"], jsx: ["JSX", "#f1e05a"], mjs: ["JavaScript", "#f1e05a"],
  json: ["JSON", "#cbcb41"], jsonc: ["JSON", "#cbcb41"],
  sh: ["Shell", "#89e051"], bash: ["Bash", "#89e051"], zsh: ["Zsh", "#89e051"], shell: ["Shell", "#89e051"], console: ["Terminal", "#89e051"],
  ps1: ["PowerShell", "#5391fe"], powershell: ["PowerShell", "#5391fe"],
  py: ["Python", "#3572a5"], python: ["Python", "#3572a5"], rs: ["Rust", "#dea584"], rust: ["Rust", "#dea584"],
  go: ["Go", "#00add8"], java: ["Java", "#b07219"], kt: ["Kotlin", "#a97bff"], kotlin: ["Kotlin", "#a97bff"],
  swift: ["Swift", "#f05138"], rb: ["Ruby", "#cc342d"], ruby: ["Ruby", "#cc342d"], php: ["PHP", "#4f5d95"],
  c: ["C", "#a8b9cc"], cpp: ["C++", "#f34b7d"], cs: ["C#", "#178600"], csharp: ["C#", "#178600"],
  css: ["CSS", "#663399"], scss: ["SCSS", "#c6538c"], html: ["HTML", "#e34c26"], xml: ["XML", "#0060ac"], svg: ["SVG", "#ff9a00"],
  sql: ["SQL", "#e38c00"], yaml: ["YAML", "#cb171e"], yml: ["YAML", "#cb171e"], toml: ["TOML", "#9c4221"], ini: ["INI", "#d1dbe0"],
  md: ["Markdown", "#519aba"], markdown: ["Markdown", "#519aba"], diff: ["Diff", "#88dddd"],
  dockerfile: ["Dockerfile", "#2496ed"], docker: ["Dockerfile", "#2496ed"], graphql: ["GraphQL", "#e10098"], lua: ["Lua", "#6b8cff"],
  text: ["Texto", ""], txt: ["Texto", ""], plaintext: ["Texto", ""],
};


type Highlight = (language: string, value: string) => HastNode[] | null;

/**
 * Resaltador compartido. highlight.js va en su propio fragmento: se pide al
 * quedar libre la app tras arrancar o con el primer bloque de código, y los
 * bloques ya pintados se colorean al llegar sin volver a interpretar el texto.
 */
let highlight: Highlight | null = null;
let highlightRequested = false;
const highlightListeners = new Set<() => void>();
function loadHighlighter(): void {
  if (highlightRequested) return;
  highlightRequested = true;
  void import("../../chatHighlight").then(module => {
    highlight = module.highlightCode;
    for (const listener of highlightListeners) listener();
  }, () => { /* sin resaltador, el código se lee en texto plano */ });
}
const subscribeHighlighter = (listener: () => void): (() => void) => {
  highlightListeners.add(listener);
  return () => { highlightListeners.delete(listener); };
};
const currentHighlighter = (): Highlight | null => highlight;
if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(loadHighlighter, { timeout: 3000 });
  else window.setTimeout(loadHighlighter, 1500);
}

/** Tokens de lowlight (solo `span` con clases y texto) como elementos de React. */
function tokensToReact(nodes: HastNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value ?? "";
    const classes = node.properties?.className;
    return createElement(node.tagName ?? "span", { key: index, className: Array.isArray(classes) ? classes.join(" ") : undefined },
      ...tokensToReact(node.children ?? []));
  });
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const code = node?.children?.find(child => child.tagName === "code");
  const language = codeLanguage(code);
  const label = typeof language === "string" ? language.toLowerCase() : "";
  const [name, color] = LANGUAGES[label] ?? [label || "Código", ""];
  const text = nodeText(code);
  const highlighter = useSyncExternalStore(subscribeHighlighter, currentHighlighter, currentHighlighter);
  useEffect(() => { if (language) loadHighlighter(); }, [language]);
  // Un bloque terminado no se vuelve a colorear aunque el mensaje se repinte.
  const highlighted = useMemo(() => {
    const tokens = highlighter && language ? highlighter(language, text) : null;
    return tokens && tokens.length ? tokensToReact(tokens) : tokens && text;
  }, [highlighter, language, text]);
  const classes = code?.properties?.className;
  return <div className="chat-code">
    <div className="chat-code-bar">
      <span className="chat-code-lang">
        <i className="chat-code-dot" style={color ? { "--lang": color } as CSSProperties : undefined} aria-hidden="true" />
        {name}
      </span>
      <CopyButton text={text.replace(/\n$/, "")} label="Copiar código" />
    </div>
    <pre>{highlighted === null
      ? children
      : <code className={["hljs", ...(Array.isArray(classes) ? classes.map(String).filter(value => value !== "hljs") : [])].join(" ")}>{highlighted}</code>}</pre>
  </div>;
}

// --- Avisos destacados -----------------------------------------------------

const CALLOUTS: Record<string, { title: string; icon: ReactNode }> = {
  note: { title: "Nota", icon: <InfoIcon size={15} /> },
  tip: { title: "Consejo", icon: <SparkIcon size={15} /> },
  important: { title: "Importante", icon: <InfoIcon size={15} /> },
  warning: { title: "Advertencia", icon: <AlertIcon size={15} /> },
  caution: { title: "Precaución", icon: <AlertIcon size={15} /> },
};

// --- Componentes -------------------------------------------------------------

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
// Solo se colorean los bloques con lenguaje (en `CodeBlock`): adivinarlo es lento y a menudo falla.
const REHYPE_PLUGINS: Options["rehypePlugins"] = [rehypeCallouts];

/** Además de lo que permite react-markdown, los enlaces `file://` y las rutas de Windows (archivos compartidos). */
const urlTransform = (url: string): string => /^(file:|[a-z]:[\\/])/i.test(url) ? url : defaultUrlTransform(url);

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  blockquote: ({ className, children }) => {
    const kind = className?.split(" ").find(name => CALLOUTS[name]);
    if (!kind) return <blockquote>{children}</blockquote>;
    return <div className={`chat-callout ${kind}`} role="note">
      <div className="chat-callout-title">{CALLOUTS[kind].icon}{CALLOUTS[kind].title}</div>
      {children}
    </div>;
  },
  p: function Paragraph({ node, children }) {
    const { cwd } = useContext(SharedFilesContext);
    const files = attachmentsOf(node as HastNode | undefined, cwd);
    return files ? <FileCards items={files} /> : <p>{children}</p>;
  },
  ul: function List({ node, children, className }) {
    const { cwd } = useContext(SharedFilesContext);
    const files = attachmentsOf(node as HastNode | undefined, cwd);
    return files ? <FileCards items={files} /> : <ul className={className}>{children}</ul>;
  },
  ol: function OrderedList({ node, children, className, start }) {
    const { cwd } = useContext(SharedFilesContext);
    const files = attachmentsOf(node as HastNode | undefined, cwd);
    return files ? <FileCards items={files} /> : <ol className={className} start={start}>{children}</ol>;
  },
  a: function Link({ href, children }) {
    const { cwd } = useContext(SharedFilesContext);
    const path = safeUrl(href) ? null : localFilePath(href, cwd);
    if (path) return <FileLink path={path}>{children}</FileLink>;
    const url = safeUrl(href);
    return <a href={url ?? undefined} title={url ?? undefined} onClick={event => {
      event.preventDefault();
      if (url) void openUrl(url).catch(() => undefined);
    }}>{children}</a>;
  },
  img: function Image({ src, alt }) {
    const { cwd } = useContext(SharedFilesContext);
    const path = typeof src === "string" && !safeUrl(src) ? localFilePath(src, cwd) : null;
    if (path) return <FileLink path={path}>{alt || path}</FileLink>;
    const url = safeUrl(typeof src === "string" ? src : undefined);
    return url
      ? <a href={url} onClick={event => { event.preventDefault(); void openUrl(url).catch(() => undefined); }}>{alt || url}</a>
      : <span>{alt}</span>;
  },
  table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
};

/** Un trozo de Markdown; memorizado para que los bloques que no cambian no se vuelvan a interpretar. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>;
});

/**
 * Se pinta por bloques independientes (cortes seguros, ver `markdownBlocks`):
 * mientras la respuesta llega solo cambia, y se vuelve a interpretar, el
 * último; al terminar no se interpreta nada de nuevo. Interpretar por bloques
 * cuesta lo mismo que el texto entero.
 */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return <div className="chat-markdown">
    {blocks.map((block, index) => <MarkdownBlock key={index} text={block} />)}
  </div>;
}

export default memo(Markdown);
