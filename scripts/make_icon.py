"""Genera el icono de trex (PNG 1024x1024) sin dependencias externas salvo Pillow.

Diseño: cuadro redondeado oscuro con un chevron de prompt ">" en degradado
naranja y un bloque de cursor, la firma visual de una terminal lista para
escribir. Se dibuja a 2048 px y se reduce con LANCZOS para obtener bordes
suavizados.

Uso:  python scripts/make_icon.py [salida.png]
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

S = 2048
RADIUS = 440


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    return mask


def vertical_gradient(size: int, top: str, bottom: str) -> Image.Image:
    return ImageOps.colorize(Image.linear_gradient("L").resize((size, size)), black=top, white=bottom)


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src-tauri/icons/trex-icon-source.png")

    # 1) Fondo: cuadrado redondeado con degradado vertical sutil.
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(vertical_gradient(S, "#0e0e13", "#272733").convert("RGBA"), (0, 0), rounded_mask(S, RADIUS))

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((7, 7, S - 8, S - 8), radius=RADIUS - 6, outline=(58, 58, 72, 255), width=9)

    # 2) Chevron ">" con extremos redondeados.
    stroke = 196
    points = [(612, 612), (1008, 902), (612, 1192)]
    chevron = Image.new("L", (S, S), 0)
    pen = ImageDraw.Draw(chevron)
    pen.line(points, fill=255, width=stroke, joint="curve")
    r = stroke / 2
    for x, y in points:
        pen.ellipse((x - r, y - r, x + r, y + r), fill=255)
    canvas.paste(vertical_gradient(S, "#df6f38", "#f9ba7c").convert("RGBA"), (0, 0), chevron)

    # 3) Bloque de cursor.
    cursor = Image.new("L", (S, S), 0)
    ImageDraw.Draw(cursor).rounded_rectangle((1178, 782, 1498, 1022), radius=48, fill=255)
    canvas.paste(Image.new("RGBA", (S, S), (243, 166, 112, 255)), (0, 0), cursor)

    # 4) Reducción final con antialiasing.
    icon = canvas.resize((1024, 1024), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    icon.save(out, "PNG")
    print(f"Icono generado: {out} ({icon.size[0]}x{icon.size[1]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
