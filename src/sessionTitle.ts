import type { TabState } from "./types";

type SessionTitle = { label: string; nativeIndicator: string | null };

// Codex antepone estos fotogramas de actividad (o el punto de aviso) al título OSC.
// Se muestran en el espacio del icono, sin añadir otra animación de TREX.
const codexIndicator = /^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●])(?:\s+|$)(.*)$/u;

export function sessionTitle(tab: Pick<TabState, "kind" | "subtitle" | "oscTitle">): SessionTitle {
  let title = tab.oscTitle?.trim() ?? "";
  const indicator = tab.kind === "codex" ? codexIndicator.exec(title) : null;
  if (indicator) title = indicator[2].trim();
  const automaticName = /^(claude|codex|shell)( \d+)?$/i.test(tab.subtitle);
  return {
    label: automaticName && title ? title : tab.subtitle,
    nativeIndicator: indicator?.[1] ?? null,
  };
}

export const sessionLabel = (tab: Pick<TabState, "kind" | "subtitle" | "oscTitle">): string => sessionTitle(tab).label;
