"""Precarga la configuración de trex con un proyecto (útil en desarrollo).

Escribe el `config.json` que lee la app en el directorio de configuración del
sistema, para que al abrirla ya aparezca el proyecto listo.

Uso:
    python scripts/seed_dev_config.py [ruta_del_proyecto ...]

Sin argumentos usa D:\\projects\\trex.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

APP_ID = "com.trex.app"

DEFAULT_SETTINGS = {
    "shell": "default",
    "claudeCommand": "claude",
    "claudeArgs": "",
    "autoRunClaude": True,
    "fontSize": 14,
    "fontFamily": "",
    "scrollback": 10000,
    "cursorBlink": True,
    "copyOnSelect": False,
    "confirmCloseTab": True,
    "restoreOnStart": True,
    "launchMode": "arg",
    "theme": "#e8834a",
}

COLORS = ["#e8834a", "#8b7ef8", "#4cc2b0", "#e0af68", "#f7768e", "#7aa2f7"]


def config_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_ID


def main() -> int:
    paths = sys.argv[1:] or [r"D:\projects\trex"]
    now = int(time.time() * 1000)

    projects = []
    for index, raw in enumerate(paths):
        path = Path(raw).resolve()
        projects.append(
            {
                "id": f"p-seed-{index + 1}",
                "name": path.name or str(path),
                "path": str(path),
                "color": COLORS[index % len(COLORS)],
                "createdAt": now,
                "lastOpenedAt": None,
                "defaultCommand": None,
                "defaultArgs": None,
            }
        )

    config = {
        "version": 1,
        "projects": projects,
        "settings": DEFAULT_SETTINGS,
        "ui": {
            "lastProjectId": projects[0]["id"] if projects else None,
            "activeProjectId": projects[0]["id"] if projects else None,
            "sidebarWidth": 268,
            "lastTabs": [],
        },
    }

    target = config_dir() / "config.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        backup = target.with_suffix(".json.bak")
        backup.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"Copia de seguridad: {backup}")
    target.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Configuración escrita en: {target}")
    for project in projects:
        print(f"  - {project['name']}: {project['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
