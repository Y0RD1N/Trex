"""Genera el sprite del loader de trex (`--loader-sprite` en src/styles.css).

El loader es un zarpazo: tres arañazos de garra en diagonal, el del centro más
largo, que se marcan uno tras otro de arriba abajo, se quedan un momento y se
desvanecen. Las puntas de cada arañazo van más suaves: la garra entra y sale.

Se dibuja en pixel art sobre una retícula de 11 x 11 y se pinta a tamaño
natural (11 px, o 55 en la pantalla de carga): a escala entera cada celda cae
en un píxel y la diagonal sale nítida, sin el emborronado de escalar 11 celdas
a 14 px. Se usa como máscara CSS, así que toma el color del texto
(`currentColor`).

Rendimiento: el SVG es estático, con los fotogramas apilados en vertical y las
opacidades ya calculadas; el CSS lo recorre con `mask-position` a saltos
(`steps()`), una propiedad que no se acelera en el compositor, de modo que WebKit
solo pinta cuando cambia el fotograma. Un SVG animado dentro de la máscara
obligaba a repintar a 60 fps mientras el agente trabajaba (~17 % de CPU). Un
fotograma cada 100 ms, en la misma rejilla que los demás indicadores (ver
src/activityMotion.ts).

Uso:
    python scripts/make_loader_sprite.py
Imprime `--loader-sprite` y `--loader-mask-still` listos para pegar. Si cambias el
número de fotogramas, ajusta también el tamaño de la máscara (`100% N00%`) y
`steps(N, ...)` y la duración (N x 100 ms) en `--loader-motion`.
"""

from __future__ import annotations

import math
import urllib.parse

GRID = 11
# Cada arañazo es la diagonal x + y = c, de arriba a la derecha hacia abajo a la
# izquierda, entre las filas y0 e y1 (incluidas).
CLAWS = [(7, 0, 7), (10, 0, 10), (13, 3, 10)]
# Fotogramas: cuánto de cada arañazo está marcado y con qué opacidad. Se marcan en
# 300 ms, se quedan 300 ms y se desvanecen en otros 300 ms.
FRAMES = [
    ((0.5, 0, 0), 1.0),
    ((1, 0.5, 0), 1.0),
    ((1, 1, 0.5), 1.0),
    ((1, 1, 1), 1.0),
    ((1, 1, 1), 1.0),
    ((1, 1, 1), 1.0),
    ((1, 1, 1), 0.55),
    ((1, 1, 1), 0.3),
    ((1, 1, 1), 0.14),
]
# Con el movimiento reducido se ven los tres arañazos, quietos.
STILL = ((1, 1, 1), 1.0)
# Opacidad máxima de las puntas.
TIP = 0.55


def cells(drawn: tuple[float, ...], level: float) -> dict[float, list[tuple[int, int]]]:
    """Celdas encendidas de un fotograma, agrupadas por opacidad."""
    by_opacity: dict[float, list[tuple[int, int]]] = {}
    for (c, y0, y1), amount in zip(CLAWS, drawn):
        if amount <= 0:
            continue
        # Redondeo de medio hacia arriba, como `Math.round` (lo usa la vista remota).
        up_to = y0 + math.floor((y1 - y0) * amount + 0.5)
        for y in range(y0, min(y1, up_to) + 1):
            opacity = min(level, TIP) if y in (y0, y1) else level
            by_opacity.setdefault(opacity, []).append((c - y, y))
    return by_opacity


def paths(drawn: tuple[float, ...], level: float, row_offset: int) -> str:
    out = []
    for opacity, points in sorted(cells(drawn, level).items(), reverse=True):
        d = "".join(f"M{x} {y + row_offset}h1v1h-1z" for x, y in points)
        attr = "" if opacity >= 1 else f" opacity='{opacity:g}'"
        out.append(f"<path{attr} d='{d}'/>")
    return "".join(out)


def data_url(svg: str) -> str:
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe="/:=' ,.-") + '")'


def svg(body: str, height: int) -> str:
    # crispEdges: cada celda llena su píxel, sin antialiasing entre escalones.
    return f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {GRID} {height}' shape-rendering='crispEdges'>{body}</svg>"


def sprite() -> str:
    body = "".join(paths(drawn, level, index * GRID) for index, (drawn, level) in enumerate(FRAMES))
    return data_url(svg(body, GRID * len(FRAMES)))


def still() -> str:
    drawn, level = STILL
    return data_url(svg(paths(drawn, level, 0), GRID))


if __name__ == "__main__":
    print(f"  --loader-sprite: {sprite()};")
    print(f"  --loader-mask-still: {still()};")
