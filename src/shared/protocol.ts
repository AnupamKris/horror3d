// Wire protocol between Client and Host. JSON-serializable only.
// Solo play uses a loopback transport; multiplayer swaps in WebSocket/WebRTC without touching this.
import type { ItemId, Vec3 } from "./level";

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 20; // host simulation rate
export const SNAP_HZ = 15; // snapshot broadcast rate
export const STATE_HZ = 20; // client -> host player state rate

export type PlayerId = string;

export interface PlayerState {
  id: PlayerId;
  name: string;
  pos: Vec3; // feet position
  yaw: number;
  pitch: number;
  crouch: boolean;
  flash: boolean; // flashlight on
  fear: number; // 0..1, host computed
}

export interface EntityState {
  open: boolean;
  locked: boolean;
}

export type ItemLocation = { at: "entity"; id: string } | { at: "player"; id: PlayerId } | { at: "gone" };

export interface DollState {
  anchor: number; // DOLL_ANCHORS index, or -1 = custom (pos/rotY)
  pos: Vec3;
  rotY: number;
  look: PlayerId | null; // whose direction the head turns to
  visible: boolean;
}

export interface Snapshot {
  tick: number;
  time: number; // host seconds
  players: PlayerState[];
  ents: Record<string, EntityState>;
  items: Record<ItemId, ItemLocation>;
  doll: DollState;
  power: number; // 0 = dead bulb, 1 = on (flicker is client-side cosmetic + events)
  phase: number;
}

// ---------------------------------------------------------------- events (reliable, host -> all)
export type GameEvent =
  | { k: "sound"; id: SoundId; pos?: Vec3; vol?: number }
  | { k: "flicker"; dur: number; intensity: number }
  | { k: "blackout" }
  | { k: "entity"; id: string; open: boolean; by: PlayerId | null; slow?: boolean }
  | { k: "unlock"; id: string; by: PlayerId }
  | { k: "pickup"; item: ItemId; by: PlayerId }
  | { k: "text"; to: PlayerId | null; text: string; dur?: number }
  | { k: "scare"; to: PlayerId; pos: Vec3; rotY: number }
  | { k: "portrait"; stage: number }
  | { k: "chair"; amp: number; dur: number }
  | { k: "lamp_swing"; amp: number }
  | { k: "escaped"; by: PlayerId };

export type SoundId =
  | "creak" | "whisper" | "knock" | "steps_above" | "giggle" | "music_box" | "door_rattle"
  | "drawer" | "lid" | "hinge" | "unlock" | "pickup" | "bulb_pop" | "stinger" | "thud" | "breath";

// ---------------------------------------------------------------- messages
export type ClientMsg =
  | { t: "hello"; v: number; name: string }
  | {
      t: "state"; seq: number; pos: Vec3; yaw: number; pitch: number; crouch: boolean; flash: boolean;
      /** client-side visibility test: is the doll on screen & unoccluded */
      seesDoll: boolean;
    }
  | { t: "interact"; id: string }
  | { t: "debug"; cmd: DebugCmd }
  | { t: "ping"; c: number };

/** host-side cheats; only honored when the Host was created with allowDebug */
export type DebugCmd = "scare" | "stalk" | "phase1" | "phase2" | "ambient" | "doll" | "flicker" | "chair";

export type HostMsg =
  | { t: "welcome"; you: PlayerId; snap: Snapshot }
  | { t: "snap"; snap: Snapshot }
  | { t: "event"; e: GameEvent }
  | { t: "correct"; pos: Vec3 } // authoritative position correction
  | { t: "pong"; c: number; h: number };
