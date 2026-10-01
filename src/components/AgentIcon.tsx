import type { TabKind } from "../types";
import { TerminalIcon } from "./Icons";

export default function AgentIcon({ kind, size = 15 }: { kind: TabKind; size?: number }) {
  if (kind === "claude") return <span aria-hidden="true">✳</span>;
  if (kind === "shell") return <TerminalIcon size={size} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></svg>;
}
