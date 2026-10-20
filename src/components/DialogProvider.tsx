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
import type { FloatingAnchor } from "../hooks/useFloatingPosition";

export type ConfirmOptions = {
  /** Control que abrió el aviso; se captura su posición antes de cambiar la UI. */
  trigger?: HTMLElement | null;
  returnFocus?: HTMLElement | null;
  title: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

export type AlertOptions = {
  trigger?: HTMLElement | null;
  returnFocus?: HTMLElement | null;
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
  anchor: FloatingAnchor | null;
  returnFocus: HTMLElement | null;
  id: number;
  title: string;
  message?: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string | null;
  tone: DialogTone;
  resolve: (value: boolean) => void;
};

export default function DialogProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [leaving, setLeaving] = useState(false);

  const entryRef = useRef<Entry | null>(null);
  const queueRef = useRef<Entry[]>([]);
  const leavingRef = useRef(false);
  const resultRef = useRef(false);
  const nextIdRef = useRef(0);

  const enqueue = useCallback(
    (
      options: ConfirmOptions & { kind: "confirm" | "alert" },
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const trigger = options.trigger === undefined
          ? document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("button, [role=button]") : null
          : options.trigger;
        const rect = trigger?.getBoundingClientRect();
        const usable = trigger?.isConnected && rect && rect.width > 0 && rect.height > 0 && !trigger.closest("[inert]");
        // Un elemento del menú desaparecerá: conservamos la posición que tenía al pulsarlo.
        const anchor: FloatingAnchor | null = usable
          ? trigger.closest('[role="menu"]') ? { rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } } : { element: trigger }
          : null;
        const item: Entry = {
          anchor,
          returnFocus: options.returnFocus ?? trigger,
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
    resultRef.current = value;
    setLeaving(true);
  }, []);

  // La tarjeta avisa al terminar su salida real; la cola no depende de un timer.
  const advance = useCallback(() => {
    const current = entryRef.current;
    if (!current || !leavingRef.current) return;
    leavingRef.current = false;
    setLeaving(false);
    const next = queueRef.current.shift() ?? null;
    entryRef.current = next;
    setEntry(next);
    current.resolve(resultRef.current);
  }, []);

  // Si la app se desmonta con diálogos pendientes, se resuelven para no colgar
  // a quien los esté esperando (los cierres de pestaña y proyecto esperan aquí).
  useEffect(() => {
    const queue = queueRef.current;
    return () => {
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
          anchor={entry.anchor}
          returnFocus={entry.returnFocus}
          title={entry.title}
          message={entry.message}
          detail={entry.detail}
          confirmLabel={entry.confirmLabel}
          cancelLabel={entry.cancelLabel}
          tone={entry.tone}
          leaving={leaving}
          onExited={advance}
          onConfirm={() => finish(true)}
          onCancel={() => finish(false)}
        />
      )}
    </DialogContext.Provider>
  );
}
