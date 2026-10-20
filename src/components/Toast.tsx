/**
 * Aviso flotante (toast): píldora con vidrio, icono y texto de 13 px.
 * Entra desde abajo con spring, se queda unos segundos y sale con un fundido.
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "./Icons";
import { usePresence } from "../hooks/usePresence";

type Props = {
  message: string;
  /** Milisegundos visible antes de desvanecerse. */
  duration?: number;
  onDismiss: () => void;
};

export default function Toast({ message, duration = 3200, onDismiss }: Props) {
  const [visible, setVisible] = useState(true);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(visible ? message : null, 180, surfaceRef);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // Cada mensaje reinicia la cuenta atrás (el padre lo remonta con otra key).
  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);

  // Al terminar el fundido de salida, se retira del árbol.
  useEffect(() => {
    if (presence.value === null) dismissRef.current();
  }, [presence.value]);

  return (
    <div className="toast-host" aria-live="polite" role="status">
      <div ref={surfaceRef} className={`toast${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}>
        <span className="toast-icon" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
        <span className="toast-text">{presence.value}</span>
      </div>
    </div>
  );
}
