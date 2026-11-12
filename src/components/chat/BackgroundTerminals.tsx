import { memo, useEffect, useMemo, useState } from "react";
import type { AgentTerminal, TerminalOwner } from "../../agentTerminals";
import { RefreshIcon } from "../Icons";
import ComposerPanel from "./ComposerPanel";
import "./BackgroundTerminals.css";

const STATES: Record<AgentTerminal["state"], string> = { running: "Activa", stopping: "Deteniendo…", completed: "Finalizada", failed: "Falló", stopped: "Detenida", unknown: "Sin confirmar" };
const plain = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
function BackgroundTerminals({ owners }: { owners: TerminalOwner[] }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null), [message, setMessage] = useState("");
  const [stopping, setStopping] = useState(new Set<string>());
  const [input, setInput] = useState(""), [writing, setWriting] = useState(false);
  const rows = useMemo(() => owners.flatMap(owner => owner.session.snapshot.entries.map(entry => ({ owner, entry, key: JSON.stringify([owner.id, entry.id]) }))), [owners]);
  const active = rows.filter(row => row.entry.state === "running" || row.entry.state === "stopping");
  const unknown = rows.some(row => row.entry.state === "unknown") || owners.some(owner => ["error", "unsupported"].includes(owner.session.snapshot.status));
  const current = rows.find(row => row.key === selected) ?? active[0] ?? rows[rows.length - 1];
  // Empty discovery and historical completed jobs do not take writing space.
  // Keep the final output available until an already-open panel is folded.
  const available = active.length > 0 || rows.some(row => row.entry.state === "unknown") || open;
  const reading = current?.owner.session.read, currentId = current?.entry.id, currentState = current?.entry.state;
  useEffect(() => setInput(""), [current?.key]);
  const sendInput = async (): Promise<void> => {
    const write = current?.owner.session.write;
    if (!current?.entry.canWrite || !write || !input || writing) return;
    const target = current; const text = input; setWriting(true); setMessage("");
    try { await write(target.entry.id, `${text}\n`); setInput(""); await target.owner.session.read(target.entry.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo enviar la entrada."); }
    finally { setWriting(false); }
  };
  useEffect(() => {
    if (!open || !currentId || !reading) return;
    let cancelled = false;
    const read = (): void => { void reading(currentId).catch(error => { if (!cancelled) setMessage(error instanceof Error ? error.message : "No se pudo consultar la salida."); }); };
    read(); const timer = currentState === "running" || currentState === "stopping" ? setInterval(read, 1500) : undefined;
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, reading, currentId, currentState]);
  const stop = async (row: NonNullable<typeof current>): Promise<void> => {
    if (stopping.has(row.key)) return;
    setMessage(""); setStopping(previous => new Set(previous).add(row.key));
    try { await row.owner.session.stop(row.entry.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo detener la terminal."); }
    finally { setStopping(previous => { const next = new Set(previous); next.delete(row.key); return next; }); }
  };
  const refreshing = owners.some(owner => owner.session.snapshot.status === "loading");
  const count = unknown ? active.length ? `${active.length}+` : "?" : String(active.length);
  return <ComposerPanel label="Terminales" title="Terminales en segundo plano" glyph="$" count={count}
    visible={available} open={open} onOpenChange={setOpen} live={active.length > 0}
    detail={`${active.length} ${active.length === 1 ? "activa" : "activas"} · ${owners.length > 1 ? "este equipo" : "este chat"}${unknown ? " · estado parcial" : ""}`}
    actions={<button type="button" className="icon-btn" aria-label="Actualizar terminales" disabled={refreshing} onClick={() => { setMessage(""); void Promise.all(owners.map(owner => owner.session.refresh())).catch(() => setMessage("No se pudo actualizar el estado.")); }}><RefreshIcon size={13} /></button>}>
    <section className="chat-background-panel" aria-label="Terminales de los agentes">
      {rows.length ? <div className="chat-background-list">{rows.map(row => <div key={row.key} className={`chat-background-row${current?.key === row.key ? " is-selected" : ""}`}>
        <button type="button" className="chat-background-select" aria-pressed={current?.key === row.key} onClick={() => { setSelected(row.key); setMessage(""); }} aria-label={`Ver salida de ${row.entry.command} (${STATES[row.entry.state]})`}>
          <span className="chat-background-state" data-state={row.entry.state} aria-hidden="true" />
          <span className="chat-background-copy"><strong title={row.entry.command}>{row.entry.command}</strong>{owners.length > 1 && <small>{row.owner.label}</small>}</span>
          <span className="chat-background-status">{STATES[row.entry.state]}</span>
        </button>
        {row.entry.canStop && <button type="button" className="chat-background-stop" disabled={row.entry.state !== "running" || stopping.has(row.key)} aria-label={`Detener ${row.entry.command}`} onClick={() => void stop(row)}>{row.entry.state === "stopping" || stopping.has(row.key) ? "Deteniendo…" : "Detener"}</button>}
      </div>)}</div> : <p className="chat-background-empty">{unknown ? "No se pudo confirmar la lista. Actualiza el proveedor para disponer del control de terminales." : "Los servidores, pruebas y monitores aparecerán aquí cuando el agente los deje en segundo plano."}</p>}
      {current && <div className="chat-background-output">
        <div className="chat-background-bar"><code className="chat-background-cwd" title={current.entry.cwd}>{current.entry.cwd}</code><span>{STATES[current.entry.state]}{current.entry.exitCode != null ? ` · código ${current.entry.exitCode}` : ""}</span></div>
        <pre tabIndex={0} aria-label={`Salida de ${current.entry.command}`}>{plain(current.entry.output) || "El proveedor todavía no ha publicado salida de esta terminal."}</pre>
        {current.entry.truncated && <small>Se muestran los últimos 64 KiB de salida.</small>}
        {current.entry.canWrite && current.owner.session.write && <form className="chat-background-input" onSubmit={event => { event.preventDefault(); void sendInput(); }}>
          <span aria-hidden="true">›</span>
          <input aria-label="Entrada para la terminal seleccionada" placeholder="Escribe una respuesta o un comando…" value={input} maxLength={16_000} disabled={writing} onChange={event => setInput(event.target.value)} />
          <button type="submit" disabled={writing || !input}>{writing ? "Enviando…" : "Enviar"}</button>
        </form>}
      </div>}
      {(message || owners.some(owner => owner.session.snapshot.error)) && <p className="chat-background-error" role="status">{message || owners.find(owner => owner.session.snapshot.error)?.session.snapshot.error}</p>}
      <p className="chat-background-hint">Detener finaliza esa terminal y conserva el chat y las demás tareas.</p>
    </section>
  </ComposerPanel>;
}

/** Memorizado: el chat se repinta con cada tanda de texto y este componente no depende de ella. */
export default memo(BackgroundTerminals);
