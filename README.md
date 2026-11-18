# Escape the House (horror3d)

Browser first-person horror. Three.js + Vite + TypeScript. Props are modeled live in Blender
through the Blender Lab MCP socket (`localhost:9876`).

## Run
```
npm install
npm run models   # meshopt-compress public/models/*.glb -> public/m/*.glb
npm run dev
```
URL params: `?sound` (open the sound editor), `?debug` (debug keys), `?lag=120` (fake network latency on the loopback), `?name=Bob`, `?server=ws://host:port` (dedicated server, future).

## Architecture (multiplayer-ready)
```
src/shared/   pure logic, no DOM/three  -> runs in browser host or Node server
  level.ts      layout (mirrors tools/hb.py LAYOUT), colliders, entities, doll anchors
  protocol.ts   ClientMsg / HostMsg / Snapshot / GameEvent
  sim.ts        authoritative GameSim + horror director (seeded RNG)
src/net/
  transport.ts  Connection/Transport interfaces; Loopback (+ WebSocket client)
  host.ts       fixed 20 Hz ticks, 15 Hz snapshots, reliable events
  client.ts     client session; remote-player interpolation buffer
src/client/   rendering only (three.js): world, player, materials, audio, post
```
* **Host-authoritative, client-predicted.** Solo = listen-host in the same tab over a loopback
  transport (messages are structured-cloned + async, so the code path matches a real network).
  Multiplayer = add a WebSocket server (Node, same `Host` class) or WebRTC P2P host. No game code changes.
* Clients send movement + a `seesDoll` visibility flag; the host validates moves (speed/collision),
  arbitrates interactions (locks, keys, items) and runs the director. The doll only moves when
  *no* player sees it — turning off your flashlight in the dark counts as not seeing it.

## Asset pipeline
* `tools/bl.py` — client for the Blender MCP socket (NUL-framed JSON `{"type":"execute"}`).
* `tools/hb.py` — Blender helpers: per-prop collection/root at its room location, part builders,
  material library, finalize (join), export, isolated preview render.
* `docs/PROP_BRIEF.md` — the brief every prop subagent follows.
* Materials are named `M_*` in Blender and swapped at load for shared triplanar materials with
  procedural canvas textures (no UVs, no texture downloads, ~20 shader programs total).

## Perf notes
Single post pass (ACES, CA, grain, vignette), MSAA HDR target, dynamic resolution (0.55–1.0),
only the flashlight has a per-frame shadow map; moonlight shadow updates only when something moves;
static props have frozen matrices; meshopt-compressed geometry (~0.5 MB for the whole room).

## Sound editor (F2)
Shows every sound cue in 3D: live markers sized by the measured post-panner level, a dashed line from
the listener, and a label with distance, head-relative direction (e.g. `120° L (behind) ↑30°`) and dBFS.
Static cue spots come straight from `level.ts` (entity anchors, doll anchors, `SOUND_SPOTS`), plus the
room shell (occlusion boundary), the random-ambient volume and the upstairs-steps plane.
* **V** fly camera, **L** listener follows the fly cam (walk around a cue and hear it move), WASD/QE, Shift fast
* **P** play the selected sound at the aim point, **[ ]** pick sound, **R** replay last cue, **O** orbit test
  (8 points around your head, clockwise from front), **M** mute ambience beds, **H** hide cue spots
* **Esc** frees the mouse for the panel (the menu stays hidden), click the view to resume
* Spatial mix sliders (distance model, ref distance, rolloff, reverb send/length, occlusion, HRTF) apply to
  new voices and persist in localStorage; **copy JSON** to paste good values into `DEFAULT_TUNE` in `audio.ts`.
