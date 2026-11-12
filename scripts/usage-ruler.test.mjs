import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/usageRuler.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { USAGE_CELLS, usageCells, layoutFlags } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("las barras tienen 25 celdas de 4 puntos y cualquier uso enciende al menos una", () => {
  assert.equal(USAGE_CELLS, 25);
  assert.deepEqual(usageCells(0, null), { filled: 0, time: null });
  assert.deepEqual(usageCells(1, 0), { filled: 1, time: 0 });
  assert.deepEqual(usageCells(75, 83), { filled: 19, time: 20 });
  assert.deepEqual(usageCells(100, 100), { filled: 25, time: 24 });
  assert.deepEqual(usageCells(140, -5), { filled: 25, time: 0 });
});

const overlaps = (a, b, width) => a.level === b.level && a.left < b.left + width && b.left < a.left + width;

test("las banderitas separadas comparten fila y el mástil cae en el valor exacto", () => {
  const places = layoutFlags([{ percent: 75, width: 60 }, { percent: 20, width: 60 }], 300);
  assert.deepEqual(places.map(place => place.level), [0, 0]);
  assert.equal(places[0].stem, 225);
  assert.equal(places[1].stem, 60);
  assert.equal(places[0].left, 195);
});

test("las etiquetas se recortan contra los bordes de la regla", () => {
  const [low, high] = layoutFlags([{ percent: 0, width: 50 }, { percent: 100, width: 50 }], 300);
  assert.equal(low.left, 0);
  assert.equal(high.left, 250);
});

test("las banderitas cercanas bajan de fila sin solaparse ni cruzar mástiles", () => {
  const flags = [{ percent: 9, width: 64 }, { percent: 0, width: 50 }, { percent: 75, width: 70 }];
  const places = layoutFlags(flags, 300);
  for (let a = 0; a < places.length; a++) for (let b = a + 1; b < places.length; b++)
    assert.ok(!overlaps(places[a], places[b], Math.max(flags[a].width, flags[b].width)), `solapan ${a} y ${b}`);
  assert.notEqual(places[0].level, places[1].level);
  assert.equal(places[2].level, 0);
  for (const [i, place] of places.entries()) for (const [j, other] of places.entries()) {
    if (i === j || other.level >= place.level) continue;
    assert.ok(other.stem < place.left || other.stem > place.left + flags[i].width, `el mástil ${j} cruza la etiqueta ${i}`);
  }
});

test("valores idénticos terminan y nunca dejan dos etiquetas en la misma fila encima", () => {
  const flags = Array.from({ length: 5 }, () => ({ percent: 40, width: 80 }));
  const places = layoutFlags(flags, 300);
  assert.equal(new Set(places.map(place => place.level)).size, 5);
});
