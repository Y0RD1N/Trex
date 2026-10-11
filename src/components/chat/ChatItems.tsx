/**
 * Piezas del hilo de chat: mensajes, filas de herramientas, diffs, tareas y
 * peticiones de permiso. Solo pintan; las acciones llegan por props.
 */
import { memo, useState, type ReactNode } from "react";
import {
  describeTool, diffStats, inputDiff, questionsOf, relativePath, todoItems,
  type DiffLine, type PermissionItem, type QuestionChoice, type ToolItem, type ToolSummary,
} from "../../chatState";
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon, FileIcon, GlobeIcon, ImageIcon, InfoIcon, ListIcon, MapIcon, PencilIcon,
  QuestionIcon, SearchIcon, ShieldIcon, SparkIcon, TerminalIcon, WrenchIcon } from "../Icons";
import Markdown, { CopyButton } from "./Markdown";

const TOOL_ICONS: Record<ToolSummary["icon"], ReactNode> = {
  read: <FileIcon />, edit: <PencilIcon size={15} />, run: <TerminalIcon size={15} />, search: <SearchIcon size={15} />,
  web: <GlobeIcon />, task: <SparkIcon />, todo: <ListIcon />, plan: <MapIcon />, question: <QuestionIcon />, tool: <WrenchIcon />,
};

export function UserMessage({ text, images, previews }: { text: string; images: number; previews: string[] }) {
  const [enlarged, setEnlarged] = useState<string | null>(null);
  return <div className="chat-user-group">
    {previews.length > 0 && <div className="chat-user-gallery">
      {previews.map((preview, index) => <button key={index} type="button" className={`chat-user-thumb${enlarged === preview ? " enlarged" : ""}`}
        aria-label={enlarged === preview ? "Reducir imagen" : "Ampliar imagen"} onClick={() => setEnlarged(enlarged === preview ? null : preview)}>
        <img src={preview} alt={`Imagen adjunta ${index + 1}`} />
      </button>)}
    </div>}
    {(text || (images > 0 && !previews.length)) && <div className="chat-user">
      {text && <div className="chat-user-text">{text}</div>}
      {images > 0 && !previews.length && <div className="chat-user-images"><ImageIcon size={14} />
        {images === 1 ? "1 imagen adjunta" : `${images} imágenes adjuntas`}</div>}
    </div>}
  </div>;
}

export const AssistantText = memo(function AssistantText({ text, streaming, actions }: { text: string; streaming: boolean; actions: boolean }) {
  return <div className={`chat-assistant${streaming ? " streaming" : ""}`}>
    <Markdown text={text} />
    {actions && <div className="chat-assistant-actions"><CopyButton text={text} label="Copiar respuesta" /></div>}
  </div>;
});

export function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return <div className="chat-thinking">
    <button type="button" className="chat-thinking-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronIcon size={13} /> Razonamiento
    </button>
    {open && <div className="chat-thinking-text">{text}</div>}
  </div>;
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return <div className="chat-diff" role="group" aria-label="Cambios">
    {lines.map((line, index) => <div key={index} className={`chat-diff-line ${line.kind}`}>
      <span className="chat-diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
      <span>{line.text || " "}</span>
    </div>)}
  </div>;
}

function DiffCount({ lines }: { lines: DiffLine[] | null }) {
  const { added, removed } = diffStats(lines);
  if (!added && !removed) return null;
  return <span className="chat-diff-count">
    {added > 0 && <span className="add">+{added}</span>}
    {removed > 0 && <span className="del">−{removed}</span>}
  </span>;
}

function StatusMark({ status }: { status: ToolItem["status"] }) {
  if (status === "running") return <span className="chat-spinner" aria-label="En curso" />;
  if (status === "error") return <span className="chat-status error" aria-label="Con error"><CloseIcon size={12} /></span>;
  return null;
}

export function TodoCard({ input }: { input: Record<string, unknown> }) {
  const todos = todoItems(input);
  if (!todos.length) return null;
  const done = todos.filter(todo => todo.status === "completed").length;
  return <div className="chat-todos">
    <div className="chat-todos-head"><ListIcon /> <span>Tareas</span><span className="chat-todos-count">{done} de {todos.length}</span></div>
    <ul>
      {todos.map((todo, index) => <li key={index} className={todo.status}>
        <span className="chat-todo-mark" aria-hidden="true">{todo.status === "completed" && <CheckIcon size={11} strokeWidth={2.4} />}</span>
        <span>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}</span>
      </li>)}
    </ul>
  </div>;
}

/** Plan propuesto en modo planificación, a la vista mientras sea el último. */
export function PlanCard({ plan, onImplement }: { plan: string; onImplement?: () => void }) {
  if (!plan.trim()) return null;
  return <div className="chat-plan">
    <div className="chat-todos-head"><MapIcon /> <span>Plan</span></div>
    <div className="chat-plan-body"><Markdown text={plan} /></div>
    {onImplement && <div className="chat-plan-actions">
      <button type="button" className="btn btn-primary btn-small" onClick={onImplement}>Implementar el plan</button>
    </div>}
  </div>;
}

function toolDetail(item: ToolItem, cwd: string): ReactNode {
  const input = item.input;
  const diff = item.patch ?? inputDiff(item.name, input);
  if (item.name === "TodoWrite") return <TodoCard input={input} />;
  if (item.name === "AskUserQuestion") return item.output
    ? <pre className="chat-tool-output">{item.output}</pre> : <div className="chat-tool-empty">Sin respuesta</div>;
  if (diff) return <>
    {item.status === "error" && item.output && <pre className="chat-tool-output error">{item.output}</pre>}
    <DiffView lines={diff} />
  </>;
  if (item.name === "ExitPlanMode" && typeof input.plan === "string") return <div className="chat-tool-plan"><Markdown text={input.plan} /></div>;
  const command = item.name === "Bash" && typeof input.command === "string" ? input.command : null;
  const request = command ?? (item.name === "Task" || item.name === "Agent" ? String(input.prompt ?? "") : null);
  return <>
    {request && <pre className="chat-tool-command">{command ? `$ ${request}` : request}</pre>}
    {!request && Object.keys(input).length > 0 && item.name !== "Read" && <pre className="chat-tool-command">{JSON.stringify(input, null, 2)}</pre>}
    {item.name === "Read" && typeof input.file_path === "string" && <div className="chat-tool-path">{relativePath(input.file_path, cwd)}</div>}
    {item.output ? <pre className={`chat-tool-output${item.status === "error" ? " error" : ""}`}>{item.output}</pre>
      : item.status !== "running" && <div className="chat-tool-empty">Sin salida</div>}
  </>;
}

export function ToolRow({ item, cwd, expanded = false, onImplement }: {
  item: ToolItem; cwd: string; expanded?: boolean; onImplement?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (item.name === "TodoWrite" && expanded) return <TodoCard input={item.input} />;
  if (item.name === "ExitPlanMode" && expanded && typeof item.input.plan === "string") return <PlanCard plan={item.input.plan} onImplement={onImplement} />;
  const summary = describeTool(item.name, item.input, cwd, item.status === "running");
  const diff = item.patch ?? inputDiff(item.name, item.input);
  const description = item.name === "Bash" && typeof item.input.description === "string" ? item.input.description : undefined;
  return <div className={`chat-tool${open ? " open" : ""}`} data-status={item.status}>
    <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen(!open)} title={description}>
      <span className="chat-tool-icon" aria-hidden="true">{TOOL_ICONS[summary.icon]}</span>
      <span className="chat-tool-verb">{summary.verb}</span>
      {summary.target && <span className={`chat-tool-target${summary.icon === "run" || summary.icon === "search" ? " mono" : ""}`}>{summary.target}</span>}
      <DiffCount lines={diff} />
      <StatusMark status={item.status} />
      <span className="chat-tool-chevron" aria-hidden="true"><ChevronIcon size={13} /></span>
    </button>
    {open && <div className="chat-tool-detail">{toolDetail(item, cwd)}</div>}
  </div>;
}

/** Opciones de "permitir siempre" que propone el propio CLI. */
function rememberLabel(suggestions: unknown[]): string | null {
  if (!suggestions.length) return null;
  const first = suggestions[0] as Record<string, unknown>;
  if (typeof first?.label === "string") return first.label;
  if (first?.type === "setMode" && first.mode === "acceptEdits") return "Aceptar ediciones en esta sesión";
  return "Permitir siempre";
}

/** Permisos extra que pide Codex (red o carpetas), en frases cortas. */
function requestedPermissions(input: Record<string, unknown>): string[] {
  const permissions = (input.permissions ?? {}) as { network?: { enabled?: boolean | null } | null;
    fileSystem?: { read?: string[] | null; write?: string[] | null } | null };
  return [
    ...(permissions.network?.enabled ? ["Acceso a la red"] : []),
    ...(permissions.fileSystem?.write ?? []).map(path => `Escribir en ${path}`),
    ...(permissions.fileSystem?.read ?? []).map(path => `Leer ${path}`),
  ];
}

export function PermissionCard({ item, cwd, agent, onAnswer }: {
  item: PermissionItem;
  cwd: string;
  /** Nombre del asistente para los títulos («Claude», «Codex»). */
  agent: string;
  onAnswer: (item: PermissionItem, allowed: boolean, remember: boolean) => void;
}) {
  const input = item.input;
  const plan = item.toolName === "ExitPlanMode" && typeof input.plan === "string" ? input.plan : null;
  const diff = item.patch ?? inputDiff(item.toolName, input, 160);
  const summary = describeTool(item.toolName, input, cwd, false);
  const extra = item.toolName === "Permissions" ? requestedPermissions(input) : null;
  const title = plan ? `${agent} terminó el plan`
    : extra ? `${agent} necesita más permisos`
    : item.toolName === "Bash" ? `${agent} quiere ejecutar un comando`
    : diff ? `${agent} quiere ${item.toolName === "Write" ? "crear" : "editar"} ${summary.target}`
    : item.toolName === "WebFetch" ? `${agent} quiere abrir ${summary.target}`
    : `${agent} quiere usar ${summary.target || item.toolName}`;
  const remember = rememberLabel(item.suggestions);
  return <div className="chat-permission" role="group" aria-label={title}>
    <div className="chat-permission-head">
      <span className="chat-permission-icon" aria-hidden="true">{plan ? <MapIcon size={16} /> : <ShieldIcon />}</span>
      <div>
        <div className="chat-permission-title">{title}</div>
        {item.description && !plan && <div className="chat-permission-sub">{item.description}</div>}
      </div>
    </div>
    {plan ? <div className="chat-permission-plan"><Markdown text={plan} /></div>
      : extra ? <ul className="chat-permission-list">{(extra.length ? extra : ["Permisos adicionales"]).map(line => <li key={line}>{line}</li>)}</ul>
      : item.toolName === "Bash" ? <pre className="chat-tool-command">$ {String(input.command ?? "")}</pre>
      : diff ? <DiffView lines={diff.slice(0, 400)} />
      : Object.keys(input).length > 0 && <pre className="chat-tool-command">{JSON.stringify(input, null, 2)}</pre>}
    <div className="chat-permission-actions">
      <button type="button" className="btn btn-primary btn-small" onClick={() => onAnswer(item, true, false)}>
        {plan ? "Aprobar plan" : "Permitir"}
      </button>
      {remember && !plan && <button type="button" className="btn btn-small" onClick={() => onAnswer(item, true, true)}>{remember}</button>}
      <button type="button" className="btn btn-ghost btn-small" onClick={() => onAnswer(item, false, false)}>
        {plan ? "Seguir planificando" : "Denegar"}
      </button>
    </div>
  </div>;
}

type Choice = QuestionChoice;

/** Preguntas con opciones del asistente (AskUserQuestion en Claude, preguntas de Codex). */
export function QuestionCard({ item, agent, onAnswer }: {
  item: PermissionItem;
  agent: string;
  onAnswer: (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]) => void;
}) {
  const questions = questionsOf(item.input);
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(question => ({ question: question.question, selected: [], other: "" })));
  const update = (index: number, change: (choice: Choice) => Choice): void =>
    setChoices(previous => previous.map((choice, position) => position === index ? change(choice) : choice));
  const complete = choices.every(choice => choice.selected.length > 0 || choice.other.trim());
  return <div className="chat-permission chat-question" role="group" aria-label={`${agent} te pregunta`}>
    <div className="chat-permission-head">
      <span className="chat-permission-icon" aria-hidden="true"><QuestionIcon size={16} /></span>
      <div className="chat-permission-title">{questions.length === 1 ? `${agent} te pregunta` : `${agent} tiene ${questions.length} preguntas`}</div>
    </div>
    {questions.map((question, index) => {
      const choice = choices[index];
      return <fieldset key={index} className="chat-question-block">
        <legend>
          {question.header && <span className="chat-question-tag">{question.header}</span>}
          <span>{question.question}</span>
          {question.multiSelect && <small>Puedes elegir varias</small>}
        </legend>
        <div className="chat-question-options">
          {question.options.map(option => {
            const selected = choice.selected.includes(option.label);
            return <button key={option.label} type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={selected}
              className={`chat-question-option${selected ? " selected" : ""}${question.multiSelect ? " multi" : ""}`}
              onClick={() => update(index, current => ({
                ...current,
                selected: question.multiSelect
                  ? selected ? current.selected.filter(label => label !== option.label) : [...current.selected, option.label]
                  : [option.label],
                other: question.multiSelect ? current.other : "",
              }))}>
              <span className="chat-question-mark" aria-hidden="true">{selected && <CheckIcon size={11} strokeWidth={2.4} />}</span>
              <span className="chat-question-text"><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span>
            </button>;
          })}
          <input className="input chat-question-other" value={choice.other} placeholder="Otra respuesta…" aria-label={`Otra respuesta para: ${question.question}`}
            onChange={event => {
              const other = event.target.value;
              update(index, current => ({ ...current, other, selected: question.multiSelect || !other.trim() ? current.selected : [] }));
            }}
            onKeyDown={event => { if (event.key === "Enter" && complete) onAnswer(item, true, false, choices); }} />
        </div>
      </fieldset>;
    })}
    <div className="chat-permission-actions">
      <button type="button" className="btn btn-primary btn-small" disabled={!complete}
        onClick={() => onAnswer(item, true, false, choices)}>Responder</button>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => onAnswer(item, false, false)}>Omitir</button>
    </div>
  </div>;
}

export function Notice({ tone, text }: { tone: "info" | "warn" | "error"; text: string }) {
  return <div className={`chat-notice ${tone}${text.includes("\n") ? " multiline" : ""}`} role={tone === "error" ? "alert" : "status"}>
    <span aria-hidden="true">{tone === "info" ? <InfoIcon size={14} /> : <AlertIcon size={14} />}</span>
    <span>{text}</span>
  </div>;
}
