import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const pureModule = async path => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};
const { normalizeDesign, matchingFrame, reducedMotion } = await pureModule("../src/visualDesign.ts");
const { PALETTES, paletteFor, paletteTokens } = await pureModule("../src/palettes.ts");
const { projectSections, sessionGroups } = await pureModule("../src/sidebarGroups.ts");

test("old and malformed preferences preserve a usable terminal frame", () => {
  assert.deepEqual(normalizeDesign({}), { colorScheme:"trex",terminalRadius:22,terminalMargin:12,terminalBorder:true,motion:"system" });
  for (const value of [null, "12", NaN, Infinity]) {
    const settings = normalizeDesign({ terminalRadius:value,terminalMargin:value,colorScheme:value,terminalBorder:value,motion:value });
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

test("favorite sections and assistant groups preserve identities and each group's order", () => {
  const projects=[{id:"a"},{id:"b",favorite:true},{id:"c",favorite:true},{id:"d"}];
  const sections=projectSections(projects);
  assert.deepEqual(sections.map(section=>section.projects.map(p=>p.id)),[["b","c"],["a","d"]]);
  assert.equal(sections[0].projects[0],projects[1]);
  assert.deepEqual(projects.map(p=>p.id),["a","b","c","d"]);
  const tabs=[{id:"cx",kind:"codex"},{id:"c1",kind:"claude"},{id:"sh",kind:"shell"},{id:"c2",kind:"claude"}];
  assert.deepEqual(sessionGroups(tabs).map(group=>group.tabs.map(tab=>tab.id)),[["c1","c2"],["cx"],["sh"]]);
  assert.deepEqual(projectSections([]),[]);
  assert.deepEqual(sessionGroups([]),[]);
});

test("reduced motion respects both the app preference and the operating system", () => {
  assert.equal(reducedMotion("system",false),false);
  assert.equal(reducedMotion("system",true),true);
  assert.equal(reducedMotion("reduced",false),true);
  assert.equal(reducedMotion("reduced",true),true);
});
