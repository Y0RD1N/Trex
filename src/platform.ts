/**
 * Detalles de la plataforma que solo afectan a las etiquetas de la interfaz.
 *
 * En macOS los atajos se anuncian con "⌘"; en el resto, con "Ctrl". El
 * comportamiento de los atajos es idéntico (el hook acepta ctrlKey o metaKey).
 */
const platformText = (): string => {
  if (typeof navigator === "undefined") return "";
  const platform = typeof navigator.platform === "string" ? navigator.platform : "";
  const agent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  return `${platform} ${agent}`;
};

/** ¿Estamos en macOS? */
export const IS_MAC: boolean = /mac/i.test(platformText());

/** Etiqueta del modificador principal: "⌘" en macOS, "Ctrl" en el resto. */
export const MOD_LABEL: string = IS_MAC ? "⌘" : "Ctrl";
