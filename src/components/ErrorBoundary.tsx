/**
 * Red de seguridad de la interfaz. Sin ella, un error al pintar un componente
 * desmonta todo el árbol de React y la ventana se queda en blanco, sin barra
 * lateral ni forma de salir.
 *
 *   - `scope="view"`: una vista (un chat). El resto de trex sigue en pie y la
 *     pestaña se puede reintentar.
 *   - `scope="app"`: la aplicación entera. Solo ofrece recargar la ventana.
 *
 * Es texto plano y alineado a la izquierda, como una salida de terminal: dice
 * qué pasó, enseña el error tal cual y ofrece una acción. Sin icono ni tarjeta.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import "./ErrorBoundary.css";

type Props = { scope: "view" | "app"; children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[trex] error al pintar (${this.props.scope})`, error, info.componentStack);
  }

  private retry = (): void => this.setState({ error: null });
  private reload = (): void => window.location.reload();

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const app = this.props.scope === "app";
    return <div className={`error-boundary${app ? " is-app" : ""}`} role="alert">
      <div className="error-boundary-body">
        <h2>{app ? "La ventana de trex dejó de dibujarse." : "Esta vista dejó de dibujarse."}</h2>
        <p>{app ? "Tus proyectos y conversaciones guardados siguen donde estaban. Recarga para continuar." : "Lo demás sigue funcionando: la barra lateral y el resto de pestañas no se tocaron."}</p>
        <pre>{error.message || String(error)}</pre>
        <button type="button" className="btn" onClick={app ? this.reload : this.retry}>{app ? "Recargar ventana" : "Volver a dibujar"}</button>
      </div>
    </div>;
  }
}
