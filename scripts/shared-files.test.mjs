import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

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
  assert.ok(!/["\n\r\\]/.test(files.FILE_SHARING_INSTRUCTIONS));
  assert.match(files.FILE_SHARING_INSTRUCTIONS, /absolute local path on a line of its own/);
});

test("Windows drives written as Unix paths point to the real file", () => {
  const windows = "D:\\proyecto", unix = "/home/ana/proyecto";
  // `/C:/…`: lo que escribe un agente que copia el ejemplo de Unix (y lo que deja `file:///C:/…`).
  assert.equal(files.localFilePath("/C:/Users/Mi PC/AppData/Local/Temp/r.png", windows), "C:/Users/Mi PC/AppData/Local/Temp/r.png");
  assert.equal(files.localFilePath("/d:/proyecto/src/app.ts:12", ""), "d:/proyecto/src/app.ts");
  assert.equal(files.localFilePath("/C:\\Users\\ana\\a.pdf", unix), "C:\\Users\\ana\\a.pdf");
  // `/c/…`: Git Bash, solo si el proyecto está en Windows; en Unix es una carpeta normal.
  assert.equal(files.localFilePath("/c/Users/Mi PC/a.png", windows), "C:/Users/Mi PC/a.png");
  assert.equal(files.localFilePath("/d/proyecto/out/CV.pdf#L3", "D:/proyecto"), "D:/proyecto/out/CV.pdf");
  assert.equal(files.localFilePath("/c/Users/ana/a.png", unix), "/c/Users/ana/a.png");
  assert.equal(files.localFilePath("/home/ana/a.png", windows), "/home/ana/a.png");
  // La respuesta real que pintaba «No se encuentra el archivo».
  assert.deepEqual(render("[resultado-oscuro.png](</C:/Users/Mi PC/AppData/Local/Temp/trex-iconos/resultado-oscuro.png>)").paragraphs[0],
    [{ path: "C:/Users/Mi PC/AppData/Local/Temp/trex-iconos/resultado-oscuro.png", label: "resultado-oscuro.png" }]);
  assert.deepEqual(render("![Captura](</c/Users/Mi PC/captura (1).png>)").paragraphs[0],
    [{ path: "C:/Users/Mi PC/captura (1).png", label: "Captura" }]);
});

/**
 * El mismo camino que el chat: react-markdown con los plugins y el filtro de
 * enlaces de `Markdown.tsx`. Devuelve los adjuntos de cada párrafo y los enlaces.
 */
function render(markdown, base = "D:\\proyecto") {
  const paragraphs = [], links = [];
  const urlTransform = (url) => files.isLocalFileHref(url) ? url : defaultUrlTransform(url);
  renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, files.remarkLocalPaths], urlTransform,
    components: {
      p: ({ node, children }) => { paragraphs.push(files.attachmentsOf(node, base)); return createElement("p", null, children); },
      a: ({ href, children }) => { links.push({ href, path: files.localFilePath(href, base) }); return createElement("a", null, children); },
    },
  }, markdown));
  return { paragraphs, links };
}

test("Windows paths attached by the agents become cards with their exact path", () => {
  // La respuesta real de Claude que no mostraba la tarjeta (las barras llegaban como %5C y se descartaban).
  const reply = "Aquí lo tienes; desde la tarjeta puedes abrirlo o guardarlo:\n\n"
    + "[agent-desktop-informe-pruebas.md](<C:\\Users\\Mi PC\\Documents\\agent-desktop-informe-pruebas.md>)\n\n"
    + "Si no te aparece la opción de descargar, el archivo también está en `C:\\Users\\Mi PC\\Documents\\`.";
  const { paragraphs } = render(reply);
  assert.equal(paragraphs[0], null);
  assert.deepEqual(paragraphs[1], [{ path: "C:\\Users\\Mi PC\\Documents\\agent-desktop-informe-pruebas.md", label: "agent-desktop-informe-pruebas.md" }]);
  assert.equal(paragraphs[2], null);
  // `\.` y `\_` son escapes de Markdown: la ruta se lee del texto original y no pierde barras.
  assert.deepEqual(render("[a.md](D:\\proyecto\\.github\\_build\\a.md)").paragraphs[0],
    [{ path: "D:\\proyecto\\.github\\_build\\a.md", label: "a.md" }]);
  assert.deepEqual(render("![Captura](<C:\\Users\\Ana\\.trex\\captura (1).png>)").paragraphs[0],
    [{ path: "C:\\Users\\Ana\\.trex\\captura (1).png", label: "Captura" }]);
});

test("attachment lines that Markdown does not parse (spaces without <>) are still cards", () => {
  const { paragraphs } = render("[Informe final.pdf](C:\\Users\\Mi PC\\Documents\\Informe final.pdf)\n"
    + "[**Datos**](</home/ana/Mis datos/datos.csv>)\n[cv.pdf](file:///C:/Users/Mi%20PC/cv.pdf)");
  assert.deepEqual(paragraphs[0], [
    { path: "C:\\Users\\Mi PC\\Documents\\Informe final.pdf", label: "Informe final.pdf" },
    { path: "/home/ana/Mis datos/datos.csv", label: "Datos" },
    { path: "C:/Users/Mi PC/cv.pdf", label: "cv.pdf" },
  ]);
  // En una frase sigue siendo texto con un enlace, y conserva la ruta exacta.
  const inline = render("Edité [app.ts](D:\\proyecto\\.github\\app.ts:12) para arreglarlo.");
  assert.equal(inline.paragraphs[0], null);
  assert.deepEqual(inline.links.map((link) => link.path), ["D:\\proyecto\\.github\\app.ts"]);
  // Las webs y los esquemas peligrosos no cambian.
  const web = render("[web](https://example.com/a.pdf)\n\n[x](javascript:alert(1))");
  assert.deepEqual(web.links.map((link) => [link.href, link.path]), [["https://example.com/a.pdf", null], ["", null]]);
  assert.deepEqual(web.paragraphs, [null, null]);
});

test("a Windows path with spaces inside a sentence is still a file link", () => {
  const { paragraphs, links } = render("La página está en [landing.html](D:\\proyecto\\out\\landing.html) y el registro "
    + "en [servidor.log](C:\\Users\\Mi PC\\Documents\\servidor.log) o en ![la captura](C:\\Users\\Mi PC\\captura (1).png).");
  assert.equal(paragraphs[0], null, "dentro de una frase son referencias, no tarjetas");
  assert.deepEqual(links.map((link) => link.path), ["D:\\proyecto\\out\\landing.html", "C:\\Users\\Mi PC\\Documents\\servidor.log"]);
  // Lo que no es una ruta con extensión sigue siendo texto.
  assert.deepEqual(render("Escribe [nombre](C:\\Mis cosas) y pulsa [Aceptar].").links, []);
  assert.deepEqual(["informe.md", "landing.HTML", "logo.svg", "datos.json", "servidor.log", "CV.pdf", "ventas.csv", "x.docx"].map(files.fileKindLabel),
    ["Markdown", "Página web", "Imagen SVG", "JSON", "Registro", "PDF", "Hoja de cálculo", "Documento"]);
});

test("network paths and Windows folders are described like the rest", () => {
  assert.equal(files.localFilePath("file://servidor/compartida/Informe.pdf", ""), "\\\\servidor\\compartida\\Informe.pdf");
  assert.equal(files.localFilePath("file://localhost/home/ana/a.pdf", ""), "/home/ana/a.pdf");
  assert.equal(files.localFilePath("C:%5CUsers%5CMi%20PC%5Ca.md", ""), "C:\\Users\\Mi PC\\a.md");
  assert.equal(files.localFilePath("%5C%5Cservidor%5Cdocs%5Ca.md", ""), "\\\\servidor\\docs\\a.md");
  assert.ok(files.isLocalFileHref("C:%5CUsers") && files.isLocalFileHref("%5C%5Cservidor%5Ca") && !files.isLocalFileHref("https://a.b"));
  const home = "C:\\Users\\Mi PC";
  assert.equal(files.folderLabel("C:\\Users\\Mi PC\\Documents\\a.md", "C:\\", home), "~\\Documents");
  assert.equal(files.folderLabel("c:\\users\\mi pc\\Documents\\a.md", "D:\\proyecto", home), "~\\Documents");
  assert.equal(files.folderLabel("C:\\Users\\Mi PC\\a.md", "", home), "~");
  assert.equal(files.folderLabel("D:\\Proyecto\\out\\a.pdf", "d:\\proyecto", home), "out");
  assert.equal(files.folderLabel("C:\\Users\\Mi PC\\app\\src\\a.ts", "C:\\Users\\Mi PC\\app", home), "src");
  assert.equal(files.folderLabel("E:\\Copias\\a.zip", "D:\\proyecto", home), "E:\\Copias");
});
