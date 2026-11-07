import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const pureModule = async path => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};
const { normalizeDesign, matchingFrame, reducedMotion, glassActive } = await pureModule("../src/visualDesign.ts");
const { PALETTES, paletteFor, paletteTokens } = await pureModule("../src/palettes.ts");
const { projectSections } = await pureModule("../src/sidebarGroups.ts");

test("old and malformed preferences preserve a usable terminal frame", () => {
  assert.deepEqual(normalizeDesign({}), { colorScheme:"trex",terminalRadius:22,terminalMargin:12,terminalBorder:true,motion:"system",glass:true,windowBackdrop:"solid",materialTint:60 });
  for (const value of [null, "12", NaN, Infinity]) {
    const settings = normalizeDesign({ terminalRadius:value,terminalMargin:value,colorScheme:value,terminalBorder:value,motion:value,glass:value,windowBackdrop:value,materialTint:value });
    assert.equal(settings.glass,true);
    assert.equal(settings.windowBackdrop,"solid");
    assert.equal(settings.materialTint,60);
    assert.equal(settings.terminalRadius,22);
    assert.equal(settings.terminalMargin,12);
    assert.equal(settings.colorScheme,"trex");
    assert.equal(settings.terminalBorder,true);
  }
  assert.equal(normalizeDesign({terminalRadius:-1}).terminalRadius,0);
  assert.equal(normalizeDesign({terminalMargin:100}).terminalMargin,24);
  assert.equal(normalizeDesign({terminalRadius:100}).terminalRadius,36);
  assert.equal(matchingFrame(normalizeDesign({})),"comfortable");
  assert.equal(matchingFrame(normalizeDesign({terminalRadius:0})),null);
  assert.equal(normalizeDesign({glass:false}).glass,false);
  for (const backdrop of ["solid","mica","mica-alt","acrylic"]) assert.equal(normalizeDesign({windowBackdrop:backdrop}).windowBackdrop,backdrop);
  assert.equal(normalizeDesign({windowMaterial:"mica-alt"}).windowBackdrop,"solid","the old key never brings back the material");
  assert.equal(normalizeDesign({materialTint:5}).materialTint,20,"never fully see-through");
  assert.equal(normalizeDesign({materialTint:100}).materialTint,90);
});

test("transparencies follow the setting and the system's reduce-transparency preference", () => {
  assert.equal(glassActive(true,false),true);
  assert.equal(glassActive(undefined,false),true,"on by default");
  assert.equal(glassActive(false,false),false);
  assert.equal(glassActive(true,true),false,"the system can always turn it off");
});

const luminance = hex => {
  const channels = hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
  return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
};
const contrast = (a,b) => { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };

test("every palette has readable text and meaningful ANSI colors in light and dark", () => {
  const semantic = ["red","green","yellow","blue","magenta","cyan","brightRed","brightGreen","brightYellow","brightBlue","brightMagenta","brightCyan"];
  for (const palette of PALETTES) for (const mode of ["dark","light"]) {
    const v=palette[mode];
    assert.ok(contrast(v.ui.text,v.ui.app)>=4.5,`${palette.id}/${mode}: UI text`);
    assert.ok(contrast(v.ui.muted,v.ui.sidebar)>=4.5,`${palette.id}/${mode}: muted text`);
    assert.ok(contrast(v.ui.dim,v.ui.sidebar)>=4.5,`${palette.id}/${mode}: captions`);
    assert.ok(contrast(v.terminal.foreground,v.terminal.background)>=4.5,`${palette.id}/${mode}: terminal text`);
    for (const color of semantic) assert.ok(contrast(v.terminal[color],v.terminal.background)>=4.5,`${palette.id}/${mode}: ${color}`);
    assert.equal(paletteTokens(v)["--term-bg"],v.terminal.background);
    assert.ok(v.terminal.selectionBackground && v.terminal.selectionInactiveBackground);
  }
  assert.equal(paletteFor("unknown").id,"trex");
});

test("stored palette choices keep a neutral interface and distinct terminal colors", () => {
  assert.deepEqual(PALETTES.map(palette => palette.id), ["trex", "ocean", "forest", "rose"]);
  for (const mode of ["light", "dark"]) {
    const expected = PALETTES[0][mode].ui;
    for (const palette of PALETTES) {
      assert.deepEqual(palette[mode].ui, expected, `${palette.id}: a terminal preset cannot tint the interface`);
      for (const [token, value] of Object.entries(palette[mode].ui)) {
        const channels = value.slice(1).match(/../g);
        assert.equal(new Set(channels).size, 1, `${palette.id}/${mode}/${token} must remain neutral`);
      }
    }
    assert.equal(new Set(PALETTES.map(palette => palette[mode].terminal.red)).size, 4, "ANSI preset choices remain available");
  }
});

test("favorite project sections preserve identities and each section's order", () => {
  const projects=[{id:"a"},{id:"b",favorite:true},{id:"c",favorite:true},{id:"d"}];
  const sections=projectSections(projects);
  assert.deepEqual(sections.map(section=>section.projects.map(p=>p.id)),[["b","c"],["a","d"]]);
  assert.equal(sections[0].projects[0],projects[1]);
  assert.deepEqual(projects.map(p=>p.id),["a","b","c","d"]);
  assert.deepEqual(projectSections([]),[]);
});

// --- Design tokens and stylesheet invariants ---------------------------------
const tokensCss = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
const themeBlock = theme => {
  const start = tokensCss.indexOf(theme === "dark" ? ':root[data-theme="dark"] {' : ':root[data-theme="light"] {');
  return tokensCss.slice(start, tokensCss.indexOf("\n  }", start));
};
const tokenValue = (block, name) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1];
const stylesheets = async () => {
  const { readdir } = await import("node:fs/promises");
  const dirs = ["../src/", "../src/components/", "../src/components/chat/"];
  const files = [];
  for (const dir of dirs) for (const name of await readdir(new URL(dir, import.meta.url))) if (name.endsWith(".css")) files.push(dir + name);
  return Promise.all(files.map(async file => ({ file, css: (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "") })));
};

test("design tokens define readable semantic states in both themes, distinct from the surfaces", () => {
  for (const theme of ["dark", "light"]) {
    const block = themeBlock(theme);
    const surface = tokenValue(block, "--bg-surface"), app = tokenValue(block, "--bg-app");
    assert.ok(surface && app, `${theme}: surfaces`);
    for (const state of ["ok", "warn", "danger", "info"]) {
      for (const suffix of ["", "-text", "-bg", "-border"]) assert.match(block, new RegExp(`--${state}${suffix}:`), `${theme}: --${state}${suffix}`);
      const text = tokenValue(block, `--${state}-text`);
      assert.ok(contrast(text, surface) >= 4.5, `${theme}: --${state}-text on surfaces`);
      assert.ok(contrast(text, app) >= 4.5, `${theme}: --${state}-text on the app background`);
    }
    assert.ok(contrast("#ffffff", tokenValue(block, "--danger-solid")) >= 4.5, `${theme}: destructive buttons keep white text readable`);
  }
  const scale = ["--fs-xs: 11px", "--fs-sm: 12px", "--fs-md: 13px", "--fs-base: 14px", "--fs-lg: 16px", "--fs-xl: 20px"];
  for (const step of scale) assert.ok(tokensCss.includes(step), step);
  for (const name of ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--sp-1", "--sp-8", "--shadow-1", "--shadow-4",
    "--z-dropdown", "--z-modal", "--z-toast", "--z-tooltip"]) assert.match(tokensCss, new RegExp(`${name}:`), name);
  // Former names stay available for components that still use them.
  for (const alias of ["--r-control", "--radius-control", "--surface-panel", "--shadow-pop", "--accent-ink"]) assert.match(tokensCss, new RegExp(`${alias}:`), alias);
});

test("stylesheets use one theme layer: no specificity chains, stray blur or text below 11px", async () => {
  for (const { file, css } of await stylesheets()) {
    if (!file.endsWith("tokens.css")) assert.doesNotMatch(css, /:root\[data-theme\]/, `${file}: theme values belong in tokens.css`);
    // The blur lives in glass.css only, behind its switch (see the next test).
    if (!file.endsWith("/glass.css")) assert.doesNotMatch(css, /backdrop-filter\s*:\s*(?!none)/, `${file}: backdrop blur creates extra compositing layers`);
    for (const match of css.matchAll(/font(?:-size)?\s*:[^;{}]*?(\d+(?:\.\d+)?)px/g)) {
      assert.ok(Number(match[1]) >= 11, `${file}: ${match[0].trim()} is below the 11px minimum`);
    }
  }
});

test("glass stays behind its switch, on small floating surfaces, and readable", async () => {
  const glass = (await readFile(new URL("../src/glass.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...glass.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  assert.ok(rules.length > 0);
  for (const { selector, body } of rules) {
    assert.match(selector, /^:root\[data-(glass="on"\]|material)/, `${selector}: every rule waits for its attribute`);
    if (/backdrop-filter/.test(body)) assert.match(selector, /^:root\[data-glass="on"\]/, `${selector}: blur only with the glass switch`);
    if (/data-material/.test(selector)) assert.doesNotMatch(body, /backdrop-filter/, "the material is drawn by the system, not by CSS");
    // Any material counts, but "none" (or no answer from Tauri yet) never clears the frame.
    if (/^:root\[data-material\]/.test(selector)) assert.match(selector, /^:root\[data-material\]:not\(\[data-material="none"\]\)/, selector);
  }
  const blurred = rules.filter(rule => /backdrop-filter/.test(rule.body));
  assert.ok(blurred.length <= 5, "a handful of blurred layers, not the whole interface");
  for (const { selector } of blurred) assert.doesNotMatch(selector, /\.(chat-thread|chat-scroll|terminal-host|terminals|sidebar)\b(?!-)/, `${selector}: large or scrolling areas stay opaque`);
  // WebView2 does not paint the blur on pseudo-elements: always on the element.
  for (const { selector } of blurred) assert.doesNotMatch(selector, /::?(before|after)/, `${selector}: blur on the element itself`);
  assert.ok(blurred.some(rule => /\.chat-dock\s*$/.test(rule.selector)), "the composer is glass");
  // Suggestions open inside the composer: a blur there would only see the composer.
  for (const { selector } of blurred) assert.doesNotMatch(selector, /\.chat-suggest\b/);
  // The band under the chat header stays an opaque gradient (no full-width blur on scroll).
  assert.doesNotMatch(glass, /\.chat::before/);
  // Glass surfaces keep most of their opaque color so text stays readable.
  const glassTokens = [...glass.matchAll(/--glass-[a-z]+:\s*color-mix\(in srgb, var\(--bg-[a-z]+\) (\d+)%, transparent\)/g)];
  assert.equal(glassTokens.length, 2);
  for (const [, percent] of glassTokens) assert.ok(Number(percent) >= 72, `${percent}% is too see-through`);
  // The window always keeps a graphite tint over the material, set by the user.
  assert.match(glass, /\.app \{\s*background: color-mix\(in srgb, var\(--bg-app\) var\(--material-tint, \d+%\), transparent\);/);
  // Each theme defines the layers that sit on the Windows material.
  for (const theme of ["dark", "light"]) for (const token of ["--material-layer"]) {
    assert.match(themeBlock(theme), new RegExp(`${token}:`), `${theme}: ${token}`);
  }
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /import "\.\/glass\.css";/);
});

test("the window material is only marked once Tauri confirms it, and the frame turns opaque first", async () => {
  const source = await readFile(new URL("../src/windowMaterial.ts", import.meta.url), "utf8");
  assert.match(source, /invoke<string>\("set_window_material"/);
  assert.match(source, /if \(!on\) root\.dataset\.material = "none";[\s\S]*await invoke/, "opaque before the system removes the material");
  assert.match(source, /root\.dataset\.material = MATERIALS\.has\(material\) \? material : "none"/, "only Tauri's answer turns the frame see-through");
  assert.match(source, /new Set\(\["mica", "mica-alt", "acrylic"\]\)/);
  assert.match(source, /onThemeChange/, "light and dark materials follow the interface");
});

test("scrollbars are compact and arrowless everywhere", async () => {
  // Setting scrollbar-width or scrollbar-color makes Chromium (WebView2) ignore
  // ::-webkit-scrollbar and draw the wide system bar with arrows.
  for (const { file, css } of await stylesheets()) assert.doesNotMatch(css, /scrollbar-(width|color)\s*:/, `${file}: use ::-webkit-scrollbar`);
  const styles = (await readFile(new URL("../src/styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const size = styles.match(/(?:^|\n)::-webkit-scrollbar \{ width: (\d+)px; height: (\d+)px; \}/);
  assert.ok(size && Number(size[1]) <= 8 && Number(size[2]) <= 8, "a thin bar");
  assert.match(styles, /::-webkit-scrollbar-button \{ display: none;/, "no arrows");
  assert.match(styles, /::-webkit-scrollbar-track \{ margin: 8px; \}/, "the ends stay clear of rounded corners");
});

test("on Windows the system rounds the window: the app frame is square and borderless", async () => {
  // Windows 11 redondea la ventana sin bordes (con sombra) y le pone su borde: un
  // segundo marco redondeado en CSS dejaba huecos transparentes en las esquinas.
  assert.match(tokensCss, /:root\[data-platform="windows"\]\s*\{\s*--window-radius:\s*0px;/);
  const styles = (await stylesheets()).find(({ file }) => file.endsWith("/styles.css")).css;
  assert.match(styles, /:root\[data-platform="windows"\] :is\(\.app, \.splash\)\s*\{\s*border-width:\s*0;/);
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /if \(IS_WINDOWS\) document\.documentElement\.dataset\.platform = "windows";[\s\S]*createRoot/, "set before the first paint");
});

test("usage levels and permission risks carry state colors, never the accent", async () => {
  const sheets = Object.fromEntries((await stylesheets()).map(({ file, css }) => [file.split("/").pop(), css]));
  assert.match(sheets["UsageMenu.css"], /\.chat-usage-window\.warning\s*\{[^}]*var\(--warn\)/);
  assert.match(sheets["UsageMenu.css"], /\.chat-usage-window\.critical\s*\{[^}]*var\(--danger\)/);
  assert.match(sheets["ChatView.css"], /\.plan-window\.critical\s*\{[^}]*var\(--danger\)/);
  assert.match(sheets["ComposerSettings.css"], /\.permission-badge\[data-risk="full"\][^{]*\{[^}]*--danger/);
  assert.match(sheets["ComposerSettings.css"], /\.permission-badge\[data-risk="edit"\][^{]*\{[^}]*--warn/);
  assert.match(sheets["ComposerSettings.css"], /\.permission-badge\[data-risk="read"\][^{]*\{[^}]*--ok/);
  assert.match(sheets["TaskPanel.css"], /\[data-status="failed"\] \.chat-task-mark\s*\{[^}]*--danger/);
  for (const [name, css] of Object.entries(sheets)) {
    assert.doesNotMatch(css, /\.(warning|critical|high)\b[^{]*\{[^}]*var\(--accent(-strong)?\)/, `${name}: a warning level cannot reuse the accent`);
  }
});

test("reduced motion respects both the app preference and the operating system", () => {
  assert.equal(reducedMotion("system",false),false);
  assert.equal(reducedMotion("system",true),true);
  assert.equal(reducedMotion("reduced",false),true);
  assert.equal(reducedMotion("reduced",true),true);
});
