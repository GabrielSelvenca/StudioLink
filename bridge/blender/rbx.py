"""
rbx.py — funções prontas pra modelar no Blender e exportar pro Roblox (StudioLink).

Uso (dentro de um script rodado pela ferramenta blender_run):
    from rbx import *
    reset()
    corpo = box("Corpo", (4, 2, 6))
    roda  = cylinder("Roda", radius=1, depth=0.5, loc=(2, -1, 2), rot=(0, 90, 0))
    carro = join([corpo, roda], "Carro")
    bevel(carro, 0.1)
    material(carro, "#e63946")
    smart_uv(carro); bake_color(carro, "assets/textures/carro.png")
    limit_tris(carro, 8000)
    export_fbx("assets/models/carro.fbx", [carro])
    report([carro])

Convenções:
- 1 unidade do Blender = 1 stud. Eixos do Blender: X = lado, Y = frente, Z = cima (o export converte).
- Tamanhos/posições em studs; rotações em graus.
- Arquivos: assets/models/*.fbx, assets/textures/*.png, assets/blend/*.blend (caminhos relativos à pasta do projeto).
- Limites do Roblox: até 20.000 triângulos por mesh (mire em <= 10.000), textura até 1024x1024.
"""
import bpy
import bmesh
import json
import math
import os
from mathutils import Vector

ROBLOX_MAX_TRIS = 20000


# ------------------------------------------------------------------ cena
def reset():
    """Cena vazia, unidades configuradas pra 1 unidade = 1 stud no export."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = "METRIC"
    s.unit_settings.scale_length = 1.0


def _ensure_dir(path):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    return os.path.abspath(path)


def select_only(*objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[-1]


def _link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _place(obj, loc, rot):
    obj.location = Vector(loc)
    obj.rotation_euler = [math.radians(a) for a in rot]
    apply_transforms(obj)
    return obj


def apply_transforms(obj, location=False):
    """Aplica rotação e escala (e posição se pedir). Sempre faça antes de exportar ou juntar."""
    select_only(obj)
    bpy.ops.object.transform_apply(location=location, rotation=True, scale=True)
    return obj


# ------------------------------------------------------------------ primitivas (tamanhos em studs)
def _from_bmesh(name, build):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(mesh)
    bm.free()
    return _link(bpy.data.objects.new(name, mesh))


def box(name, size=(1, 1, 1), loc=(0, 0, 0), rot=(0, 0, 0)):
    """Caixa com tamanho (x, y, z) em studs."""
    def b(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    return _place(_from_bmesh(name, b), loc, rot)


def cylinder(name, radius=0.5, depth=1, segments=24, loc=(0, 0, 0), rot=(0, 0, 0)):
    """Cilindro em pé (eixo Z)."""
    def b(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=depth)
    return _place(_from_bmesh(name, b), loc, rot)


def cone(name, radius=0.5, depth=1, segments=24, tip_radius=0.0, loc=(0, 0, 0), rot=(0, 0, 0)):
    def b(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=tip_radius, depth=depth)
    return _place(_from_bmesh(name, b), loc, rot)


def sphere(name, radius=0.5, segments=24, rings=12, loc=(0, 0, 0), rot=(0, 0, 0)):
    def b(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius)
    return _place(_from_bmesh(name, b), loc, rot)


def torus(name, major=1.0, minor=0.25, loc=(0, 0, 0), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor)
    obj = bpy.context.active_object
    obj.name = name
    return _place(obj, loc, rot)


def from_points(name, verts, faces):
    """Mesh livre: verts [(x,y,z)...], faces [(i,j,k,...)...]."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([Vector(v) for v in verts], [], faces)
    mesh.update()
    return _link(bpy.data.objects.new(name, mesh))


# ------------------------------------------------------------------ modificadores (sempre aplicados)
def _apply_mod(obj, mod):
    select_only(obj)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def bevel(obj, width=0.1, segments=2):
    """Arredonda as quinas (deixa com cara de cartoon/polido)."""
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    return _apply_mod(obj, m)


def mirror(obj, axis="X"):
    m = obj.modifiers.new("Mirror", "MIRROR")
    m.use_axis = [axis == "X", axis == "Y", axis == "Z"]
    return _apply_mod(obj, m)


def array(obj, count=3, offset=(1.2, 0, 0)):
    m = obj.modifiers.new("Array", "ARRAY")
    m.count = count
    m.relative_offset_displace = offset
    return _apply_mod(obj, m)


def subdivide(obj, levels=1):
    m = obj.modifiers.new("Subsurf", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    return _apply_mod(obj, m)


def boolean(obj, cutter, op="DIFFERENCE"):
    """op: DIFFERENCE (cortar), UNION (juntar), INTERSECT. Apaga o cutter depois."""
    m = obj.modifiers.new("Bool", "BOOLEAN")
    m.object = cutter
    m.operation = op
    _apply_mod(obj, m)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def join(objs, name):
    """Junta vários objetos em um só (um MeshPart no Roblox)."""
    for o in objs:
        apply_transforms(o)
    select_only(*objs)
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    return obj


# ------------------------------------------------------------------ topologia
def tris(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def limit_tris(obj, max_tris=10000):
    """Retopologia simples: reduz até caber no limite (Decimate). Não mexe se já couber."""
    t = tris(obj)
    if t <= max_tris:
        return obj
    m = obj.modifiers.new("Decimate", "DECIMATE")
    m.ratio = max(0.01, max_tris / t * 0.98)
    return _apply_mod(obj, m)


def remesh(obj, voxel=0.1, smooth=True):
    """Retopologia uniforme (voxel). Bom pra limpar malha de esculpido/boolean. Depois use limit_tris."""
    m = obj.modifiers.new("Remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    _apply_mod(obj, m)
    if smooth:
        shade_smooth(obj)
    return obj


def clean(obj, merge_distance=0.0001):
    """Remove vértices duplicados e corrige normais (sempre antes de exportar)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_distance)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def shade_flat(obj):
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj


# ------------------------------------------------------------------ UV, material, textura
def smart_uv(obj, margin=0.02):
    """UV automático (necessário pra textura)."""
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def _rgba(color):
    if isinstance(color, str):
        h = color.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        # hex é sRGB; o Blender trabalha em linear
        lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return (lin(r), lin(g), lin(b), 1.0)
    if len(color) == 3:
        return (*color, 1.0)
    return tuple(color)


def material(obj, color="#cccccc", roughness=0.6, metallic=0.0, name=None, faces=None):
    """Cor/material. faces: lista de índices de faces pra pintar só elas (senão o objeto todo)."""
    mat = bpy.data.materials.new(name or (obj.name + "_Mat"))
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = _rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    obj.data.materials.append(mat)
    idx = len(obj.data.materials) - 1
    if faces is not None:
        for i in faces:
            obj.data.polygons[i].material_index = idx
    elif idx > 0:
        for p in obj.data.polygons:
            p.material_index = idx
    return mat


def paint_by_height(obj, colors):
    """Pinta faces por altura: colors = [(z_ate, "#hex"), ...] em ordem crescente."""
    mats = [material(obj, c, name=f"{obj.name}_h{i}", faces=[]) for i, (_, c) in enumerate(colors)]
    first = len(obj.data.materials) - len(mats)
    for p in obj.data.polygons:
        z = (obj.matrix_world @ p.center).z
        for i, (limit, _) in enumerate(colors):
            if z <= limit or i == len(colors) - 1:
                p.material_index = first + i
                break
    return obj


def bake_color(obj, path, size=1024):
    """Gera a textura (PNG) com as cores dos materiais do objeto. Precisa de UV (smart_uv antes)."""
    path = _ensure_dir(path)
    if not obj.data.uv_layers:
        smart_uv(obj)
    img = bpy.data.images.new(os.path.basename(path), size, size, alpha=False)
    for mat in obj.data.materials:
        nodes = mat.node_tree.nodes
        node = nodes.new("ShaderNodeTexImage")
        node.image = img
        nodes.active = node
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.samples = 1
    s.render.bake.use_pass_direct = False
    s.render.bake.use_pass_indirect = False
    s.render.bake.margin = 4
    select_only(obj)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"})
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    # troca os materiais por um só usando a textura (o FBX leva a textura junto)
    for mat in obj.data.materials:
        nodes = mat.node_tree.nodes
        tex = next(n for n in nodes if n.type == "TEX_IMAGE" and n.image == img)
        mat.node_tree.links.new(tex.outputs["Color"], nodes.get("Principled BSDF").inputs["Base Color"])
    return path


# ------------------------------------------------------------------ rig
def armature(name, bones, loc=(0, 0, 0)):
    """bones: [{"name": "Raiz", "head": (0,0,0), "tail": (0,0,1), "parent": None}, ...] em studs."""
    data = bpy.data.armatures.new(name)
    arm = _link(bpy.data.objects.new(name, data))
    arm.location = Vector(loc)
    select_only(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    made = {}
    for b in bones:
        eb = data.edit_bones.new(b["name"])
        eb.head = Vector(b["head"])
        eb.tail = Vector(b["tail"])
        made[b["name"]] = eb
    for b in bones:
        if b.get("parent"):
            made[b["name"]].parent = made[b["parent"]]
            made[b["name"]].use_connect = b.get("connect", False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def bind(mesh, arm):
    """Skinning automático (pesos por proximidade). O mesh passa a se deformar com os ossos."""
    apply_transforms(mesh)
    select_only(mesh, arm)
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    return mesh


# ------------------------------------------------------------------ saída
def export_fbx(path, objs=None):
    """Exporta pro Roblox (FBX). objs: lista de objetos (padrão: todos os meshes e armatures)."""
    path = _ensure_dir(path)
    objs = objs or [o for o in bpy.context.scene.objects if o.type in ("MESH", "ARMATURE")]
    extra = []
    for o in objs:
        if o.type == "MESH":
            clean(o)
            if o.parent and o.parent.type == "ARMATURE" and o.parent not in objs:
                extra.append(o.parent)
            for m in o.modifiers:
                if m.type == "ARMATURE" and m.object and m.object not in objs:
                    extra.append(m.object)
    select_only(*(objs + extra))
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=True,
        object_types={"MESH", "ARMATURE"},
        apply_scale_options="FBX_SCALE_ALL",
        axis_forward="-Z",
        axis_up="Y",
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=True,
    )
    return path


def save_blend(path):
    path = _ensure_dir(path)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    return path


def report(objs=None):
    """Imprime o resumo (a ferramenta blender_run lê isto): triângulos, tamanho e avisos."""
    objs = objs or [o for o in bpy.context.scene.objects if o.type == "MESH"]
    out = []
    for o in objs:
        t = tris(o) if o.type == "MESH" else 0
        warn = []
        if t > ROBLOX_MAX_TRIS:
            warn.append(f"{t} triângulos: acima do limite do Roblox ({ROBLOX_MAX_TRIS}); use limit_tris")
        if o.type == "MESH" and not o.data.uv_layers:
            warn.append("sem UV (textura não vai funcionar)")
        out.append({"nome": o.name, "tipo": o.type, "triangulos": t,
                    "tamanho_studs": [round(d, 3) for d in o.dimensions], "avisos": warn})
    print("RBX_REPORT " + json.dumps(out, ensure_ascii=False))
    return out
