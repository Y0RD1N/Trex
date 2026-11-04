/**
 * Resaltador de código de las respuestas del chat.
 *
 * Se carga aparte (import dinámico desde `Markdown.tsx`) para que highlight.js
 * no pese en el arranque de la app, y se crea una sola vez: cada gramática se
 * compila la primera vez que se usa y no en cada mensaje (rehype-highlight
 * creaba otro lowlight, y lo volvía a compilar, en cada pintado).
 *
 * Solo lenguajes habituales en un proyecto de software; el resto (y los bloques
 * sin lenguaje) se muestran como texto plano.
 */
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { HastNode } from "./chatMarkdown";

const lowlight = createLowlight({
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java, javascript, json, kotlin, lua, makefile, markdown,
  php, plaintext, powershell, python, ruby, rust, scss, shell, sql, typescript, xml, yaml,
});
// Nombres que usan los modelos y que las gramáticas no declaran.
lowlight.registerAlias({ json: ["jsonc", "json5"], ini: ["toml", "conf"], plaintext: ["text", "txt"], dockerfile: ["docker", "containerfile"],
  bash: ["sh", "zsh"], powershell: ["ps1", "pwsh"], typescript: ["tsx", "mts", "cts"], javascript: ["jsx", "mjs", "cjs"] });

/**
 * Tokens coloreados (nodos hast de lowlight, clases `hljs-*`) o null si el
 * lenguaje no está registrado o su gramática falla: el bloque queda en plano.
 */
export function highlightCode(language: string, value: string): HastNode[] | null {
  if (!lowlight.registered(language)) return null;
  try {
    return lowlight.highlight(language, value, { prefix: "hljs-" }).children as unknown as HastNode[];
  } catch {
    return null;
  }
}
