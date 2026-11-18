"""Regenera los iconos de trex desde el dibujo vectorial public/trex.svg.

Diseño: el cráneo de un Tyrannosaurus rex en pixel art sobre un cuadro oscuro.
El SVG lo escribe `scripts/make_logo.py` (ahí se cambia el dibujo); Tauri
rasteriza los tamaños del ejecutable, instalador, escritorio y plataformas
móviles con el mismo dibujo. También regenera los iconos de la app remota
(`public/remote-icon-*.png`).

Uso: python scripts/make_icon.py [salida-maestra.png]
Requiere Node y las dependencias npm del proyecto ya instaladas.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def maskable_svg(icon: str) -> str:
    """El icono a sangre: el cuadro llena todo el lienzo y el dibujo se encoge al 76 %."""
    head, rest = icon.split("<rect", 1)
    rect, body = rest.split("/>", 1)
    fill = rect.split('fill="', 1)[1].split('"', 1)[0]
    body = body.replace("</svg>", "").strip()
    return (
        f'{head}<rect width="1024" height="1024" fill="{fill}"/>'
        f'<g transform="translate(512 512) scale(.76) translate(-512 -512)">{body}</g></svg>'
    )


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    source = root / "public" / "trex.svg"
    icons = root / "src-tauri" / "icons"
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else icons / "trex-icon-source.png"
    cli = root / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"
    command = ["node", str(cli), "icon", str(source)]

    with tempfile.TemporaryDirectory(prefix="trex-icon-") as temporary:
        subprocess.run(command + ["--output", temporary, "--png", "1024", "--png", "64"], cwd=root, check=True)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(temporary) / "1024x1024.png", out)
        shutil.copyfile(Path(temporary) / "64x64.png", icons / "64x64.png")

        # App remota (PWA): los iconos normales son el mismo cuadro redondeado.
        subprocess.run(command + ["--output", temporary, "--png", "180", "--png", "192", "--png", "512"], cwd=root, check=True)
        for size in (180, 192, 512):
            shutil.copyfile(Path(temporary) / f"{size}x{size}.png", root / "public" / f"remote-icon-{size}.png")
        # El «maskable» va a sangre (el sistema lo recorta con su forma) y con el dibujo
        # más pequeño, dentro de la zona segura.
        maskable = Path(temporary) / "maskable.svg"
        maskable.write_text(maskable_svg(source.read_text(encoding="utf-8")), encoding="utf-8")
        subprocess.run(["node", str(cli), "icon", str(maskable), "--output", temporary, "--png", "512"], cwd=root, check=True)
        shutil.copyfile(Path(temporary) / "512x512.png", root / "public" / "remote-icon-maskable-512.png")

    subprocess.run(command + ["--output", str(icons), "--ios-color", "#111111"], cwd=root, check=True)
    print(f"Iconos regenerados desde {source.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
