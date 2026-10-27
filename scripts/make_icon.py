"""Regenera los iconos de trex desde el dibujo vectorial public/trex.svg.

Diseño: una «t» geométrica blanca sobre un cuadro negro, sin degradados.
El SVG es la única fuente; Tauri rasteriza los tamaños del ejecutable,
instalador, escritorio y plataformas móviles con el mismo dibujo.

Uso: python scripts/make_icon.py [salida-maestra.png]
Requiere Node y las dependencias npm del proyecto ya instaladas.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


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

    subprocess.run(command + ["--output", str(icons), "--ios-color", "#111111"], cwd=root, check=True)
    print(f"Iconos regenerados desde {source.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
