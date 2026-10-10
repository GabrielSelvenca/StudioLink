"""
rbx.py — funções prontas pra modelar no Blender e exportar pro Roblox (StudioLink).

Uso (dentro de um script rodado pela ferramenta blender_run). Jeito certo = MALHA ÚNICA + conferir o preview:
    from rbx import *
    reset()
    corpo = loft("Corpo", [(-5, 0.5, 0.5, 0), (-4, 1, 1, 0), (4, 1, 1, 0), (5, 0.4, 0.4, 0.3)])  # tubo contínuo
    asa   = prism("Asa", [(-6, 1), (-6, 2), (6, 2), (6, 1)], -0.2, 0.2)                          # placa grossa
    material(corpo, "#f2f2f2"); material(asa, "#2f6fed")
    obj = union([corpo, asa], "Modelo")       # funde tudo numa malha só (nada de peças sobrepostas)
    shade_flat(obj)
    print("CHECK", check(obj))                # tem que dar [] (fechada, 1 pedaço só)
    palette_texture(obj, "assets/textures/modelo.png")   # cores chapadas, sem borrão
    export_fbx("assets/models/modelo.fbx", [obj])
    preview("assets/preview/modelo.png", [obj])          # 4 vistas: OLHE antes de entregar
    report([obj])

Regras: nunca use join() pra montar o modelo final (gera peças sobrepostas); use union().
Sempre olhe o preview (Read na imagem) e refaça até ficar bom. Só então faça upload.

Convenções:
- 1 unidade do Blender = 1 stud. Eixos do Blender: X = lado, Z = cima, FRENTE = -Y (vira a frente do Roblox, -Z).
  Modele o nariz/frente apontando pra -Y. Se modelou pra +Y, gire 180° em Z antes de exportar.
  O X sai espelhado: Blender +X = Roblox -X (pra mapas/plantas vistos de cima: use x = -leste).
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
    for o in list(bpy.context.view_layer.objects):
        if o is not None:
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


def shade_auto(obj, angle=35):
    """Liso nas curvas e quina viva nas bordas (asa, caixa). O melhor pra modelo arredondado."""
    select_only(obj)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
    return obj


def dome(y0, y1, radius_x, radius_z, z=0.0, steps=6):
    """Seções de uma ponta arredondada (nariz/cauda) pra usar no loft: vai de y0 (ponta) a y1 (largura total)."""
    out = []
    for i in range(steps + 1):
        t = i / steps
        a = t * math.pi / 2
        out.append((y0 + (y1 - y0) * (1 - math.cos(a)), max(radius_x * math.sin(a), 0.02), max(radius_z * math.sin(a), 0.02), z))
    return out


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


# ------------------------------------------------------------------ malha única e limpa (use isto em vez de join)
def loft(name, sections, sides=8, cap_front=None, cap_back=None, angle_offset=None):
    """Tubo contínuo (fuselagem, garrafa, tronco...) a partir de seções ao longo de Y.
    sections: [(y, raio_x, raio_z, z_centro), ...] de trás pra frente ou de frente pra trás.
    cap_front / cap_back: (x, y, z) de um vértice central pra fechar a ponta (arredondado); None = tampa plana."""
    off = math.pi / sides if angle_offset is None else angle_offset  # lado reto em cima e embaixo
    verts, faces = [], []
    for (y, rx, rz, zc) in sections:
        for i in range(sides):
            a = off + 2 * math.pi * i / sides
            verts.append((math.cos(a) * rx, y, zc + math.sin(a) * rz))
    n = len(sections)
    for s_ in range(n - 1):
        for i in range(sides):
            a, b = s_ * sides + i, s_ * sides + (i + 1) % sides
            c, d = b + sides, a + sides
            faces.append((a, b, c, d))
    def cap(ring, point, flip):
        idx = list(range(ring * sides, ring * sides + sides))
        if point is None:
            faces.append(tuple(reversed(idx)) if flip else tuple(idx))
        else:
            verts.append(point)
            ci = len(verts) - 1
            for i in range(sides):
                a, b = idx[i], idx[(i + 1) % sides]
                faces.append((b, a, ci) if flip else (a, b, ci))
    cap(0, cap_back, True)
    cap(n - 1, cap_front, False)
    obj = from_points(name, verts, faces)
    clean(obj)
    return obj


def prism(name, outline, z0, z1, axis="Z"):
    """Placa grossa (asa, leme, lâmina): outline = [(a, b), ...] no plano, extrudado de z0 a z1.
    axis Z: outline em (x, y), espessura em z.  axis X: outline em (y, z), espessura em x."""
    k = len(outline)
    if axis == "Z":
        verts = [(a, b, z0) for a, b in outline] + [(a, b, z1) for a, b in outline]
    else:
        verts = [(z0, a, b) for a, b in outline] + [(z1, a, b) for a, b in outline]
    faces = [tuple(reversed(range(k))), tuple(range(k, 2 * k))]
    for i in range(k):
        j = (i + 1) % k
        faces.append((i, j, j + k, i + k))
    obj = from_points(name, verts, faces)
    clean(obj)
    return obj


def union(objs, name):
    """Funde vários objetos fechados numa malha ÚNICA (boolean exato): sem peças sobrepostas por dentro.
    Os materiais de cada parte são mantidos."""
    base = objs[0]
    for o in objs:
        apply_transforms(o)
    for o in objs[1:]:
        m = base.modifiers.new("Union", "BOOLEAN")
        m.operation = "UNION"
        m.solver = "EXACT"
        m.material_mode = "TRANSFER"  # mantém a cor de cada parte
        m.object = o
        _apply_mod(base, m)
        bpy.data.objects.remove(o, do_unlink=True)
    base.name = name
    base.data.name = name
    clean(base)
    return base


def palette_texture(obj, path, cell=16):
    """Cores chapadas sem borrão: cria uma textura-paleta (1 quadrado por material) e aponta o UV de cada face
    pro centro do quadrado da cor dela. Ideal pra low-poly. Substitui smart_uv + bake_color."""
    path = _ensure_dir(path)
    mats = list(obj.data.materials) or [None]
    n = len(mats)
    cols = max(1, math.ceil(math.sqrt(n)))
    size = cols * cell
    img = bpy.data.images.new(os.path.basename(path), size, size, alpha=False)
    px = [0.0] * (size * size * 4)
    centers = []
    for k, mat in enumerate(mats):
        c = (0.8, 0.8, 0.8, 1.0)
        if mat and mat.node_tree:
            b = mat.node_tree.nodes.get("Principled BSDF")
            if b:
                lin = b.inputs["Base Color"].default_value
                # o material guarda cor linear; a imagem (PNG) guarda sRGB
                to_srgb = lambda x: x * 12.92 if x <= 0.0031308 else 1.055 * (x ** (1 / 2.4)) - 0.055
                c = (to_srgb(lin[0]), to_srgb(lin[1]), to_srgb(lin[2]), 1.0)
        cx, cy = k % cols, k // cols
        for y in range(cy * cell, cy * cell + cell):
            for x in range(cx * cell, cx * cell + cell):
                i = (y * size + x) * 4
                px[i:i + 4] = [c[0], c[1], c[2], 1.0]
        centers.append(((cx + 0.5) / cols, (cy + 0.5) / cols))
    img.pixels = px
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UV")
    uv = me.uv_layers.active.data
    for p in me.polygons:
        u, v = centers[min(p.material_index, n - 1)]
        for li in p.loop_indices:
            uv[li].uv = (u, v)
    # um material só com a paleta (o FBX leva a textura)
    mat = bpy.data.materials.new(obj.name + "_Paleta")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    mat.node_tree.links.new(tex.outputs["Color"], nodes.get("Principled BSDF").inputs["Base Color"])
    me.materials.clear()
    me.materials.append(mat)
    for p in me.polygons:
        p.material_index = 0
    return path


def check(obj):
    """Valida a malha: devolve problemas (malha aberta, arestas soltas, faces sobrepostas). Lista vazia = ok."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    probs = []
    non_manifold = [e for e in bm.edges if not e.is_manifold]
    if non_manifold:
        probs.append(f"{len(non_manifold)} arestas abertas/não-manifold")
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        probs.append(f"{len(loose)} vértices soltos")
    zero = [f for f in bm.faces if f.calc_area() < 1e-6]
    if zero:
        probs.append(f"{len(zero)} faces com área zero")
    parts = 0
    seen = set()
    for v in bm.verts:
        if v.index in seen:
            continue
        parts += 1
        stack = [v]
        while stack:
            x = stack.pop()
            if x.index in seen:
                continue
            seen.add(x.index)
            stack.extend(e.other_vert(x) for e in x.link_edges)
    if parts > 1:
        probs.append(f"{parts} pedaços separados (deveria ser 1)")
    bm.free()
    return probs


def preview(path, objs=None, size=640):
    """Renderiza 4 vistas (3/4 frente, lado, cima, 3/4 trás) num PNG só, pra conferir o modelo antes de entregar.
    Frente = -Y. Mostra a textura de verdade (o que vai pro Roblox)."""
    path = _ensure_dir(path)
    objs = objs or [o for o in bpy.context.scene.objects if o.type == "MESH"]
    s = bpy.context.scene
    lo = Vector((min((o.matrix_world @ Vector(c)).x for o in objs for c in o.bound_box),
                 min((o.matrix_world @ Vector(c)).y for o in objs for c in o.bound_box),
                 min((o.matrix_world @ Vector(c)).z for o in objs for c in o.bound_box)))
    hi = Vector((max((o.matrix_world @ Vector(c)).x for o in objs for c in o.bound_box),
                 max((o.matrix_world @ Vector(c)).y for o in objs for c in o.bound_box),
                 max((o.matrix_world @ Vector(c)).z for o in objs for c in o.bound_box)))
    center, radius = (lo + hi) / 2, max((hi - lo).length / 2, 0.5)
    if not s.world:
        s.world = bpy.data.worlds.new("Mundo")
    s.world.color = (0.62, 0.74, 0.86)
    # Cycles na CPU: funciona sem placa de vídeo/janela e mostra a textura de verdade
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.samples = 24
    s.cycles.use_denoising = False
    s.world.use_nodes = True
    bg = s.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.62, 0.74, 0.86, 1)
        bg.inputs["Strength"].default_value = 0.55
    sun = _link(bpy.data.objects.new("PreviewSun", bpy.data.lights.new("PreviewSun", "SUN")))
    sun.data.energy = 2.2
    sun.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
    s.render.resolution_x = s.render.resolution_y = size
    cam = _link(bpy.data.objects.new("PreviewCam", bpy.data.cameras.new("PreviewCam")))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = radius * 1.75
    s.camera = cam
    views = [("3/4 frente", (-1, -1, 0.7)), ("lado", (1, 0, 0)), ("cima", (0, 0, 1)), ("3/4 tras", (1, 1, 0.5))]
    files = []
    for i, (_, d) in enumerate(views):
        d = Vector(d).normalized()
        cam.location = center + d * radius * 4
        up = "Y" if abs(d.z) < 0.99 else "Z"
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y" if up == "Y" else "Y").to_euler()
        if abs(d.z) >= 0.99:
            cam.rotation_euler = (0, 0, 0)
        f = path[:-4] + f"_{i}.png"
        s.render.filepath = f
        bpy.ops.render.render(write_still=True)
        files.append(f)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.objects.remove(sun, do_unlink=True)
    # junta as 4 imagens numa grade 2x2
    imgs = [bpy.data.images.load(f) for f in files]
    W = size * 2
    out = bpy.data.images.new(os.path.basename(path), W, W, alpha=False)
    big = [0.0] * (W * W * 4)
    for k, im in enumerate(imgs):
        ox, oy = (k % 2) * size, (1 - k // 2) * size
        p = list(im.pixels)
        for y in range(size):
            row = p[y * size * 4:(y + 1) * size * 4]
            start = ((oy + y) * W + ox) * 4
            big[start:start + size * 4] = row
    out.pixels = big
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    for f in files:
        try:
            os.remove(f)
        except OSError:
            pass
    print("RBX_PREVIEW " + path)
    return path
