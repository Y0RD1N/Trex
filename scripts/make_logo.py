"""Genera el logo de trex: el cráneo de un Tyrannosaurus rex en pixel art.

El dibujo es una retícula de 32 x 22 celdas, de perfil y mirando a la derecha,
con la forma de un cráneo real: cuña con una cresta sobre el ojo, tres
aberturas (la temporal detrás del ojo, la grande delante y una pequeña más
adelante), el orificio nasal, dientes más largos en el centro y una mandíbula
articulada atrás. El ojo es el único punto de color: el cursor de un terminal.

Este script es la única fuente del dibujo. Escribe:
  - public/trex.svg                 icono de la app (cuadro oscuro + cráneo)
  - src/components/brandSkull.ts    los trazos, para pintarlo dentro de la app

Uso:
    python scripts/make_logo.py
Después, `python scripts/make_icon.py` regenera los PNG, ICO e ICNS.
"""

from __future__ import annotations

from pathlib import Path

WIDTH, HEIGHT = 32, 22
BONE, SHADE, EYE, EMPTY = "#", "+", "o", "."
# Cada celda deja una rendija, para que se lea como píxeles.
CELL = 0.92
INSET = (1 - CELL) / 2

TILE = "#111111"
BONE_COLOR = "#ece3cf"
SHADE_COLOR = "#a89d86"
EYE_COLOR = "#f06a8d"


def bitmap() -> list[list[str]]:
    grid = [[EMPTY] * WIDTH for _ in range(HEIGHT)]

    def fill(x0: int, x1: int, y0: int, y1: int, value: str) -> None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                grid[y][x] = value

    # Cráneo: columnas (x0, x1) con su borde superior e inferior. La cresta sobre
    # el ojo (x 9-12) es el punto más alto; desde ahí baja hacia el hocico y la nuca.
    for x0, x1, top, bottom in [
        (2, 2, 6, 12), (3, 3, 5, 13), (4, 4, 4, 13), (5, 5, 4, 12), (6, 6, 4, 11), (7, 8, 3, 11),
        (9, 12, 2, 11), (13, 13, 3, 11), (14, 20, 4, 12), (21, 25, 5, 12), (26, 29, 6, 12), (30, 30, 7, 11),
    ]:
        fill(x0, x1, top, bottom, BONE)
    fill(6, 13, 11, 11, SHADE)
    fill(2, 2, 6, 12, SHADE)
    # Ventana temporal, estrechada por el medio.
    fill(4, 6, 6, 7, EMPTY)
    fill(5, 5, 8, 8, EMPTY)
    fill(4, 6, 9, 10, EMPTY)
    # Cuenca del ojo, en forma de cerradura.
    fill(9, 11, 4, 6, EYE)
    fill(10, 10, 7, 9, EMPTY)
    # Abertura anteorbital (triangular) y la pequeña de delante.
    fill(14, 19, 6, 6, EMPTY)
    fill(14, 18, 7, 7, EMPTY)
    fill(15, 17, 8, 8, EMPTY)
    fill(15, 16, 9, 9, EMPTY)
    fill(21, 22, 8, 8, EMPTY)
    # Orificio nasal.
    fill(26, 28, 7, 7, EMPTY)
    fill(26, 27, 8, 8, EMPTY)
    # Dientes de arriba: los más largos, en el centro.
    for x, tip in [(15, 14), (17, 15), (19, 15), (21, 15), (23, 14), (25, 14), (27, 14), (29, 13)]:
        fill(x, x, 13, tip, BONE)
    # Mandíbula: alta atrás, donde se articula, y afinándose hacia la punta.
    for x0, x1, top, bottom in [(3, 5, 14, 17), (6, 10, 15, 19), (11, 20, 16, 19), (21, 25, 16, 18), (26, 28, 16, 17), (29, 29, 16, 16)]:
        fill(x0, x1, top, bottom, BONE)
    fill(3, 5, 17, 17, SHADE)
    fill(6, 20, 19, 19, SHADE)
    fill(21, 25, 18, 18, SHADE)
    fill(26, 28, 17, 17, SHADE)
    # Dientes de abajo, intercalados con los de arriba.
    for x, tip in [(16, 15), (18, 14), (20, 14), (22, 14), (24, 15), (26, 15), (28, 15)]:
        fill(x, x, tip, 15, BONE)
    return grid


def number(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def path(grid: list[list[str]], kind: str) -> str:
    return "".join(
        f"M{number(x + INSET)} {number(y + INSET)}h{CELL}v{CELL}h-{CELL}z"
        for y, row in enumerate(grid)
        for x, value in enumerate(row)
        if value == kind
    )


def bounds(grid: list[list[str]]) -> tuple[int, int, int, int]:
    xs = [x for row in grid for x, value in enumerate(row) if value != EMPTY]
    ys = [y for y, row in enumerate(grid) if any(value != EMPTY for value in row)]
    return min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    grid = bitmap()
    bone, shade, eye = path(grid, BONE), path(grid, SHADE), path(grid, EYE)
    x, y, width, height = bounds(grid)

    # Icono: el cráneo centrado en el cuadro, a 24 unidades por celda.
    scale = 24
    left = (1024 - width * scale) / 2 - x * scale
    top = (1024 - height * scale) / 2 - y * scale
    icon = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n'
        f'  <rect x="32" y="32" width="960" height="960" rx="224" fill="{TILE}"/>\n'
        f'  <g transform="translate({number(left)} {number(top)}) scale({scale})">\n'
        f'    <path d="{bone}" fill="{BONE_COLOR}"/>\n'
        f'    <path d="{shade}" fill="{SHADE_COLOR}"/>\n'
        f'    <path d="{eye}" fill="{EYE_COLOR}"/>\n'
        "  </g>\n"
        "</svg>\n"
    )
    (root / "public" / "trex.svg").write_text(icon, encoding="utf-8", newline="\n")

    module = (
        "// Generado por scripts/make_logo.py: no lo edites a mano. El dibujo se cambia allí.\n"
        "/** Recuadro que ocupa el cráneo dentro de su retícula (x, y, ancho, alto). */\n"
        f"export const SKULL_BOX = [{x}, {y}, {width}, {height}] as const;\n"
        f'export const SKULL_BONE = "{bone}";\n'
        f'export const SKULL_SHADE = "{shade}";\n'
        f'export const SKULL_EYE = "{eye}";\n'
    )
    (root / "src" / "components" / "brandSkull.ts").write_text(module, encoding="utf-8", newline="\n")
    print(f"Logo escrito: public/trex.svg y src/components/brandSkull.ts ({width} x {height} celdas)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
