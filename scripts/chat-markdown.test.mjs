import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const markdown = await load("chatMarkdown");
const text = (value) => ({ type: "text", value });
const element = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
const transform = (tree) => { markdown.rehypeCallouts()(tree); return tree; };

test("> [!NOTE] and friends become callouts without the label", () => {
  // Así llega `> [!WARNING]\n> Haz copia antes.` desde remark.
  const quote = element("blockquote", [text("\n"), element("p", [text("[!WARNING]\nHaz copia antes.")]), text("\n")]);
  transform({ type: "root", children: [quote] });
  assert.deepEqual(quote.properties.className, ["chat-callout", "warning"]);
  assert.equal(markdown.nodeText(quote).trim(), "Haz copia antes.");
});

test("a label alone on its line leaves no empty paragraph", () => {
  const quote = element("blockquote", [element("p", [text("[!tip]")]), element("p", [text("Usa turbo.")])]);
  transform({ type: "root", children: [element("div", [quote])] });
  assert.deepEqual(quote.properties.className, ["chat-callout", "tip"]);
  assert.deepEqual(quote.children.map((child) => markdown.nodeText(child)), ["Usa turbo."]);
});

test("ordinary quotes and unknown labels stay as quotes", () => {
  const plain = element("blockquote", [element("p", [text("Una cita normal.")])]);
  const unknown = element("blockquote", [element("p", [text("[!DANGER] no existe")])]);
  transform({ type: "root", children: [plain, unknown] });
  assert.equal(plain.properties.className, undefined);
  assert.equal(unknown.properties.className, undefined);
  assert.equal(markdown.nodeText(unknown), "[!DANGER] no existe");
});
