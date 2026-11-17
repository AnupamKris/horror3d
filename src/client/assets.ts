import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { libraryMaterial, needsTriplanar } from "./materials";

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/**
 * Load a prop. Returns its root (= Blender prop root local space). Replaces materials with the
 * shared library and bakes `tpos`/`tnrm` (rest pose, prop-local) for triplanar texturing.
 */
export async function loadProp(name: string): Promise<THREE.Group> {
  let gltf;
  try {
    gltf = await loader.loadAsync(`/m/${name}.glb`); // optimized (npm run models)
  } catch {
    gltf = await loader.loadAsync(`/models/${name}.glb`); // raw Blender export fallback
  }
  const root = gltf.scene as THREE.Group;
  root.name = name;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const replaced = mats.map((mat) => libraryMaterial(mat.name) ?? mat);
    mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0];
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (replaced.some(needsTriplanar)) {
      const g = mesh.geometry;
      m.multiplyMatrices(inv, mesh.matrixWorld);
      nm.getNormalMatrix(m);
      const pos = g.getAttribute("position");
      const nrm = g.getAttribute("normal");
      const tp = new Float32Array(pos.count * 3);
      const tn = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        tp[i * 3] = v.x; tp[i * 3 + 1] = v.y; tp[i * 3 + 2] = v.z;
        if (nrm) {
          v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
          tn[i * 3] = v.x; tn[i * 3 + 1] = v.y; tn[i * 3 + 2] = v.z;
        } else tn[i * 3 + 1] = 1;
      }
      g.setAttribute("tpos", new THREE.BufferAttribute(tp, 3));
      g.setAttribute("tnrm", new THREE.BufferAttribute(tn, 3));
    }
  });
  return root;
}
