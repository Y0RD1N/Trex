/**
 * Visor de archivos dentro de la app: los documentos, el código, las tablas y
 * los PDF que comparte el asistente se leen sin salir del chat.
 *
 * Aquí solo está el proveedor (ligero, en el arranque); el visor se carga en su
 * propio fragmento la primera vez que queda libre la app o que se abre.
 *
 * Uso:
 *   const viewer = useFileViewer();
 *   viewer?.open({ path, name, cwd });
 */
import { createContext, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { lazyComponent } from "../lazyComponent";

export type FileViewerRequest = {
  path: string;
  /** Nombre que se muestra (el del enlace o el del archivo). */
  name: string;
  /** Carpeta del proyecto del chat, para describir dónde está el archivo. */
  cwd: string;
};
export type FileViewerSession = FileViewerRequest & { opener: HTMLElement | null };

type FileViewerApi = { open: (request: FileViewerRequest) => void };
const FileViewerContext = createContext<FileViewerApi | null>(null);

/** null fuera del proveedor: quien lo use abre el archivo con el sistema. */
export const useFileViewer = (): FileViewerApi | null => useContext(FileViewerContext);

const FileViewerDialog = lazyComponent(() => import("./FileViewerDialog"));

export default function FileViewerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<FileViewerSession | null>(null);
  const [used, setUsed] = useState(false);
  const open = useCallback((request: FileViewerRequest) => {
    setUsed(true);
    setSession({ ...request, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);
  const close = useCallback(() => setSession(null), []);
  const api = useMemo(() => ({ open }), [open]);
  return <FileViewerContext.Provider value={api}>
    {children}
    {used && <Suspense fallback={null}><FileViewerDialog session={session} onClose={close} /></Suspense>}
  </FileViewerContext.Provider>;
}
