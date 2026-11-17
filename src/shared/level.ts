// Room 01 level definition, shared by host (authoritative sim) and client (rendering).
// Coordinates are three.js world space (Y up, meters). Blender (x, y, z) -> three (x, z, -y),
// Blender rotation about Z == three rotation about Y (same angle).
// Keep this file free of three.js imports so a headless Node server can use it.

export type Vec3 = [number, number, number];

export const b2t = (x: number, y: number, z: number): Vec3 => [x, z, -y];
const deg = (d: number) => (d * Math.PI) / 180;

export interface PropPlacement {
  name: string; // glb file name in /m/<name>.glb
  pos: Vec3;
  rotY: number;
}

// Mirrors tools/hb.py LAYOUT (the Blender scene is the level editor).
export const PROPS: PropPlacement[] = [
  ["room_shell", [0, 0, 0], 0],
  ["door", [1.6, 2.5, 0], 0],
  ["bed", [-1.95, -0.7, 0], 90],
  ["nightstand", [-2.7, 0.42, 0], 90],
  ["oil_lamp", [-2.7, 0.42, 0.6], 90],
  ["wardrobe", [-1.55, 2.17, 0], 0],
  ["rocking_chair", [2.15, -1.65, 0], -135],
  ["doll", [2.15, -1.65, 0.462], -135],
  ["trunk", [-0.62, -0.7, 0], 90],
  ["portrait", [0, -2.47, 1.55], 180],
  ["books_pile", [-0.55, 2.2, 0], 15],
  ["ceiling_lamp", [0, 0, 2.8], 0],
  ["rug", [0.25, -0.35, 0], 4],
].map(([name, p, r]) => {
  const [x, y, z] = p as number[];
  return { name: name as string, pos: b2t(x, y, z), rotY: deg(r as number) };
});

export const propByName = (n: string) => PROPS.find((p) => p.name === n)!;

/** Transform a prop-local point (Blender local coords) into three world space. */
export function propLocalToWorld(prop: string, bx: number, by: number, bz: number): Vec3 {
  const p = propByName(prop);
  const [lx, ly, lz] = b2t(bx, by, bz);
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  return [p.pos[0] + lx * c + lz * s, p.pos[1] + ly, p.pos[2] - lx * s + lz * c];
}

// ------------------------------------------------------------------ collision (2D, XZ plane)
export interface OBB {
  id: string;
  x: number; z: number; // center
  hx: number; hz: number; // half extents (local)
  rot: number; // about Y
  /** collider only active while this entity is closed */
  whileClosed?: string;
}

const ROOM = { minX: -3, maxX: 3, minZ: -2.5, maxZ: 2.5, height: 2.8 };
export const ROOM_BOUNDS = ROOM;

function propBox(id: string, prop: string, w: number, d: number, offX = 0, offY = 0): OBB {
  const p = propByName(prop);
  const [x, , z] = propLocalToWorld(prop, offX, offY, 0);
  return { id, x, z, hx: w / 2, hz: d / 2, rot: p.rotY };
}

export const COLLIDERS: OBB[] = [
  // walls (thick slabs outside the interior)
  { id: "wall_w", x: ROOM.minX - 0.5, z: 0, hx: 0.5, hz: 4, rot: 0 },
  { id: "wall_e", x: ROOM.maxX + 0.5, z: 0, hx: 0.5, hz: 4, rot: 0 },
  { id: "wall_s", x: 0, z: ROOM.maxZ + 0.5, hx: 4, hz: 0.5, rot: 0 },
  // north wall split around the door opening (x 1.15..2.05)
  { id: "wall_n_a", x: (ROOM.minX - 1 + 1.15) / 2, z: ROOM.minZ - 0.5, hx: (1.15 - (ROOM.minX - 1)) / 2, hz: 0.5, rot: 0 },
  { id: "wall_n_b", x: (2.05 + ROOM.maxX + 1) / 2, z: ROOM.minZ - 0.5, hx: (ROOM.maxX + 1 - 2.05) / 2, hz: 0.5, rot: 0 },
  { id: "door_closed", x: 1.6, z: ROOM.minZ - 0.04, hx: 0.45, hz: 0.06, rot: 0, whileClosed: "door" },
  propBox("bed", "bed", 1.05, 2.0),
  propBox("nightstand", "nightstand", 0.45, 0.4),
  propBox("wardrobe", "wardrobe", 1.22, 0.62),
  propBox("rocking_chair", "rocking_chair", 0.62, 0.95),
  propBox("trunk", "trunk", 0.86, 0.5),
  propBox("books_pile", "books_pile", 0.45, 0.35),
];

/** Push a circle (player) out of all colliders. Mutates and returns pos. */
export function collide(pos: { x: number; z: number }, r: number, isOpen: (id: string) => boolean): void {
  for (let iter = 0; iter < 3; iter++) {
    for (const b of COLLIDERS) {
      if (b.whileClosed && isOpen(b.whileClosed)) continue;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      // world -> box local (inverse rotation about Y)
      const dx = pos.x - b.x, dz = pos.z - b.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const qx = Math.max(-b.hx, Math.min(b.hx, lx));
      const qz = Math.max(-b.hz, Math.min(b.hz, lz));
      let nx = lx - qx, nz = lz - qz;
      let d2 = nx * nx + nz * nz;
      if (d2 >= r * r) continue;
      let push: number;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        push = r - d;
        nx /= d; nz /= d;
      } else {
        // center inside box: push out along the shallowest axis
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + r; }
        else { nx = 0; nz = Math.sign(lz) || 1; push = pz + r; }
      }
      // local -> world
      const wx = nx * c + nz * s, wz = -nx * s + nz * c;
      pos.x += wx * push;
      pos.z += wz * push;
    }
  }
}

// ------------------------------------------------------------------ interactive entities
export type EntityKind = "door" | "drawer" | "lid" | "hinged" | "inspect";

export interface EntityDef {
  id: string;
  kind: EntityKind;
  prop: string;
  node?: string; // MOV_ node in the prop glb that animates
  anchor: Vec3; // interaction reference point (world)
  locked?: boolean;
  requires?: ItemId;
  contains?: ItemId;
  lockedText?: string;
  text?: string; // inspect text
}

export type ItemId = "trunk_key" | "door_key";

export const ITEMS: Record<ItemId, { label: string; scale: number }> = {
  trunk_key: { label: "Small tarnished key", scale: 0.8 },
  door_key: { label: "Heavy iron key", scale: 1.25 },
};

export const ENTITIES: EntityDef[] = [
  {
    id: "door", kind: "door", prop: "door", node: "MOV_door_leaf",
    anchor: propLocalToWorld("door", 0.3, -0.05, 1.0),
    locked: true, requires: "door_key",
    lockedText: "Locked. The keyhole is caked with rust... and something darker.",
  },
  {
    id: "drawer", kind: "drawer", prop: "nightstand", node: "MOV_nightstand_drawer",
    anchor: propLocalToWorld("nightstand", 0, -0.2, 0.5), contains: "trunk_key",
  },
  {
    id: "trunk", kind: "lid", prop: "trunk", node: "MOV_trunk_lid",
    anchor: propLocalToWorld("trunk", 0, -0.2, 0.45), locked: true, requires: "trunk_key", contains: "door_key",
    lockedText: "The trunk is locked. A small brass keyhole.",
  },
  {
    id: "wardrobe_l", kind: "hinged", prop: "wardrobe", node: "MOV_wardrobe_door_l",
    anchor: propLocalToWorld("wardrobe", -0.3, -0.35, 1.1),
  },
  {
    id: "wardrobe_r", kind: "hinged", prop: "wardrobe", node: "MOV_wardrobe_door_r",
    anchor: propLocalToWorld("wardrobe", 0.3, -0.35, 1.1),
  },
  {
    id: "portrait", kind: "inspect", prop: "portrait",
    anchor: propLocalToWorld("portrait", 0, -0.05, 0),
    text: "\"The Ashworth family, 1921.\" Someone scratched out the little girl's face.",
  },
  {
    id: "doll", kind: "inspect", prop: "doll",
    anchor: propLocalToWorld("doll", 0, 0, 0.3),
    text: "Her eyes are wet.",
  },
];

export const entityById = (id: string) => ENTITIES.find((e) => e.id === id);

// ------------------------------------------------------------------ doll anchors (where it can be)
export interface DollAnchor { pos: Vec3; rotY: number; sitting: boolean }

export const DOLL_ANCHORS: DollAnchor[] = [
  { pos: propByName("doll").pos, rotY: propByName("doll").rotY, sitting: true }, // rocking chair
  { pos: propLocalToWorld("bed", 0.15, 0.55, 0.55), rotY: deg(90 + 25), sitting: true }, // on bed pillow
  { pos: propLocalToWorld("trunk", 0, 0, 0.48), rotY: deg(90), sitting: true }, // on trunk
  { pos: b2t(-1.55, 1.5, 0), rotY: deg(10), sitting: true }, // floor before wardrobe
  { pos: b2t(1.0, 1.9, 0), rotY: deg(-30), sitting: true }, // by the door
  { pos: b2t(2.6, 0.9, 0), rotY: deg(-110), sitting: true }, // under window
];

export const PLAYER = {
  radius: 0.26,
  eye: 1.62,
  eyeCrouch: 1.0,
  walk: 1.45,
  run: 2.7,
  crouch: 0.8,
  reach: 1.9,
};

// yaw convention: forward = (-sin(yaw), 0, -cos(yaw)); yaw 90° looks toward -X (the bed).
export const SPAWN: { pos: Vec3; yaw: number } = { pos: [0.35, 0, 0.55], yaw: deg(80) };
