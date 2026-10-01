import type { AgentActivity, TabKind } from "../types";
import { TerminalIcon } from "./Icons";

export default function AgentIcon({ kind, size = 15, activity = "idle" }: { kind: TabKind; size?: number; activity?: AgentActivity }) {
  return <span className={`agent-icon agent-icon-${kind}`} data-activity={kind === "shell" ? "idle" : activity}
    style={{ width: size, height: size, fontSize: size }} aria-hidden="true">
    {kind === "claude" ? "✳" : kind === "shell" ? <TerminalIcon size={size} />
      : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></svg>}
  </span>;
}
