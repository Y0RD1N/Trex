import type { AgentActivity, TabKind } from "../types";
import { TerminalIcon } from "./Icons";

export default function AgentIcon({ kind, size = 15, activity = "idle", nativeIndicator }: { kind: TabKind; size?: number; activity?: AgentActivity; nativeIndicator?: string | null }) {
  const native = kind === "codex" ? nativeIndicator : null;
  return <span className={`agent-icon agent-icon-${kind}${native ? " agent-icon-native" : ""}`} data-activity={kind === "shell" ? "idle" : activity}
    style={{ width: size, height: size, fontSize: size }} aria-hidden="true">
    {native ?? (kind === "claude" ? "✳" : kind === "trex" ? "✴" : kind === "shell" ? <TerminalIcon size={size} />
      : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></svg>)}
  </span>;
}
