// Host: owns the authoritative GameSim, accepts Connections, runs fixed ticks,
// broadcasts snapshots + reliable events. Environment-agnostic (browser tab or Node).
import type { ClientMsg, HostMsg } from "../shared/protocol";
import { PROTOCOL_VERSION, SNAP_HZ, TICK_HZ } from "../shared/protocol";
import { GameSim } from "../shared/sim";
import type { Connection } from "./transport";

export class Host {
  readonly sim: GameSim;
  private conns = new Map<string, Connection>();
  private acc = 0;
  private snapAcc = 0;
  private readonly dt = 1 / TICK_HZ;

  constructor(seed?: number) {
    this.sim = new GameSim(seed);
  }

  addConnection(conn: Connection): void {
    conn.onMessage((raw) => this.onMessage(conn, raw as ClientMsg));
    conn.onClose(() => {
      this.conns.delete(conn.id);
      this.sim.removePlayer(conn.id);
    });
  }

  private onMessage(conn: Connection, msg: ClientMsg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      if (msg.v !== PROTOCOL_VERSION) return conn.close();
      this.conns.set(conn.id, conn);
      this.sim.addPlayer(conn.id, String(msg.name).slice(0, 24));
      this.sendTo(conn.id, { t: "welcome", you: conn.id, snap: this.sim.snapshot() });
      return;
    }
    if (msg.t === "ping") return this.sendTo(conn.id, { t: "pong", c: msg.c, h: this.sim.time });
    if (!this.conns.has(conn.id)) return;
    this.sim.handle(conn.id, msg);
  }

  private sendTo(id: string, m: HostMsg) {
    this.conns.get(id)?.send(m);
  }
  private broadcast(m: HostMsg) {
    for (const c of this.conns.values()) c.send(m);
  }

  /** Advance with real elapsed seconds; runs fixed ticks internally. */
  update(elapsed: number): void {
    this.acc += Math.min(elapsed, 0.25);
    while (this.acc >= this.dt) {
      this.acc -= this.dt;
      this.sim.step(this.dt);
      this.flush();
      this.snapAcc += this.dt;
      if (this.snapAcc >= 1 / SNAP_HZ) {
        this.snapAcc = 0;
        this.broadcast({ t: "snap", snap: this.sim.snapshot() });
      }
    }
  }

  private flush() {
    const out = this.sim.outbox.splice(0);
    for (const o of out) {
      if ("correct" in o) this.sendTo(o.to, { t: "correct", pos: o.correct });
      else if (o.to) this.sendTo(o.to, { t: "event", e: o.e });
      else this.broadcast({ t: "event", e: o.e });
    }
  }
}
