"""Genera el sprite del loader de trex (`--loader-sprite` en src/styles.css).

El loader es la «t» de trex cortada en cuatro estratos que se iluminan de arriba
abajo (ciclo de 1,4 s, ease-in-out, cada estrato .14 s después del anterior).

Antes era un SVG con la animación dentro, usado como máscara CSS. WebKit anima
esas imágenes con su propio reloj a 60 fps y repinta cada elemento enmascarado en
cada fotograma; con el agente trabajando eso costaba ~17 % de CPU (proceso web y
ventana). Ahora el SVG es estático: N fotogramas apilados en vertical con las
opacidades ya calculadas, que el CSS recorre con `mask-position` a saltos
(`steps()`), una propiedad que no se acelera en el compositor: WebKit solo pinta
cuando cambia el fotograma (10 veces por segundo con N = 14).

Uso:
    python scripts/make_loader_sprite.py [fotogramas]
Imprime el valor `url("data:...")` para pegarlo en `--loader-sprite`; si cambias
el número de fotogramas, ajusta también el tamaño (`100% N00%`) y `steps(N, ...)`.
"""

from __future__ import annotations

import sys
import urllib.parse

CYCLE = 1.4
DELAYS = [0, 0.14, 0.28, 0.42]
# Fotogramas clave de cada estrato: (progreso, opacidad), con ease-in-out entre ellos.
KEYS = [(0, 0.25), (0.35, 1), (0.55, 1), (1, 0.25)]
BANDS = [(248, 104), (360, 104), (472, 152), (632, 160)]
SIZE = 544
T_PATH = "M432 248h120v104h200v112H552v160q0 56 56 56h128v112H592q-160 0-160-160V464H272V352h160Z"


def ease_in_out(t: float) -> float:
    """cubic-bezier(.42, 0, .58, 1) resuelto por bisección."""
    lo, hi = 0.0, 1.0
    for _ in range(60):
        m = (lo + hi) / 2
        x = 3 * (1 - m) ** 2 * m * 0.42 + 3 * (1 - m) * m * m * 0.58 + m**3
        lo, hi = (m, hi) if x < t else (lo, m)
    m = (lo + hi) / 2
    return 3 * (1 - m) * m * m + m**3


def opacity(progress: float) -> float:
    for (a, va), (b, vb) in zip(KEYS, KEYS[1:]):
        if a <= progress <= b:
            return va + (vb - va) * ease_in_out((progress - a) / (b - a))
    return KEYS[0][1]


def sprite(frames: int) -> str:
    parts = []
    for k in range(frames):
        t = k * CYCLE / frames
        rects = "".join(
            f"<rect x='240' y='{y + k * SIZE}' width='544' height='{h}' opacity='{opacity(((t - d) % CYCLE) / CYCLE):.2f}'/>"
            for (y, h), d in zip(BANDS, DELAYS)
        )
        parts.append(
            f"<clipPath id='t{k}'><path transform='translate(0 {k * SIZE})' d='{T_PATH}'/></clipPath>"
            f"<g clip-path='url(#t{k})'>{rects}</g>"
        )
    svg = f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='240 248 {SIZE} {SIZE * frames}'>{''.join(parts)}</svg>"
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe="/:=' ,.-") + '")'


if __name__ == "__main__":
    print(sprite(int(sys.argv[1]) if len(sys.argv) > 1 else 14))
