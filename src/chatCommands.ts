/**
 * Sugerencias de la caja del chat: `@` para archivos, carpetas y subagentes,
 * `/` para los comandos del asistente y `$` para las skills de Codex.
 *
 * Solo hay datos y texto: qué disparador hay bajo el cursor, qué sugerir y
 * cómo queda el mensaje al elegir. La interfaz y los protocolos van aparte.
 */
import { list, record, text, type Json } from "./chatState";
import type { AgentProvider } from "./types";

export type CommandInfo = { name: string; description: string; hint: string };
export type AgentInfo = { name: string; description: string };
export type SkillInfo = { name: string; description: string; path: string };

export type Trigger = { char: "@" | "/" | "$"; query: string; start: number; end: number };

export type Suggestion = {
  id: string;
  kind: "file" | "folder" | "agent" | "command" | "skill";
  label: string;
  detail: string;
  /** Texto que sustituye al disparador y su consulta. */
  insert: string;
  /** Comando sin argumentos: al elegirlo se ejecuta. */
  run?: boolean;
};

// --- Comandos -----------------------------------------------------------------

/**
 * Comandos que resuelve el propio chat. En Claude Code sustituyen a los del CLI
 * con el mismo nombre; Codex no tiene comandos en modo servidor y estos son
 * los suyos.
 */
export const LOCAL_COMMANDS: Record<AgentProvider, CommandInfo[]> = {
  claude: [
    { name: "clear", description: "Empieza una conversación nueva", hint: "" },
    { name: "model", description: "Elige el modelo", hint: "" },
    { name: "effort", description: "Elige el nivel de esfuerzo", hint: "" },
    { name: "permissions", description: "Cambia lo que Claude puede hacer sin preguntar", hint: "" },
  ],
  codex: [
    { name: "new", description: "Empieza una conversación nueva", hint: "" },
    { name: "compact", description: "Resume la conversación para liberar contexto", hint: "" },
    { name: "review", description: "Revisa los cambios sin confirmar y busca errores", hint: "[qué revisar]" },
    { name: "init", description: "Crea un AGENTS.md con las instrucciones del proyecto", hint: "" },
    { name: "model", description: "Elige el modelo", hint: "" },
    { name: "effort", description: "Elige el nivel de esfuerzo", hint: "" },
    { name: "permissions", description: "Cambia lo que Codex puede hacer sin preguntar", hint: "" },
    { name: "status", description: "Modelo, esfuerzo, modo y contexto usado", hint: "" },
    { name: "mcp", description: "Servidores MCP y sus herramientas", hint: "" },
  ],
};

/** Nombres que significan lo mismo en uno y otro asistente. */
const SYNONYMS = [["clear", "new"], ["permissions", "approvals"]];

/** Comando local que corresponde a lo escrito (con sus sinónimos), o null. */
export function localCommand(provider: AgentProvider, name: string): string | null {
  const names = LOCAL_COMMANDS[provider].map(command => command.name);
  const group = SYNONYMS.find(words => words.includes(name)) ?? [name];
  return group.find(word => names.includes(word)) ?? null;
}

/** Comandos del CLI que no tienen sentido fuera de su terminal. */
const TERMINAL_ONLY = new Set(["color", "focus", "heapdump", "exit", "quit", "vim", "terminal-setup"]);

/** Comandos que anuncia Claude Code en `initialize`. */
export function parseClaudeCommands(raw: unknown): CommandInfo[] {
  return list(raw).map(record).filter((command): command is Json => !!command && !!text(command.name))
    .map(command => ({ name: text(command.name).replace(/^\//, ""), description: text(command.description), hint: text(command.argumentHint) }))
    .filter(command => !command.name.startsWith("__") && !TERMINAL_ONLY.has(command.name)
      && !/^\(removed\)|^Renamed to /i.test(command.description));
}

export function parseClaudeAgents(raw: unknown): AgentInfo[] {
  return list(raw).map(record).filter((agent): agent is Json => !!agent && !!text(agent.name))
    .map(agent => ({ name: text(agent.name), description: text(agent.description) }));
}

/** Skills de `skills/list` (una entrada por carpeta), sin repetir nombres. */
export function parseCodexSkills(raw: unknown): SkillInfo[] {
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];
  for (const entry of list(raw).map(record)) {
    for (const skill of list(entry?.skills).map(record)) {
      const name = text(skill?.name);
      if (!skill || !name || skill.enabled === false || seen.has(name)) continue;
      seen.add(name);
      const face = record(skill.interface);
      skills.push({ name, path: text(skill.path),
        description: text(face?.shortDescription) || text(skill.shortDescription) || text(skill.description) });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Comandos del menú `/`: los locales primero y después los del CLI. */
export function commandList(provider: AgentProvider, cliCommands: CommandInfo[]): CommandInfo[] {
  const local = LOCAL_COMMANDS[provider];
  const names = new Set(local.map(command => command.name));
  return [...local, ...cliCommands.filter(command => !names.has(command.name) && !localCommand(provider, command.name))];
}

/** `/nombre argumentos` al principio del mensaje. */
export function parseCommand(value: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}

/** Skills nombradas con `$nombre` en el mensaje, para adjuntarlas a Codex. */
export function mentionedSkills(value: string, skills: SkillInfo[]): SkillInfo[] {
  return skills.filter(skill => new RegExp(`(^|\\s)\\$${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s.,;:!?)])`).test(value));
}

// --- Disparadores -------------------------------------------------------------

/**
 * Disparador bajo el cursor. `/` solo cuenta al principio del mensaje; `@` y
 * `$`, al principio de una palabra.
 */
export function findTrigger(value: string, caret: number, chars: string): Trigger | null {
  const before = value.slice(0, caret);
  const rest = /^[^\s]*/.exec(value.slice(caret))?.[0] ?? "";
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash && chars.includes("/")) return { char: "/", query: slash[1], start: 0, end: caret + rest.length };
  const word = /(^|\s)([@$])([^\s]*)$/.exec(before);
  if (!word || !chars.includes(word[2])) return null;
  return { char: word[2] as "@" | "$", query: word[3], start: caret - word[3].length - 1, end: caret + rest.length };
}

/** Mensaje tras elegir una sugerencia, con el cursor detrás de lo insertado. */
export function applySuggestion(value: string, trigger: Trigger, insert: string): { text: string; caret: number } {
  const after = value.slice(trigger.end);
  const glue = insert.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
  return { text: value.slice(0, trigger.start) + insert + glue, caret: trigger.start + insert.length };
}

// --- Archivos -----------------------------------------------------------------

/** Carpetas que contienen los archivos (con `/` al final). */
export function folderPaths(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    let index = file.indexOf("/");
    while (index !== -1) {
      folders.add(file.slice(0, index + 1));
      index = file.indexOf("/", index + 1);
    }
  }
  return [...folders].sort();
}

const baseName = (path: string): string => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/** Parecido entre la ruta y lo escrito; null si no se parece. */
export function pathScore(path: string, query: string): number | null {
  if (!query) return 0;
  const lower = path.toLowerCase(), wanted = query.toLowerCase(), base = baseName(lower);
  let score: number;
  if (base === wanted || base === wanted.replace(/\/$/, "")) score = 1200;
  else if (base.startsWith(wanted)) score = 1000;
  else if (base.includes(wanted)) score = 800;
  else if (lower.startsWith(wanted)) score = 700;
  else if (lower.includes(wanted)) score = 600;
  else {
    // Letras en orden aunque no estén juntas («chtv» → ChatView).
    let position = 0, gaps = 0;
    for (const char of wanted) {
      const found = lower.indexOf(char, position);
      if (found === -1) return null;
      gaps += found - position;
      position = found + 1;
    }
    score = 300 - Math.min(250, gaps);
  }
  return score - path.length * 0.4;
}

/** Archivos y carpetas que mejor encajan con lo escrito. */
export function rankPaths(files: string[], query: string, limit = 40): { path: string; folder: boolean }[] {
  const folders = folderPaths(files);
  if (!query) {
    // Sin consulta: lo que hay en la raíz, carpetas primero.
    const top = (path: string): boolean => !path.slice(0, path.endsWith("/") ? -1 : undefined).includes("/");
    return [...folders.filter(top).map(path => ({ path, folder: true })), ...files.filter(top).map(path => ({ path, folder: false }))].slice(0, limit);
  }
  // Una consulta que acaba en `/` lista el contenido de esa carpeta.
  if (query.endsWith("/")) {
    const inside = (path: string): boolean => path.toLowerCase().startsWith(query.toLowerCase()) && path.length > query.length
      && !path.slice(query.length, path.endsWith("/") ? -1 : undefined).includes("/");
    const children = [...folders.filter(inside).map(path => ({ path, folder: true })), ...files.filter(inside).map(path => ({ path, folder: false }))];
    if (children.length) return children.slice(0, limit);
  }
  const scored: { path: string; folder: boolean; score: number }[] = [];
  for (const path of folders) {
    const score = pathScore(path, query);
    if (score !== null) scored.push({ path, folder: true, score: score + 5 });
  }
  for (const path of files) {
    const score = pathScore(path, query);
    if (score !== null) scored.push({ path, folder: false, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit).map(({ path, folder }) => ({ path, folder }));
}

// --- Sugerencias --------------------------------------------------------------

const matches = (name: string, query: string): number | null => {
  if (!query) return 0;
  const lower = name.toLowerCase(), wanted = query.toLowerCase();
  return lower.startsWith(wanted) ? 2 : lower.includes(wanted) ? 1 : null;
};
const byMatch = <T,>(items: T[], name: (item: T) => string, query: string): T[] =>
  items.map(item => ({ item, score: matches(name(item), query) })).filter(entry => entry.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map(entry => entry.item);

export type SuggestionSources = {
  provider: AgentProvider;
  files: string[] | null;
  agents: AgentInfo[];
  commands: CommandInfo[];
  skills: SkillInfo[];
};

export function buildSuggestions(trigger: Trigger, sources: SuggestionSources): Suggestion[] {
  const { query } = trigger;
  if (trigger.char === "/") {
    const commands = byMatch(commandList(sources.provider, sources.commands), command => command.name, query)
      .map((command): Suggestion => ({ id: `c:${command.name}`, kind: "command", label: `/${command.name}`,
        detail: [command.hint, command.description].filter(Boolean).join(" · "), insert: `/${command.name} `, run: !command.hint }));
    // En Codex las skills también se ofrecen aquí, como en su terminal.
    const skills = sources.provider === "codex" ? byMatch(sources.skills, skill => skill.name, query).map(skillSuggestion) : [];
    return [...commands, ...skills].slice(0, 60);
  }
  if (trigger.char === "$") return byMatch(sources.skills, skill => skill.name, query).map(skillSuggestion).slice(0, 60);
  const agentQuery = query.replace(/^agent-/i, "");
  const agents = byMatch(sources.agents, agent => agent.name, agentQuery).slice(0, 8)
    .map((agent): Suggestion => ({ id: `a:${agent.name}`, kind: "agent", label: agent.name, detail: agent.description, insert: `@agent-${agent.name} ` }));
  const paths = rankPaths(sources.files ?? [], query).map(({ path, folder }): Suggestion => ({
    id: `${folder ? "d" : "f"}:${path}`, kind: folder ? "folder" : "file", label: baseName(path) + (folder ? "/" : ""),
    detail: path.slice(0, path.length - baseName(path).length - (folder ? 1 : 0)), insert: `@${path}${folder ? "" : " "}`,
  }));
  return [...agents, ...paths];
}

const skillSuggestion = (skill: SkillInfo): Suggestion => ({
  id: `s:${skill.name}`, kind: "skill", label: `$${skill.name}`, detail: skill.description, insert: `$${skill.name} `,
});
