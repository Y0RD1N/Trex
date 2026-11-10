/**
 * Qué hacer cuando la configuración no se puede cargar. Nunca se sustituye por
 * los valores por defecto en silencio ni se guarda nada encima sin que la
 * persona lo decida: un archivo bloqueado un instante o dañado no debe costar
 * los proyectos y perfiles.
 */
import type { AppConfig } from "./types";

export type ConfigFailure = {
  /** "unreadable": existe pero no se pudo leer. "corrupt": se leyó y no es válido. */
  kind: "unreadable" | "corrupt";
  message: string;
  /** Copia que el backend hizo del archivo dañado. */
  backup: string | null;
  /** Hay una copia válida del último arranque correcto. */
  previous: boolean;
};

/** Lee el rechazo de `load_config`. Lo que no se reconoce cuenta como ilegible: es el caso que nunca sobrescribe. */
export function configFailure(error: unknown): ConfigFailure {
  const data = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : typeof data?.message === "string" ? data.message : "";
  return {
    kind: data?.kind === "corrupt" ? "corrupt" : "unreadable",
    message: text || "No se pudo leer el archivo de configuración.",
    backup: typeof data?.backup === "string" && data.backup ? data.backup : null,
    previous: data?.previous === true,
  };
}

type Question = { title: string; message: string; detail?: string; confirmLabel: string; cancelLabel: string; tone?: "default" | "danger" };
export type RecoveryIo = {
  confirm: (question: Question) => Promise<boolean>;
  load: () => Promise<AppConfig>;
  restore: () => Promise<AppConfig>;
};
/** `config` null: empezar con los valores por defecto. `save` false: esta sesión no escribe la configuración. */
export type Recovery = { config: AppConfig | null; save: boolean };

const WITHOUT_SAVING = "Seguir sin guardar";
const UNTOUCHED = "No se ha cambiado nada en el disco.";

/**
 * Pregunta hasta tener una configuración que usar. Cerrar un diálogo o pulsar
 * Esc lleva siempre a la salida que no escribe nada.
 */
export async function recoverConfig(first: ConfigFailure, io: RecoveryIo): Promise<Recovery> {
  let failure = first;
  for (;;) {
    if (failure.kind === "unreadable") {
      const retry = await io.confirm({
        title: "No se pudo leer tu configuración",
        message: failure.message,
        detail: `${UNTOUCHED} Puede que otro programa tenga el archivo abierto: vuelve a intentarlo, o sigue con los valores por defecto sin guardar nada en esta sesión.`,
        confirmLabel: "Reintentar", cancelLabel: WITHOUT_SAVING,
      });
      if (!retry) return { config: null, save: false };
      try { return { config: await io.load(), save: true }; }
      catch (error) { failure = configFailure(error); }
      continue;
    }
    const kept = failure.backup ? ` El archivo dañado se ha copiado a «${failure.backup}».` : "";
    if (failure.previous) {
      const restore = await io.confirm({
        title: "Tu configuración está dañada",
        message: failure.message,
        detail: `${UNTOUCHED}${kept} Hay una copia del último arranque correcto: puedes volver a ella.`,
        confirmLabel: "Restaurar la copia anterior", cancelLabel: "Otras opciones",
      });
      if (restore) {
        try { return { config: await io.restore(), save: true }; }
        // La copia dejó de servir: quedan las opciones sin copia.
        catch { failure = { ...failure, previous: false }; continue; }
      }
    }
    const fresh = await io.confirm({
      title: failure.previous ? "¿Empezar de cero?" : "Tu configuración está dañada",
      message: failure.previous ? "Se guardará una configuración nueva en lugar de la dañada." : failure.message,
      detail: `${failure.previous ? "" : `${UNTOUCHED}${kept} `}Empezar de cero crea una configuración nueva, sin proyectos ni perfiles. Si prefieres arreglar el archivo a mano, sigue sin guardar y cierra trex.`.trim(),
      confirmLabel: "Empezar de cero", cancelLabel: WITHOUT_SAVING, tone: "danger",
    });
    return { config: null, save: fresh };
  }
}
