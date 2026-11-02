export type GitFile = { path: string; originalPath: string | null; status: string; staged: boolean; untracked: boolean; conflicted: boolean };
export type GitProjectStatus = { root: string; branch: string | null; head: string | null; detached: boolean; upstream: string | null;
  remote: string | null; remotes: string[]; ahead: number; behind: number; files: GitFile[]; totalFiles: number; token: string; operation: string | null; remoteError: string | null; warning: string | null };
export type GitProjectDiff = { files: GitFile[]; patch: string; truncated: boolean };
export const gitFileLabel = (file: GitFile): string => file.conflicted ? "Conflicto" : file.untracked ? "Nuevo"
  : file.status.includes("R") ? "Renombrado" : file.status.includes("D") ? "Eliminado" : file.status.includes("A") ? "Añadido" : "Modificado";
export function gitDiffRows(patch: string): { kind: "add" | "del" | "ctx" | "gap"; text: string }[] {
  const rows = patch.replace(/\r\n/g, "\n").split("\n"); if (rows[rows.length - 1] === "") rows.pop();
  const unified = rows.some(row => row.startsWith("@@")); let hunk = false;
  return rows.flatMap<{ kind: "add" | "del" | "ctx" | "gap"; text: string }>(row => {
    if (row.startsWith("diff --git")) { hunk = false; return []; }
    if (row.startsWith("@@")) { hunk = true; return [{ kind: "gap" as const, text: row }]; }
    if (unified && !hunk) return [];
    return [{ kind: row.startsWith("+") ? "add" as const : row.startsWith("-") ? "del" as const : "ctx" as const,
      text: /^[+\- ]/.test(row) ? row.slice(1) : row }];
  });
}
