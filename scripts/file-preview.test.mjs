import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const preview = await load("filePreview");

test("documents, code, tables and PDFs are read inside the app; the rest opens outside", () => {
  const kind = (path) => preview.previewKind(path, true);
  assert.deepEqual(["informe.md", "README.markdown", "datos.csv", "datos.TSV", "pagina.html", "logo.svg", "CV.pdf"].map(kind),
    ["markdown", "markdown", "table", "table", "html", "svg", "pdf"]);
  assert.deepEqual(["app.tsx", "main.rs", "config.yaml", "C:\\proyecto\\Dockerfile", "/srv/Makefile", "datos.json"].map(kind),
    ["code", "code", "code", "code", "code", "code"]);
  assert.deepEqual(["notas.txt", "servidor.log", ".env", ".gitignore"].map(kind), ["text", "text", "text", "text"]);
  for (const outside of ["informe.docx", "datos.xlsx", "x.zip", "foto.png", "video.mp4", "sin-extension", "C:\\Users\\Ana\\Documents\\"]) {
    assert.equal(kind(outside), null, outside);
  }
  // Sin visor de PDF (WebKitGTK), el PDF se abre con el sistema.
  assert.equal(preview.previewKind("CV.pdf", false), null);
  assert.equal(preview.canPreviewPdf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0"), true);
  assert.equal(preview.canPreviewPdf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"), true);
  assert.equal(preview.canPreviewPdf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)"), false);
  assert.deepEqual(["informe.md", "datos.csv", "pagina.html", "logo.svg", "app.ts", "CV.pdf"].map((path) => preview.hasSourceView(kind(path))),
    [true, true, true, true, false, false]);
  assert.equal(preview.previewLanguage("C:\\a\\b.tsx"), "typescript");
  assert.equal(preview.previewLanguage("notas.txt"), null);
});

test("previews decode text, drop a cut character and refuse binary data", () => {
  const utf8 = new TextEncoder().encode("\ufeffAcción ✓");
  assert.deepEqual(preview.decodePreview(utf8), { text: "Acción ✓", binary: false });
  // El límite de lectura cortó «✓» (3 bytes) por la mitad: no queda un carácter roto al final.
  assert.deepEqual(preview.decodePreview(utf8.subarray(0, utf8.length - 1)), { text: "Acción ", binary: false });
  assert.equal(preview.decodePreview(new Uint8Array([0x25, 0x50, 0x00, 0x01])).binary, true);
  const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x6f, 0x00, 0x6c, 0x00, 0x61, 0x00]);
  assert.deepEqual(preview.decodePreview(utf16), { text: "Hola", binary: false });
});

test("CSV tables keep quoted fields and count every row", () => {
  const csv = "nombre,nota\r\n\"Pérez, Ana\",9\n\"Dice \"\"hola\"\"\",7\n\"dos\nlíneas\",5\n\n";
  const { rows, total } = preview.parseDelimited(csv, ",");
  assert.deepEqual(rows, [["nombre", "nota"], ["Pérez, Ana", "9"], ["Dice \"hola\"", "7"], ["dos\nlíneas", "5"]]);
  assert.equal(total, 4);
  const many = preview.parseDelimited("a\n1\n2\n3\n4", ",", 3);
  assert.deepEqual([many.rows.length, many.total], [3, 5]);
  assert.equal(preview.tableDelimiter("a.csv", "nombre;nota;curso\n1,5;2;3"), ";");
  assert.equal(preview.tableDelimiter("a.csv", "nombre,nota\n1;2"), ",");
  assert.equal(preview.tableDelimiter("a.tsv", "a,b"), "\t");
  // Cifras a la derecha; fechas y textos a la izquierda; las celdas vacías no cuentan.
  const body = [["2026-02-02", "Cliente 1, S.L.", "3", "137,50", "12 %", ""], ["2026-03-03", "Cliente 2", "", "1.275,00 €", "-4%", ""]];
  assert.deepEqual(preview.numericColumns(body, 6), [false, false, true, true, true, false]);
});

test("HTML previews cannot reach the network", () => {
  const policy = /Content-Security-Policy" content="default-src 'none'/;
  assert.match(preview.isolatedHtml("<html><head><title>x</title></head><body>hola</body></html>"), /<head><meta http-equiv="Content-Security-Policy"/);
  assert.match(preview.isolatedHtml("<p>sin cabecera</p>"), policy);
});
