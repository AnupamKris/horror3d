// Authoritative game simulation. Runs ONLY on the host (in-tab for solo / listen-server,
// or in Node for a dedicated server). Pure logic: no DOM, no three.js.
import {
  collide, DOLL_ANCHORS, ENTITIES, entityById, ITEMS, PLAYER, ROOM_BOUNDS, SOUND_SPOTS, SPAWN,
  type ItemId, type Vec3,
} from "./level";
import type {
  ClientMsg, DebugCmd, DollState, EntityState, GameEvent, ItemLocation, PlayerId, PlayerState, Snapshot, SoundId,
} from "./protocol";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PlayerRec extends PlayerState {
  seesDoll: boolean;
  lastStateAt: number;
  seq: number;
}

type Outbound = { to: PlayerId | null; e: GameEvent } | { to: PlayerId; correct: Vec3 };

const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2;

export class GameSim {
  tick = 0;
  time = 0;
  phase = 0; // 0 start, 1 has trunk key, 2 has door key, 3 escaped
  power = 1;
  readonly players = new Map<PlayerId, PlayerRec>();
  readonly ents: Record<string, EntityState> = {};
  readonly items: Record<ItemId, ItemLocation>;
  doll: DollState;
  /** drained by the Host every tick */
  readonly outbox: Outbound[] = [];

  private rng: () => number;
  private timers: { at: number; fn: () => void }[] = [];
  private nextAmbient = 9;
  private nextDollMove = 25;
  private stalking: { target: PlayerId; placed: boolean; scaredAt: number } | null = null;
  private portraitStage = 0;
  /** accept debug commands (only for an in-tab/dev host, never a public server) */
  allowDebug = false;

  constructor(seed = (Math.random() * 2 ** 31) | 0) {
    this.rng = mulberry32(seed);
    for (const e of ENTITIES) this.ents[e.id] = { open: false, locked: !!e.locked };
    this.items = {
      trunk_key: { at: "entity", id: "drawer" },
      door_key: { at: "entity", id: "trunk" },
    };
    const a = DOLL_ANCHORS[0];
    this.doll = { anchor: 0, pos: [...a.pos], rotY: a.rotY, look: null, visible: true };
  }

  // ------------------------------------------------------------ players
  addPlayer(id: PlayerId, name: string): void {
    const n = this.players.size;
    const pos: Vec3 = [SPAWN.pos[0] + (n % 2) * 0.6, 0, SPAWN.pos[2] + Math.floor(n / 2) * 0.6];
    this.players.set(id, {
      id, name, pos, yaw: SPAWN.yaw, pitch: 0, crouch: false, flash: true, fear: 0,
      seesDoll: false, lastStateAt: this.time, seq: 0,
    });
  }

  removePlayer(id: PlayerId): void {
    this.players.delete(id);
    for (const k of Object.keys(this.items) as ItemId[]) {
      const loc = this.items[k];
      if (loc.at === "player" && loc.id === id) this.items[k] = { at: "entity", id: k === "trunk_key" ? "drawer" : "trunk" };
    }
  }

  handle(id: PlayerId, msg: ClientMsg): void {
    const p = this.players.get(id);
    if (!p) return;
    if (msg.t === "state") this.applyState(p, msg);
    else if (msg.t === "interact") this.interact(p, msg.id);
    else if (msg.t === "debug" && this.allowDebug) this.debug(p, msg.cmd);
  }

  // ------------------------------------------------------------ debug cheats
  private debug(p: PlayerRec, cmd: DebugCmd): void {
    const give = (item: ItemId) => {
      if (this.items[item].at !== "player") this.items[item] = { at: "player", id: p.id };
    };
    switch (cmd) {
      case "scare": {
        // instant: doll appears 1.3m in front of the player and lunges
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        const spot = { x: p.pos[0] + fx * 1.3, z: p.pos[2] + fz * 1.3 };
        collide(spot, 0.15, (eid) => this.ents[eid]?.open);
        this.doll.anchor = -1;
        this.doll.pos = [spot.x, 0, spot.z];
        this.doll.rotY = Math.atan2(p.pos[0] - spot.x, p.pos[2] - spot.z);
        this.doll.visible = true;
        this.stalking = { target: p.id, placed: true, scaredAt: this.time };
        this.emit({ k: "scare", to: p.id, pos: [...this.doll.pos], rotY: this.doll.rotY });
        this.sound("stinger", this.doll.pos, 1);
        break;
      }
      case "stalk": // the real thing: doll appears behind you once you look away; turn around
        this.stalking = { target: p.id, placed: false, scaredAt: -1 };
        this.say(p.id, "[debug] Stalk armed - look away from the doll, then turn around.", 3);
        break;
      case "phase1":
        give("trunk_key");
        this.items.trunk_key = { at: "gone" };
        this.ents.trunk.locked = false;
        if (this.phase < 1) this.enterPhase1();
        break;
      case "phase2":
        give("door_key");
        if (this.phase < 1) { this.phase = 1; this.power = 0; this.emit({ k: "blackout" }); }
        if (this.phase < 2) this.enterPhase2(p.id);
        break;
      case "ambient": this.ambient(); break;
      case "doll": this.nextDollMove = this.time; if (this.phase < 1) this.phase = 1; break;
      case "flicker": this.emit({ k: "flicker", dur: 1.5, intensity: 1 }); break;
      case "chair":
        this.moveDollToAnchor(0);
        this.emit({ k: "chair", amp: 0.2, dur: 8 });
        this.sound("creak", this.doll.pos, 0.8);
        break;
    }
  }

  private applyState(p: PlayerRec, m: Extract<ClientMsg, { t: "state" }>): void {
    if (m.seq <= p.seq) return;
    p.seq = m.seq;
    const dt = Math.max(0.05, this.time - p.lastStateAt);
    p.lastStateAt = this.time;
    const maxStep = PLAYER.run * 1.5 * dt + 0.25;
    const want = { x: m.pos[0], z: m.pos[2] };
    const dx = want.x - p.pos[0], dz = want.z - p.pos[2];
    const d = Math.hypot(dx, dz);
    let corrected = false;
    if (!Number.isFinite(d)) return;
    if (d > maxStep) {
      want.x = p.pos[0] + (dx / d) * maxStep;
      want.z = p.pos[2] + (dz / d) * maxStep;
      corrected = true;
    }
    const before = { ...want };
    collide(want, PLAYER.radius - 0.02, (eid) => this.ents[eid]?.open);
    if (Math.hypot(want.x - before.x, want.z - before.z) > 0.06) corrected = true;
    // escaping through the open door is allowed (z < room min)
    want.x = Math.max(ROOM_BOUNDS.minX - 2, Math.min(ROOM_BOUNDS.maxX + 2, want.x));
    p.pos = [want.x, 0, want.z];
    p.yaw = m.yaw;
    p.pitch = m.pitch;
    p.crouch = m.crouch;
    p.flash = m.flash;
    p.seesDoll = m.seesDoll;
    if (corrected) this.outbox.push({ to: p.id, correct: p.pos });
  }

  // ------------------------------------------------------------ interaction
  private emit(e: GameEvent, to: PlayerId | null = null) {
    this.outbox.push({ to, e });
  }
  private say(to: PlayerId | null, text: string, dur = 3.5) {
    this.emit({ k: "text", to, text, dur }, to);
  }
  private sound(id: SoundId, pos?: Vec3, vol = 1) {
    this.emit({ k: "sound", id, pos, vol });
  }
  private after(sec: number, fn: () => void) {
    this.timers.push({ at: this.time + sec, fn });
  }

  private has(p: PlayerRec, item: ItemId) {
    const l = this.items[item];
    return l.at === "player" && l.id === p.id;
  }

  private interact(p: PlayerRec, id: string): void {
    if (this.phase >= 3) return;
    if (id.startsWith("item:")) return this.pickup(p, id.slice(5) as ItemId);
    const def = entityById(id);
    if (!def) return;
    if (dist2(p.pos, def.anchor) > (PLAYER.reach + 0.6) ** 2) return; // too far: ignore (anti-cheat)
    const st = this.ents[id];
    if (def.kind === "inspect") {
      if (id === "portrait") {
        this.say(p.id, this.portraitStage > 0 ? "The whole family is looking at you now." : def.text!);
      } else this.say(p.id, def.text!);
      return;
    }
    if (st.locked) {
      if (def.requires && this.has(p, def.requires)) {
        st.locked = false;
        this.items[def.requires] = { at: "gone" };
        this.emit({ k: "unlock", id, by: p.id });
        this.sound("unlock", def.anchor);
        this.say(p.id, id === "door" ? "The key turns. Something behind you sighs." : "Click.");
      } else {
        this.sound(id === "door" ? "door_rattle" : "thud", def.anchor, 0.8);
        this.say(p.id, def.lockedText ?? "Locked.");
        if (id === "door" && this.phase === 0) this.after(1.2, () => this.sound("giggle", this.doll.pos, 0.5));
      }
      return;
    }
    st.open = !st.open;
    this.emit({ k: "entity", id, open: st.open, by: p.id });
    this.sound(def.kind === "drawer" ? "drawer" : def.kind === "lid" ? "lid" : "hinge", def.anchor);
    if (id === "door" && st.open) {
      this.phase = 3;
      this.emit({ k: "escaped", by: p.id });
    }
  }

  private pickup(p: PlayerRec, item: ItemId) {
    const loc = this.items[item];
    if (!loc || loc.at !== "entity") return;
    const holder = entityById(loc.id)!;
    if (!this.ents[holder.id].open) return;
    if (dist2(p.pos, holder.anchor) > (PLAYER.reach + 0.6) ** 2) return;
    this.items[item] = { at: "player", id: p.id };
    this.emit({ k: "pickup", item, by: p.id });
    this.sound("pickup", holder.anchor, 0.7);
    this.say(p.id, `Picked up: ${ITEMS[item].label}`, 2.5);
    if (item === "trunk_key" && this.phase < 1) this.enterPhase1();
    if (item === "door_key" && this.phase < 2) this.enterPhase2(p.id);
  }

  // ------------------------------------------------------------ horror director
  private enterPhase1() {
    this.phase = 1;
    this.after(1.4, () => {
      this.emit({ k: "flicker", dur: 1.2, intensity: 1 });
    });
    this.after(2.8, () => {
      this.power = 0;
      this.emit({ k: "blackout" });
      this.sound("bulb_pop", SOUND_SPOTS.bulb);
      this.emit({ k: "lamp_swing", amp: 0.5 });
    });
    this.after(8, () => {
      const w = this.ents["wardrobe_l"];
      if (!w.open) {
        w.open = true;
        this.emit({ k: "entity", id: "wardrobe_l", open: true, by: null, slow: true });
        this.sound("creak", entityById("wardrobe_l")!.anchor, 1);
      }
    });
    this.after(14, () => this.sound("music_box", this.doll.pos, 0.6));
    this.nextDollMove = this.time + 6;
  }

  private enterPhase2(pid: PlayerId) {
    this.phase = 2;
    this.portraitStage = 1;
    this.emit({ k: "portrait", stage: 1 });
    this.after(4, () => {
      this.stalking = { target: pid, placed: false, scaredAt: -1 };
    });
  }

  private nearestPlayer(pos: Vec3): PlayerRec | null {
    let best: PlayerRec | null = null, bd = Infinity;
    for (const p of this.players.values()) {
      const d = dist2(p.pos, pos);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private anyoneSeesDoll() {
    for (const p of this.players.values()) if (p.seesDoll) return true;
    return false;
  }

  /** is world point behind every player (outside a ~110° forward cone)? */
  private hiddenFromAll(pos: Vec3) {
    for (const p of this.players.values()) {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const dx = pos[0] - p.pos[0], dz = pos[2] - p.pos[2];
      const d = Math.hypot(dx, dz) || 1;
      if ((fx * dx + fz * dz) / d > -0.05) return false;
    }
    return true;
  }

  private moveDollToAnchor(i: number) {
    const a = DOLL_ANCHORS[i];
    this.doll.anchor = i;
    this.doll.pos = [...a.pos];
    this.doll.rotY = a.rotY;
    this.doll.visible = true;
  }

  private ambient() {
    const r = this.rng;
    const any = this.players.values().next().value as PlayerRec | undefined;
    if (!any) return;
    const roll = r();
    const { min, max } = SOUND_SPOTS.ambientBox;
    const rp = (): Vec3 => [min[0] + r() * (max[0] - min[0]), min[1] + r() * (max[1] - min[1]), min[2] + r() * (max[2] - min[2])];
    const sa = SOUND_SPOTS.stepsAbove;
    if (roll < 0.22) this.sound("creak", rp(), 0.6 + r() * 0.4);
    else if (roll < 0.36) this.sound("steps_above", [(r() * 2 - 1) * sa.half, sa.y, (r() * 2 - 1) * sa.half], 0.7);
    else if (roll < 0.48) {
      const p = this.nearestPlayer(this.doll.pos) ?? any;
      // whisper right behind a player's head
      const b = SOUND_SPOTS.whisperBehind;
      this.sound("whisper", [p.pos[0] + Math.sin(p.yaw) * b, 1.6, p.pos[2] + Math.cos(p.yaw) * b], 0.8);
    } else if (roll < 0.58) this.sound("knock", SOUND_SPOTS.knock, 0.9);
    else if (roll < 0.7 && this.power > 0) this.emit({ k: "flicker", dur: 0.4 + r() * 1.2, intensity: 0.5 + r() * 0.5 });
    else if (roll < 0.82 && this.doll.anchor === 0) {
      this.emit({ k: "chair", amp: 0.12 + r() * 0.1, dur: 6 + r() * 6 });
      this.sound("creak", this.doll.pos, 0.5);
    } else if (roll < 0.9) this.emit({ k: "lamp_swing", amp: 0.12 + r() * 0.15 });
    else if (this.phase >= 1) this.sound("giggle", this.doll.pos, 0.6);
    else this.sound("thud", rp(), 0.5);
  }

  private updateStalk() {
    const s = this.stalking!;
    const p = this.players.get(s.target);
    if (!p) { this.stalking = null; return; }
    if (!s.placed) {
      if (p.seesDoll) return;
      // appear ~1.8m behind the player (far enough to be in view when they turn), facing them
      const bx = p.pos[0] + Math.sin(p.yaw) * 1.8, bz = p.pos[2] + Math.cos(p.yaw) * 1.8;
      const spot = { x: bx, z: bz };
      collide(spot, 0.15, (eid) => this.ents[eid]?.open);
      this.doll.anchor = -1;
      this.doll.pos = [spot.x, 0, spot.z];
      this.doll.rotY = Math.atan2(p.pos[0] - spot.x, p.pos[2] - spot.z);
      this.doll.visible = true;
      s.placed = true;
      this.sound("breath", [spot.x, 1.0, spot.z], 0.9);
      return;
    }
    if (s.scaredAt < 0) {
      if (p.seesDoll && dist2(p.pos, this.doll.pos) < 2.8 * 2.8) {
        s.scaredAt = this.time;
        this.emit({ k: "scare", to: p.id, pos: [...this.doll.pos], rotY: this.doll.rotY });
        this.sound("stinger", this.doll.pos, 1);
      }
      return;
    }
    // vanish right after the lunge; reappear in the chair only when nobody is facing it
    if (this.time - s.scaredAt > 0.8) this.doll.visible = false;
    if (this.time - s.scaredAt > 2.0 && this.hiddenFromAll(DOLL_ANCHORS[0].pos)) {
      this.moveDollToAnchor(0);
      this.stalking = null;
      this.nextDollMove = this.time + 12;
    }
  }

  step(dt: number): void {
    this.tick++;
    this.time += dt;

    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at <= this.time) {
        const t = this.timers[i];
        this.timers.splice(i, 1);
        t.fn();
      }
    }

    if (this.players.size === 0 || this.phase >= 3) return;

    if (this.time >= this.nextAmbient) {
      this.ambient();
      const pace = this.phase === 0 ? 1 : this.phase === 1 ? 0.75 : 0.55;
      this.nextAmbient = this.time + (11 + this.rng() * 16) * pace;
    }

    // the doll only ever moves while nobody is looking
    if (this.stalking) this.updateStalk();
    else if (this.phase >= 1 && this.time >= this.nextDollMove) {
      if (!this.anyoneSeesDoll()) {
        const options: number[] = [];
        for (let i = 0; i < DOLL_ANCHORS.length; i++) {
          if (i === this.doll.anchor) continue;
          const a = DOLL_ANCHORS[i];
          const np = this.nearestPlayer(a.pos);
          if (!np) continue;
          const d = Math.sqrt(dist2(np.pos, a.pos));
          if (d < 1.0 || !this.hiddenFromAll(a.pos)) continue;
          options.push(i);
        }
        if (options.length) {
          this.moveDollToAnchor(options[(this.rng() * options.length) | 0]);
          this.sound("thud", this.doll.pos, 0.35);
          this.nextDollMove = this.time + (this.phase === 1 ? 16 + this.rng() * 14 : 10 + this.rng() * 10);
        } else this.nextDollMove = this.time + 2;
      } else this.nextDollMove = this.time + 1.5;
    }

    const look = this.nearestPlayer(this.doll.pos);
    this.doll.look = look ? look.id : null;

    // fear
    for (const p of this.players.values()) {
      const d = Math.sqrt(dist2(p.pos, this.doll.pos));
      const target = Math.min(1, this.phase * 0.18 + (1 - this.power) * 0.12 + Math.max(0, (2.5 - d) / 2.5) * 0.55);
      p.fear += (target - p.fear) * Math.min(1, dt * 0.8);
    }
  }

  snapshot(): Snapshot {
    return {
      tick: this.tick,
      time: this.time,
      players: [...this.players.values()].map(({ id, name, pos, yaw, pitch, crouch, flash, fear }) => ({
        id, name, pos, yaw, pitch, crouch, flash, fear: Math.round(fear * 100) / 100,
      })),
      ents: structuredClone(this.ents),
      items: { ...this.items },
      doll: { ...this.doll, pos: [...this.doll.pos] },
      power: this.power,
      phase: this.phase,
    };
  }
}
