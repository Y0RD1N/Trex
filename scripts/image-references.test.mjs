import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { insertImageReferences, removeImageReference, moveSelection, withoutImageLabels } = await load("imageReferences");
const { userInput, codexReducer } = await load("codexChat");
const { userMessageLine, chatReducer } = await load("claudeChat");
const { initialChatState } = await load("chatState");
const selection = (start, end = start) => ({ start, end });

test("pegar cita cada imagen en el cursor y permite continuar escribiendo", () => {
  const next = insertImageReferences("Compara con esta", selection(8), 0, 2);
  assert.equal(next.text, "Compara [Imagen 1] [Imagen 2] con esta");
  assert.deepEqual(next.selection, selection(30));
  assert.deepEqual(insertImageReferences("Mira esto", selection(4), 0, 1), { text: "Mira [Imagen 1] esto", selection: selection(16) });
  assert.deepEqual(insertImageReferences("", selection(0), 0, 1), { text: "[Imagen 1] ", selection: selection(11) });
  assert.equal(insertImageReferences("á漢🙂\nfin", selection(5, 8), 2, 1).text, "á漢🙂\n[Imagen 3] ");
});

test("quitar una imagen elimina sus citas repetidas y renumera las demás con su selección", () => {
  const text = "[Imagen 1] compara [Imagen 2] y [Imagen 3]. Mira [Imagen 2] otra vez.";
  const next = removeImageReference(text, selection(text.indexOf("Mira"), text.length), 1, 3);
  assert.equal(next.text, "[Imagen 1] compara y [Imagen 2]. Mira otra vez.");
  assert.equal(next.text.slice(next.selection.start, next.selection.end), "Mira otra vez.");
  assert.equal(removeImageReference("[Imagen 1] ", selection(11), 0, 1).text, "");
  assert.equal(removeImageReference("[Imagen 1] [Imagen 99]", selection(0), 0, 1).text, "[Imagen 99]");
});

test("una lectura de portapapeles tardía conserva el punto de pegado mientras se escribe", () => {
  assert.deepEqual(moveSelection("Mira esto", "Mira esto ahora", selection(9)), selection(9));
  assert.deepEqual(moveSelection("Mira esto", "Por favor, Mira esto", selection(9)), selection(20));
  assert.deepEqual(moveSelection("Mira esto", "Mira esto", selection(5, 9)), selection(5, 9));
});

test("Codex y Claude reciben la etiqueta junto a la imagen correcta aunque se citen en otro orden", () => {
  const images = [{ mediaType: "image/png", data: "AAAA" }, { mediaType: "image/jpeg", data: "BBBB" }];
  const text = "Cambia [Imagen 2] para que se vea como [Imagen 1].";
  const codex = userInput(text, images);
  const claude = JSON.parse(userMessageLine(text, images)).message.content;
  for (const content of [codex, claude]) {
    assert.equal(content[0].text, "[Imagen 1]");
    assert.equal(content[2].text, "[Imagen 2]");
    assert.equal(content[4].text, text);
    assert.deepEqual(withoutImageLabels(content).filter(part => part.type === "text").map(part => part.text), [text]);
  }
  assert.equal(codex[1].url, "data:image/png;base64,AAAA");
  assert.equal(codex[3].url, "data:image/jpeg;base64,BBBB");
  assert.equal(claude[1].source.data, "AAAA");
  assert.equal(claude[3].source.data, "BBBB");
});

test("recuperar el historial no duplica las etiquetas ni cambia el orden de los adjuntos", () => {
  const images = [{ mediaType: "image/png", data: "AAAA" }, { mediaType: "image/jpeg", data: "BBBB" }];
  const text = "[Imagen 2] compárala con [Imagen 1].";
  const codex = codexReducer(initialChatState(), { type: "history", turns: [{ id: "t", status: "completed", items: [
    { type: "userMessage", id: "u", content: userInput(text, images) },
  ] }] });
  assert.equal(codex.items[0].text, text);
  assert.deepEqual(codex.items[0].previews, ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"]);
  const message = JSON.parse(userMessageLine(text, images, "u"));
  const claude = chatReducer(initialChatState(), { type: "history", entries: [message] });
  assert.equal(claude.items[0].text, text);
  assert.equal(claude.items[0].images, 2);
  const legacy = [{ type: "image", url: "old" }, { type: "text", text: "[Imagen 1]" }];
  assert.deepEqual(withoutImageLabels(legacy), legacy);
});

test("los archivos adjuntos viajan como rutas al final y se recuperan del historial", async () => {
  const { withAttachedFiles, splitAttachedFiles, referenceParts, insertImageReferences, removeImageReference } = await load("imageReferences");
  const paths = ["C:\Users\Ana\informe final.pdf", "/home/ana/datos.csv"];
  const text = withAttachedFiles("Resume [Archivo 1] con [Archivo 2]", paths);
  assert.equal(text, "Resume [Archivo 1] con [Archivo 2]\n\nArchivos adjuntos:\n[Archivo 1]: C:\Users\Ana\informe final.pdf\n[Archivo 2]: /home/ana/datos.csv");
  assert.deepEqual(splitAttachedFiles(text), { text: "Resume [Archivo 1] con [Archivo 2]", files: paths });
  assert.deepEqual(splitAttachedFiles(withAttachedFiles("", paths.slice(1))), { text: "", files: paths.slice(1) });
  assert.deepEqual(splitAttachedFiles("Sin adjuntos"), { text: "Sin adjuntos", files: [] });
  assert.equal(withAttachedFiles("Hola", []), "Hola");

  assert.equal(insertImageReferences("Lee", selection(3), 1, 1, "Archivo").text, "Lee [Archivo 2] ");
  assert.equal(removeImageReference("[Imagen 1] [Archivo 1] [Archivo 2]", selection(0), 0, 2, "Archivo").text, "[Imagen 1] [Archivo 1]");

  assert.deepEqual(referenceParts("Mira [Imagen 1] y [Archivo 3]", { Imagen: 1, Archivo: 2 }), [
    { text: "Mira " }, { kind: "Imagen", index: 0, text: "[Imagen 1]" }, { text: " y [Archivo 3]" },
  ]);
  assert.deepEqual(referenceParts(""), [{ text: "" }]);
});
