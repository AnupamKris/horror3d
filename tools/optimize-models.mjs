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
const SELF_MTIME = fs.statSync(new URL(import.meta.url)).mtimeMs;

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

let tin = 0, tout = 0;
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".glb"))) {
  const src = path.join(SRC, f), dst = path.join(DST, f);
  // up to date only if newer than both the source model and this script (pipeline changes rebuild all)
  if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs > Math.max(fs.statSync(src).mtimeMs, SELF_MTIME)) {
    tin += fs.statSync(src).size; tout += fs.statSync(dst).size;
    continue;
  }
  const doc = await io.read(src);
  // Quantization bakes its dequantize offset/scale into the matrix of the node holding the mesh, which
  // moves that node's origin to the mesh bbox center. For MOV_* parts the origin IS the hinge/pivot, so
  // move every mesh onto its own child node: the named node keeps its Blender transform untouched.
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    node.addChild(doc.createNode(`${node.getName()}_mesh`).setMesh(mesh));
    node.setMesh(null);
  }
  await doc.transform(dedup(), prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  await io.write(dst, doc);
  const a = fs.statSync(src).size, b = fs.statSync(dst).size;
  tin += a; tout += b;
  console.log(`${f.padEnd(22)} ${(a / 1024).toFixed(1).padStart(7)} KB -> ${(b / 1024).toFixed(1).padStart(7)} KB`);
}
console.log(`total ${(tin / 1024).toFixed(0)} KB -> ${(tout / 1024).toFixed(0)} KB`);
