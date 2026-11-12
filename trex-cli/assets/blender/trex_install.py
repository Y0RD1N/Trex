# SPDX-License-Identifier: GPL-3.0-or-later
# Run by Trex inside Blender (`blender --background --python trex_install.py -- ACTION BRIDGE_FILE`)
# so the install location, the preferences file and the add-on registry are Blender's own on any
# platform. ACTION is status, install or uninstall. Prints one `TREX_INSTALL {json}` line.
#
# Blender is started WITHOUT --factory-startup: the user's preferences are loaded first, so saving
# them afterwards only adds or removes this one add-on and never resets anything else.
import hashlib
import json
import os
import shutil
import sys

import addon_utils
import bpy

MODULE = "trex_bridge"


def digest(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main():
    action, source = sys.argv[sys.argv.index("--") + 1:][:2]
    report = {"action": action, "blender": bpy.app.version_string, "error": None}
    try:
        folder = bpy.utils.user_resource("SCRIPTS", path="addons", create=(action == "install"))
        target = os.path.join(folder, MODULE + ".py") if folder else None
        if action == "install":
            os.makedirs(folder, exist_ok=True)
            shutil.copyfile(source, target)
            # A fresh Blender profile has no add-ons folder yet, so it is not on sys.path until refreshed.
            bpy.utils.refresh_script_paths()
            if folder not in sys.path:
                sys.path.append(folder)
            addon_utils.modules_refresh()
            if MODULE not in bpy.context.preferences.addons:
                bpy.ops.preferences.addon_enable(module=MODULE)
            bpy.ops.wm.save_userpref()
        elif action == "uninstall":
            if MODULE in bpy.context.preferences.addons:
                bpy.ops.preferences.addon_disable(module=MODULE)
            if target and os.path.exists(target):
                os.remove(target)
            bpy.ops.wm.save_userpref()
        elif action != "status":
            raise ValueError("unknown action")
        report.update(path=target, installed=bool(target and os.path.exists(target)),
                      enabled=MODULE in bpy.context.preferences.addons,
                      up_to_date=bool(target) and digest(target) == digest(source))
    except Exception as error:  # noqa: BLE001
        report["error"] = f"{type(error).__name__}: {error}"
    print("TREX_INSTALL " + json.dumps(report), flush=True)


main()
