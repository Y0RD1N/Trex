"""Genera el sprite del loader de trex (`--loader-sprite` en src/styles.css).

El loader son cuatro huellas de tres dedos, en pixel art, que dan la vuelta por
las esquinas de un cuadrado: la más reciente a plena opacidad y las anteriores
desvaneciéndose, como el rastro de alguien que camina en círculo.

Se dibuja sobre una retícula de 11 x 11 celdas y se usa como máscara CSS, así que
toma el color del texto (`currentColor`).

Rendimiento: el SVG es estático, con los fotogramas apilados en vertical y las
opacidades ya calculadas; el CSS lo recorre con `mask-position` a saltos
(`steps()`), una propiedad que no se acelera en el compositor, de modo que WebKit
solo pinta cuando cambia el fotograma. Un SVG animado dentro de la máscara
obligaba a repintar a 60 fps mientras el agente trabajaba (~17 % de CPU).

Uso:
    python scripts/make_loader_sprite.py
Imprime `--loader-sprite` y `--loader-mask-still` listos para pegar. Si cambias el
número de fotogramas, ajusta también el tamaño de la máscara (`100% N00%`) y
`steps(N, ...)` en `--loader-motion`.
"""

from __future__ import annotations

import urllib.parse

GRID = 11
# Una huella de terópodo: tres dedos, la planta y el talón.
PRINT = ["#.#.#", "#.#.#", ".###.", "..#.."]
# Esquinas en el orden en que se pisan: arriba izquierda y en el sentido del reloj.
CORNERS = [(0, 0), (6, 0), (6, 7), (0, 7)]
# Opacidad de una huella según cuántos pasos hace que se pisó.
FADE = [1.0, 0.5, 0.22, 0.0]
# Con el movimiento reducido se ven las cuatro: la primera marcada y el resto tenues.
STILL = [1.0, 0.3, 0.3, 0.3]
FRAMES = len(CORNERS)
# Cada celda deja una rendija, para que se lea como píxeles y no como una mancha.
CELL = 0.9
INSET = (1 - CELL) / 2


def cells(corner: tuple[int, int], opacity: float, row_offset: int) -> str:
    if opacity <= 0:
        return ""
    ox, oy = corner
    return "".join(
        f"<rect x='{ox + x + INSET:.2f}' y='{oy + y + row_offset + INSET:.2f}' width='{CELL}' height='{CELL}' opacity='{opacity:.2f}'/>"
        for y, row in enumerate(PRINT)
        for x, char in enumerate(row)
        if char == "#"
    )


def data_url(svg: str) -> str:
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe="/:=' ,.-") + '")'


def sprite() -> str:
    body = "".join(
        cells(corner, FADE[(frame - index) % FRAMES], frame * GRID)
        for frame in range(FRAMES)
        for index, corner in enumerate(CORNERS)
    )
    return data_url(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {GRID} {GRID * FRAMES}'>{body}</svg>")


def still() -> str:
    body = "".join(cells(corner, STILL[index], 0) for index, corner in enumerate(CORNERS))
    return data_url(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {GRID} {GRID}'>{body}</svg>")


if __name__ == "__main__":
    print(f"  --loader-sprite: {sprite()};")
    print(f"  --loader-mask-still: {still()};")
