/**
 * Aviso flotante (toast): píldora con vidrio, icono y texto de 13 px.
 * Entra desde abajo con spring, se queda unos segundos y sale con un fundido.
 */
import { useEffect, useRef, useState } from "react";
import { AlertIcon, CheckIcon } from "./Icons";
import { usePresence } from "../hooks/usePresence";

/** Los avisos de fallo llevan el icono y el color de error, no la marca de éxito. */
const ERROR_MESSAGE = /^(no se (pudo|puede|ha podido)|error|fall[óo]|imposible|no hay conexión)/i;

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

  const failed = ERROR_MESSAGE.test(presence.value?.trim() ?? "");
  return (
    <div className="toast-host" aria-live={failed ? "assertive" : "polite"} role={failed ? "alert" : "status"}>
      <div ref={surfaceRef} className={`toast${failed ? " error" : ""}${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}>
        <span className="toast-icon" aria-hidden="true">
          {failed ? <AlertIcon size={14} /> : <CheckIcon size={14} />}
        </span>
        <span className="toast-text">{presence.value}</span>
      </div>
    </div>
  );
}
