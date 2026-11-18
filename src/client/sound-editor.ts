// Sound editor (F2): see exactly where every sound cue fires, hear it from anywhere, tune the spatial mix.
//  - live 3D markers at each positional voice (size = measured post-panner level), stem to the floor,
//    a line from the listener, and a label with distance / head-relative azimuth / dB
//  - static cue spots taken from level.ts (entity anchors, doll anchors, SOUND_SPOTS)
//  - top-down radar with colliders, listener cone and -6/-12/-20 dB distance rings
//  - fly camera (V) that can carry the listener (L), audition any sound at the aim point (P),
//    replay the last cue (R), orbit test around your head (O), live tuning sliders + Copy JSON
import * as THREE from "three";
import { COLLIDERS, DOLL_ANCHORS, ENTITIES, ROOM_BOUNDS, SOUND_SPOTS, type Vec3 } from "../shared/level";
import type { SoundId } from "../shared/protocol";
import { DEFAULT_TUNE, type Audio, type AudioTune, type VoiceInfo } from "./audio";
import type { Player } from "./player";

const SOUNDS: SoundId[] = [
  "knock", "creak", "whisper", "giggle", "breath", "steps_above", "music_box", "door_rattle",
  "drawer", "lid", "hinge", "unlock", "pickup", "bulb_pop", "thud", "stinger",
];

const COLORS: Record<string, string> = {
  creak: "#e0a040", whisper: "#b070ff", knock: "#ff5040", steps_above: "#a08060", giggle: "#ff70c0",
  music_box: "#70e0ff", door_rattle: "#ff8040", drawer: "#c0c070", lid: "#c09050", hinge: "#e0c080",
  unlock: "#f0f070", pickup: "#80ff80", bulb_pop: "#ffffff", stinger: "#ff2020", thud: "#a0a0a0",
  breath: "#60c0a0", footstep: "#607080",
};
const colorOf = (id: string) => COLORS[id] ?? "#ffffff";

const TUNE_KEY = "horror3d.soundTune";
const SLIDERS: [keyof AudioTune, string, number, number, number][] = [
  ["refDistance", "ref distance (m)", 0.1, 3, 0.05],
  ["rolloff", "rolloff", 0, 5, 0.05],
  ["maxDistance", "max distance (m)", 2, 40, 0.5],
  ["wet", "reverb send", 0, 1.5, 0.01],
  ["verbSec", "reverb length (s)", 0.2, 3, 0.05],
  ["occlusionHz", "occlusion lowpass (Hz)", 200, 4000, 25],
  ["beds", "ambience beds", 0, 2, 0.01],
];

interface Live {
  v: VoiceInfo;
  g: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  ray: THREE.Line;
  mats: THREE.Material[];
  label: HTMLDivElement;
  buf: Float32Array<ArrayBuffer>;
  level: number;
  peak: number;
  note?: string;
}

const tmp = new THREE.Vector3();
const fwdV = new THREE.Vector3();

export class SoundEditor {
  on = false;
  flying = false;
  listenerOnFly = true;
  showSpots = true;
  logSteps = false;
  readonly cam = new THREE.PerspectiveCamera(72, 1, 0.05, 40);
  onToggle?: (on: boolean) => void;

  private audio: Audio | null = null;
  private root = new THREE.Group();
  private spots = new THREE.Group();
  private live: Live[] = [];
  private spotLabels: { el: HTMLDivElement; pos: () => Vec3 }[] = [];
  private dollMarker!: THREE.Object3D;
  private whisperMarker!: THREE.Object3D;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private prevFrozen = false;
  private selected = 0;
  private last: { id: SoundId; pos?: Vec3; vol: number } | null = null;
  private orbitTimer = 0;
  private savedBeds = 1;
  private ray = new THREE.Raycaster();
  private geo = { core: new THREE.SphereGeometry(0.06, 16, 12), ring: new THREE.RingGeometry(0.1, 0.125, 40) };

  private panel: HTMLDivElement;
  private labels: HTMLDivElement;
  private radar: HTMLCanvasElement;
  private logEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private selEl!: HTMLSelectElement;
  private tuneInputs = new Map<keyof AudioTune, HTMLInputElement | HTMLSelectElement>();

  constructor(
    scene: THREE.Scene,
    private player: Player,
    private canvas: HTMLCanvasElement,
    private aimTargets: () => THREE.Object3D[],
    private dollPos: () => Vec3,
  ) {
    this.root.visible = false;
    this.root.add(this.spots);
    scene.add(this.root);
    this.labels = document.createElement("div");
    this.labels.id = "se-labels";
    this.radar = document.createElement("canvas");
    this.radar.id = "se-radar";
    this.radar.width = this.radar.height = 260;
    this.panel = document.createElement("div");
    this.panel.id = "se-panel";
    for (const el of [this.labels, this.radar, this.panel]) (el.style.display = "none"), document.body.appendChild(el);
    this.buildSpots();
    this.buildPanel();

    addEventListener("keydown", (e) => this.key(e, true));
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    addEventListener("mousemove", (e) => {
      if (!this.flying || document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.0022));
    });
  }

  attach(audio: Audio) {
    this.audio = audio;
    try {
      const saved = JSON.parse(localStorage.getItem(TUNE_KEY) ?? "null");
      if (saved) Object.assign(audio.tune, saved);
    } catch { /* no storage: defaults */ }
    audio.applyTune();
    audio.inspect = this.on;
    audio.onVoice = (v) => this.addVoice(v);
    this.syncInputs();
  }

  /** camera to render with this frame */
  camera(playerCam: THREE.PerspectiveCamera) {
    return this.on && this.flying ? this.cam : playerCam;
  }
  /** what the audio listener should follow */
  listener(playerCam: THREE.PerspectiveCamera) {
    return this.on && this.flying && this.listenerOnFly ? this.cam : playerCam;
  }

  toggle(on = !this.on) {
    this.on = on;
    this.root.visible = on;
    for (const el of [this.labels, this.radar, this.panel]) el.style.display = on ? "block" : "none";
    if (this.audio) this.audio.inspect = on;
    if (!on) {
      this.setFly(false);
      for (const l of [...this.live]) this.removeLive(l);
    }
    this.onToggle?.(on);
    this.status();
  }

  setFly(fly: boolean) {
    if (fly === this.flying) return;
    this.flying = fly;
    const pc = this.player.camera;
    if (fly) {
      this.cam.position.copy(pc.position);
      this.yaw = this.player.yaw;
      this.pitch = this.player.pitch;
      this.prevFrozen = this.player.frozen;
      this.player.frozen = true;
    } else this.player.frozen = this.prevFrozen;
    this.status();
  }

  resize(w: number, h: number) {
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ input
  private key(e: KeyboardEvent, down: boolean) {
    if (e.code === "F2") {
      e.preventDefault();
      this.toggle();
      return;
    }
    if (!this.on || !down) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    this.keys.add(e.code);
    if (e.repeat) return;
    switch (e.code) {
      case "KeyV": this.setFly(!this.flying); break;
      case "KeyL": this.listenerOnFly = !this.listenerOnFly; this.status(); break;
      case "KeyR": this.replay(); break;
      case "KeyP": this.playAtAim(); break;
      case "KeyO": this.orbit(); break;
      case "KeyH": this.showSpots = !this.showSpots; this.spots.visible = this.showSpots; break;
      case "KeyM": this.muteBeds(); break;
      case "BracketLeft": this.select(this.selected - 1); break;
      case "BracketRight": this.select(this.selected + 1); break;
    }
  }

  private select(i: number) {
    this.selected = (i + SOUNDS.length) % SOUNDS.length;
    this.selEl.value = SOUNDS[this.selected];
    this.status();
  }

  private muteBeds() {
    const a = this.audio;
    if (!a) return;
    if (a.tune.beds > 0) (this.savedBeds = a.tune.beds), (a.tune.beds = 0);
    else a.tune.beds = this.savedBeds || 1;
    this.tuneChanged();
  }

  private replay() {
    if (this.audio && this.last) this.audio.play(this.last.id, this.last.pos, this.last.vol);
  }

  private aimPoint(): Vec3 {
    const cam = this.camera(this.player.camera);
    cam.updateMatrixWorld();
    this.ray.setFromCamera(new THREE.Vector2(0, 0), cam);
    this.ray.far = 12;
    const hit = this.ray.intersectObjects(this.aimTargets(), true)[0];
    const p = hit
      ? hit.point.clone().addScaledVector(this.ray.ray.direction, -0.06)
      : this.ray.ray.at(2, new THREE.Vector3());
    return [p.x, p.y, p.z];
  }

  private playAtAim() {
    this.audio?.play(SOUNDS[this.selected], this.aimPoint(), 1);
  }

  /** 8 points around the listener's head at ear height: front, front-right, right... clockwise */
  private orbit() {
    const a = this.audio;
    if (!a) return;
    clearTimeout(this.orbitTimer);
    const L = [...a.listenerPos] as Vec3, F = a.listenerFwd;
    const base = Math.atan2(F[0], F[2]);
    const names = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"];
    const id = SOUNDS[this.selected];
    const step = (i: number) => {
      if (i >= 8 || !this.on) return;
      const ang = base - (i * Math.PI) / 4; // clockwise seen from above
      const pos: Vec3 = [L[0] + Math.sin(ang) * 1.5, L[1], L[2] + Math.cos(ang) * 1.5];
      this.nextNote = `orbit: ${names[i]}`;
      a.play(id, pos, 0.9);
      this.orbitTimer = window.setTimeout(() => step(i + 1), 1300);
    };
    step(0);
  }
  private nextNote: string | undefined;

  // ------------------------------------------------------------------ voices
  private addVoice(v: VoiceInfo) {
    if (v.id !== "footstep" || this.logSteps) this.log(v);
    if (v.id !== "footstep") this.last = { id: v.id as SoundId, pos: v.pos, vol: v.vol };
    const note = this.nextNote;
    this.nextNote = undefined;
    if (!this.on || !v.pos) return;
    const col = new THREE.Color(colorOf(v.id));
    const mk = (o: THREE.Material) => Object.assign(o, { depthTest: false, transparent: true, fog: false });
    const coreM = mk(new THREE.MeshBasicMaterial({ color: col }));
    const ringM = mk(new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
    const lineM = mk(new THREE.LineBasicMaterial({ color: col }));
    const rayM = mk(new THREE.LineDashedMaterial({ color: col, dashSize: 0.08, gapSize: 0.06, opacity: 0.6 }));
    const g = new THREE.Group();
    g.position.set(...v.pos);
    const core = new THREE.Mesh(this.geo.core, coreM);
    const ring = new THREE.Mesh(this.geo.ring, ringM);
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -v.pos[1], 0)]), lineM);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), rayM);
    for (const o of [core, ring, stem, ray]) o.renderOrder = 1000;
    g.add(core, ring, stem);
    this.root.add(g, ray);
    const label = document.createElement("div");
    label.className = "se-label";
    label.style.borderColor = colorOf(v.id);
    this.labels.appendChild(label);
    this.live.push({ v, g, core, ring, ray, mats: [coreM, ringM, lineM, rayM], label, buf: new Float32Array(512), level: 0, peak: 0, note });
  }

  private removeLive(l: Live) {
    this.root.remove(l.g, l.ray);
    (l.g.children[2] as THREE.Line).geometry.dispose();
    l.ray.geometry.dispose();
    for (const m of l.mats) m.dispose();
    l.label.remove();
    this.live.splice(this.live.indexOf(l), 1);
  }

  /** head-relative direction of a world point from the listener */
  private rel(pos: Vec3) {
    const a = this.audio!, L = a.listenerPos, F = a.listenerFwd;
    const dx = pos[0] - L[0], dy = pos[1] - L[1], dz = pos[2] - L[2];
    const fl = Math.hypot(F[0], F[2]) || 1, fx = F[0] / fl, fz = F[2] / fl;
    const rx = -fz, rz = fx; // right = forward x up
    const az = (Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180) / Math.PI;
    const el = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    const dist = Math.hypot(dx, dy, dz);
    const side = Math.abs(az) < 8 ? "ahead" : Math.abs(az) > 172 ? "behind" : `${Math.abs(az).toFixed(0)}° ${az > 0 ? "R" : "L"}${Math.abs(az) > 90 ? " (behind)" : ""}`;
    const up = Math.abs(el) > 12 ? ` ${el > 0 ? "↑" : "↓"}${Math.abs(el).toFixed(0)}°` : "";
    return { dist, az, el, text: `${side}${up}` };
  }

  private log(v: VoiceInfo) {
    const row = document.createElement("div");
    row.className = "se-row";
    const r = v.pos && this.audio ? this.rel(v.pos) : null;
    const t = this.audio?.ctx.currentTime ?? 0;
    row.innerHTML =
      `<span class="t">${t.toFixed(1)}</span> <b style="color:${colorOf(v.id)}">${v.id}</b> ` +
      `<span class="k">${v.kind === "sample" ? v.take : "synth"}</span> vol ${v.vol.toFixed(2)}<br>` +
      (r
        ? `<span class="p">[${v.pos!.map((n) => n.toFixed(2)).join(", ")}]</span> ${r.dist.toFixed(2)}m · ${r.text}${v.occluded ? " · <i>occluded</i>" : ""}`
        : `<span class="p">head-locked (no position)</span>`) +
      (this.nextNote ? ` · <u>${this.nextNote}</u>` : "");
    row.title = "click to replay";
    row.onclick = () => this.audio?.play(v.id as SoundId, v.pos, v.vol);
    this.logEl.prepend(row);
    while (this.logEl.children.length > 60) this.logEl.lastChild!.remove();
  }

  // ------------------------------------------------------------------ static cue spots
  private buildSpots() {
    const spot = (pos: () => Vec3, text: string, color: string, shape: "oct" | "box" = "oct") => {
      const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.7, fog: false });
      const geo = shape === "oct" ? new THREE.OctahedronGeometry(0.07) : new THREE.BoxGeometry(0.1, 0.1, 0.1);
      const o = new THREE.LineSegments(new THREE.WireframeGeometry(geo), m);
      o.renderOrder = 999;
      o.position.set(...pos());
      this.spots.add(o);
      const el = document.createElement("div");
      el.className = "se-label spot";
      el.textContent = text;
      el.style.color = color;
      this.labels.appendChild(el);
      this.spotLabels.push({ el, pos });
      return o;
    };
    const kinds: Record<string, string> = {
      door: "door · unlock / rattle / hinge", drawer: "drawer · drawer / pickup", trunk: "trunk · lid / thud / unlock / pickup",
      wardrobe_l: "wardrobe L · hinge / creak (phase 1)", wardrobe_r: "wardrobe R · hinge",
    };
    for (const e of ENTITIES) if (kinds[e.id]) spot(() => e.anchor, kinds[e.id], "#d8c890");
    DOLL_ANCHORS.forEach((a, i) => spot(() => [a.pos[0], a.pos[1] + 0.3, a.pos[2]], `doll anchor ${i}`, "#c08090", "box"));
    spot(() => SOUND_SPOTS.bulb, "bulb · bulb_pop", "#ffffff");
    spot(() => SOUND_SPOTS.wind, "wind · loop (always on)", "#80c0ff");
    spot(() => SOUND_SPOTS.knock, "knock · hallway side of door", "#ff6050");
    this.dollMarker = spot(() => this.dollNow(), "DOLL NOW · giggle / music_box / breath / stinger / thud", "#ff80c0");
    this.whisperMarker = spot(() => this.whisperNow(), "whisper spot (behind your head)", "#b070ff");

    const box = (min: Vec3, max: Vec3, color: string, opacity: number) => {
      const h = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), color);
      Object.assign(h.material, { depthTest: false, transparent: true, opacity, fog: false });
      h.renderOrder = 998;
      this.spots.add(h);
    };
    const R = ROOM_BOUNDS, A = SOUND_SPOTS.ambientBox, S = SOUND_SPOTS.stepsAbove;
    box([R.minX, 0, R.minZ], [R.maxX, R.height, R.maxZ], "#4060ff", 0.35); // occlusion boundary
    box(A.min, A.max, "#e0a040", 0.25); // random ambient creak / thud volume
    box([-S.half, S.y, -S.half], [S.half, S.y + 0.02, S.half], "#a08060", 0.5); // footsteps upstairs
    spot(() => [R.maxX - 0.3, R.height - 0.1, R.maxZ - 0.1], "room shell = occlusion boundary", "#6080ff", "box");
    spot(() => [A.max[0] - 0.4, A.max[1], A.min[2] + 0.3], "ambient creak/thud volume", "#e0a040", "box");
    spot(() => [S.half, S.y, S.half], "steps_above plane", "#a08060", "box");
  }

  private dollNow(): Vec3 {
    const p = this.dollPos();
    return [p[0], p[1] + 0.25, p[2]];
  }
  private whisperNow(): Vec3 {
    const p = this.player.pos, y = this.player.yaw, b = SOUND_SPOTS.whisperBehind;
    return [p.x + Math.sin(y) * b, 1.6, p.z + Math.cos(y) * b];
  }

  // ------------------------------------------------------------------ panel
  private buildPanel() {
    const p = this.panel;
    p.innerHTML = `
      <h3>SOUND EDITOR <small>F2</small></h3>
      <div class="keys">
        <b>V</b> fly camera · <b>L</b> listener follows fly cam · <b>WASD QE</b> move, <b>Shift</b> fast<br>
        <b>P</b> play selected at aim · <b>[ ]</b> pick sound · <b>R</b> replay last · <b>O</b> orbit test<br>
        <b>H</b> cue spots · <b>M</b> mute ambience · <b>Esc</b> free mouse, click view to resume
      </div>
      <div class="se-status"></div>
      <div class="row"><select class="sel"></select><button data-a="aim">Play at aim</button><button data-a="orbit">Orbit</button></div>
      <h4>Spatial mix <button data-a="reset">reset</button><button data-a="copy">copy JSON</button></h4>
      <div class="tune"></div>
      <h4>Cue log <label><input type="checkbox" class="steps"> footsteps</label> <button data-a="clear">clear</button></h4>
      <div class="log"></div>`;
    this.statusEl = p.querySelector(".se-status")!;
    this.logEl = p.querySelector(".log")!;
    this.selEl = p.querySelector(".sel")!;
    this.selEl.innerHTML = SOUNDS.map((s) => `<option>${s}</option>`).join("");
    this.selEl.onchange = () => this.select(SOUNDS.indexOf(this.selEl.value as SoundId));
    (p.querySelector(".steps") as HTMLInputElement).onchange = (e) => (this.logSteps = (e.target as HTMLInputElement).checked);
    p.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === "aim") this.playAtAim();
      if (a === "orbit") this.orbit();
      if (a === "clear") this.logEl.innerHTML = "";
      if (a === "reset" && this.audio) (this.audio.tune = { ...DEFAULT_TUNE }), this.tuneChanged(), this.syncInputs();
      if (a === "copy" && this.audio) navigator.clipboard?.writeText(JSON.stringify(this.audio.tune, null, 2));
      b.blur();
    }));

    const tune = p.querySelector(".tune")!;
    const sel = document.createElement("select");
    sel.innerHTML = ["inverse", "exponential", "linear"].map((m) => `<option>${m}</option>`).join("");
    sel.onchange = () => this.setTune("distanceModel", sel.value as DistanceModelType);
    tune.append(this.labelled("distance model", sel));
    this.tuneInputs.set("distanceModel", sel);
    for (const [k, label, min, max, step] of SLIDERS) {
      const inp = Object.assign(document.createElement("input"), { type: "range", min, max, step });
      const val = document.createElement("span");
      val.className = "v";
      inp.oninput = () => (this.setTune(k, +inp.value), (val.textContent = inp.value));
      const wrap = this.labelled(label, inp);
      wrap.append(val);
      tune.append(wrap);
      this.tuneInputs.set(k, inp);
    }
    for (const k of ["occlusion", "hrtf"] as const) {
      const inp = Object.assign(document.createElement("input"), { type: "checkbox" });
      inp.onchange = () => this.setTune(k, inp.checked);
      tune.append(this.labelled(k === "hrtf" ? "HRTF (off = equal-power)" : "wall/ceiling occlusion", inp));
      this.tuneInputs.set(k, inp);
    }
    this.syncInputs();
  }

  private labelled(text: string, el: HTMLElement) {
    const l = document.createElement("label");
    l.className = "tl";
    l.append(Object.assign(document.createElement("span"), { textContent: text }), el);
    return l;
  }

  private setTune<K extends keyof AudioTune>(k: K, v: AudioTune[K]) {
    if (!this.audio) return;
    this.audio.tune[k] = v;
    this.tuneChanged();
  }

  private tuneChanged() {
    if (!this.audio) return;
    this.audio.applyTune();
    try { localStorage.setItem(TUNE_KEY, JSON.stringify(this.audio.tune)); } catch { /* ignore */ }
    this.syncInputs();
  }

  private syncInputs() {
    const T = this.audio?.tune ?? DEFAULT_TUNE;
    for (const [k, el] of this.tuneInputs) {
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!T[k];
      else {
        el.value = String(T[k]);
        const v = el.parentElement?.querySelector(".v");
        if (v) v.textContent = String(T[k]);
      }
    }
  }

  private status() {
    if (!this.statusEl) return;
    this.statusEl.innerHTML = !this.audio
      ? "<i>start the game to enable audio</i>"
      : `camera: <b>${this.flying ? "FLY" : "player"}</b> · listener: <b>${this.flying && this.listenerOnFly ? "fly cam" : "player head"}</b> · selected: <b>${SOUNDS[this.selected]}</b>`;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    if (!this.on) return;
    if (this.flying) {
      const k = this.keys, sp = (k.has("ShiftLeft") || k.has("ShiftRight") ? 6 : 2) * dt;
      this.cam.rotation.set(this.pitch, this.yaw, 0, "YXZ");
      this.cam.getWorldDirection(fwdV);
      const right = tmp.set(-fwdV.z, 0, fwdV.x).normalize();
      if (k.has("KeyW")) this.cam.position.addScaledVector(fwdV, sp);
      if (k.has("KeyS")) this.cam.position.addScaledVector(fwdV, -sp);
      if (k.has("KeyD")) this.cam.position.addScaledVector(right, sp);
      if (k.has("KeyA")) this.cam.position.addScaledVector(right, -sp);
      if (k.has("KeyE") || k.has("Space")) this.cam.position.y += sp;
      if (k.has("KeyQ")) this.cam.position.y -= sp;
      this.cam.updateMatrixWorld();
    }
    const cam = this.camera(this.player.camera);
    this.dollMarker.position.set(...this.dollNow());
    this.whisperMarker.position.set(...this.whisperNow());
    if (!this.audio) return this.drawRadar(cam);
    const now = this.audio.ctx.currentTime, L = this.audio.listenerPos;
    const W = innerWidth, H = innerHeight;
    const place = (el: HTMLElement, pos: Vec3) => {
      tmp.set(...pos).project(cam);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
      el.style.display = vis ? "block" : "none";
      if (vis) el.style.transform = `translate(${((tmp.x + 1) / 2) * W}px, ${((1 - tmp.y) / 2) * H}px)`;
    };
    for (const s of this.spotLabels) {
      if (!this.showSpots) { s.el.style.display = "none"; continue; }
      place(s.el, s.pos());
    }
    for (const l of [...this.live]) {
      const age = now - l.v.t0, end = l.v.dur + 0.4;
      if (age > end + 3) { this.removeLive(l); continue; }
      const playing = age <= end;
      let rms = 0;
      if (l.v.meter && playing) {
        l.v.meter.getFloatTimeDomainData(l.buf);
        for (let i = 0; i < l.buf.length; i++) rms += l.buf[i] * l.buf[i];
        rms = Math.sqrt(rms / l.buf.length);
      }
      l.level += (rms - l.level) * Math.min(1, dt * 20);
      l.peak = Math.max(l.peak * Math.exp(-dt * 1.5), l.level);
      const fade = playing ? 1 : Math.max(0, 1 - (age - end) / 3) * 0.35;
      l.core.scale.setScalar(1 + Math.min(6, l.level * 25));
      l.ring.scale.setScalar(1 + ((age * 1.6) % 1.6) * 3);
      l.ring.quaternion.copy(cam.quaternion);
      (l.mats[1] as THREE.MeshBasicMaterial).opacity = playing ? 0.8 * (1 - ((age * 1.6) % 1.6) / 1.6) : 0;
      (l.mats[0] as THREE.MeshBasicMaterial).opacity = fade;
      (l.mats[2] as THREE.LineBasicMaterial).opacity = fade * 0.7;
      (l.mats[3] as THREE.LineDashedMaterial).opacity = playing ? 0.6 : 0;
      const pos = l.v.pos!;
      const attr = l.ray.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.setXYZ(0, L[0], L[1] - 0.15, L[2]);
      attr.setXYZ(1, pos[0], pos[1], pos[2]);
      attr.needsUpdate = true;
      l.ray.geometry.computeBoundingSphere();
      l.ray.computeLineDistances();
      const r = this.rel(pos);
      const db = l.peak > 1e-5 ? (20 * Math.log10(l.peak)).toFixed(0) : "–∞";
      l.label.style.opacity = String(Math.max(fade, 0.25));
      l.label.innerHTML = `<b>${l.v.id}</b>${l.note ? ` <u>${l.note}</u>` : ""}<br>${r.dist.toFixed(2)}m · ${r.text}<br>${playing ? `${db} dBFS` : "ended"}${l.v.occluded ? " · occluded" : ""}`;
      place(l.label, pos);
    }
    this.drawRadar(cam);
  }

  private drawRadar(cam: THREE.Camera) {
    const c = this.radar, g = c.getContext("2d")!, S = c.width;
    const R = ROOM_BOUNDS, span = 7.4, k = S / span;
    const X = (x: number) => S / 2 + x * k, Z = (z: number) => S / 2 + z * k;
    g.clearRect(0, 0, S, S);
    g.fillStyle = "rgba(0,0,0,0.72)";
    g.fillRect(0, 0, S, S);
    g.strokeStyle = "#4060ff";
    g.strokeRect(X(R.minX), Z(R.minZ), (R.maxX - R.minX) * k, (R.maxZ - R.minZ) * k);
    g.strokeStyle = "rgba(200,190,170,0.5)";
    for (const b of COLLIDERS) {
      if (b.id.startsWith("wall")) continue;
      g.save();
      g.translate(X(b.x), Z(b.z));
      g.rotate(-b.rot);
      g.strokeRect(-b.hx * k, -b.hz * k, b.hx * 2 * k, b.hz * 2 * k);
      g.restore();
    }
    const a = this.audio;
    const L = a?.listenerPos ?? [this.player.pos.x, 1.6, this.player.pos.z];
    const F = a?.listenerFwd ?? [0, 0, -1];
    // distance rings from the current panner model
    if (a) {
      const T = a.tune;
      for (const [gain, txt] of [[0.5, "-6"], [0.25, "-12"], [0.1, "-20"]] as const) {
        const d = distForGain(T, gain);
        if (!Number.isFinite(d) || d > span) continue;
        g.strokeStyle = "rgba(120,255,120,0.25)";
        g.beginPath();
        g.arc(X(L[0]), Z(L[2]), d * k, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = "rgba(120,255,120,0.5)";
        g.font = "9px monospace";
        g.fillText(txt + "dB", X(L[0]) + d * k * 0.707 + 2, Z(L[2]) - d * k * 0.707);
      }
    }
    // static spots
    if (this.showSpots) {
      g.fillStyle = "rgba(216,200,144,0.6)";
      for (const s of this.spotLabels) {
        const p = s.pos();
        g.fillRect(X(p[0]) - 1.5, Z(p[2]) - 1.5, 3, 3);
      }
    }
    // player body (when flying, it can differ from the listener)
    const pp = this.player.pos;
    g.fillStyle = "#888";
    g.beginPath();
    g.arc(X(pp.x), Z(pp.z), 3, 0, Math.PI * 2);
    g.fill();
    if (this.flying) {
      const cp = (cam as THREE.PerspectiveCamera).position;
      g.strokeStyle = "#0ff";
      g.strokeRect(X(cp.x) - 3, Z(cp.z) - 3, 6, 6);
    }
    // listener + facing cone
    const ang = Math.atan2(F[2], F[0]);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.moveTo(X(L[0]), Z(L[2]));
    g.arc(X(L[0]), Z(L[2]), 40, ang - 0.6, ang + 0.6);
    g.closePath();
    g.fill();
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(X(L[0]), Z(L[2]), 4, 0, Math.PI * 2);
    g.fill();
    // voices
    const now = a?.ctx.currentTime ?? 0;
    for (const l of this.live) {
      const p = l.v.pos!, age = now - l.v.t0, end = l.v.dur + 0.4, playing = age <= end;
      g.globalAlpha = playing ? 1 : Math.max(0, 1 - (age - end) / 3) * 0.4;
      g.fillStyle = g.strokeStyle = colorOf(l.v.id);
      g.beginPath();
      g.arc(X(p[0]), Z(p[2]), 3 + Math.min(14, l.level * 60), 0, Math.PI * 2);
      g.fill();
      if (playing) {
        g.beginPath();
        g.moveTo(X(L[0]), Z(L[2]));
        g.lineTo(X(p[0]), Z(p[2]));
        g.stroke();
      }
      g.font = "10px monospace";
      g.fillText(l.v.id, X(p[0]) + 6, Z(p[2]) - 4);
      g.globalAlpha = 1;
    }
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.font = "10px monospace";
    g.fillText("top-down · door is up (-Z)", 6, S - 6);
  }
}

/** distance at which the panner's distance gain drops to `gain` (WebAudio formulas) */
function distForGain(T: AudioTune, gain: number) {
  const r = T.refDistance, f = T.rolloff;
  if (f <= 0) return Infinity;
  switch (T.distanceModel) {
    case "linear": return r + ((1 - gain) * (T.maxDistance - r)) / Math.min(1, f);
    case "exponential": return r * Math.pow(gain, -1 / f);
    default: return r + (r * (1 / gain - 1)) / f;
  }
}
