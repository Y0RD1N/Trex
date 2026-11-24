import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "./ts-loader.mjs";

// The colours the desktop shares with the remote control (the phone page and the iPhone app).
const { REMOTE_THEME_TOKENS, cssColorToHex, buildRemoteTheme } = await load("remoteTheme");
const { TONE_PRESETS } = await load("visualDesign");
const { toneUi, paletteTokens, paletteFor, accentSurfaces } = await load("palettes");

test("CSS colours are sent as opaque #rrggbb or not at all", () => {
  assert.equal(cssColorToHex("#F06A8D"), "#f06a8d");
  assert.equal(cssColorToHex(" #abc "), "#aabbcc");
  assert.equal(cssColorToHex("rgb(240, 106, 141)"), "#f06a8d");
  assert.equal(cssColorToHex("rgb(11,14,19)"), "#0b0e13");
  for (const bad of ["", "red", "rgb(256, 0, 0)", "rgba(1, 2, 3, .5)", "#12345", "#12345678", "var(--accent)", "color-mix(in srgb, red, blue)"]) assert.equal(cssColorToHex(bad), null, bad);
});

test("the shared colours are the ones the phone page and the iPhone app read", async () => {
  const app = await readFile(new URL("../src/remote/RemoteApp.tsx", import.meta.url), "utf8");
  assert.match(app, /Object\.entries\(REMOTE_THEME_TOKENS\)/, "the phone page applies the same tokens");
  const swift = await readFile(new URL("../ios/Sources/TrexRemote/Theme.swift", import.meta.url), "utf8");
  const mapping = /let mapping: \[\(String, WritableKeyPath<Palette, Color>\)\] = \[([\s\S]*?)\n\s*\]/.exec(swift)?.[1];
  assert.ok(mapping, "Theme.swift keeps its key mapping");
  assert.deepEqual([...mapping.matchAll(/\("(\w+)"/g)].map(match => match[1]), Object.keys(REMOTE_THEME_TOKENS));
});

// What the app puts on <html> for a tone and mode, as getPropertyValue would return it.
const resolved = (mode, tone, accent) => {
  const ui = toneUi(mode, tone), values = paletteTokens(paletteFor("trex")[mode], ui);
  return { ...values, "--accent": `rgb(${accent.join(", ")})`, "--accent-strong": `rgb(${accent.map(channel => Math.min(255, channel + 20)).join(", ")})`, "--accent-contrast": "rgb(11, 14, 19)", surfaces: accentSurfaces(mode, ui) };
};

test("every tone preset, in both modes, becomes a complete theme", () => {
  for (const mode of ["dark", "light"]) for (const preset of TONE_PRESETS) {
    const values = resolved(mode, { hue: preset.hue, tint: preset.tint }, [240, 106, 141]);
    const theme = buildRemoteTheme(mode, token => values[token] ?? "");
    assert.ok(theme, `${preset.id} ${mode}`);
    assert.equal(theme.mode, mode);
    assert.deepEqual(Object.keys(theme.colors), Object.keys(REMOTE_THEME_TOKENS));
    for (const [name, value] of Object.entries(theme.colors)) assert.match(value, /^#[0-9a-f]{6}$/, `${preset.id} ${mode} ${name}`);
    assert.equal(theme.colors.app, values["--bg-app"]);
    assert.equal(theme.colors.accent, "#f06a8d");
  }
});

test("a theme the interface has not applied yet is not sent", () => {
  const values = resolved("dark", { hue: 40, tint: 100 }, [240, 106, 141]);
  assert.equal(buildRemoteTheme("dark", () => ""), null);
  assert.equal(buildRemoteTheme("dark", token => token === "--accent" ? "" : values[token] ?? ""), null);
  assert.equal(buildRemoteTheme("system", token => values[token] ?? ""), null);
});
