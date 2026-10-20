import { memo, useMemo, useState, type CSSProperties } from "react";
import { formatDuration, formatTokens } from "../../chatState";
import { changeTree, type ChangeNode, type WorkSummary as Summary } from "../../workSummary";
import { CheckIcon, ChevronIcon, FileIcon, FolderIcon, SplitIcon } from "../Icons";
import { DiffView } from "./ChatItems";
import { useMessageEntry } from "./useMessageEntry";

const STATUS = { modified: "Modificado", added: "Creado", deleted: "Eliminado", renamed: "Renombrado" };

function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="chat-changes-counts" aria-label={`${added} líneas añadidas y ${removed} eliminadas`}>
    <span className="add">+{formatTokens(added)}</span><span className="del">−{formatTokens(removed)}</span>
  </span>;
}

function ChangeRow({ node, depth = 0, allDiffs }: { node: ChangeNode; depth?: number; allDiffs: boolean }) {
  const [expanded, setExpanded] = useState(allDiffs);
  const file = node.file;
  const open = expanded;
  return <li className={`chat-change-node${open ? " open" : ""}`} style={{ "--change-depth": depth } as CSSProperties}>
    <button type="button" className="chat-change-row" aria-expanded={open} aria-label={`${file ? STATUS[file.kind] : "Carpeta"}: ${node.path}`}
      onClick={() => setExpanded(value => !value)} title={file?.previousPath ? `${file.previousPath} → ${file.path}` : node.path}>
      <span className="chat-change-chevron"><ChevronIcon size={12} /></span>
      <span className={`chat-change-icon${file ? ` ${file.kind}` : ""}`}>{file ? <FileIcon size={15} /> : <FolderIcon size={15} />}</span>
      <span className="chat-change-name">{node.name}</span>
      {file && file.kind !== "modified" && <span className={`chat-change-status ${file.kind}`}>{STATUS[file.kind]}</span>}
      {!file && <span className="chat-change-files">{node.files}</span>}
      <Counts added={node.added} removed={node.removed} />
    </button>
    {open && (file ? <div className="chat-change-diff">
      {file.diff.length ? <DiffView lines={file.diff.slice(0, 1200)} />
        : <p className="chat-change-no-diff">{file.previousPath ? `${file.previousPath} → ${file.path}` : "El asistente no proporcionó un diff de este archivo."}</p>}
      {file.diff.length > 1200 && <p className="chat-change-no-diff">Vista previa limitada a 1200 líneas.</p>}
    </div> : <ul>{node.children.map(child => <ChangeRow key={child.path} node={child} depth={depth + 1} allDiffs={allDiffs} />)}</ul>)}
  </li>;
}

export default memo(function WorkSummary({ summary, durationMs, animate = false }: { summary: Summary; durationMs: number; animate?: boolean }) {
  const entry = useMessageEntry(animate);
  const [open, setOpen] = useState(true);
  const [allDiffs, setAllDiffs] = useState(false);
  const tree = useMemo(() => changeTree(summary.files), [summary.files]);
  if (!summary.files.length) return <div ref={entry.ref} className={`chat-turn chat-turn-complete${entry.entering ? " chat-enter" : ""}`}>
    <CheckIcon size={12} /><span>{durationMs > 0 ? `Listo en ${formatDuration(durationMs)}` : "Trabajo completado"}</span>
    <span className="chat-turn-separator">·</span><span>Sin ediciones de archivos registradas</span>
  </div>;
  return <section ref={entry.ref} className={`chat-changes${entry.entering ? " chat-enter" : ""}`} aria-label="Resumen de cambios de esta tarea">
    <header className="chat-changes-head">
      <button type="button" className="chat-changes-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="chat-changes-check"><CheckIcon size={13} /></span>
        <strong>{summary.files.length} {summary.files.length === 1 ? "archivo modificado" : "archivos modificados"}</strong>
        <Counts added={summary.added} removed={summary.removed} />
        <ChevronIcon size={13} />
      </button>
      <button type="button" className={`chat-changes-diff-button tip${allDiffs ? " active" : ""}`} aria-label={allDiffs ? "Cerrar diferencias" : "Ver diferencias"}
        data-tip={allDiffs ? "Cerrar diferencias" : "Ver diferencias"} aria-pressed={allDiffs}
        onClick={() => { setAllDiffs(value => !value); setOpen(true); }}><SplitIcon size={15} /></button>
    </header>
    {open && <ul className="chat-changes-tree">{tree.map(node => <ChangeRow key={`${node.path}-${allDiffs}`} node={node} allDiffs={allDiffs} />)}</ul>}
    <footer className="chat-changes-footer"><span>Cambios de esta tarea</span>
      {durationMs > 0 && <span>Listo en {formatDuration(durationMs)}</span>}
    </footer>
  </section>;
});
