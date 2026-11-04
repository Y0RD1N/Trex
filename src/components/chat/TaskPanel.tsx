import { formatClock } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import { useEffect, useId, useState } from "react";
import { formatDuration } from "../../chatState";
import { TASK_STATES, type ChatTask } from "../../chatTasks";
import { CheckIcon, ChevronIcon, ListIcon, CloseIcon } from "../Icons";
import "./TaskPanel.css";

export default function TaskPanel({ tasks, author, paused, onClose, onReveal, panelId }: {
  tasks: ChatTask[]; author: string; paused?: boolean; onClose: () => void; onReveal: (task: ChatTask) => void; panelId?: string;
}) {
  const id = useId();
  const [selectedId, setSelected] = useState<string | null>(null);
  const selected = tasks.find(task => task.id === selectedId) ?? tasks.find(task => task.status === "in_progress") ?? tasks.find(task => task.status !== "completed") ?? tasks[tasks.length - 1];
  const done = tasks.filter(task => task.status === "completed").length;
  // Live clock only while something is running (and the flow is not paused).
  const running = !paused && tasks.some(task => task.status === "in_progress" && task.startedAt !== undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = (task: ChatTask): number | null => task.startedAt === undefined ? null
    : task.completedAt !== undefined ? task.completedAt - task.startedAt
    : task.status === "in_progress" ? Math.max(0, now - task.startedAt) : null;
  const starts = tasks.flatMap(task => task.startedAt ?? []), ends = tasks.flatMap(task => task.completedAt ?? []);
  const allDone = tasks.length > 0 && done === tasks.length;
  const totalMs = starts.length ? (allDone && ends.length ? Math.max(...ends) : running ? now : Math.max(...ends, ...starts)) - Math.min(...starts) : null;
  const timeFormat = useTimeFormat();
  const clock = (ms: number) => formatClock(ms, timeFormat);
  return <aside id={panelId} className="chat-task-panel" aria-labelledby={id}>
    <header><div><h2 id={id}><ListIcon size={16} />Tareas</h2><p>{tasks.length ? `Por ${author}` : "Organiza el trabajo de este chat"}</p></div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Contraer lista de tareas"><CloseIcon size={14} /></button></header>
    {tasks.length > 0 ? <>
      <div className="chat-task-progress"><div><strong>{done} de {tasks.length} completadas</strong><span>{Math.round(done / tasks.length * 100)}%</span></div>
        {totalMs !== null && <p className="chat-task-total" aria-live="off">
          <span>{allDone ? "Tiempo total" : "Tiempo transcurrido"} <b>{formatDuration(totalMs)}</b></span>
          <span>{clock(Math.min(...starts))}{allDone && ends.length ? ` → ${clock(Math.max(...ends))}` : ""}</span></p>}
        <div className="chat-task-track" role="progressbar" aria-label="Tareas completadas" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={done}>
          <span style={{ transform: `scaleX(${done / tasks.length})` }} /></div></div>
      <ol className="chat-task-list">{tasks.map((task, index) => <li key={task.id} data-status={task.status}>
        <button type="button" aria-current={selected?.id === task.id ? "step" : undefined} onClick={() => setSelected(task.id)}>
          <span className="chat-task-mark" aria-hidden="true">{task.status === "in_progress" ? <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="none" stroke="currentColor" />
            <circle cx="8" cy="8" r="2.5" fill="currentColor" />
          </svg> : task.status === "completed" ? <CheckIcon size={11} /> : ["failed", "uncertain"].includes(task.status) ? "!" : null}</span>
          <span className="chat-task-copy"><strong>{task.title}</strong><small>{task.owner}<span aria-hidden="true"> · </span>{paused && task.status === "in_progress" ? "En pausa" : TASK_STATES[task.status]}
            {elapsed(task) !== null && <><span aria-hidden="true"> · </span><span className={`chat-task-time${task.status === "in_progress" ? " live" : ""}`}
              title={task.approximate ? "Aproximado: el agente no marcó la tarea como «en curso» al empezarla." : undefined}>
              {task.approximate ? "≈ " : ""}{formatDuration(elapsed(task)!)}</span></>}</small></span>
          <span className="chat-task-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        </button></li>)}</ol>
      {selected && <section className="chat-task-detail"><small>{TASK_STATES[selected.status]} · {selected.owner}</small><p>{selected.title}</p>
        {selected.startedAt !== undefined && <p className="chat-task-when">
          {selected.approximate ? "Inicio aprox." : "Inicio"} {clock(selected.startedAt)}
          {selected.completedAt !== undefined ? ` · Fin ${clock(selected.completedAt)}` : ""}
          {elapsed(selected) !== null ? ` · ${formatDuration(elapsed(selected)!)}` : ""}</p>}
        {selected.report && <details><summary>Resultado de la tarea</summary><p>{selected.report}</p></details>}
        <button type="button" onClick={() => onReveal(selected)}>Ver actividad en el chat <ChevronIcon size={12} /></button></section>}
    </> : <div className="chat-task-empty"><ListIcon size={24} /><p>Todo el trabajo, paso a paso</p><small>Pide al agente una lista de tareas en este chat. Aquí verás lo que está haciendo y lo que ya terminó, sin cambiar de modo.</small></div>}
    <footer><span aria-hidden="true" />{paused ? "Flujo en pausa. Se conserva el progreso." : "Se actualiza con el progreso del agente."}</footer>
  </aside>;
}
