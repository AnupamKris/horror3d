// Client session: talks to a Host through any Transport. Keeps the latest authoritative
// snapshot + a short buffer for interpolating remote players. Own movement is client-predicted;
// the host only sends a correction when it disagrees.
import type { Vec3 } from "../shared/level";
import type { ClientMsg, GameEvent, HostMsg, PlayerId, PlayerState, Snapshot } from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type { Transport } from "./transport";

interface Buffered { at: number; snap: Snapshot }

export class ClientSession {
  you: PlayerId = "";
  snap: Snapshot | null = null;
  private buffer: Buffered[] = [];
  private seq = 0;
  private eventCbs: ((e: GameEvent) => void)[] = [];
  private correctCbs: ((p: Vec3) => void)[] = [];
  private ready!: Promise<void>;
  /** remote players are rendered this far in the past for smooth interpolation */
  interpDelay = 0.12;

  constructor(private transport: Transport, name: string) {
    this.ready = new Promise((resolve) => {
      transport.onMessage((raw) => {
        const m = raw as HostMsg;
        if (m.t === "welcome") {
          this.you = m.you;
          this.push(m.snap);
          resolve();
        } else if (m.t === "snap") this.push(m.snap);
        else if (m.t === "event") this.eventCbs.forEach((cb) => cb(m.e));
        else if (m.t === "correct") this.correctCbs.forEach((cb) => cb(m.pos));
      });
    });
    this.send({ t: "hello", v: PROTOCOL_VERSION, name });
  }

  whenReady() { return this.ready; }
  onEvent(cb: (e: GameEvent) => void) { this.eventCbs.push(cb); }
  onCorrect(cb: (p: Vec3) => void) { this.correctCbs.push(cb); }

  private push(snap: Snapshot) {
    this.snap = snap;
    this.buffer.push({ at: performance.now() / 1000, snap });
    if (this.buffer.length > 12) this.buffer.shift();
  }

  private send(m: ClientMsg) { this.transport.send(m); }

  sendState(s: Omit<Extract<ClientMsg, { t: "state" }>, "t" | "seq">) {
    this.send({ t: "state", seq: ++this.seq, ...s });
  }

  interact(id: string) { this.send({ t: "interact", id }); }

  /** Interpolated remote players (excludes self). */
  remotePlayers(): PlayerState[] {
    const now = performance.now() / 1000 - this.interpDelay;
    const b = this.buffer;
    if (!b.length) return [];
    let i = b.length - 1;
    while (i > 0 && b[i - 1].at > now) i--;
    const a = b[Math.max(0, i - 1)], c = b[i];
    const t = c.at === a.at ? 1 : Math.max(0, Math.min(1, (now - a.at) / (c.at - a.at)));
    return c.snap.players
      .filter((p) => p.id !== this.you)
      .map((p) => {
        const q = a.snap.players.find((x) => x.id === p.id) ?? p;
        const lerp = (x: number, y: number) => x + (y - x) * t;
        return { ...p, pos: [lerp(q.pos[0], p.pos[0]), 0, lerp(q.pos[2], p.pos[2])] as Vec3, yaw: lerp(q.yaw, p.yaw) };
      });
  }

  me(): PlayerState | undefined {
    return this.snap?.players.find((p) => p.id === this.you);
  }
}
