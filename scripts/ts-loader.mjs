/**
 * Carga módulos TypeScript de src/ en las pruebas, sin compilar el proyecto.
 *
 * Transpila cada archivo y resuelve sus imports relativos de la misma forma;
 * las llamadas a Tauri se sustituyen por un módulo que falla si se usan.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const stub = `data:text/javascript;base64,${Buffer.from('export const invoke = () => { throw new Error("Unexpected native call"); };').toString("base64")}`;
const urls = new Map();

async function moduleUrl(name) {
  if (!urls.has(name)) urls.set(name, (async () => {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    let { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    outputText = outputText.replace(/from "@tauri-apps\/[^"]+"/g, `from "${stub}"`);
    for (const [statement, specifier] of [...outputText.matchAll(/from "(\.\.?\/[^"]+)"/g)]) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      outputText = outputText.replace(statement, `from "${await moduleUrl(target)}"`);
    }
    return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  })());
  return urls.get(name);
}

/** Importa `src/<name>.ts`. */
export const load = async (name) => import(await moduleUrl(name));
