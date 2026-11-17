import * as THREE from "three";
import { b2t, DOLL_ANCHORS, ENTITIES, ITEMS, PROPS, propByName, type ItemId, type Vec3 } from "../shared/level";
import type { Snapshot } from "../shared/protocol";
import { loadProp } from "./assets";
import { bulbMaterial, flameMaterial, portraitMaterial, portraitTexture } from "./materials";

/** How each MOV_ node animates when its entity opens. Axis is in the node's parent (prop) space. */
interface Motion { type: "rot" | "pos"; axis: THREE.Vector3; open: number; time: number }
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const D = Math.PI / 180;
// Blender local -> three local: Bl Z rot == three Y rot (same sign), Bl X == three X, Bl -Y == three +Z
export const MOTIONS: Record<string, Motion> = {
  door: { type: "rot", axis: Y, open: -100 * D, time: 1.6 },
  drawer: { type: "pos", axis: Z, open: 0.28, time: 0.45 },
  trunk: { type: "rot", axis: X, open: -100 * D, time: 1.0 },
  wardrobe_l: { type: "rot", axis: Y, open: -105 * D, time: 1.1 },
  wardrobe_r: { type: "rot", axis: Y, open: 105 * D, time: 1.1 },
};

/** where items rest inside their containers (Blender prop-local coords) */
export const ITEM_SPOTS: Record<ItemId, { prop: string; node?: string; at: Vec3; rotZ: number }> = {
  trunk_key: { prop: "nightstand", node: "MOV_nightstand_drawer", at: [0.03, -0.03, 0.471], rotZ: 25 },
  door_key: { prop: "trunk", at: [0.1, 0.0, 0.062], rotZ: -15 },
};

interface Anim { node: THREE.Object3D; motion: Motion; restQ: THREE.Quaternion; restP: THREE.Vector3; t: number; target: number; speed: number }

export class World {
  scene = new THREE.Scene();
  props = new Map<string, THREE.Group>();
  /** objects the interaction ray can hit -> interaction id */
  interactables: { obj: THREE.Object3D; id: string }[] = [];
  /** big static meshes that block line of sight (doll visibility test) */
  occluders: THREE.Object3D[] = [];
  private anims = new Map<string, Anim>();
  private items = new Map<ItemId, THREE.Object3D>();

  bulbLight!: THREE.PointLight;
  lampLight!: THREE.PointLight;
  moon!: THREE.SpotLight;
  private swing?: THREE.Object3D;
  private swingAmp = 0.05;
  private chair?: THREE.Object3D;
  private chairAmp = 0;
  private chairUntil = 0;
  private flickerUntil = 0;
  private flickerAmt = 0;
  power = 1;
  private time = 0;

  doll!: THREE.Group;
  dollHead?: THREE.Object3D;
  private dollAnchor = 0;
  dollFocus = new THREE.Vector3(); // point used for the "is it seen" test
  private lunge = 0;
  /** cold under-light on the doll face during the jumpscare (always in scene: no shader recompile) */
  scareLight = new THREE.PointLight(0xb8c8ff, 0, 1.6, 2);

  private remote = new Map<string, THREE.Group>();

  async load(onProgress: (f: number) => void) {
    const names = [...PROPS.map((p) => p.name), "key"];
    let done = 0;
    const loaded = await Promise.all(
      names.map(async (n) => {
        try {
          const g = await loadProp(n);
          return [n, g] as const;
        } catch (e) {
          console.warn("missing prop", n, e);
          return [n, null] as const;
        } finally {
          onProgress(++done / names.length);
        }
      }),
    );
    for (const [n, g] of loaded) if (g) this.props.set(n, g);

    for (const p of PROPS) {
      const g = this.props.get(p.name);
      if (!g) continue;
      g.position.set(...p.pos);
      g.rotation.y = p.rotY;
      this.scene.add(g);
    }
    this.setupStatic();
    this.setupEntities();
    this.setupItems();
    this.setupLights();
    this.setupDoll();
    // freeze matrices of props that never move (skips per-frame matrix recompute)
    for (const name of ["room_shell", "bed", "rug", "books_pile", "portrait"]) {
      const g = this.props.get(name);
      if (!g) continue;
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        o.matrixAutoUpdate = false;
        o.matrixWorldAutoUpdate = false;
      });
    }
  }

  private setupStatic() {
    for (const name of ["room_shell", "wardrobe", "bed", "door", "trunk", "nightstand", "rocking_chair"]) {
      const g = this.props.get(name);
      if (!g) continue;
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !o.name.startsWith("MOV_doll")) this.occluders.push(o);
      });
    }
    // glass & tiny stuff should not cast shadows (cheaper + prettier)
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).transparent) m.castShadow = false;
    });
    const rug = this.props.get("rug");
    rug?.traverse((o) => (o.castShadow = false));
    // portrait canvas
    portraitMaterial.map = portraitTexture(0);
    portraitMaterial.needsUpdate = true;
    const portrait = this.props.get("portrait");
    if (portrait) this.interactables.push({ obj: portrait, id: "portrait" });
  }

  setPortraitStage(stage: number) {
    portraitMaterial.map?.dispose();
    portraitMaterial.map = portraitTexture(stage);
    portraitMaterial.needsUpdate = true;
  }

  private findNode(prop: string, name?: string) {
    const g = this.props.get(prop);
    if (!g || !name) return g;
    return g.getObjectByName(name) ?? g.getObjectByName(name.replace(/\./g, ""));
  }

  private setupEntities() {
    for (const e of ENTITIES) {
      const node = this.findNode(e.prop, e.node);
      if (!node) continue;
      // drawer/trunk: the whole piece of furniture is the click target, not just the moving part
      const clickTarget = e.kind === "drawer" || e.kind === "lid" ? this.props.get(e.prop)! : node;
      if (e.kind !== "inspect" || e.id === "doll") this.interactables.push({ obj: clickTarget, id: e.id });
      const motion = MOTIONS[e.id];
      if (motion && e.node && node !== this.props.get(e.prop)) {
        this.anims.set(e.id, {
          node, motion, restQ: node.quaternion.clone(), restP: node.position.clone(), t: 0, target: 0, speed: 1 / motion.time,
        });
      }
    }
    this.swing = this.findNode("ceiling_lamp", "MOV_ceiling_lamp_swing");
    this.chair = this.findNode("rocking_chair", "MOV_rocking_chair_body");
  }

  private setupItems() {
    const key = this.props.get("key");
    if (!key) return;
    this.scene.remove(key);
    for (const id of Object.keys(ITEM_SPOTS) as ItemId[]) {
      const spot = ITEM_SPOTS[id];
      const k = key.clone(true);
      k.scale.setScalar(ITEMS[id].scale);
      const prop = this.props.get(spot.prop);
      if (!prop) continue;
      const parent = (spot.node && prop.getObjectByName(spot.node)) || prop;
      prop.updateMatrixWorld(true);
      const world = new THREE.Vector3(...b2t(...spot.at)).applyMatrix4(prop.matrixWorld);
      parent.add(k);
      parent.updateMatrixWorld(true);
      k.position.copy(parent.worldToLocal(world));
      k.rotation.y = spot.rotZ * D;
      if (id === "door_key") k.traverse((o) => ((o as THREE.Mesh).material && ((o as THREE.Mesh).material = darkIron)));
      this.items.set(id, k);
      this.interactables.push({ obj: k, id: "item:" + id });
    }
  }

  private setupLights() {
    const s = this.scene;
    s.background = new THREE.Color(0x000000);
    s.fog = new THREE.FogExp2(0x020203, 0.12);
    s.add(new THREE.HemisphereLight(0x1a2233, 0x0c0806, 0.35));

    // bulb: rides the swinging cord
    this.bulbLight = new THREE.PointLight(0xffb36b, 6, 9, 2);
    const swing = this.swing ?? this.props.get("ceiling_lamp");
    if (swing) {
      swing.add(this.bulbLight);
      // bulb center reported by the prop agent: Blender (0,0,-0.91) under the swing pivot; nudge below the glass
      this.bulbLight.position.set(0, -0.95, 0);
    } else {
      this.bulbLight.position.set(0, 2.0, 0);
      s.add(this.bulbLight);
    }

    // oil lamp flame
    this.lampLight = new THREE.PointLight(0xff8a3a, 0.9, 3.2, 2);
    const lamp = this.props.get("oil_lamp");
    if (lamp) {
      lamp.add(this.lampLight);
      this.lampLight.position.set(0, 0.155, 0);
    }

    // moonlight through the boarded window: static shadow map, refreshed only on change
    this.moon = new THREE.SpotLight(0x7f9cd8, 45, 14, 0.42, 0.6, 1.2);
    this.moon.position.set(5.5, 2.9, -0.4);
    this.moon.target.position.set(0, 0, 0.6);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1024, 1024);
    this.moon.shadow.bias = -0.0008;
    this.moon.shadow.normalBias = 0.02;
    this.moon.shadow.camera.near = 1.5;
    this.moon.shadow.camera.far = 12;
    this.moon.shadow.autoUpdate = false;
    this.moon.shadow.needsUpdate = true;
    s.add(this.moon, this.moon.target);
  }

  private setupDoll() {
    const d = this.props.get("doll");
    if (!d) {
      this.doll = new THREE.Group();
      return;
    }
    this.doll = d;
    this.dollHead = d.getObjectByName("MOV_doll_head");
    d.add(this.scareLight);
    this.scareLight.position.set(0, 0.12, 0.28); // low and in front of the face: underlit
    const box = new THREE.Box3().setFromObject(d);
    this.dollFocus.copy(box.getCenter(new THREE.Vector3()));
  }

  refreshShadows() {
    this.moon.shadow.needsUpdate = true;
  }

  // ---------------------------------------------------------------- reactions to host events
  setEntity(id: string, open: boolean, slow = false) {
    const a = this.anims.get(id);
    if (!a) return;
    a.target = open ? 1 : 0;
    a.speed = (1 / a.motion.time) * (slow ? 0.12 : 1);
  }
  flicker(dur: number, intensity: number) {
    this.flickerUntil = this.time + dur;
    this.flickerAmt = intensity;
  }
  blackout() {
    this.power = 0;
    bulbMaterial.color.setRGB(0.05, 0.04, 0.03);
  }
  rockChair(amp: number, dur: number) {
    this.chairAmp = amp;
    this.chairUntil = this.time + dur;
  }
  swingLamp(amp: number) {
    this.swingAmp = Math.max(this.swingAmp, amp);
  }
  lungeDoll(pos: Vec3, rotY: number) {
    // the event carries the spot: don't wait for the next snapshot
    this.doll.position.set(...pos);
    this.doll.rotation.set(0, rotY, 0);
    this.doll.visible = true;
    this.dollAnchor = -1;
    this.lunge = 1;
  }

  /** apply authoritative snapshot (doll placement, entity states, items) */
  applySnapshot(s: Snapshot, you: string) {
    for (const [id, st] of Object.entries(s.ents)) {
      const a = this.anims.get(id);
      if (a && a.target !== (st.open ? 1 : 0)) this.setEntity(id, st.open);
    }
    for (const [id, loc] of Object.entries(s.items) as [ItemId, Snapshot["items"][ItemId]][]) {
      const k = this.items.get(id);
      if (k) k.visible = loc.at === "entity";
    }
    if (s.power === 0 && this.power !== 0) this.blackout();
    // doll
    const dl = s.doll;
    if (this.lunge > 0) return; // client owns the doll during the jumpscare animation
    if (this.doll && (dl.anchor !== this.dollAnchor || dl.anchor === -1)) {
      const moved = this.doll.position.distanceToSquared(new THREE.Vector3(...dl.pos)) > 1e-4;
      this.dollAnchor = dl.anchor;
      const anchor = DOLL_ANCHORS[dl.anchor];
      this.doll.position.set(...dl.pos);
      this.doll.rotation.y = dl.rotY;
      // standing behind the player (stalk) vs sitting at an anchor: sit on floor if custom
      if (!anchor) this.doll.position.y = 0;
      if (moved) this.refreshShadows();
    }
    this.doll.visible = dl.visible;
    this.dollLookAt = dl.look === you ? "you" : dl.look;
  }
  dollLookAt: string | null = null;

  // ---------------------------------------------------------------- per frame
  update(dt: number, camPos: THREE.Vector3, dollSeen: boolean) {
    this.time += dt;
    const t = this.time;

    for (const a of this.anims.values()) {
      if (a.t === a.target) continue;
      a.t = a.target > a.t ? Math.min(a.target, a.t + dt * a.speed) : Math.max(a.target, a.t - dt * a.speed);
      const e = a.t * a.t * (3 - 2 * a.t); // smoothstep
      if (a.motion.type === "rot") a.node.quaternion.setFromAxisAngle(a.motion.axis, a.motion.open * e).multiply(a.restQ);
      else a.node.position.copy(a.restP).addScaledVector(a.motion.axis, a.motion.open * e);
      if (a.t === a.target) this.refreshShadows();
    }

    // light flicker
    const flick = t < this.flickerUntil
      ? (Math.random() < 0.35 ? 0.05 : 1) * (1 - this.flickerAmt * 0.6 * Math.random())
      : 0.92 + 0.08 * Math.sin(t * 13.0) * Math.sin(t * 7.3);
    const bulbOn = this.power * flick;
    this.bulbLight.intensity = 6 * bulbOn;
    this.bulbLight.visible = bulbOn > 0.01;
    if (this.power > 0) bulbMaterial.color.setRGB(4 * bulbOn, 3.2 * bulbOn, 2 * bulbOn);
    const lf = 0.8 + 0.15 * Math.sin(t * 9.1) + 0.1 * Math.sin(t * 23.7 + 1.3) + (Math.random() - 0.5) * 0.08;
    this.lampLight.intensity = 0.9 * lf;
    flameMaterial.color.setRGB(5 * lf, 2.7 * lf, 1 * lf);

    if (this.swing) {
      this.swingAmp = Math.max(0.03, this.swingAmp * (1 - dt * 0.08));
      this.swing.rotation.x = Math.sin(t * 1.9) * this.swingAmp * 0.6;
      this.swing.rotation.z = Math.cos(t * 1.7) * this.swingAmp * 0.4;
    }
    if (this.chair) {
      const amp = t < this.chairUntil ? this.chairAmp : Math.max(0, this.chairAmp * (1 - dt * 0.4));
      this.chairAmp = amp;
      this.chair.rotation.x = Math.sin(t * 2.4) * amp;
      if (this.dollAnchor === 0 && this.doll) {
        // doll rides the chair
        const base = new THREE.Vector3(...propByName("doll").pos);
        this.doll.position.copy(base);
        this.doll.rotation.x = 0;
        this.doll.position.y = base.y + Math.abs(Math.sin(t * 2.4) * amp) * 0.05;
      }
    }

    // doll head: turns toward its target only while unseen (snaps, never animates on screen)
    if (this.dollHead && this.doll.visible) {
      const target = new THREE.Vector3();
      if (this.dollLookAt) target.copy(camPos);
      if (!dollSeen) {
        const local = this.doll.worldToLocal(target.clone());
        const want = Math.max(-1.9, Math.min(1.9, Math.atan2(local.x, local.z)));
        this.dollHead.rotation.set(0.12, want, 0.08);
      }
    }
    if (this.lunge > 0) {
      // jumpscare: a beat of stillness, then the doll launches at your face (head-high, filling the view)
      const prev = this.lunge;
      this.lunge = Math.max(0, this.lunge - dt * 1.4);
      const k = 1 - this.lunge; // 0 -> 1 over ~0.7s
      if (k > 0.2 && this.lunge > 0) {
        const s = Math.min(1, (k - 0.2) / 0.35);
        const e = s * s; // accelerate
        const target = camPos.clone().add(new THREE.Vector3(0, -0.42, 0));
        const toCam = target.clone().sub(this.doll.position);
        const toCamFlat = toCam.clone().setY(0);
        const d = toCamFlat.length();
        if (d > 0.55) this.doll.position.addScaledVector(toCamFlat.normalize(), Math.min(d - 0.55, dt * (2 + e * 12)));
        this.scareLight.intensity = 2.5 * (0.7 + Math.random() * 0.3);
        this.doll.position.y += (target.y - this.doll.position.y) * Math.min(1, dt * (3 + e * 14));
        this.doll.rotation.y = Math.atan2(camPos.x - this.doll.position.x, camPos.z - this.doll.position.z);
        if (this.dollHead) this.dollHead.rotation.set(-0.15, 0, 0.35 * Math.sin(k * 40)); // twitching
      }
      if (prev > 0 && this.lunge === 0) { this.doll.visible = false; this.scareLight.intensity = 0; } // gone when the light returns
    }
    this.dollFocus.copy(this.doll.position).add(new THREE.Vector3(0, 0.35, 0));
  }

  // ---------------------------------------------------------------- remote players (simple avatars)
  syncRemote(players: { id: string; pos: Vec3; yaw: number; crouch: boolean; flash: boolean }[]) {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      let g = this.remote.get(p.id);
      if (!g) {
        g = makeAvatar();
        this.remote.set(p.id, g);
        this.scene.add(g);
      }
      g.position.set(p.pos[0], 0, p.pos[2]);
      g.rotation.y = p.yaw;
      g.scale.y = p.crouch ? 0.65 : 1;
      (g.userData.light as THREE.SpotLight).visible = p.flash;
    }
    for (const [id, g] of this.remote) if (!seen.has(id)) { this.scene.remove(g); this.remote.delete(id); }
  }
}

const darkIron = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, metalness: 0.9, roughness: 0.45 });

function makeAvatar() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.1, 4, 8), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }));
  body.position.y = 0.8;
  body.castShadow = true;
  g.add(body);
  const light = new THREE.SpotLight(0xfff1d6, 8, 9, 0.4, 0.5, 2);
  light.position.set(0.2, 1.45, -0.2);
  light.target.position.set(0.2, 1.2, -3);
  g.add(light, light.target);
  g.userData.light = light;
  return g;
}
