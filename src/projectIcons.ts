/** Logo de cada proyecto en la barra lateral; sin logo se muestra la carpeta. */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const cache = new Map<string, Promise<string | null>>();

/** Se busca una vez por ruta mientras la app está abierta. */
export function projectIcon(path: string): Promise<string | null> {
  let pending = cache.get(path);
  if (!pending) {
    pending = isTauri()
      ? invoke<string | null>("project_icon", { path }).catch(() => null)
      : Promise.resolve(null);
    cache.set(path, pending);
  }
  return pending;
}

export function useProjectIcon(path: string): string | null {
  const [icon, setIcon] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void projectIcon(path).then(url => { if (alive) setIcon({ path, url }); });
    return () => { alive = false; };
  }, [path]);
  return icon?.path === path ? icon.url : null;
}
