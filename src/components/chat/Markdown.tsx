/**
 * Markdown de las respuestas del asistente (Claude Code y Codex).
 *
 * react-markdown genera elementos de React (nunca HTML crudo), así que el
 * texto del modelo no puede inyectar scripts en la ventana de la app. Los
 * enlaces se abren en el navegador del sistema y las imágenes remotas no se
 * cargan: se muestran como enlace. Los bloques de código llevan colores de
 * sintaxis y los avisos `> [!NOTE]` (como en GitHub) se pintan destacados.
 */
import { memo, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { common } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { nodeText, rehypeCallouts, type HastNode } from "../../chatMarkdown";
import { AlertIcon, CheckIcon, CopyIcon, InfoIcon, SparkIcon } from "../Icons";

const safeUrl = (href: string | undefined): string | null =>
  href && /^(https?:|mailto:)/i.test(href) ? href : null;

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="chat-copy" aria-label={label} data-tip={copied ? "Copiado" : label}
    onClick={() => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      });
    }}>
    {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
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


function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const code = node?.children?.find(child => child.tagName === "code");
  const classes = code?.properties?.className;
  const language = Array.isArray(classes)
    ? String(classes.find(name => String(name).startsWith("language-")) ?? "").replace("language-", "").toLowerCase()
    : "";
  const [name, color] = LANGUAGES[language] ?? [language || "Código", ""];
  return <div className="chat-code">
    <div className="chat-code-bar">
      <span className="chat-code-lang">
        <i className="chat-code-dot" style={color ? { "--lang": color } as CSSProperties : undefined} aria-hidden="true" />
        {name}
      </span>
      <CopyButton text={nodeText(code).replace(/\n$/, "")} label="Copiar código" />
    </div>
    <pre>{children}</pre>
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

const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  rehypeCallouts,
  // Solo se colorean los bloques con lenguaje: adivinarlo es lento y a menudo falla.
  [rehypeHighlight, { languages: { ...common, dockerfile, powershell }, aliases: { dockerfile: ["docker"], powershell: ["ps1"] } }],
];

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
  a: ({ href, children }) => {
    const url = safeUrl(href);
    return <a href={url ?? undefined} title={url ?? undefined} onClick={event => {
      event.preventDefault();
      if (url) void openUrl(url).catch(() => undefined);
    }}>{children}</a>;
  },
  img: ({ src, alt }) => {
    const url = safeUrl(typeof src === "string" ? src : undefined);
    return url
      ? <a href={url} onClick={event => { event.preventDefault(); void openUrl(url).catch(() => undefined); }}>{alt || url}</a>
      : <span>{alt}</span>;
  },
  table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
};

function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={REHYPE_PLUGINS} components={components}>{text}</ReactMarkdown>
  </div>;
}

export default memo(Markdown);
