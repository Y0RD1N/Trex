import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Función con identidad fija que siempre llama a la última versión de `callback`.
 * Sirve para pasar acciones a filas memorizadas sin que se repinten en cada render.
 */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const ref = useRef(callback);
  useLayoutEffect(() => { ref.current = callback; });
  return useCallback((...args: Args) => ref.current(...args), []);
}
