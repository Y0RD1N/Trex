/**
 * Sistema de diálogos propio de trex (sustituye a los diálogos nativos del
 * sistema operativo, que rompían por completo la estética de la app).
 *
 * Uso:
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm({ title: "…", tone: "danger" }))) return;
 *   await dialog.alert({ title: "…", message: "…" });
 *
 * El host se monta una sola vez (en App) y gestiona una cola: si llega un
 * diálogo mientras hay otro abierto, se muestra al terminar el primero.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Dialog, { type DialogTone } from "./Dialog";

export type ConfirmOptions = {
  title: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

export type AlertOptions = {
  title: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
};

export type DialogApi = {
  /** Pregunta al usuario y resuelve `true` solo si confirma. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Aviso con un único botón de aceptar. */
  alert: (options: AlertOptions) => Promise<void>;
};

const DialogContext = createContext<DialogApi | null>(null);

/** Acceso al sistema de diálogos. Debe usarse dentro de `<DialogProvider>`. */
export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog() necesita un <DialogProvider> por encima");
  return api;
}

type Entry = {
  id: number;
  title: string;
  message?: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string | null;
  tone: DialogTone;
  resolve: (value: boolean) => void;
};

/** Duración de la animación de salida (debe coincidir con el CSS). */
const EXIT_MS = 160;

export default function DialogProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [leaving, setLeaving] = useState(false);

  const entryRef = useRef<Entry | null>(null);
  const queueRef = useRef<Entry[]>([]);
  const leavingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);

  const enqueue = useCallback(
    (
      options: ConfirmOptions & { kind: "confirm" | "alert" },
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const item: Entry = {
          id: (nextIdRef.current += 1),
          title: options.title,
          message: options.message,
          detail: options.detail,
          confirmLabel: options.confirmLabel?.trim() || "Aceptar",
          // Un alert solo tiene el botón de aceptar.
          cancelLabel:
            options.kind === "alert" ? null : options.cancelLabel?.trim() || "Cancelar",
          tone: options.kind === "alert" ? "default" : options.tone ?? "default",
          resolve,
        };
        if (entryRef.current) {
          queueRef.current.push(item);
          return;
        }
        entryRef.current = item;
        setEntry(item);
      }),
    [],
  );

  /** Cierra el diálogo actual (con animación) y pasa al siguiente de la cola. */
  const finish = useCallback((value: boolean) => {
    const current = entryRef.current;
    if (!current || leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      leavingRef.current = false;
      setLeaving(false);
      const next = queueRef.current.shift() ?? null;
      entryRef.current = next;
      setEntry(next);
      current.resolve(value);
    }, EXIT_MS);
  }, []);

  // Si la app se desmonta con diálogos pendientes, se resuelven para no colgar
  // a quien los esté esperando (los cierres de pestaña y proyecto esperan aquí).
  useEffect(() => {
    const queue = queueRef.current;
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      queueRef.current = [];
      queue.forEach((item) => item.resolve(false));
      entryRef.current?.resolve(false);
    };
  }, []);

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (options) => enqueue({ ...options, kind: "confirm" }),
      alert: async (options) => {
        await enqueue({ ...options, kind: "alert" });
      },
    }),
    [enqueue],
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {entry && (
        <Dialog
          key={entry.id}
          title={entry.title}
          message={entry.message}
          detail={entry.detail}
          confirmLabel={entry.confirmLabel}
          cancelLabel={entry.cancelLabel}
          tone={entry.tone}
          leaving={leaving}
          onConfirm={() => finish(true)}
          onCancel={() => finish(false)}
        />
      )}
    </DialogContext.Provider>
  );
}
