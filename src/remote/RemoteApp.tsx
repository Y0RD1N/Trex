/**
 * trex remoto: la app móvil («cuaderno de campo», docs/design/remoto-movil.html).
 *
 * Lo que te necesita va primero; las acciones viven abajo, al alcance del pulgar.
 * Pantallas: emparejar (A), sesiones (B), chat en vivo (C) y hojas inferiores para
 * permisos (D) y preguntas (E). El PC manda: aquí solo se pinta lo que publica y se
 * le envían órdenes.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { strata } from "../strata";
import { timeAgo, type RemoteChoice, type RemoteDetail, type RemoteItem, type RemotePending, type RemoteQuestion, type RemoteSession } from "../remoteProtocol";
import { RemoteClient, defaultDeviceName, forgetToken, pairDevice, storedToken, type ConnectionState, type RemoteTheme } from "./client";

const T_PATH = "M432 248h120v104h200v112H552v160q0 56 56 56h128v112H592q-160 0-160-160V464H272V352h160Z";
const PROVIDER_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", trex: "Trex" };

// --- Piezas pequeñas -------------------------------------------------------------

function Brand({ size = 18 }: { size?: number }) {
  return <svg className="r-brand" width={size} height={size} viewBox="240 248 544 544" aria-hidden="true"><path d={T_PATH} /></svg>;
}

/** La «t» cortada en cuatro estratos que se encienden de arriba abajo. */
function Loader({ size = 14 }: { size?: number }) {
  const id = useMemo(() => `t${Math.random().toString(36).slice(2, 8)}`, []);
  return <svg className="r-loader" width={size} height={size} viewBox="240 248 544 544" aria-hidden="true">
    <defs><clipPath id={id}><path d={T_PATH} /></clipPath></defs>
    <g clipPath={`url(#${id})`}>{[0, 1, 2, 3].map(i => <rect key={i} x="240" y={248 + i * 136} width="544" height="136" />)}</g>
  </svg>;
}

/** Núcleo de sondeo: la misma columna de estratos que el proyecto tiene en el PC. */
const Core = memo(function Core({ seed, height }: { seed: string; height?: number }) {
  const layers = useMemo(() => strata(seed, 20), [seed]);
  return <span className="r-core" style={height ? { height } : undefined} aria-hidden="true">
    {layers.map((layer, index) => <i key={index} style={{ flexGrow: layer.height, background: layer.color }} />)}
  </span>;
});

const safeUrl = (url: string): string => {
  const value = defaultUrlTransform(url);
  return /^(https?:|mailto:|#)/i.test(value) ? value : "";
};

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="r-md"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl}
    components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: () => null }}>{text}</ReactMarkdown></div>;
});

function useNow(interval = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} m ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
};

function applyTheme(theme: RemoteTheme | null): void {
  const root = document.documentElement;
  if (!theme) return;
  root.dataset.theme = theme.mode;
  const map: Record<string, string> = {
    app: "--bg-app", sidebar: "--bg-sidebar", surface: "--bg-surface", elevated: "--bg-elevated", inset: "--bg-inset", selected: "--session-selected",
    border: "--border", borderStrong: "--border-strong", text: "--text", muted: "--text-muted", dim: "--text-dim",
    accent: "--accent", accentText: "--accent-strong", accentInk: "--accent-contrast",
  };
  for (const [key, token] of Object.entries(map)) {
    const value = theme.colors[key];
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(token, value);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.sidebar ?? "#110f0b");
}

// --- A · Emparejar -----------------------------------------------------------------

function PairScreen({ reason }: { reason: string | null }) {
  const fromLink = useMemo(() => /[#&]pair=([A-Za-z0-9-]{4,12})/.exec(location.hash)?.[1] ?? "", []);
  const [code, setCode] = useState(fromLink.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(reason);
  const auto = useRef(!!fromLink);

  const submit = useCallback(async (value = code) => {
    if (value.length < 6 || busy) return;
    setBusy(true); setError(null);
    try {
      await pairDevice(value, name);
      history.replaceState(null, "", location.pathname);
      location.reload();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
  }, [code, name, busy]);

  // Desde el QR el código ya viene en el enlace: se empareja sin teclear nada.
  useEffect(() => { if (auto.current) { auto.current = false; void submit(code); } }, [code, submit]);

  const chars = code.padEnd(6, " ").slice(0, 6).split("");
  return <div className="r-screen">
    <header className="r-top"><Brand /><span className="r-wordmark">trex</span></header>
    <main className="r-pair">
      <h1>Conecta con tu PC</h1>
      <p className="r-sub">Tus sesiones siguen en el PC. Desde aquí las ves y las diriges.</p>
      <ol className="r-steps">
        <li><span>01</span>En trex, abre Ajustes › Control remoto.</li>
        <li><span>02</span>Pulsa «Emparejar un móvil» y escanea el código, o escribe sus seis caracteres.</li>
        <li><span>03</span>Este móvil aparecerá en tu lista de dispositivos.</li>
      </ol>
      <div className="r-rule"><span>código de emparejado</span></div>
      <label className="r-code" onClick={event => (event.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
        {chars.map((char, index) => <span key={index} className={`r-code-cell${index === code.length ? " is-current" : ""}`}>{char.trim()}</span>).flatMap((cell, index) => index === 3 ? [<em key="dash">–</em>, cell] : [cell])}
        <input aria-label="Código de emparejado" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={code} maxLength={8}
          onChange={event => setCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
          onKeyDown={event => { if (event.key === "Enter") void submit(); }} />
      </label>
      <label className="r-field"><span>Nombre de este dispositivo</span>
        <input value={name} maxLength={60} onChange={event => setName(event.currentTarget.value)} /></label>
      <div className="r-addr"><span>servidor</span><span>{location.host}</span></div>
      {error && <p className="r-error" role="alert">{error}</p>}
      <div className="r-cta"><button type="button" className="r-btn is-primary is-large" disabled={code.length < 6 || busy} onClick={() => void submit()}>
        {busy ? <><Loader />Emparejando…</> : "Emparejar este dispositivo"}</button></div>
    </main>
  </div>;
}

// --- Cabecera y estado de la conexión --------------------------------------------------

function LinkChip({ state, host, latency }: { state: ConnectionState; host: string; latency: number | null }) {
  const online = state === "online";
  return <span className={`r-link${online ? "" : " is-off"}`} role="status">
    <span className="r-bars" aria-hidden="true"><i /><i /><i /></span>
    {online ? <>{host || "PC"}{latency !== null && <> · {latency} ms</>}</> : state === "connecting" ? "conectando…" : "sin conexión"}
  </span>;
}

// --- B · Sesiones ------------------------------------------------------------------------

const ORDER: Record<RemoteSession["status"], number> = { needs: 0, working: 1, idle: 2, exited: 3 };

function SessionCard({ session, now, onOpen, onQuick }: { session: RemoteSession; now: number; onOpen: () => void; onQuick: (allowed: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const quick = async (allowed: boolean) => {
    setBusy(allowed ? "allow" : "deny");
    try { await onQuick(allowed); } finally { setBusy(null); }
  };
  const need = session.need;
  return <article className={`r-card${need ? " is-need" : ""}`}>
    <button type="button" className="r-srow" onClick={onOpen}>
      <Core seed={session.project.id} />
      <span className="r-sbody">
        <span className="r-sh"><b className="r-ttl">{session.title}</b><span className="r-when">{timeAgo(session.updatedAt, now)}</span></span>
        <span className="r-meta">{session.project.name} · {session.agent}{session.model ? ` · ${session.model}` : ""}</span>
        {need ? <span className="r-st is-warn">{need.kind === "question" ? "?" : "▲"} {need.kind === "permission" ? "pide permiso · " : need.kind === "plan" ? "" : "pregunta · "}{need.label}</span>
          : session.status === "working" ? <span className="r-st is-work"><Loader />{session.activity ?? "trabajando"}</span> : null}
      </span>
    </button>
    {need?.kind === "permission" && <div className="r-quick">
      <button type="button" className="r-btn is-ghost" onClick={onOpen}>Ver</button>
      <button type="button" className="r-btn" disabled={!!busy} onClick={() => void quick(false)}>{busy === "deny" ? <Loader /> : "Rechazar"}</button>
      <button type="button" className="r-btn is-warn" disabled={!!busy} onClick={() => void quick(true)}>{busy === "allow" ? <Loader /> : "Permitir"}</button>
    </div>}
  </article>;
}

function SessionList({ sessions, filter, onFilter, onlyWaiting, onOpen, onQuick }: {
  sessions: RemoteSession[]; filter: string | null; onFilter: (project: string | null) => void; onlyWaiting: boolean;
  onOpen: (id: string) => void; onQuick: (session: RemoteSession, allowed: boolean) => Promise<void>;
}) {
  const now = useNow();
  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of sessions) seen.set(session.project.id, session.project.name);
    return [...seen];
  }, [sessions]);
  const visible = sessions.filter(session => (!filter || session.project.id === filter) && (!onlyWaiting || session.status === "needs"))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt);
  const groups: [string, RemoteSession[]][] = [
    ["Te necesitan", visible.filter(s => s.status === "needs")],
    ["Trabajando", visible.filter(s => s.status === "working")],
    ["En reposo", visible.filter(s => s.status === "idle" || s.status === "exited")],
  ];
  return <div className="r-scroll">
    {projects.length > 1 && <div className="r-chips" role="toolbar" aria-label="Filtrar por proyecto">
      <button type="button" className={`r-chip${filter ? "" : " is-on"}`} onClick={() => onFilter(null)}>Todos</button>
      {projects.map(([id, name]) => <button type="button" key={id} className={`r-chip${filter === id ? " is-on" : ""}`} onClick={() => onFilter(filter === id ? null : id)}>
        <Core seed={id} height={14} />{name}</button>)}
    </div>}
    {!visible.length && <div className="r-empty">{onlyWaiting ? "Nada te espera ahora mismo." : "No hay sesiones de chat abiertas en el PC."}</div>}
    {groups.map(([label, list]) => list.length > 0 && <section key={label}>
      <div className="r-rule r-sec"><span>{label}</span><span className="r-n">{list.length}</span></div>
      {label === "En reposo"
        ? <div className="r-plain-list">{list.map(session => <button type="button" key={session.id} className="r-plain" onClick={() => onOpen(session.id)}>
            <Core seed={session.project.id} height={20} /><span className="r-ttl">{session.title}</span>
            <span className="r-when">{session.status === "exited" ? "cerrada" : timeAgo(session.updatedAt, now)}</span></button>)}</div>
        : <div className="r-cards">{list.map(session => <SessionCard key={session.id} session={session} now={now} onOpen={() => onOpen(session.id)}
            onQuick={allowed => onQuick(session, allowed)} />)}</div>}
    </section>)}
  </div>;
}

// --- C · Chat en vivo ------------------------------------------------------------------------

const ItemRow = memo(function ItemRow({ item }: { item: RemoteItem }) {
  switch (item.kind) {
    case "user": return <div className="r-me"><span>{item.text}{item.images > 0 && <small> · {item.images} imagen{item.images === 1 ? "" : "es"}</small>}</span></div>;
    case "text": return <div className="r-ai"><Markdown text={item.text} /></div>;
    case "notice": return <div className={`r-notice is-${item.tone}`}>{item.text}</div>;
    case "turn": return <div className="r-turn">respuesta en {duration(item.durationMs)}</div>;
    case "tool": return null;
  }
});

/** Herramientas seguidas, en un solo árbol ├─ ✓. */
function ToolTree({ tools }: { tools: Extract<RemoteItem, { kind: "tool" }>[] }) {
  return <div className="r-tree">{tools.map((tool, index) => <div key={tool.id} className="r-tree-row">
    <span className="r-tree-branch">{index === tools.length - 1 ? "└─" : "├─"}</span>
    {tool.status === "running" ? <Loader size={12} /> : <span className={tool.status === "error" ? "r-tree-err" : "r-tree-ok"}>{tool.status === "error" ? "✕" : "✓"}</span>}
    <span className="r-tree-text">{tool.verb} {tool.target}</span>
    {(tool.added > 0 || tool.removed > 0) && <span className="r-diff"><span className="is-add">+{tool.added}</span> <span className="is-del">−{tool.removed}</span></span>}
  </div>)}</div>;
}

function Thread({ items }: { items: RemoteItem[] }) {
  const blocks: ReactNode[] = [];
  let tools: Extract<RemoteItem, { kind: "tool" }>[] = [];
  const flush = () => { if (tools.length) { blocks.push(<ToolTree key={`tree-${tools[0].id}`} tools={tools} />); tools = []; } };
  for (const item of items) {
    if (item.kind === "tool") { tools.push(item); continue; }
    flush();
    blocks.push(<ItemRow key={item.id} item={item} />);
  }
  flush();
  return <>{blocks}</>;
}

function WorkingLine({ since }: { since: number | null }) {
  const now = useNow(1000);
  return <div className="r-working"><Loader />trabajando{since ? ` · ${duration(now - since)}` : ""}</div>;
}

function Composer({ detail, onSend }: { detail: RemoteDetail; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try { await onSend(value); setText(""); } catch { /* el aviso lo muestra quien envía */ } finally { setBusy(false); }
  };
  if (detail.locked) return <div className="r-composer"><div className="r-locked">{detail.locked}</div></div>;
  return <div className="r-composer">
    {detail.queues && <div className="r-queued">se entregará al terminar el turno{detail.queued > 0 ? ` · ${detail.queued} en cola` : ""}</div>}
    <div className="r-box">
      <span className="r-prompt" aria-hidden="true">›</span>
      <textarea ref={area} rows={1} value={text} placeholder={detail.queues ? "Escribe para encolar…" : "Escribe una indicación…"} aria-label="Mensaje"
        onChange={event => setText(event.currentTarget.value)} />
      <button type="button" className="r-send" aria-label={detail.queues ? "Añadir a la cola" : "Enviar"} disabled={!text.trim() || busy} onClick={() => void send()}>
        {busy ? <Loader /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>}
      </button>
    </div>
  </div>;
}

function ChatScreen({ session, detail, onBack, onCommand, onToast }: {
  session: RemoteSession | null; detail: RemoteDetail | null; onBack: () => void;
  onCommand: (action: Parameters<RemoteClient["command"]>[1]) => Promise<void>; onToast: (text: string) => void;
}) {
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [sheetClosed, setSheetClosed] = useState<string | null>(null);
  const pending = detail?.pending ?? null;
  const sheetOpen = !!pending && sheetClosed !== pending.item;
  useEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [detail]);
  const run = async (action: Parameters<RemoteClient["command"]>[1]): Promise<void> => {
    try { await onCommand(action); } catch (error) { onToast(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const title = session?.title ?? "Sesión";
  return <div className="r-screen">
    <header className="r-chat-top">
      <button type="button" className="r-back" aria-label="Volver a las sesiones" onClick={onBack}>‹</button>
      {session && <Core seed={session.project.id} height={28} />}
      <div className="r-who"><b>{title}</b><span>{session ? `${session.project.name} · ${session.agent}${session.model ? ` · ${session.model}` : ""}` : "cargando…"}</span></div>
      {detail?.running && <button type="button" className="r-stop" onClick={() => void run({ kind: "interrupt" }).catch(() => undefined)}><i />Detener</button>}
    </header>
    {detail && detail.tasks.total > 0 && <div className="r-tasks">
      <div className="r-tasks-h"><b>{detail.tasks.current ?? (detail.tasks.done === detail.tasks.total ? "Tareas completadas" : "Tareas")}</b><span>tareas {detail.tasks.done}/{detail.tasks.total}</span></div>
      <div className="r-seglist" style={{ gridTemplateColumns: `repeat(${Math.min(detail.tasks.total, 24)}, 1fr)` }}>
        {Array.from({ length: Math.min(detail.tasks.total, 24) }, (_, index) => {
          const scaled = Math.floor(index * detail.tasks.total / Math.min(detail.tasks.total, 24));
          return <i key={index} className={scaled < detail.tasks.done ? "is-done" : scaled === detail.tasks.done && detail.tasks.current ? "is-active" : ""} />;
        })}
      </div>
    </div>}
    <div className="r-thread" ref={thread} onScroll={event => {
      const el = event.currentTarget;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {!detail && <div className="r-empty"><Loader size={20} /></div>}
      {detail?.dormant && <div className="r-notice is-info">Esta sesión aún no se abrió en el PC desde que arrancó trex: su historial no está cargado. Lo que envíes desde aquí la reanuda.</div>}
      {detail && detail.hidden > 0 && <div className="r-turn">{detail.hidden} mensajes anteriores en el PC</div>}
      {detail && <Thread items={detail.items} />}
      {detail?.running && <WorkingLine since={detail.turnStartedAt} />}
      {pending && !sheetOpen && <button type="button" className="r-pending-bar" onClick={() => setSheetClosed(null)}>
        {pending.kind === "question" ? "? Te hace una pregunta" : pending.kind === "plan" ? "▲ Propone un plan" : "▲ Pide permiso"} · ver</button>}
    </div>
    {detail && <Composer detail={detail} onSend={text => run({ kind: "send", text })} />}
    {sheetOpen && pending && <Sheet agent={PROVIDER_NAME[session?.provider ?? ""] ?? session?.agent ?? "El agente"} pending={pending}
      onClose={() => setSheetClosed(pending.item)}
      onAnswer={(allowed, remember, choices) => run({ kind: "answer", item: pending.item, allowed, remember, choices })} />}
  </div>;
}

// --- D/E · Hojas inferiores -------------------------------------------------------------------

function Sheet({ agent, pending, onClose, onAnswer }: { agent: string; pending: RemotePending; onClose: () => void;
  onAnswer: (allowed: boolean, remember: boolean, choices: RemoteChoice[] | null) => Promise<void> }) {
  return <div className="r-sheet-wrap">
    <button type="button" className="r-scrim" aria-label="Ocultar" onClick={onClose} />
    <div className="r-sheet" role="dialog" aria-modal="true" aria-label={pending.kind === "question" ? `${agent} pregunta` : `${agent} pide permiso`}>
      <button type="button" className="r-grab" aria-label="Ocultar" onClick={onClose} />
      {pending.kind === "question" ? <QuestionSheet agent={agent} pending={pending} onAnswer={onAnswer} />
        : pending.kind === "plan" ? <PlanSheet agent={agent} pending={pending} onAnswer={onAnswer} />
        : <PermissionSheet agent={agent} pending={pending} onAnswer={onAnswer} />}
    </div>
  </div>;
}

function useBusy(): [string | null, (key: string, work: () => Promise<void>) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  return [busy, (key, work) => { if (busy) return; setBusy(key); void work().catch(() => undefined).finally(() => setBusy(null)); }];
}

function PermissionSheet({ agent, pending, onAnswer }: { agent: string; pending: Extract<RemotePending, { kind: "permission" }>; onAnswer: (allowed: boolean, remember: boolean, choices: null) => Promise<void> }) {
  const [busy, act] = useBusy();
  const what = pending.command ? "ejecutar un comando" : pending.added || pending.removed ? `editar ${pending.target}` : `${pending.verb.toLowerCase()} ${pending.target}`.trim();
  return <>
    <div className="r-rule"><span>{agent} pide permiso</span></div>
    <div className="r-perm">
      <div className="r-perm-what">Quiere <b>{what}</b> en tu PC</div>
      {pending.command && <div className="r-cmd"><span className="r-cmd-p">$</span> {pending.command}<span className="r-cmd-cwd">{pending.cwd}</span></div>}
      {!pending.command && pending.detail && <div className="r-cmd">{pending.detail}</div>}
      {(pending.added > 0 || pending.removed > 0) && <div className="r-diff"><span className="is-add">+{pending.added}</span> <span className="is-del">−{pending.removed}</span></div>}
      {pending.description && <div className="r-why">{pending.description}</div>}
    </div>
    <div className="r-acts">
      <button type="button" className="r-btn is-tall" disabled={!!busy} onClick={() => act("deny", () => onAnswer(false, false, null))}>{busy === "deny" ? <Loader /> : "Rechazar"}</button>
      <button type="button" className="r-btn is-warn is-tall" disabled={!!busy} onClick={() => act("allow", () => onAnswer(true, false, null))}>{busy === "allow" ? <Loader /> : "Permitir una vez"}</button>
      {pending.remember && <button type="button" className="r-btn is-ghost is-wide" disabled={!!busy} onClick={() => act("always", () => onAnswer(true, true, null))}>{busy === "always" ? <Loader /> : pending.remember}</button>}
    </div>
    <div className="r-hint">también lo verás en el PC · lo que respondas primero manda</div>
  </>;
}

function PlanSheet({ agent, pending, onAnswer }: { agent: string; pending: Extract<RemotePending, { kind: "plan" }>; onAnswer: (allowed: boolean, remember: boolean, choices: null) => Promise<void> }) {
  const [busy, act] = useBusy();
  return <>
    <div className="r-rule"><span>{agent} terminó el plan</span></div>
    <div className="r-plan"><Markdown text={pending.plan || "Sin detalles."} /></div>
    <div className="r-acts">
      <button type="button" className="r-btn is-tall" disabled={!!busy} onClick={() => act("deny", () => onAnswer(false, false, null))}>{busy === "deny" ? <Loader /> : "Seguir planificando"}</button>
      <button type="button" className="r-btn is-primary is-tall" disabled={!!busy} onClick={() => act("allow", () => onAnswer(true, false, null))}>{busy === "allow" ? <Loader /> : "Aprobar plan"}</button>
    </div>
  </>;
}

function QuestionSheet({ agent, pending, onAnswer }: { agent: string; pending: Extract<RemotePending, { kind: "question" }>; onAnswer: (allowed: boolean, remember: boolean, choices: RemoteChoice[]) => Promise<void> }) {
  const questions = pending.questions;
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<RemoteChoice[]>(() => questions.map(q => ({ question: q.question, selected: [], other: "" })));
  const [writing, setWriting] = useState(false);
  const [busy, act] = useBusy();
  const question: RemoteQuestion | undefined = questions[step];
  if (!question) return null;
  const choice = choices[step];
  const last = step === questions.length - 1;
  const answered = choice.selected.length > 0 || choice.other.trim().length > 0;
  const update = (next: RemoteChoice) => setChoices(list => list.map((value, index) => index === step ? next : value));
  const advance = (list = choices) => {
    if (!last) { setStep(step + 1); setWriting(false); return; }
    act("send", () => onAnswer(true, false, list));
  };
  const pick = (label: string) => {
    if (question.multiSelect) { update({ ...choice, selected: choice.selected.includes(label) ? choice.selected.filter(v => v !== label) : [...choice.selected, label] }); return; }
    const next = choices.map((value, index) => index === step ? { ...value, selected: [label], other: "" } : value);
    setChoices(next);
  };
  return <>
    <div className="r-rule"><span>{pending.title || `${agent} pregunta`}</span>{questions.length > 1 && <span className="r-n">{step + 1} de {questions.length}</span>}</div>
    <p className="r-q">{question.question}</p>
    <div className="r-opts">
      {question.options.map((option, index) => <button type="button" key={option.label} className={`r-opt${choice.selected.includes(option.label) ? " is-sel" : ""}`}
        aria-pressed={choice.selected.includes(option.label)} onClick={() => pick(option.label)}>
        <span className="r-opt-k">{index + 1}</span>
        <span><b>{option.title}{option.recommended && <small> · recomendada</small>}</b>{option.description && <span>{option.description}</span>}</span>
      </button>)}
      {question.other && (writing || !question.options.length
        ? <textarea className="r-other-input" autoFocus={question.options.length > 0} rows={2} value={choice.other} placeholder="Tu respuesta…"
            onChange={event => update({ ...choice, other: event.currentTarget.value, selected: question.multiSelect ? choice.selected : [] })} />
        : <button type="button" className="r-other" onClick={() => setWriting(true)}>› Otra respuesta…</button>)}
    </div>
    <div className="r-row">
      <button type="button" className="r-btn is-ghost is-tall" disabled={!!busy} onClick={() => act("skip", () => onAnswer(false, false, choices))}>Omitir</button>
      <button type="button" className="r-btn is-primary is-tall r-grow" disabled={!answered || !!busy} onClick={() => advance()}>
        {busy === "send" ? <Loader /> : last ? "Responder" : "Siguiente"}</button>
    </div>
  </>;
}

// --- Este dispositivo ---------------------------------------------------------------------------

function DeviceScreen({ host, device, onForget }: { host: string; device: { id: string; name: string } | null; onForget: () => void }) {
  const [permission, setPermission] = useState(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  return <div className="r-scroll">
    <div className="r-rule r-sec"><span>Este dispositivo</span></div>
    <div className="r-card r-device">
      <div><span className="r-meta">nombre</span><b>{device?.name ?? "—"}</b></div>
      <div><span className="r-meta">conectado a</span><b>{host || "PC"} · {location.host}</b></div>
    </div>
    <div className="r-rule r-sec"><span>Avisos</span></div>
    <div className="r-card r-device">
      {permission === "unsupported" || !window.isSecureContext
        ? <p className="r-note">Los avisos necesitan HTTPS. Con Tailscale, activa «Publicar con HTTPS» en Ajustes del PC y abre la dirección https.</p>
        : permission === "granted" ? <p className="r-note">Te avisaremos cuando una sesión te necesite mientras la app esté abierta.</p>
        : <button type="button" className="r-btn" onClick={() => void Notification.requestPermission().then(setPermission)}>Activar avisos</button>}
    </div>
    <div className="r-rule r-sec"><span>Seguridad</span></div>
    <div className="r-card r-device">
      <p className="r-note">Para quitarle el acceso a este dispositivo, desvincúlalo aquí o en Ajustes › Control remoto del PC.</p>
      <button type="button" className="r-btn is-danger" onClick={onForget}>Olvidar este dispositivo</button>
    </div>
  </div>;
}

// --- Aplicación ---------------------------------------------------------------------------------

type Tab = "sessions" | "waiting" | "device";

export default function RemoteApp() {
  const client = useRef<RemoteClient | null>(null);
  const [state, setState] = useState<ConnectionState>(storedToken() ? "connecting" : "denied");
  const [reason, setReason] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [device, setDevice] = useState<{ id: string; name: string } | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<RemoteDetail | null>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [filter, setFilter] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const seenNeeds = useRef(new Set<string>());

  useEffect(() => {
    const instance = new RemoteClient({
      state: (next, why) => { setState(next); if (why) setReason(why); },
      ready: info => { setHost(info.host); setDevice(info.device); },
      sessions: list => {
        setSessions(list);
        // Aviso del sistema solo para lo nuevo que te necesita, y solo si la app no está a la vista.
        for (const session of list) {
          if (!session.need || seenNeeds.current.has(session.need.item)) continue;
          seenNeeds.current.add(session.need.item);
          if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
            try { new Notification(session.title, { body: session.need.label, tag: session.id }); } catch { /* sin avisos */ }
          }
        }
      },
      detail: (id, value) => { if (id === openRef.current) setDetail(value); },
      theme: applyTheme,
      latency: setLatency,
    });
    client.current = instance;
    instance.connect();
    return () => instance.stop();
  }, []);

  // Atrás del sistema (Android) vuelve a la lista.
  useEffect(() => {
    const back = () => { setOpen(null); setDetail(null); client.current?.watch(null); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4200); return () => clearTimeout(timer); }, [toast]);

  const openSession = (id: string) => {
    setOpen(id); setDetail(null);
    client.current?.watch(id);
    history.pushState({ session: id }, "");
  };
  const closeSession = () => { if (history.state?.session) history.back(); else { setOpen(null); setDetail(null); client.current?.watch(null); } };
  const command = (session: string, action: Parameters<RemoteClient["command"]>[1]) => client.current?.command(session, action) ?? Promise.reject(new Error("Sin conexión."));
  const quick = async (session: RemoteSession, allowed: boolean) => {
    if (!session.need) return;
    try { await command(session.id, { kind: "answer", item: session.need.item, allowed, remember: false, choices: null }); }
    catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  };
  const forget = () => { forgetToken(); client.current?.stop(); setState("denied"); setReason(null); };

  if (state === "denied") return <PairScreen reason={reason} />;

  const waiting = sessions.filter(session => session.status === "needs").length;
  const current = open ? sessions.find(session => session.id === open) ?? null : null;
  const offline = state !== "online";

  return <div className="r-app">
    {open ? <ChatScreen session={current} detail={detail} onBack={closeSession} onCommand={action => command(open, action)} onToast={setToast} />
      : <div className="r-screen">
        <header className="r-top"><Brand /><span className="r-wordmark">trex</span><LinkChip state={state} host={host} latency={latency} /></header>
        {tab === "device" ? <DeviceScreen host={host} device={device} onForget={forget} />
          : state === "connecting" && !sessions.length ? <div className="r-empty"><Loader size={22} /><span>Conectando con tu PC…</span></div>
          : <SessionList sessions={sessions} filter={filter} onFilter={setFilter} onlyWaiting={tab === "waiting"} onOpen={openSession} onQuick={quick} />}
        <nav className="r-dock" aria-label="Secciones">
          <button type="button" className={`r-tab${tab === "sessions" ? " is-on" : ""}`} aria-current={tab === "sessions" ? "page" : undefined} onClick={() => setTab("sessions")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg>Sesiones</button>
          <button type="button" className={`r-tab${tab === "waiting" ? " is-on" : ""}`} aria-current={tab === "waiting" ? "page" : undefined} onClick={() => setTab("waiting")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v5M12 17.5v.5" /><path d="M3.5 20 12 4l8.5 16Z" /></svg>
            <span>Esperan{waiting > 0 && <span className="r-badge">{waiting}</span>}</span></button>
          <button type="button" className={`r-tab${tab === "device" ? " is-on" : ""}`} aria-current={tab === "device" ? "page" : undefined} onClick={() => setTab("device")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>Este móvil</button>
        </nav>
      </div>}
    {offline && open && <div className="r-offline" role="status">{state === "connecting" ? "Reconectando…" : "Sin conexión con el PC. Reintentando…"}</div>}
    {toast && <div className="r-toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}
  </div>;
}
