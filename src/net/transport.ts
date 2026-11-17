// Transport abstraction. The game only ever talks through these two interfaces:
//   Connection: host's handle to one client      Transport: client's handle to the host
// Implementations: Loopback (solo / listen-host player in the same tab), and later
// WebSocket (dedicated Node server running the same Host) or WebRTC DataChannel (P2P host).

export interface Connection {
  readonly id: string;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface Transport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

let nextId = 1;

/**
 * In-memory pair. Messages are delivered asynchronously and structured-cloned so the
 * code path behaves like a real network (no shared object references). Optional fake latency
 * for testing netcode in solo.
 */
export function createLoopback(latencyMs = 0): { conn: Connection; transport: Transport } {
  const hostSide: ((m: unknown) => void)[] = [];
  const clientSide: ((m: unknown) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const deliver = (cbs: ((m: unknown) => void)[], msg: unknown) => {
    if (closed) return;
    const copy = structuredClone(msg);
    const run = () => cbs.forEach((cb) => cb(copy));
    if (latencyMs > 0) setTimeout(run, latencyMs);
    else queueMicrotask(run);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    closeCbs.forEach((cb) => cb());
  };
  const conn: Connection = {
    id: "p" + nextId++,
    send: (m) => deliver(clientSide, m),
    onMessage: (cb) => hostSide.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close,
  };
  const transport: Transport = {
    send: (m) => deliver(hostSide, m),
    onMessage: (cb) => clientSide.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close,
  };
  return { conn, transport };
}

/** WebSocket client transport (for a future dedicated server: same Host class under Node + `ws`). */
export function createWebSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgCbs: ((m: unknown) => void)[] = [];
    const closeCbs: (() => void)[] = [];
    ws.onmessage = (ev) => msgCbs.forEach((cb) => cb(JSON.parse(ev.data as string)));
    ws.onclose = () => closeCbs.forEach((cb) => cb());
    ws.onerror = () => reject(new Error("websocket failed: " + url));
    ws.onopen = () =>
      resolve({
        send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
        onMessage: (cb) => msgCbs.push(cb),
        onClose: (cb) => closeCbs.push(cb),
        close: () => ws.close(),
      });
  });
}
