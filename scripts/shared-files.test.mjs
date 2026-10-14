import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const files = await load("sharedFiles");
const cwd = "/home/ana/proyecto";

test("links to local files are recognized, with or without line references", () => {
  const path = (href) => files.localFilePath(href, cwd);
  assert.equal(path("/home/ana/cv/CV.pdf"), "/home/ana/cv/CV.pdf");
  assert.equal(path("file:///home/ana/Mis%20archivos/Informe.pdf"), "/home/ana/Mis archivos/Informe.pdf");
  assert.equal(path("~/Descargas/foto.png"), "~/Descargas/foto.png");
  assert.equal(path("output/pdf/CV.pdf"), "/home/ana/proyecto/output/pdf/CV.pdf");
  assert.equal(path("./src/../README.md"), "/home/ana/proyecto/README.md");
  assert.equal(path("src/app.ts:42"), "/home/ana/proyecto/src/app.ts");
  assert.equal(path("src/app.ts:42:7"), "/home/ana/proyecto/src/app.ts");
  assert.equal(path("/home/ana/proyecto/src/app.ts#L10-L20"), "/home/ana/proyecto/src/app.ts");
  assert.equal(path("C:\\Users\\ana\\cv.pdf"), "C:\\Users\\ana\\cv.pdf");
  assert.equal(files.localFilePath("file:///C:/Users/ana/cv.pdf", ""), "C:/Users/ana/cv.pdf");
  for (const web of ["https://example.com/a.pdf", "mailto:a@b.c", "#seccion", "", undefined, "javascript:alert(1)"]) assert.equal(path(web), null);
  assert.equal(files.localFilePath("docs/a.md", ""), null, "sin proyecto no hay base para una ruta relativa");
});

test("a paragraph or list made only of file links becomes attachments", () => {
  const text = (value) => ({ type: "text", value });
  const link = (href, label) => ({ type: "element", tagName: "a", properties: { href }, children: [text(label)] });
  const p = (...children) => ({ type: "element", tagName: "p", children });
  assert.deepEqual(files.attachmentsOf(p(link("/home/ana/cv/CV.pdf", "CV.pdf")), cwd), [{ path: "/home/ana/cv/CV.pdf", label: "CV.pdf" }]);
  // Varias en líneas seguidas, la etiqueta que es una ruta se cambia por el nombre y no se repiten.
  assert.deepEqual(files.attachmentsOf(p(link("out/a.png", "out/a.png"), { type: "element", tagName: "br" }, text("\n"),
    link("out/b.csv", "Datos"), text(" · "), link("out/a.png", "otra")), cwd),
    [{ path: "/home/ana/proyecto/out/a.png", label: "a.png" }, { path: "/home/ana/proyecto/out/b.csv", label: "Datos" }]);
  // Una imagen Markdown sola también es un adjunto.
  assert.deepEqual(files.attachmentsOf(p({ type: "element", tagName: "img", properties: { src: "/tmp/x.png", alt: "Captura" } }), cwd),
    [{ path: "/tmp/x.png", label: "Captura" }]);
  // Dentro de una frase, o con una web, es una referencia normal.
  assert.equal(files.attachmentsOf(p(text("Edité "), link("src/app.ts:4", "app.ts"), text(" para arreglarlo.")), cwd), null);
  assert.equal(files.attachmentsOf(p(link("https://example.com", "web")), cwd), null);
  const list = { type: "element", tagName: "ul", children: [
    { type: "element", tagName: "li", children: [link("/tmp/a.pdf", "a.pdf")] }, text("\n"),
    { type: "element", tagName: "li", children: [p(link("/tmp/b.pdf", "b.pdf"))] },
  ] };
  assert.deepEqual(files.attachmentsOf(list, cwd).map((item) => item.path), ["/tmp/a.pdf", "/tmp/b.pdf"]);
  list.children.push({ type: "element", tagName: "li", children: [text("y una nota")] });
  assert.equal(files.attachmentsOf(list, cwd), null);
});

test("files are described by kind, size and folder", () => {
  assert.deepEqual(["CV.pdf", "foto.JPG", "datos.csv", "app.tsx", "notas.md", "x.zip", "raro.xyz"].map(files.fileKind),
    ["pdf", "image", "sheet", "code", "text", "archive", "other"]);
  assert.deepEqual([830, 2048, 12_345, 3_565_158, 52_428_800, 5 * 1024 ** 3].map(files.formatBytes),
    ["830 B", "2 KB", "12 KB", "3,4 MB", "50 MB", "5 GB"]);
  assert.equal(files.folderLabel("/home/ana/proyecto/output/pdf/CV.pdf", cwd, "/home/ana"), "output/pdf");
  assert.equal(files.folderLabel("/home/ana/proyecto/CV.pdf", cwd, "/home/ana"), "proyecto");
  assert.equal(files.folderLabel("/home/ana/Descargas/CV.pdf", cwd, "/home/ana"), "~/Descargas");
  assert.equal(files.folderLabel("/tmp/CV.pdf", cwd, "/home/ana"), "/tmp");
  assert.equal(files.baseName("/home/ana/cv/"), "cv");
});

test("the agents are told how to attach files in a single shell-safe line", () => {
  assert.ok(!/["\n\r]/.test(files.FILE_SHARING_INSTRUCTIONS));
  assert.match(files.FILE_SHARING_INSTRUCTIONS, /absolute local path on a line of its own/);
});
