/** Archivos editados en un turno: usa el diff neto del proveedor cuando existe. */
import { diffStats, inputDiff, relativePath, type ChatItem, type DiffLine, type ToolItem } from "./chatState";

export type ChangedFile = {
  path: string;
  previousPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed";
  added: number;
  removed: number;
  diff: DiffLine[];
};
export type WorkSummary = { files: ChangedFile[]; added: number; removed: number };
export type SummaryCache = Map<string, { item: ChatItem; cwd: string; summary: WorkSummary }>;
export type ChangeNode = { name: string; path: string; added: number; removed: number; files: number;
  file?: ChangedFile; children: ChangeNode[] };

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Delete", "Move", "NotebookEdit"]);
const normalize = (path: string, cwd: string): string => relativePath(path.replace(/\\/g, "/"), cwd).replace(/^\.\//, "");
const keyOf = (path: string, cwd: string): string => /^[A-Za-z]:[\\/]/.test(cwd) ? path.toLowerCase() : path;

function toolFile(item: ToolItem, cwd: string): ChangedFile | null {
  if (item.status !== "done" || !EDIT_TOOLS.has(item.name)) return null;
  const original = item.input.file_path ?? item.input.notebook_path;
  if (typeof original !== "string" || !original) return null;
  const destination = typeof item.input.destination === "string" ? item.input.destination : "";
  const diff = item.patch ?? inputDiff(item.name, item.input, Number.MAX_SAFE_INTEGER) ?? [];
  return { path: normalize(destination || original, cwd), ...(destination ? { previousPath: normalize(original, cwd) } : {}),
    kind: destination ? "renamed" : item.input.changeKind === "add" ? "added" : item.name === "Delete" ? "deleted" : "modified",
    ...(item.changeStats ?? diffStats(diff)), diff };
}

/** Rutas entrecomilladas por Git, incluidas sus secuencias octales UTF-8. */
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index++) {
    if (value[index] !== "\\") { bytes.push(...new TextEncoder().encode(value[index])); continue; }
    const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); index += 3; }
    else { const escaped = value[++index]; bytes.push(...new TextEncoder().encode(({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[escaped] ?? escaped)); }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** El diff de Codex abarca el turno entero, sin sumar dos veces las ediciones de un archivo. */
export function filesFromDiff(raw: string, cwd: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let file: ChangedFile | null = null;
  let inHunk = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const paths = line.slice(11);
      const match = /^(?:"(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(paths);
      const path = match ? gitPath(match[1]).replace(/^b\//, "") : "";
      file = path ? { path: normalize(path, cwd), kind: "modified", added: 0, removed: 0, diff: [] } : null;
      if (file) files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.kind = "added";
    else if (line.startsWith("deleted file mode")) file.kind = "deleted";
    else if (line.startsWith("rename from ")) { file.kind = "renamed"; file.previousPath = gitPath(line.slice(12)); }
    else if (line.startsWith("rename to ")) file.path = normalize(gitPath(line.slice(10)), cwd);
    else if (line.startsWith("@@")) {
      if (inHunk) file.diff.push({ kind: "gap", text: "…" });
      inHunk = true;
    } else if (inHunk && /^[ +\-]/.test(line)) {
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
      file.diff.push({ kind, text: line.slice(1) });
      if (kind === "add") file.added++;
      if (kind === "del") file.removed++;
    }
  }
  return files;
}

export function summarizeWork(items: ChatItem[], cwd: string, rawDiff?: string): WorkSummary {
  const byPath = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const file = toolFile(item, cwd);
    if (!file) continue;
    const key = keyOf(file.path, cwd);
    const previous = byPath.get(key);
    if (previous) byPath.set(key, { ...file, kind: previous.kind === "added" && file.kind !== "deleted" ? "added" : file.kind,
      added: previous.added + file.added, removed: previous.removed + file.removed,
      diff: [...previous.diff, ...(previous.diff.length && file.diff.length ? [{ kind: "gap" as const, text: "…" }] : []), ...file.diff] });
    else byPath.set(key, file);
  }
  const netFiles = rawDiff ? filesFromDiff(rawDiff, cwd) : [];
  const files = (rawDiff === "" ? [] : netFiles.length ? netFiles : [...byPath.values()]).sort((a, b) => a.path.localeCompare(b.path, "es", { numeric: true }));
  return { files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) };
}

/** Cada resumen pertenece a su turno, incluso al recuperar el historial. */
export function completedWork(items: ChatItem[], cwd: string, historyCount = 0, cache?: SummaryCache): Map<string, WorkSummary> {
  const summaries = new Map<string, WorkSummary>();
  let start = 0;
  items.forEach((item, index) => {
    if (index === historyCount) start = index;
    if (item.kind !== "turn") return;
    const saved = cache?.get(item.id);
    const summary = saved?.item === item && saved.cwd === cwd ? saved.summary : summarizeWork(items.slice(start, index), cwd, item.diff);
    summaries.set(item.id, summary);
    cache?.set(item.id, { item, cwd, summary });
    start = index + 1;
  });
  if (cache) for (const id of cache.keys()) if (!summaries.has(id)) cache.delete(id);
  return summaries;
}

export function changeTree(files: ChangedFile[]): ChangeNode[] {
  const roots: ChangeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let children = roots, path = "";
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      let node = children.find(child => child.path === path);
      if (!node) { node = { name, path, added: 0, removed: 0, files: 0, children: [] }; children.push(node); }
      node.added += file.added;
      node.removed += file.removed;
      node.files++;
      if (index === parts.length - 1) node.file = file;
      children = node.children;
    });
  }
  const sort = (nodes: ChangeNode[]): ChangeNode[] => nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file)
    || a.name.localeCompare(b.name, "es", { numeric: true })).map(node => ({ ...node, children: sort(node.children) }));
  return sort(roots);
}
