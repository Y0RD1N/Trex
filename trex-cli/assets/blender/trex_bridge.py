# SPDX-License-Identifier: GPL-3.0-or-later
# Trex Bridge: lets Trex agents see and drive a Blender session that the user has open.
#
# This single file is both a legacy add-on (bl_info/register) and a script that can be
# started with `blender --python trex_bridge.py`. It is licensed GPL-3.0-or-later because
# it imports Blender's `bpy`; the rest of Trex is MIT and talks to it only over a socket.
#
# Safety model:
#   * listens on 127.0.0.1 only, on an ephemeral port, and requires a random token;
#   * the port and token live in a per-user file (mode 0600) that Trex reads;
#   * everything that touches bpy runs on Blender's main thread (a timer), never on the
#     socket thread; the socket thread only queues requests;
#   * `exec` runs arbitrary Python by design: Trex decides who may call it (plan mode and
#     permissions); the bridge cannot tell an agent from the user.
bl_info = {
    "name": "Trex Bridge",
    "author": "Trex",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "Runs in the background (no panel)",
    "description": "Lets Trex agents see and drive this Blender session",
    "category": "Development",
}

import atexit
import contextlib
import io
import json
import math
import os
import queue
import secrets
import socket
import struct
import sys
import tempfile
import threading
import time
import traceback
import zlib

import bpy

PROTOCOL = 1
HOST = "127.0.0.1"
MAX_REQUEST = 8 * 1024 * 1024
MAX_OUTPUT_CHARS = 60_000
MAX_EDGE = 1568
REQUEST_TIMEOUT = 120.0

_state = {"server": None, "token": None, "info": None, "started": 0.0, "paused": False, "last_op": "", "last_time": 0.0, "ui": False}
_requests: "queue.Queue" = queue.Queue()
_namespace: dict = {}


# --------------------------------------------------------------------------- discovery
def bridge_dir():
    """Per-user directory with one JSON file per running Blender (mirrored by Trex)."""
    override = os.environ.get("TREX_BRIDGE_DIR")
    if override:
        return override
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(base, "Trex", "blender-bridge")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Trex", "blender-bridge")
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(base, "trex", "blender-bridge")


def _write_info(port):
    directory = bridge_dir()
    os.makedirs(directory, mode=0o700, exist_ok=True)
    path = os.path.join(directory, f"{os.getpid()}.json")
    payload = {"protocol": PROTOCOL, "port": port, "token": _state["token"], "pid": os.getpid(),
               "blender": bpy.app.version_string, "started": time.time(), "file": bpy.data.filepath}
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(payload, handle)
    _state["info"] = path


def _remove_info():
    path = _state.get("info")
    if path:
        with contextlib.suppress(OSError):
            os.remove(path)
        _state["info"] = None


# --------------------------------------------------------------------------- helpers
def _clip(text, limit=MAX_OUTPUT_CHARS):
    if len(text) <= limit:
        return text
    return text[: limit // 2] + f"\n… [{len(text) - limit} characters omitted] …\n" + text[-limit // 2:]


def _r(value, digits=4):
    return round(float(value), digits)


def _vec(value, digits=4):
    return [_r(v, digits) for v in value]


def _windows():
    return list(bpy.context.window_manager.windows)


def _find_area(area_type="VIEW_3D"):
    for window in _windows():
        for area in window.screen.areas:
            if area.type == area_type:
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region:
                    return window, area, region
    return None, None, None


def _redraw():
    for window in _windows():
        for area in window.screen.areas:
            area.tag_redraw()


def _update():
    with contextlib.suppress(Exception):
        bpy.context.view_layer.update()


def _no_object_error():
    return "no such object"


# --------------------------------------------------------------------------- scene model
def _bbox_world(obj):
    """World-space min/max for an object, or None when it has no geometry."""
    from mathutils import Vector
    if obj.type in {"MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME", "GPENCIL", "CURVES", "POINTCLOUD", "LATTICE", "ARMATURE"} and obj.bound_box:
        points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    else:
        points = [obj.matrix_world.translation.copy()]
    lows = [min(p[i] for p in points) for i in range(3)]
    highs = [max(p[i] for p in points) for i in range(3)]
    return lows, highs


def _scene_bounds(objects):
    lows, highs = [math.inf] * 3, [-math.inf] * 3
    any_found = False
    for obj in objects:
        try:
            low, high = _bbox_world(obj)
        except Exception:
            continue
        any_found = True
        for i in range(3):
            lows[i] = min(lows[i], low[i])
            highs[i] = max(highs[i], high[i])
    return (lows, highs) if any_found else None


def _collection_tree(collection, depth=0):
    node = {"name": collection.name, "objects": len(collection.objects),
            "hidden": bool(getattr(collection, "hide_viewport", False))}
    if depth < 6 and collection.children:
        node["children"] = [_collection_tree(child, depth + 1) for child in collection.children]
    return node


def _material_names(obj):
    return [slot.material.name for slot in obj.material_slots if slot.material]


def _object_row(obj):
    row = {"name": obj.name, "type": obj.type,
           "collections": [c.name for c in obj.users_collection],
           "location": _vec(obj.location, 3), "rotation_deg": [round(math.degrees(v), 2) for v in obj.rotation_euler],
           "scale": _vec(obj.scale, 3), "dimensions": _vec(obj.dimensions, 3),
           "visible": obj.visible_get(), "selected": obj.select_get()}
    if obj.parent:
        row["parent"] = obj.parent.name
    materials = _material_names(obj)
    if materials:
        row["materials"] = materials
    if obj.modifiers:
        row["modifiers"] = [f"{m.name}:{m.type}" for m in obj.modifiers]
    if obj.type == "MESH" and obj.data:
        row["mesh"] = {"vertices": len(obj.data.vertices), "faces": len(obj.data.polygons)}
    if obj.type == "LIGHT" and obj.data:
        row["light"] = {"kind": obj.data.type, "energy": _r(obj.data.energy, 2), "color": _vec(obj.data.color, 3)}
    if obj.type == "CAMERA" and obj.data:
        row["camera"] = {"lens": _r(obj.data.lens, 2), "type": obj.data.type}
    return row


def op_hello(_req):
    return {"bridge": {"protocol": PROTOCOL, "version": ".".join(map(str, bl_info["version"]))},
            "blender": {"version": bpy.app.version_string, "file": bpy.data.filepath or None,
                        "dirty": bpy.data.is_dirty, "background": bool(bpy.app.background)},
            "paused": bool(_state["paused"]),
            "areas": sorted({a.type for w in _windows() for a in w.screen.areas})}


def op_scene(req):
    level = req.get("level", "overview")
    scene = bpy.context.scene
    if level == "overview":
        objects = list(scene.objects)
        counts = {}
        for obj in objects:
            counts[obj.type] = counts.get(obj.type, 0) + 1
        bounds = _scene_bounds([o for o in objects if o.type not in {"CAMERA", "LIGHT", "EMPTY"}] or objects)
        active = bpy.context.view_layer.objects.active
        result = {
            "scene": scene.name, "file": bpy.data.filepath or None, "dirty": bpy.data.is_dirty,
            "mode": getattr(bpy.context, "mode", None),
            "units": {"system": scene.unit_settings.system, "scale": _r(scene.unit_settings.scale_length, 4)},
            "frame": {"current": scene.frame_current, "start": scene.frame_start, "end": scene.frame_end, "fps": scene.render.fps},
            "render": {"engine": scene.render.engine, "resolution": [scene.render.resolution_x, scene.render.resolution_y],
                       "percentage": scene.render.resolution_percentage},
            "counts": counts, "total_objects": len(objects),
            "active": active.name if active else None,
            "selected": [o.name for o in objects if o.select_get()][:50],
            "camera": scene.camera.name if scene.camera else None,
            "world": scene.world.name if scene.world else None,
            "collections": _collection_tree(scene.collection),
            "materials": len(bpy.data.materials), "images": len(bpy.data.images),
            "areas": sorted({a.type for w in _windows() for a in w.screen.areas}),
        }
        if bounds:
            result["bounds"] = {"min": _vec(bounds[0], 3), "max": _vec(bounds[1], 3),
                                "size": [_r(bounds[1][i] - bounds[0][i], 3) for i in range(3)]}
        return result
    if level == "objects":
        offset, limit = int(req.get("offset", 0)), max(1, min(int(req.get("limit", 40)), 200))
        kind = req.get("type")
        match = (req.get("match") or "").lower()
        rows = [o for o in scene.objects if (not kind or o.type == kind) and (not match or match in o.name.lower())]
        page = rows[offset: offset + limit]
        return {"total": len(rows), "offset": offset, "objects": [_object_row(o) for o in page],
                "next_offset": offset + limit if offset + limit < len(rows) else None}
    if level == "object":
        obj = bpy.data.objects.get(req.get("name", ""))
        if not obj:
            raise ValueError(f"no object named {req.get('name')!r}")
        return _object_detail(obj)
    if level == "datablocks":
        # What already exists in the file, so the agent reuses a material or node group instead of duplicating it.
        kinds = ("materials", "meshes", "collections", "images", "node_groups", "actions", "cameras", "lights", "worlds", "textures", "fonts", "libraries")
        return {kind: {"count": len(getattr(bpy.data, kind)), "names": [d.name for d in list(getattr(bpy.data, kind))[:60]]} for kind in kinds if hasattr(bpy.data, kind)}
    raise ValueError("level must be overview, objects, object or datablocks")


def _rna_values(struct, limit=40):
    values = {}
    for prop in struct.bl_rna.properties:
        if prop.identifier in {"rna_type", "name"} or prop.type in {"POINTER", "COLLECTION"}:
            continue
        try:
            value = getattr(struct, prop.identifier)
        except Exception:
            continue
        if hasattr(value, "__len__") and not isinstance(value, str):
            value = [(_r(v, 4) if isinstance(v, float) else v) for v in value]
        elif isinstance(value, float):
            value = _r(value, 4)
        values[prop.identifier] = value
        if len(values) >= limit:
            break
    return values


def _material_summary(material):
    tree = getattr(material, "node_tree", None)  # `use_nodes` is deprecated in Blender 5.x
    info = {"name": material.name, "has_nodes": tree is not None}
    if tree is not None:
        nodes = []
        for node in tree.nodes:
            entry = {"type": node.bl_idname.replace("ShaderNode", ""), "name": node.name}
            if node.bl_idname == "ShaderNodeBsdfPrincipled":
                for key in ("Base Color", "Metallic", "Roughness", "Alpha", "Emission Color", "Emission Strength"):
                    socket_ = node.inputs.get(key)
                    if socket_ is not None and not socket_.is_linked and hasattr(socket_, "default_value"):
                        value = socket_.default_value
                        entry[key] = _vec(value, 3) if hasattr(value, "__len__") else _r(value, 3)
            if node.bl_idname == "ShaderNodeTexImage" and node.image:
                entry["image"] = node.image.name
            nodes.append(entry)
        info["nodes"] = nodes[:30]
    else:
        info["diffuse_color"] = _vec(material.diffuse_color, 3)
    return info


def _object_detail(obj):
    detail = _object_row(obj)
    detail["matrix_world"] = [_vec(row, 4) for row in obj.matrix_world]
    detail["children"] = [c.name for c in obj.children]
    detail["hide_render"] = bool(obj.hide_render)
    if obj.type == "MESH" and obj.data:
        mesh = obj.data
        detail["mesh"] = {"vertices": len(mesh.vertices), "edges": len(mesh.edges), "faces": len(mesh.polygons),
                          "uv_layers": [layer.name for layer in mesh.uv_layers], "shade_smooth": any(p.use_smooth for p in mesh.polygons[:200])}
    detail["modifiers"] = [{"name": m.name, "type": m.type, "settings": _rna_values(m)} for m in obj.modifiers]
    detail["constraints"] = [{"name": c.name, "type": c.type} for c in obj.constraints]
    detail["materials"] = [_material_summary(slot.material) for slot in obj.material_slots if slot.material]
    if obj.animation_data and obj.animation_data.action:
        action = obj.animation_data.action
        detail["animation"] = {"action": action.name, "frame_range": _vec(action.frame_range, 1)}
    props = {k: obj[k] for k in obj.keys() if not k.startswith("_") and isinstance(obj[k], (int, float, str, bool))}
    if props:
        detail["custom_properties"] = props
    return detail


def _signature():
    """Compact per-object fingerprint, used to tell the agent what an `exec` changed."""
    sig = {}
    for obj in bpy.context.scene.objects:
        mesh = (len(obj.data.vertices), len(obj.data.polygons)) if obj.type == "MESH" and obj.data else None
        sig[obj.name] = (obj.type, tuple(round(v, 4) for v in obj.location), tuple(round(v, 4) for v in obj.rotation_euler),
                         tuple(round(v, 4) for v in obj.scale), mesh, tuple(_material_names(obj)),
                         tuple(m.name for m in obj.modifiers), obj.parent.name if obj.parent else None, obj.visible_get())
    return sig


def _diff(before, after):
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(n for n in set(before) & set(after) if before[n] != after[n])
    return {"added": added, "removed": removed, "changed": changed}


# --------------------------------------------------------------------------- imaging
def _png(rgba, width, height):
    import numpy as np
    flat = np.zeros((height, width * 4 + 1), dtype=np.uint8)
    pixels = rgba.reshape(height, width * 4)
    flat[:, 1:] = pixels
    flat[:, 4::4] = 255  # opaque alpha: 4th byte of each pixel (index 1 is the filter byte)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(flat.tobytes(), 3)) + chunk(b"IEND", b""))


def _basis_view_matrix(eye, target):
    from mathutils import Matrix, Vector
    forward = (Vector(target) - Vector(eye)).normalized()
    up_hint = Vector((0, 0, 1)) if abs(forward.z) < 0.999 else Vector((0, 1, 0))
    right = forward.cross(up_hint).normalized()
    up = right.cross(forward).normalized()
    rotation = Matrix(((right.x, up.x, -forward.x, 0), (right.y, up.y, -forward.y, 0), (right.z, up.z, -forward.z, 0), (0, 0, 0, 1)))
    return (Matrix.Translation(Vector(eye)) @ rotation).inverted()


def _perspective(fov, aspect, near, far):
    from mathutils import Matrix
    f = 1.0 / math.tan(fov / 2.0)
    return Matrix(((f / aspect, 0, 0, 0), (0, f, 0, 0), (0, 0, (far + near) / (near - far), 2 * far * near / (near - far)), (0, 0, -1, 0)))


PRESETS = {  # direction from the target towards the eye
    "front": (0, -1, 0.15), "back": (0, 1, 0.15), "right": (1, 0, 0.15), "left": (-1, 0, 0.15),
    "top": (0, 0, 1), "bottom": (0, 0, -1), "iso": (1, -1, 0.8), "iso_back": (-1, 1, 0.8),
}


def _focus_objects(spec):
    scene = bpy.context.scene
    if isinstance(spec, list) and spec:
        found = [bpy.data.objects[n] for n in spec if n in bpy.data.objects]
        if found:
            return found
    if spec == "selected":
        found = [o for o in scene.objects if o.select_get()]
        if found:
            return found
    geometry = [o for o in scene.objects if o.type not in {"CAMERA", "LIGHT", "EMPTY"} and o.visible_get()]
    return geometry or list(scene.objects)


def _frame(objects, direction, fov):
    from mathutils import Vector
    bounds = _scene_bounds(objects)
    if bounds:
        low, high = Vector(bounds[0]), Vector(bounds[1])
        center = (low + high) / 2
        radius = max((high - low).length / 2, 0.25)
    else:
        center, radius = Vector((0, 0, 0)), 5.0
    distance = radius / math.sin(fov / 2) * 1.1
    eye = center + Vector(direction).normalized() * distance
    return eye, center, distance, radius


@contextlib.contextmanager
def _viewport_overrides(space, shading, overlays):
    """Change the 3D view's look for one synchronous capture and restore it; the UI cannot
    redraw in between because everything happens inside one timer call."""
    saved = []
    try:
        if shading:
            saved.append((space.shading, "type", space.shading.type))
            space.shading.type = shading
        if overlays is not None:
            saved.append((space.overlay, "show_overlays", space.overlay.show_overlays))
            space.overlay.show_overlays = overlays
        yield
    finally:
        for owner, name, value in reversed(saved):
            with contextlib.suppress(Exception):
                setattr(owner, name, value)


def _draw(space, region, view, projection, width, height):
    import gpu
    import numpy as np
    offscreen = gpu.types.GPUOffScreen(width, height)
    try:
        offscreen.draw_view3d(bpy.context.scene, bpy.context.view_layer, space, region, view, projection, do_color_management=True)
        with offscreen.bind():
            framebuffer = gpu.state.active_framebuffer_get()
            buffer = framebuffer.read_color(0, 0, width, height, 4, 0, "UBYTE")
            data = np.array(buffer, dtype=np.uint8).reshape(height, width, 4)
    finally:
        offscreen.free()
    return data[::-1].copy()  # GL rows start at the bottom


def _clamp_size(req, default_w, default_h):
    width, height = int(req.get("width", default_w)), int(req.get("height", default_h))
    scale = min(1.0, MAX_EDGE / max(width, height))
    return max(64, int(width * scale)), max(64, int(height * scale))


def op_view(req):
    kind = req.get("view", "iso")
    if kind == "window":
        return _view_window(req)
    window, area, region = _find_area("VIEW_3D")
    if not area:
        raise RuntimeError("there is no 3D viewport in this Blender window (open one, or use view=window)")
    space = area.spaces.active
    _update()
    shading, overlays = req.get("shading"), req.get("overlays")
    if shading not in {None, "WIREFRAME", "SOLID", "MATERIAL", "RENDERED"}:
        raise ValueError("shading must be WIREFRAME, SOLID, MATERIAL or RENDERED")
    fov = math.radians(float(req.get("fov", 45)))
    focus = _focus_objects(req.get("focus"))
    if kind == "sheet":
        width, height = _clamp_size(req, 1280, 720)
        tiles = [("iso", "iso"), ("front", "front"), ("right", "right"), ("top", "top")]
        import numpy as np
        half_w, half_h = width // 2, height // 2
        canvas = np.zeros((half_h * 2, half_w * 2, 4), dtype=np.uint8)
        with _viewport_overrides(space, shading, overlays):
            for index, (_, preset) in enumerate(tiles):
                eye, center, distance, radius = _frame(focus, PRESETS[preset], fov)
                view = _basis_view_matrix(eye, center)
                projection = _perspective(fov, half_w / half_h, max(distance * 0.01, 0.01), distance + radius * 8)
                tile = _draw(space, region, view, projection, half_w, half_h)
                row, col = divmod(index, 2)
                canvas[row * half_h:(row + 1) * half_h, col * half_w:(col + 1) * half_w] = tile
        return {"png": _png(canvas, half_w * 2, half_h * 2), "width": half_w * 2, "height": half_h * 2, "tiles": [t[1] for t in tiles], "view": "sheet", "shading": shading or space.shading.type,
                "note": "2x2 sheet: top-left iso, top-right front, bottom-left right, bottom-right top"}
    width, height = _clamp_size(req, 960, 540)
    if kind == "camera":
        camera = bpy.context.scene.camera
        if not camera:
            raise RuntimeError("the scene has no active camera")
        view = camera.matrix_world.inverted()
        projection = camera.calc_matrix_camera(bpy.context.evaluated_depsgraph_get(), x=width, y=height)
    else:
        if "eye" in req and "target" in req:
            eye, center = req["eye"], req["target"]
            from mathutils import Vector
            distance, radius = (Vector(eye) - Vector(center)).length, 1.0
        elif kind in PRESETS:
            eye, center, distance, radius = _frame(focus, PRESETS[kind], fov)
        else:
            raise ValueError("view must be one of " + ", ".join(sorted(PRESETS)) + ", camera, sheet, window or give eye+target")
        view = _basis_view_matrix(eye, center)
        projection = _perspective(fov, width / height, max(distance * 0.01, 0.01), distance + radius * 8)
    with _viewport_overrides(space, shading, overlays):
        pixels = _draw(space, region, view, projection, width, height)
    return {"png": _png(pixels, width, height), "width": width, "height": height, "view": kind, "shading": shading or space.shading.type}


def _view_window(req):
    """What the user really sees: the whole window or one editor (shader editor, timeline…)."""
    editor = (req.get("area") or "WINDOW").upper()
    kinds = {"VIEWPORT": "VIEW_3D", "3D": "VIEW_3D", "SHADER": "NODE_EDITOR", "NODES": "NODE_EDITOR", "TIMELINE": "TIMELINE",
             "OUTLINER": "OUTLINER", "PROPERTIES": "PROPERTIES", "WINDOW": "WINDOW"}
    editor = kinds.get(editor, editor)
    window = _windows()[0] if _windows() else None
    if window is None:
        raise RuntimeError("Blender has no window")
    handle, path = tempfile.mkstemp(suffix=".png", prefix="trex_view_")
    os.close(handle)
    try:
        _update()
        for area in window.screen.areas:
            area.tag_redraw()
        if editor == "WINDOW":
            with bpy.context.temp_override(window=window):
                bpy.ops.screen.screenshot(filepath=path)
        else:
            win, area, region = _find_area(editor)
            if not area:
                raise RuntimeError(f"no {editor} area is open; available: " + ", ".join(sorted({a.type for a in window.screen.areas})))
            with bpy.context.temp_override(window=win, area=area, region=region):
                bpy.ops.screen.screenshot_area(filepath=path)
        with open(path, "rb") as handle:
            data = handle.read()
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)
    if editor == "WINDOW":
        trimmed = _trim_margin(data)
        if trimmed:
            data = trimmed
    width, height = struct.unpack(">II", data[16:24])
    return {"png": data, "width": width, "height": height}


def _trim_margin(png):
    """Drop the strip above Blender's top bar that Blender does not draw: black on X11, uninitialised
    colour noise on Wayland. Detected from the pixels (the API does not expose it); None when there is none."""
    import numpy as np
    handle, path = tempfile.mkstemp(suffix=".png", prefix="trex_trim_")
    os.close(handle)
    try:
        with open(path, "wb") as out:
            out.write(png)
        image = bpy.data.images.load(path)
        try:
            image.colorspace_settings.name = "Non-Color"  # raw values, no colour conversion on read
            width, height = image.size
            buffer = np.empty(width * height * 4, dtype=np.float32)
            image.pixels.foreach_get(buffer)
        finally:
            bpy.data.images.remove(image)
    except Exception:  # noqa: BLE001 - a failed trim must never lose the screenshot
        return None
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)
    rows = buffer.reshape(height, width, 4)[::-1]  # Blender stores bottom-up: rows[0] is now the top
    cut = 0
    for y in range(min(64, height // 4)):
        row = rows[y, :, :3]
        if row.max() <= 0.03 or row.std() > 0.18:
            cut += 1
        else:
            break
    if cut == 0:
        return None
    pixels = (np.clip(rows[cut:], 0.0, 1.0) * 255 + 0.5).astype(np.uint8)
    return _png(np.ascontiguousarray(pixels), width, height - cut)


# --------------------------------------------------------------------------- exec / undo / render
def op_exec(req):
    code = req.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code is required")
    before = _signature()
    out = io.StringIO()
    _namespace.setdefault("bpy", bpy)
    _namespace.pop("result", None)
    ok, error = True, None
    started = time.time()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(code, "<trex>", "exec"), _namespace)
    except BaseException:  # noqa: BLE001 - SystemExit from a script must not kill Blender
        ok, error = False, traceback.format_exc(limit=6)
    with contextlib.suppress(Exception):
        bpy.ops.ed.undo_push(message="Trex")
    _update()
    _redraw()
    result = _namespace.get("result")
    try:
        json.dumps(result)
    except (TypeError, ValueError):
        result = repr(result)
    return {"ok": ok, "error": error, "output": _clip(out.getvalue()), "result": result,
            "changes": _diff(before, _signature()), "seconds": _r(time.time() - started, 3)}


def op_undo(req):
    steps = max(1, min(int(req.get("steps", 1)), 20))
    window, area, region = _find_area("VIEW_3D")
    done = 0
    for _ in range(steps):
        try:
            if window:
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.ed.undo()
            else:
                bpy.ops.ed.undo()
            done += 1
        except Exception:
            break
    _update()
    _redraw()
    return {"undone": done}


def op_render(req):
    scene = bpy.context.scene
    width, height = _clamp_size(req, scene.render.resolution_x, scene.render.resolution_y)
    saved = {"engine": scene.render.engine, "x": scene.render.resolution_x, "y": scene.render.resolution_y,
             "pct": scene.render.resolution_percentage, "path": scene.render.filepath, "frame": scene.frame_current,
             "format": scene.render.image_settings.file_format, "display": bpy.context.preferences.view.render_display_type}
    handle, path = tempfile.mkstemp(suffix=".png", prefix="trex_render_")
    os.close(handle)
    engine = req.get("engine")
    try:
        if engine:
            scene.render.engine = engine
        scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = width, height, 100
        if "samples" in req:
            samples = int(req["samples"])
            if hasattr(scene, "cycles") and scene.render.engine == "CYCLES":
                scene.cycles.samples = samples
            elif hasattr(scene, "eevee"):
                scene.eevee.taa_render_samples = samples
        if "frame" in req:
            scene.frame_set(int(req["frame"]))
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.context.preferences.view.render_display_type = "NONE"  # no pop-up window for the user
        started = time.time()
        bpy.ops.render.render(write_still=True)
        with open(path, "rb") as handle:
            data = handle.read()
    finally:
        scene.render.engine = saved["engine"]
        scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = saved["x"], saved["y"], saved["pct"]
        scene.render.filepath, scene.render.image_settings.file_format = saved["path"], saved["format"]
        bpy.context.preferences.view.render_display_type = saved["display"]
        with contextlib.suppress(Exception):
            scene.frame_set(saved["frame"])
        with contextlib.suppress(OSError):
            os.remove(path)
    return {"png": data, "width": width, "height": height, "seconds": _r(time.time() - started, 2)}


OPS = {"hello": op_hello, "scene": op_scene, "view": op_view, "exec": op_exec, "undo": op_undo, "render": op_render}


def _handle(req):
    name = req.get("op")
    handler = OPS.get(name)
    if handler is None:
        return {"ok": False, "error": f"unknown op {name!r}"}
    if _state["paused"] and name != "hello":
        return {"ok": False, "error": "The user paused Trex's control of this Blender (status bar, bottom right). Ask them to resume it; do not try to work around the pause."}
    if name != "hello":
        _state["last_op"], _state["last_time"], _state["settled"] = name, time.time(), False
        _redraw_status()
    try:
        result = handler(req)
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"{type(error).__name__}: {error}", "trace": _clip(traceback.format_exc(limit=4), 4000)}
    return _encode(result)


def _encode(result):
    """Binary images travel as base64 so the wire stays one JSON line per message."""
    import base64
    if isinstance(result, dict) and isinstance(result.get("png"), (bytes, bytearray)):
        result = dict(result)
        result["png"] = base64.b64encode(result["png"]).decode("ascii")
    return {"ok": True, "result": result}


# --------------------------------------------------------------------------- user-facing controls
def _redraw_status():
    for window in _windows():
        for area in window.screen.areas:
            if area.type == "STATUSBAR":
                area.tag_redraw()


class TREX_OT_toggle_pause(bpy.types.Operator):
    bl_idname = "trex.toggle_pause"
    bl_label = "Pause or resume Trex"
    bl_description = "Stop Trex agents from seeing or changing this Blender until you resume. Click again to resume"

    def execute(self, context):
        _state["paused"] = not _state["paused"]
        _redraw_status()
        return {"FINISHED"}


def _draw_status(self, context):
    if _state["server"] is None:
        return
    recent = time.time() - _state["last_time"] < 4
    if _state["paused"]:
        text, icon = "Trex paused", "PAUSE"
    elif recent:
        text, icon = f"Trex: {_state['last_op']}", "PLAY"
    else:
        text, icon = "Trex connected", "LINKED"
    self.layout.operator("trex.toggle_pause", text=text, icon=icon, emboss=False)


def _register_ui():
    if _state["ui"] or bpy.app.background:
        return
    with contextlib.suppress(ValueError):
        bpy.utils.register_class(TREX_OT_toggle_pause)
    bpy.types.STATUSBAR_HT_header.append(_draw_status)
    _state["ui"] = True


def _unregister_ui():
    if not _state["ui"]:
        return
    with contextlib.suppress(Exception):
        bpy.types.STATUSBAR_HT_header.remove(_draw_status)
    with contextlib.suppress(Exception):
        bpy.utils.unregister_class(TREX_OT_toggle_pause)
    _state["ui"] = False


# --------------------------------------------------------------------------- server
def _tick():
    try:
        while True:
            request, slot, done = _requests.get_nowait()
            try:
                slot.append(_handle(request))
            except Exception:  # noqa: BLE001
                slot.append({"ok": False, "error": traceback.format_exc(limit=3)})
            done.set()
    except queue.Empty:
        pass
    # The status bar shows the last operation for a few seconds, then goes back to "connected".
    if not _state.get("settled", True) and time.time() - _state["last_time"] > 4.2:
        _state["settled"] = True
        _redraw_status()
    return 0.03


def _read_line(conn):
    data = bytearray()
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_REQUEST:
            raise ValueError("request too large")
        if data.endswith(b"\n"):
            break
    return bytes(data)


def _client(conn):
    conn.settimeout(10)
    with conn:
        try:
            raw = _read_line(conn)
            if not raw.startswith(b"{"):
                return  # an HTTP request or noise: never answer it
            request = json.loads(raw)
            if not secrets.compare_digest(str(request.get("token", "")), _state["token"] or ""):
                response = {"ok": False, "error": "bad token"}
            else:
                slot, done = [], threading.Event()
                _requests.put((request, slot, done))
                response = slot[0] if done.wait(float(request.get("timeout", REQUEST_TIMEOUT))) and slot else {"ok": False, "error": "Blender did not answer in time (is it busy or showing a modal dialog?)"}
            response["id"] = request.get("id")
        except Exception as error:  # noqa: BLE001
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        with contextlib.suppress(OSError):
            conn.sendall(json.dumps(response).encode("utf-8") + b"\n")


def _serve(server):
    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            return
        threading.Thread(target=_client, args=(conn,), daemon=True).start()


def start():
    if _state["server"] is not None:
        return
    if bpy.app.background and not os.environ.get("TREX_BRIDGE_BACKGROUND"):
        return
    _state["token"] = secrets.token_hex(24)
    server = socket.socket()
    server.bind((HOST, 0))
    server.listen(8)
    _state["server"] = server
    _write_info(server.getsockname()[1])
    threading.Thread(target=_serve, args=(server,), daemon=True).start()
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=0.1, persistent=True)
    _register_ui()
    with contextlib.suppress(Exception):
        bpy.context.preferences.view.show_splash = False
    print("TREX_BRIDGE_READY", server.getsockname()[1], flush=True)


def stop():
    server = _state.get("server")
    if server is not None:
        with contextlib.suppress(OSError):
            server.close()
    _state["server"] = None
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    _unregister_ui()
    _remove_info()


atexit.register(_remove_info)


def register():
    start()


def unregister():
    stop()


if __name__ == "__main__":
    start()
