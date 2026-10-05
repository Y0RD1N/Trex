export type TerminalSize = { cols: number; rows: number };

type ResizeTarget = {
  measure: () => TerminalSize | undefined;
  currentSize: () => TerminalSize;
  session: () => string | null;
  apply: (size: TerminalSize) => void;
  notify: (id: string, size: TerminalSize) => Promise<void>;
  refresh: () => void;
};

const sameSize = (a: TerminalSize, b: TerminalSize): boolean => a.cols === b.cols && a.rows === b.rows;
const validSize = (size: TerminalSize | undefined): size is TerminalSize => !!size
  && Number.isInteger(size.cols) && Number.isInteger(size.rows) && size.cols >= 2 && size.rows >= 2;

/** Agrupa la rejilla y el aviso al PTY: nunca se hace reflow durante el debounce. */
export class TerminalResizeCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private ptySize: (TerminalSize & { id: string }) | undefined;
  private disposed = false;

  constructor(private readonly target: ResizeTarget, private readonly delay = 120) {}

  spawned(id: string, size: TerminalSize): void {
    this.ptySize = { id, ...size };
    this.request(); // El contenedor pudo cambiar mientras arrancaba el proceso.
  }

  request(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const size = this.target.measure();
    if (!validSize(size)) return; // Una pestaña oculta conserva su tamaño y buffer.
    const id = this.target.session();
    if (!id) {
      this.target.apply(size); // El proceso nace con la medida real, sin esperar.
      return;
    }
    if (sameSize(size, this.target.currentSize()) && this.ptySize?.id === id && sameSize(size, this.ptySize)) {
      this.target.refresh(); // Cambiar de pestaña con el mismo tamaño no avisa al PTY.
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Las llamadas IPC se serializan: una respuesta antigua no restaura otro tamaño.
      this.pending = this.pending.then(() => this.commit()).catch(() => {
        // No se recuerda un tamaño que falló: el siguiente ajuste puede reintentarlo.
      });
    }, this.delay);
  }

  private async commit(): Promise<void> {
    if (this.disposed) return;
    // Se mide al aplicar, incluso si hubo otra animación, pestaña o reinicio en cola.
    const size = this.target.measure();
    if (!validSize(size)) return;
    const id = this.target.session();
    if (!id) return;
    if (!sameSize(size, this.target.currentSize())) this.target.apply(size);
    if (this.ptySize?.id !== id || !sameSize(size, this.ptySize)) {
      await this.target.notify(id, size);
      if (this.disposed || this.target.session() !== id) return;
      this.ptySize = { id, ...size };
    }
    this.target.refresh();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
