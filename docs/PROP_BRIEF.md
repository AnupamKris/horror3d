# Prop brief — horror3d "Escape the House", Room 01 (abandoned child's bedroom, ~1920s house)

You are building ONE prop in a live, shared Blender 5.3 instance. Several other agents are building
other props in the same scene **at the same time**. The user is watching the viewport.

## Talking to Blender
Run code inside Blender with (from `C:\Users\anupa\Code\horror3d`):

    uv run tools/bl.py -c "<python code>"        # inline
    uv run tools/bl.py path\to\script.py         # file (put scratch scripts in your scratchpad, not the repo)

The prelude already imports `bpy, bmesh, math, Vector, Matrix, Euler` and **`hb`** (helpers in
`tools/hb.py` — read that file first, it is short). Set `result = {...}` (a dict) to return data.
Each call runs atomically on Blender's main thread.

## HARD RULES (shared scene!)
1. Touch ONLY your own prop: objects you create via `hb.*` in collection `PROP_<name>`. Never delete,
   select-and-operate, rename, or modify anything else. Never clear the scene, never `read_homefile`,
   never change render/scene settings, never save the .blend.
2. **Build part by part — one `bl.py` call per part (or small group of identical parts)** so the user sees
   the prop assemble live. Do not build the whole prop in one call.
3. Never leave edit mode / sculpt mode on. Prefer `bmesh` + `hb` builders over `bpy.ops`. If you need an
   operator, wrap it in `with hb.ctx([objs], active):` and only on your own objects.
4. Start with `hb.reset("<name>")` (wipes only your prop). Redo a single part by calling its builder again
   (same part name replaces it) or `hb.remove_part(name, part_name)`.
5. Part names must be globally unique: prefix them with your prop name, e.g. `bed_leg_fl`.

## Space & conventions
- Meters, Z up. Build in your root's LOCAL space: origin = floor-center of the footprint (unless your
  task says otherwise), **front faces local −Y**, up +Z. `hb.LAYOUT` places/rotates your root in the room
  — don't change it.
- Moving parts → object name `MOV_<prop>_<part>` with the **object origin at the pivot** (hinge axis /
  slide start), and geometry offset relative to that origin. Pickup-able/clickable static bits → `INT_...`.
  Everything else gets joined into one mesh on `hb.finalize`.
- Materials: ONLY from the library via `material="M_..."` (see `hb.MATS`). The game replaces them by name
  with procedural triplanar materials, so you don't need UVs (exceptions: `M_Portrait`, `M_Paper` need a
  clean 0..1 UV on the visible face). Use several materials for readable detail (wood + iron + brass...).

## Quality bar: medium-poly, decent-looking, CREEPY, OPTIMIZED
- Triangle budget: **low-complexity props 300–2,500 tris, complex props 2,500–9,000 tris** (room shell up to
  ~6k). Spend tris on silhouette (bevels on visible edges with 1–2 segments, turned legs, curved arms),
  not on flat faces. Use 8–16 cylinder segments depending on size. No hidden interior geometry.
- Make it look old, used and wrong: sagging, slight asymmetry, small random rotations (1–3°), chipped or
  missing bits, stains (`M_Blood` sparingly), dust-cover cloth, broken slats, a crack. Real proportions.
- Keep walls-facing sides simple (they're never seen).

## Finish
1. `result = hb.finalize("<name>")` → check `_total_tris` is in budget.
2. `result = hb.preview("<name>")` → look at `previews\<name>.png` with your Read tool (try other angles with
   `azim=`/`elev=` args). Max ~4 previews — each render blocks Blender for everyone. Fix what looks bad.
   After finalize, parts are joined; to fix things either `hb.reset` and rebuild, or edit the joined mesh.
3. `result = hb.export("<name>")` → writes `public/models/<name>.glb`.
4. Reply with: final tri count, list of MOV_/INT_ objects with their pivot meaning and axis/range of motion
   (e.g. "MOV_wardrobe_door_l: hinge on local Z, opens 0→ -100° about Z"), the prop's local bounding box
   size, and anything the game programmer must know. Keep the reply short.
