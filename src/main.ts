import * as THREE from "three";
import { Audio } from "./client/audio";
import { Player } from "./client/player";
import { Post } from "./client/post";
import { World } from "./client/world";
import { ClientSession } from "./net/client";
import { Host } from "./net/host";
import { createLoopback, createWebSocketTransport, type Transport } from "./net/transport";
import { entityById, ITEMS, PLAYER, SPAWN, type ItemId } from "./shared/level";
import { STATE_HZ, type DebugCmd, type GameEvent } from "./shared/protocol";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer
const canvas = $("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false });
renderer.setPixelRatio(1); // resolution is managed by Post (dynamic resolution)
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const post = new Post(renderer);

const world = new World();
const player = new Player(canvas);
world.scene.add(player.camera);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  player.camera.aspect = w / h;
  player.camera.updateProjectionMatrix();
  post.setSize(w, h);
}
addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------ networking: host-in-tab by default
let host: Host | null = null;
let transport: Transport;
const serverUrl = params.get("server");
if (serverUrl) {
  transport = await createWebSocketTransport(serverUrl); // dedicated server (future)
} else {
  host = new Host();
  host.sim.allowDebug = true; // in-tab host = dev/solo: debug keys allowed
  const lb = createLoopback(Number(params.get("lag") ?? 0));
  host.addConnection(lb.conn);
  transport = lb.transport;
}
const session = new ClientSession(transport, params.get("name") ?? "Guest");

// ------------------------------------------------------------------ HUD
const promptEl = $("prompt"), subEl = $("subtitle"), invEl = $("inventory"), fadeEl = $("fade");
let subTimer = 0;
function subtitle(text: string, dur = 3.5) {
  subEl.textContent = text;
  subEl.classList.add("show");
  clearTimeout(subTimer);
  subTimer = window.setTimeout(() => subEl.classList.remove("show"), dur * 1000);
}

// ------------------------------------------------------------------ boot
const loadingEl = $("loading");
await world.load((f) => (loadingEl.textContent = `Loading… ${Math.round(f * 100)}%`));
await session.whenReady();
const me = session.me();
player.place(me?.pos ?? SPAWN.pos, me?.yaw ?? SPAWN.yaw);
world.applySnapshot(session.snap!, session.you);
loadingEl.textContent = "";
// precompile all shaders before the first frame to avoid hitches
renderer.compile(world.scene, player.camera);

let audio: Audio | null = null;
let started = false;
let escaped = false;
const playBtn = $("play") as HTMLButtonElement;
playBtn.disabled = false;
playBtn.onclick = async () => {
  if (!audio) {
    audio = new Audio();
    await audio.resume();
    audio.startAmbience();
  }
  $("menu").classList.add("hidden");
  player.lock();
  if (!started) {
    started = true;
    fadeIn(4);
    setTimeout(() => subtitle("...where am I? This isn't my room.", 4), 2500);
    setTimeout(() => subtitle("[E] interact   [F] flashlight   [Shift] run   [C] crouch", 5), 7500);
  }
};
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && started && !escaped) $("menu").classList.remove("hidden"), (playBtn.textContent = "Resume");
});

let fadeTarget = 1, fadeVal = 1, fadeSpeed = 1;
function fadeIn(sec: number) { fadeTarget = 0; fadeSpeed = 1 / sec; }
function fadeOut(sec: number) { fadeTarget = 1; fadeSpeed = 1 / sec; }

// ------------------------------------------------------------------ host events
let scare = 0;
let flashFlickerUntil = 0;
session.onEvent((e: GameEvent) => {
  switch (e.k) {
    case "sound": audio?.play(e.id, e.pos, e.vol); break;
    case "flicker": world.flicker(e.dur, e.intensity); break;
    case "blackout": world.blackout(); flashFlickerUntil = clock.elapsedTime + 1.2; break;
    case "entity": world.setEntity(e.id, e.open, e.slow); break;
    case "unlock": break;
    case "pickup": break;
    case "text": subtitle(e.text, e.dur); break;
    case "portrait": world.setPortraitStage(e.stage); break;
    case "chair": world.rockChair(e.amp, e.dur); break;
    case "lamp_swing": world.swingLamp(e.amp); break;
    case "scare":
      if (e.to === session.you) {
        scare = 1;
        world.lungeDoll(e.pos, e.rotY);
        // let them SEE it lunge first, then the flashlight dies
        setTimeout(() => (flashFlickerUntil = clock.elapsedTime + 1.0), 650);
      }
      break;
    case "escaped":
      escaped = true;
      player.frozen = true;
      setTimeout(() => {
        fadeOut(3);
        setTimeout(() => {
          document.exitPointerLock();
          const m = $("menu");
          m.classList.remove("hidden");
          m.querySelector("h1")!.textContent = "YOU ESCAPED THE NURSERY";
          m.querySelector(".sub")!.textContent = "...but the house is much bigger than one room.";
          playBtn.style.display = "none";
          m.querySelector(".hint")!.textContent = "Chapter II coming soon.";
        }, 3200);
      }, 1500);
      break;
  }
});
session.onCorrect((p) => {
  player.pos.x = p[0];
  player.pos.z = p[2];
});

// ------------------------------------------------------------------ interaction raycast
const ray = new THREE.Raycaster();
ray.far = PLAYER.reach;
const center = new THREE.Vector2(0, 0);
let focus: string | null = null;

function interactLabel(id: string): string {
  if (id.startsWith("item:")) return `Take ${ITEMS[id.slice(5) as ItemId].label.toLowerCase()}`;
  const st = session.snap?.ents[id];
  const def = entityById(id);
  if (!def || !st) return "";
  if (def.kind === "inspect") return "Examine";
  if (st.locked) return def.kind === "door" ? "Open door" : "Open trunk";
  const verb = st.open ? "Close" : "Open";
  return `${verb} ${def.kind === "drawer" ? "drawer" : def.kind === "lid" ? "trunk" : def.kind === "door" ? "door" : "wardrobe"}`;
}

function findInteractable(o: THREE.Object3D | null): string | null {
  while (o) {
    const hit = world.interactables.find((i) => i.obj === o);
    if (hit) return hit.id;
    o = o.parent;
  }
  return null;
}

const rayTargets = () => [...world.interactables.map((i) => i.obj), ...world.occluders];
player.onInteract = () => {
  if (focus && !escaped) session.interact(focus);
};
player.onStep = () => audio?.footstep(player.running, player.crouch);
player.onToggleFlash = () => audio?.play("pickup", undefined, 0.25);

// ------------------------------------------------------------------ doll visibility (client-side test, reported to host)
const proj = new THREE.Vector3();
let dollSeen = false;
let visTimer = 0;
function testDollSeen(): boolean {
  if (!world.doll?.visible) return false;
  // in the dark without a flashlight, you can't see it - and it knows
  const lit = player.flashOn || world.power > 0;
  if (!lit) return false;
  proj.copy(world.dollFocus).project(player.camera);
  if (proj.z > 1 || Math.abs(proj.x) > 1.05 || Math.abs(proj.y) > 1.05) return false;
  const camPos = player.camera.position;
  const dir = world.dollFocus.clone().sub(camPos);
  const dist = dir.length();
  ray.set(camPos, dir.normalize());
  ray.far = dist - 0.25;
  const hit = ray.intersectObjects(world.occluders, false)[0];
  ray.far = PLAYER.reach;
  return !hit;
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let stateAcc = 0;
const isOpen = (id: string) => !!session.snap?.ents[id]?.open;
const fwd = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  host?.update(dt);
  if (session.snap) world.applySnapshot(session.snap, session.you);

  if (started) player.update(dt, isOpen);
  else player.update(0, isOpen);

  // flashlight: battery-free but unreliable when things happen
  const flick = t < flashFlickerUntil ? (Math.random() < 0.5 ? 0 : 1) : 1;
  player.flashlight.visible = player.flashOn && flick > 0;
  player.flashlight.intensity = 22 * (0.96 + Math.random() * 0.04);

  visTimer += dt;
  if (visTimer > 0.1) {
    visTimer = 0;
    dollSeen = testDollSeen();
    // interaction focus
    ray.setFromCamera(center, player.camera);
    const hit = ray.intersectObjects(rayTargets(), true)[0];
    const id = hit ? findInteractable(hit.object) : null;
    focus = id && !escaped ? id : null;
    const label = focus ? interactLabel(focus) : "";
    promptEl.textContent = label ? `[E] ${label}` : "";
    promptEl.classList.toggle("show", !!label);
  }

  world.update(dt, player.camera.position, dollSeen);

  stateAcc += dt;
  if (stateAcc >= 1 / STATE_HZ) {
    stateAcc = 0;
    session.sendState({
      pos: [player.pos.x, 0, player.pos.z], yaw: player.yaw, pitch: player.pitch,
      crouch: player.crouch, flash: player.flashOn, seesDoll: dollSeen,
    });
  }
  world.syncRemote(session.remotePlayers());

  // HUD inventory
  const inv = session.snap
    ? (Object.entries(session.snap.items) as [ItemId, { at: string; id?: string }][])
        .filter(([, l]) => l.at === "player" && l.id === session.you)
        .map(([k]) => ITEMS[k].label)
    : [];
  const invText = inv.join(" · ");
  if (invEl.textContent !== invText) invEl.textContent = invText;

  // audio listener + fear
  const fear = session.me()?.fear ?? 0;
  if (audio) {
    player.camera.getWorldDirection(fwd);
    audio.setListener(player.camera.position, fwd);
    audio.update(fear + scare * 0.5);
  }

  // post FX
  fadeVal += Math.sign(fadeTarget - fadeVal) * Math.min(Math.abs(fadeTarget - fadeVal), dt * fadeSpeed);
  scare = Math.max(0, scare - dt * 0.9);
  const u = post.uniforms;
  u.uTime.value = t;
  u.uFear.value += (fear - u.uFear.value) * Math.min(1, dt * 2);
  u.uScare.value = scare;
  u.uFade.value = started ? fadeVal : 1;
  fadeEl.style.opacity = "0";

  post.render(world.scene, player.camera);
  post.adapt(dt);
});

// ------------------------------------------------------------------ debug keys (` toggles)
const DEBUG_KEYS: [string, DebugCmd, string][] = [
  ["Digit1", "scare", "Jumpscare NOW (doll in front of you)"],
  ["Digit2", "stalk", "Arm stalk scare (look away, turn around)"],
  ["Digit3", "phase1", "Skip: trunk key + blackout"],
  ["Digit4", "phase2", "Skip: door key (stalk starts in 4s)"],
  ["Digit5", "ambient", "Random ambient event"],
  ["Digit6", "doll", "Doll relocates (when unseen)"],
  ["Digit7", "flicker", "Light flicker"],
  ["Digit8", "chair", "Doll back to chair + rock"],
];
const debugEl = $("debug");
let debugOn = params.has("debug");
function renderDebug() {
  debugEl.style.display = debugOn ? "block" : "none";
  debugEl.innerHTML = host
    ? `<b>DEBUG</b> (\` to hide)<br>` + DEBUG_KEYS.map(([k, , label]) => `${k.slice(5)} — ${label}`).join("<br>")
    : "<b>DEBUG</b> unavailable on a remote server";
}
renderDebug();
addEventListener("keydown", (e) => {
  if (e.code === "Backquote") {
    debugOn = !debugOn;
    renderDebug();
    return;
  }
  if (!debugOn || e.repeat) return;
  const hit = DEBUG_KEYS.find(([k]) => k === e.code);
  if (hit) {
    session.debug(hit[1]);
    subtitle(`[debug] ${hit[2]}`, 1.5);
  }
});

// debug handle
Object.assign(window, {
  game: {
    world, player, session, host, renderer, post,
    /** debug teleport (only works with an in-tab host, which owns authority) */
    tp(x: number, z: number, yaw = player.yaw, pitch = player.pitch) {
      const p = host?.sim.players.get(session.you);
      if (p) p.pos = [x, 0, z];
      player.place([x, 0, z], yaw);
      player.pitch = pitch;
    },
  },
});
