/**
 * Aviso flotante (toast): píldora con vidrio, icono y texto de 13 px.
 * Entra desde abajo con spring, se queda unos segundos y sale con un fundido.
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "./Icons";

type Props = {
  message: string;
  /** Milisegundos visible antes de desvanecerse. */
  duration?: number;
  onDismiss: () => void;
};

export default function Toast({ message, duration = 3200, onDismiss }: Props) {
  const [leaving, setLeaving] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // Cada mensaje reinicia la cuenta atrás (el padre lo remonta con otra key).
  useEffect(() => {
    setLeaving(false);
    const timer = window.setTimeout(() => setLeaving(true), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);

  // Al terminar el fundido de salida, se retira del árbol.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismissRef.current(), 180);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return (
    <div className="toast-host" aria-live="polite" role="status">
      <div className={`toast${leaving ? " leaving" : ""}`}>
        <span className="toast-icon" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
        <span className="toast-text">{message}</span>
      </div>
    </div>
  );
}
