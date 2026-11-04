import type { ITheme } from "@xterm/xterm";
import type { ColorScheme } from "./visualDesign";

export type SurfacePalette = {
  app: string; sidebar: string; surface: string; elevated: string; inset: string;
  border: string; borderStrong: string; text: string; muted: string; dim: string; selected: string;
};
export type PaletteVariant = { ui: SurfacePalette; terminal: ITheme };
type Palette = { id: ColorScheme; name: string; description: string; accent: string; dark: PaletteVariant; light: PaletteVariant };

const ansiKeys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const variant = (ui: SurfacePalette, foreground: string, ansi: string[], selection: string): PaletteVariant => ({
  ui,
  terminal: { background: ui.app, foreground, selectionBackground: `${selection}50`, selectionInactiveBackground: `${selection}28`,
    ...Object.fromEntries(ansiKeys.map((key, index) => [key, ansi[index]])) },
});

/**
 * Surfaces are shared by every preset; ANSI colors remain provider output.
 * Dark is graphite rather than pure black (less glare); the sidebar sits one
 * step deeper and floating surfaces one step lighter. Light keeps white
 * reading surfaces with a visible gray chrome, so it never looks washed out.
 * Mirrored as defaults in tokens.css for the first paint.
 */
export const MONOCHROME_UI: Record<"dark" | "light", SurfacePalette> = {
  dark: { app:"#161616",sidebar:"#111111",surface:"#1c1c1c",elevated:"#212121",inset:"#262626",border:"#2c2c2c",borderStrong:"#404040",text:"#ebebeb",muted:"#a8a8a8",dim:"#8e8e8e",selected:"#2b2b2b" },
  light: { app:"#ffffff",sidebar:"#f6f6f6",surface:"#ffffff",elevated:"#ffffff",inset:"#f3f3f3",border:"#e6e6e6",borderStrong:"#d2d2d2",text:"#171717",muted:"#5e5e5e",dim:"#6e6e6e",selected:"#ececec" },
};

const TERMINAL_PALETTES: readonly Palette[] = [
  { id: "trex", name: "Grafito", description: "Neutro y cálido", accent: "#e8834a",
    dark: variant({ app:"#121212",sidebar:"#060606",surface:"#171717",elevated:"#1d1d1d",inset:"#0b0b0b",border:"#242424",borderStrong:"#383838",text:"#ececec",muted:"#a5a5a5",dim:"#878787",selected:"#1d1d1d" }, "#e4e7ec",
      ["#2b3340","#f2687f","#7fd962","#e6b455","#6cb6ff","#c58af9","#56d4dd","#c8ccd4","#6f7a8c","#ff8095","#9ae86e","#f5cd7c","#8ec7ff","#d8a6ff","#7ee2ea","#f2f4f8"], "#768fb8"),
    light: variant({ app:"#faf9f6",sidebar:"#f1f0ec",surface:"#ffffff",elevated:"#ffffff",inset:"#eae9e5",border:"#e1e0db",borderStrong:"#cecdc6",text:"#29292f",muted:"#62626b",dim:"#6b6b74",selected:"#e2e1dc" }, "#1b1f27",
      ["#24292f","#cf222e","#1a7f37","#9a6700","#0969da","#8250df","#1b7c83","#6b7280","#57606a","#a40e26","#116329","#7d4e00","#0550ae","#6639ba","#0f6672","#12161c"], "#2563eb") },
  { id: "ocean", name: "Océano", description: "Azules profundos", accent: "#7aa2f7",
    dark: variant({ app:"#1b2433",sidebar:"#151d2a",surface:"#232f42",elevated:"#2b3950",inset:"#121b28",border:"#33435b",borderStrong:"#496180",text:"#e4edf9",muted:"#afc0d7",dim:"#8da4c3",selected:"#2c405d" }, "#dce7f5",
      ["#26364a","#f28b9b","#8bd5a2","#e8c77c","#82b5ff","#c1a4ef","#7ad5e4","#c7d5e8","#8da4c3","#ffacb9","#b0ecc3","#ffe09e","#a8cdff","#dac5ff","#a1e9f2","#f2f7ff"], "#739bcb"),
    light: variant({ app:"#f5f8fd",sidebar:"#e9eff8",surface:"#ffffff",elevated:"#ffffff",inset:"#dfe8f4",border:"#d5dfed",borderStrong:"#bdccdf",text:"#23354e",muted:"#516580",dim:"#5b6e86",selected:"#d9e5f5" }, "#23354e",
      ["#23354e","#b53654","#237649","#8f650b","#2459af","#7850a7","#1a7382","#66778c","#526780","#98263f","#175c36","#745000","#174894","#613d91","#0c5a67","#142840"], "#3477cf") },
  { id: "forest", name: "Bosque", description: "Verdes tranquilos", accent: "#4cc2b0",
    dark: variant({ app:"#1c2926",sidebar:"#15201d",surface:"#24342f",elevated:"#2d4039",inset:"#111c18",border:"#344a42",borderStrong:"#4a665b",text:"#e3eee8",muted:"#abc1b5",dim:"#8ea99a",selected:"#304b40" }, "#dcebe2",
      ["#273c32","#ef9494","#94d7a0","#dfc27a","#8cbcf0","#c7a1da","#75d5c0","#c8dace","#8ea99a","#ffb0ad","#b6eabd","#f5dc9c","#b0d6ff","#e1bcf1","#9cead9","#f1faf4"], "#6aab91"),
    light: variant({ app:"#f4f9f5",sidebar:"#e8f0e9",surface:"#ffffff",elevated:"#ffffff",inset:"#dce8df",border:"#d3e1d7",borderStrong:"#b7cdbf",text:"#243b2f",muted:"#526d5d",dim:"#536e5e",selected:"#d5e6db" }, "#243b2f",
      ["#243b2f","#b63847","#23743b","#8b640e","#2c609d","#8050a0","#167565","#63796a","#526d5d","#972b37","#175c2b","#704e04","#214c83","#674088","#095a4d","#163022"], "#32966c") },
  { id: "rose", name: "Ciruela", description: "Violetas suaves", accent: "#b494ed",
    dark: variant({ app:"#282330",sidebar:"#201b27",surface:"#332d3d",elevated:"#3c3449",inset:"#1a1521",border:"#473c53",borderStrong:"#625271",text:"#eee7f5",muted:"#c1b2ce",dim:"#a894b9",selected:"#483853" }, "#e9e0f0",
      ["#3a2e44","#f394ac","#a5d29a","#e7c384","#9bb8f4","#d0a8ef","#8bcdd5","#d8c8e1","#a894b9","#ffb1c5","#c4e7b9","#ffdfa7","#bdd1ff","#e6c6ff","#aee6eb","#fbf3ff"], "#b18bc8"),
    light: variant({ app:"#fbf7fc",sidebar:"#f1eaf4",surface:"#ffffff",elevated:"#ffffff",inset:"#e8dfee",border:"#e3d7e9",borderStrong:"#cfbed8",text:"#3b2b46",muted:"#705c7e",dim:"#756181",selected:"#e7dced" }, "#3b2b46",
      ["#3b2b46","#b13359","#397b36","#926413","#3b5ba8","#8b459e","#24747c","#7b6c83","#6a5678","#932645","#29612a","#754e09","#2c478e","#743685","#175b63","#2a1935"], "#9c5cbb") },
];

// Keep stored scheme IDs and all ANSI choices. Selecting a preset no longer
// introduces a second color palette into the rest of the interface.
export const PALETTES: readonly Palette[] = TERMINAL_PALETTES.map(palette => ({
  ...palette,
  dark: { ui: MONOCHROME_UI.dark, terminal: { ...palette.dark.terminal, background: MONOCHROME_UI.dark.app,
    foreground: MONOCHROME_UI.dark.text, selectionBackground:"#ffffff30",selectionInactiveBackground:"#ffffff18" } },
  light: { ui: MONOCHROME_UI.light, terminal: { ...palette.light.terminal, background: MONOCHROME_UI.light.app,
    foreground: MONOCHROME_UI.light.text, selectionBackground:"#00000024",selectionInactiveBackground:"#00000012" } },
}));

export const paletteFor = (id: unknown): Palette => PALETTES.find(palette => palette.id === id) ?? PALETTES[0];

export const paletteTokens = (variant: PaletteVariant): Record<string, string> => {
  const u = variant.ui;
  return { "--bg-app":u.app,"--bg-sidebar":u.sidebar,"--bg-surface":u.surface,"--bg-elevated":u.elevated,"--bg-inset":u.inset,
    "--term-bg":variant.terminal.background!,"--term-fg":variant.terminal.foreground!,"--border":u.border,"--border-strong":u.borderStrong,
    "--text":u.text,"--text-muted":u.muted,"--text-dim":u.dim,"--session-selected":u.selected,
    "--scroll-thumb":u.borderStrong,"--scroll-thumb-hover":u.dim };
};
