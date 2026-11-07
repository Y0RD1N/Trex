/**
 * Material de la ventana en Windows 11: Mica, Mica intensa o Acrílico.
 *
 * Tauri aplica el material y responde cuál quedó puesto; solo entonces se marca
 * `data-material` y glass.css aclara el marco. Al apagarlo, el marco vuelve a
 * ser opaco antes de retirar el material, así que nunca asoma el escritorio sin
 * difuminar. Pasar de un material a otro no lo vuelve opaco: los tres los pinta
 * el sistema. Sigue por su cuenta al modo claro u oscuro de la interfaz.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "./platform";
import { getThemeMode, onThemeChange } from "./theme";
import { glassActive, systemReducesTransparency, type WindowMaterial } from "./visualDesign";

const MATERIALS: ReadonlySet<string> = new Set(["mica", "mica-alt", "acrylic"]);

let wanted = false;
let wantedMaterial: WindowMaterial = "solid";
let request = 0;
let applied = "";
let subscribed = false;

const apply = async (): Promise<void> => {
  const root = document.documentElement;
  const on = IS_WINDOWS && isTauri() && wantedMaterial !== "solid" && glassActive(wanted, systemReducesTransparency());
  const key = on ? `${wantedMaterial}:${getThemeMode()}` : "none";
  if (key === applied) return;
  const ticket = ++request;
  // Primero opaco: el marco no espera a que el sistema retire el material.
  if (!on) root.dataset.material = "none";
  if (!IS_WINDOWS || !isTauri()) {
    applied = key;
    return;
  }
  try {
    const material = await invoke<string>("set_window_material", {
      material: on ? wantedMaterial : "none",
      dark: getThemeMode() === "dark",
    });
    if (ticket !== request) return;
    root.dataset.material = MATERIALS.has(material) ? material : "none";
    applied = MATERIALS.has(material) ? key : "none";
  } catch {
    if (ticket !== request) return;
    root.dataset.material = "none";
    applied = "";
  }
};

/** Pone o quita el material según «Efecto cristal» y el fondo elegido («solid»: ninguno). */
export const syncWindowMaterial = (enabled: boolean, material: WindowMaterial): void => {
  wanted = enabled;
  wantedMaterial = material;
  if (!subscribed) {
    subscribed = true;
    onThemeChange(() => { void apply(); });
  }
  void apply();
};
