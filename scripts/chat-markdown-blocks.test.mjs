/**
 * Las respuestas se pintan por bloques de Markdown (rendimiento al recibirlas
 * por partes). Cada bloque debe interpretarse igual que dentro del texto
 * completo: se compara el HTML de ambos caminos con react-markdown real.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { load } from "./ts-loader.mjs";

const { markdownBlocks, codeLanguage } = await load("chatMarkdown");
const render = (text) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
// Entre bloques de primer nivel react-markdown deja saltos de línea que no se ven.
const html = (value) => value.replace(/>\n+</g, "><").trim();
const byBlocks = (text) => renderToStaticMarkup(createElement(Fragment, null,
  ...markdownBlocks(text).map((block, index) => createElement(Markdown, { key: index, remarkPlugins: [remarkGfm] }, block))));

const samples = {
  paragraphs: "Uno.\n\nDos con **negrita** y `código`.\n\n\nTres tras dos líneas en blanco.",
  headings: "# Título\n\nTexto.\n\n## Sección\n\nMás texto\n===\n\n---\n\nFinal.",
  looseList: "1. Primero\n\n2. Segundo\n\n3. Tercero\n\nDespués de la lista.",
  tightAndNested: "- a\n- b\n  - b1\n\n    continuación sangrada\n- c\n\nPárrafo.\n\n* otra lista\n\n+ y otra",
  fences: "Antes.\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nEntre.\n\n~~~~\n```\nno cierra\n\n~~~~\n\nDespués.",
  unclosedFence: "Texto.\n\n```bash\necho uno\n\necho dos",
  indentedCode: "Párrafo.\n\n    código sangrado\n\n    sigue\n\nFin.",
  table: "Tabla:\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nNota al final.",
  quotes: "> [!NOTE]\n> Aviso.\n\n> Otra cita\n\nTexto.",
  references: "Ver [doc][1].\n\nOtro párrafo.\n\n[1]: https://example.com",
  footnotes: "Texto con nota[^1].\n\nMás.\n\n[^1]: La nota.",
  htmlComment: "Antes.\n\n<!--\n\noculto\n\n-->\n\nDespués.",
  orderedStart: "Intro.\n\n3. tres\n4. cuatro\n\n5) cinco",
  leadingBlank: "\n\nEmpieza con líneas en blanco.\n\nY sigue.",
  trailing: "Termina con espacio.\n\n",
  partialList: "1. a\n\n2",
  setextAfterBlank: "Párrafo\n\n===",
};

for (const [name, text] of Object.entries(samples)) {
  test(`markdown blocks render like the whole text: ${name}`, () => {
    assert.equal(html(byBlocks(text)), html(render(text)));
  });
}

test("every prefix of a streamed answer renders like the whole prefix", () => {
  const answer = Object.values(samples).slice(0, 10).join("\n\n");
  for (let end = 1; end <= answer.length; end += 7) {
    const prefix = answer.slice(0, end);
    assert.equal(html(byBlocks(prefix)), html(render(prefix)), `prefix of ${end} chars`);
  }
});

test("blocks only cut on safe blank lines and keep the text", () => {
  assert.deepEqual(markdownBlocks("Uno.\n\nDos."), ["Uno.", "Dos."]);
  assert.deepEqual(markdownBlocks("1. a\n\n2. b"), ["1. a\n\n2. b"]);
  assert.deepEqual(markdownBlocks("```\na\n\nb\n```\n\nc"), ["```\na\n\nb\n```", "c"]);
  assert.deepEqual(markdownBlocks("a\n\n[x]: https://example.com"), ["a\n\n[x]: https://example.com"]);
  assert.deepEqual(markdownBlocks("sin cortes"), ["sin cortes"]);
  // Los bloques terminados no cambian al llegar más texto: no se repintan.
  const before = markdownBlocks("Uno.\n\nDos.\n\nTr");
  const after = markdownBlocks("Uno.\n\nDos.\n\nTres y más");
  assert.deepEqual(before.slice(0, 2), after.slice(0, 2));
});

test("code language is read like rehype-highlight does", () => {
  const code = (...className) => ({ type: "element", tagName: "code", properties: { className }, children: [] });
  assert.equal(codeLanguage(code("language-ts")), "ts");
  assert.equal(codeLanguage(code("lang-rust")), "rust");
  assert.equal(codeLanguage(code("language-js", "no-highlight")), false);
  assert.equal(codeLanguage({ type: "element", tagName: "code", properties: {}, children: [] }), undefined);
  assert.equal(codeLanguage(undefined), undefined);
});
