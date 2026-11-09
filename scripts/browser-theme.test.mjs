import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { THEME_COLORS } from "../trex-browser/worker/browser-theme.mjs";
import { normalizeTheme, themeCss } from "../trex-browser/shell/theme.mjs";

const pureModule = async path => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};
const { BROWSER_THEME_TOKENS, cssColorToHex, buildBrowserTheme } = await pureModule("../src/browserTheme.ts");
const { TONE_PRESETS } = await pureModule("../src/visualDesign.ts");
const { toneUi, paletteTokens, paletteFor, accentSurfaces } = await pureModule("../src/palettes.ts");

test("CSS colours are sent as opaque #rrggbb or not at all", () => {
  assert.equal(cssColorToHex("#F06A8D"), "#f06a8d");
  assert.equal(cssColorToHex(" #abc "), "#aabbcc");
  assert.equal(cssColorToHex("rgb(240, 106, 141)"), "#f06a8d");
  assert.equal(cssColorToHex("rgb(11,14,19)"), "#0b0e13");
  for (const bad of ["", "red", "rgb(256, 0, 0)", "rgba(1, 2, 3, .5)", "#12345", "#12345678", "var(--accent)", "color-mix(in srgb, red, blue)"]) assert.equal(cssColorToHex(bad), null, bad);
});

test("the colours the app shares are the ones the worker, the shell and the native command expect", async () => {
  assert.deepEqual(Object.keys(BROWSER_THEME_TOKENS), THEME_COLORS);
  const native = await readFile(new URL("../src-tauri/src/trex_browser.rs", import.meta.url), "utf8");
  const listed = /const THEME_COLORS: \[&str; \d+\] = \[([^\]]+)\]/.exec(native)?.[1].match(/"[^"]+"/g)?.map(name => name.slice(1, -1));
  assert.deepEqual(listed, THEME_COLORS);
});

// What the app puts on <html> for a tone and mode, as getPropertyValue would return it.
const resolved = (mode, tone, accent) => {
  const ui = toneUi(mode, tone), values = paletteTokens(paletteFor("trex")[mode], ui);
  return { ...values, "--accent": `rgb(${accent.join(", ")})`, "--accent-strong": `rgb(${accent.map(channel => Math.min(255, channel + 20)).join(", ")})`, "--accent-contrast": "rgb(11, 14, 19)", surfaces: accentSurfaces(mode, ui) };
};

test("every tone preset, in both modes, becomes a theme the browser shell accepts", () => {
  for (const mode of ["dark", "light"]) for (const preset of TONE_PRESETS) {
    const values = resolved(mode, { hue: preset.hue, tint: preset.tint }, [240, 106, 141]);
    const theme = buildBrowserTheme(mode, token => values[token] ?? "");
    assert.ok(theme, `${preset.id} ${mode}`);
    assert.deepEqual(normalizeTheme(theme), theme, `${preset.id} ${mode}: the shell takes it as is`);
    assert.equal(theme.colors.app, values["--bg-app"]);
    assert.equal(theme.colors.accent, "#f06a8d");
    assert.match(themeCss(normalizeTheme(theme)), new RegExp(`--bg:${values["--bg-app"]};`));
  }
});

test("a theme the interface has not applied yet is not sent", () => {
  const values = resolved("dark", { hue: 40, tint: 100 }, [240, 106, 141]);
  assert.equal(buildBrowserTheme("dark", () => ""), null);
  assert.equal(buildBrowserTheme("dark", token => token === "--accent" ? "" : values[token] ?? ""), null);
  assert.equal(buildBrowserTheme("system", token => values[token] ?? ""), null);
});
