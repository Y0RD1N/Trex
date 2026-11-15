import type { AgentActivity, TabKind } from "../types";
import { AntigravityIcon, AsteriskIcon, CodeIcon, StarburstIcon, TerminalIcon } from "./Icons";

export default function AgentIcon({ kind, size = 15, activity = "idle", nativeIndicator }: { kind: TabKind; size?: number; activity?: AgentActivity; nativeIndicator?: string | null }) {
  const native = kind === "codex" ? nativeIndicator : null;
  return <span className={`agent-icon agent-icon-${kind}${native ? " agent-icon-native" : ""}`} data-activity={kind === "shell" ? "idle" : activity}
    style={{ width: size, height: size, fontSize: size }} aria-hidden="true">
    {native ?? (kind === "claude" ? <AsteriskIcon size={size} />
      : kind === "trex" ? <StarburstIcon size={size} />
      : kind === "antigravity" ? <AntigravityIcon size={size} />
      : kind === "shell" ? <TerminalIcon size={size} />
      : <CodeIcon size={size} />)}
  </span>;
}
