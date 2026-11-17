// Optimize Blender exports: public/models/*.glb -> public/m/*.glb
// dedup + prune + weld + vertex-cache reorder + meshopt compression (EXT_meshopt_compression,
// KHR_mesh_quantization). Node names (MOV_*, INT_*) are preserved: no flatten/join.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import fs from "node:fs";
import path from "node:path";

const SRC = "public/models";
const DST = "public/m";
fs.mkdirSync(DST, { recursive: true });

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

let tin = 0, tout = 0;
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".glb"))) {
  const src = path.join(SRC, f), dst = path.join(DST, f);
  if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs > fs.statSync(src).mtimeMs) {
    tin += fs.statSync(src).size; tout += fs.statSync(dst).size;
    continue;
  }
  const doc = await io.read(src);
  await doc.transform(dedup(), prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  await io.write(dst, doc);
  const a = fs.statSync(src).size, b = fs.statSync(dst).size;
  tin += a; tout += b;
  console.log(`${f.padEnd(22)} ${(a / 1024).toFixed(1).padStart(7)} KB -> ${(b / 1024).toFixed(1).padStart(7)} KB`);
}
console.log(`total ${(tin / 1024).toFixed(0)} KB -> ${(tout / 1024).toFixed(0)} KB`);
