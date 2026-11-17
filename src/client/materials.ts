// Shared material library. Blender exports materials named M_*; we replace them by name with a
// handful of shared MeshStandardMaterials using procedural canvas textures sampled TRIPLANAR in
// prop-rest space (attributes `tpos`/`tnrm` baked at load), so no UVs are needed, textures stay
// glued to moving parts, and there are only ~20 shader variants in the whole game.
import * as THREE from "three";

type Painter = (g: CanvasRenderingContext2D, s: number, rnd: () => number) => void;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function canvasTex(size: number, seed: number, paint: Painter, repeat = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  paint(g, size, rng(seed));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** tileable value noise blotches (mean ~ mid gray) */
function blotches(g: CanvasRenderingContext2D, s: number, r: () => number, n: number, minR: number, maxR: number, alpha: number, dark = true) {
  for (let i = 0; i < n; i++) {
    const x = r() * s, y = r() * s, rad = minR + r() * (maxR - minR);
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      const v = dark ? 0 : 255;
      gr.addColorStop(0, `rgba(${v},${v},${v},${alpha * r()})`);
      gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = gr;
      g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
}

function speckle(g: CanvasRenderingContext2D, s: number, r: () => number, n: number, a: number) {
  for (let i = 0; i < n; i++) {
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${a * r()})`;
    g.fillRect(r() * s, r() * s, 1 + r() * 2, 1 + r() * 2);
  }
}

const P: Record<string, Painter> = {
  wood: (g, s, r) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    // grain lines along X
    for (let i = 0; i < 90; i++) {
      const y = r() * s, amp = 2 + r() * 6, f = (1 + ((r() * 3) | 0)) * (Math.PI * 2) / s;
      g.strokeStyle = `rgba(${r() > 0.5 ? 40 : 170},${r() > 0.5 ? 30 : 140},20,${0.12 + r() * 0.25})`;
      g.lineWidth = 0.5 + r() * 2.5;
      g.beginPath();
      for (let x = 0; x <= s; x += 8) g.lineTo(x, y + Math.sin(x * f + i) * amp);
      g.stroke();
    }
    blotches(g, s, r, 14, 10, 50, 0.25);
    speckle(g, s, r, 1500, 0.15);
  },
  floor: (g, s, r) => {
    P.wood(g, s, r);
    // plank seams (4 planks per tile) + end joints
    const n = 4;
    for (let i = 0; i < n; i++) {
      const y = (i * s) / n;
      g.fillStyle = "rgba(0,0,0,0.85)";
      g.fillRect(0, y, s, 3);
      const jx = r() * s;
      g.fillRect(jx, y, 3, s / n);
      g.fillStyle = `rgba(${r() > 0.5 ? 0 : 255},${r() > 0.5 ? 0 : 230},${0},${0.06 + r() * 0.08})`;
      g.fillRect(0, y + 3, s, s / n - 3);
    }
    blotches(g, s, r, 8, 20, 70, 0.35);
  },
  paint: (g, s, r) => {
    g.fillStyle = "#8a8a86";
    g.fillRect(0, 0, s, s);
    blotches(g, s, r, 30, 5, 25, 0.25);
    // chipped paint revealing dark wood
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(60,35,20,${0.5 + r() * 0.5})`;
      g.beginPath();
      const x = r() * s, y = r() * s;
      for (let k = 0; k < 7; k++) g.lineTo(x + (r() - 0.5) * 18, y + (r() - 0.5) * 12);
      g.fill();
    }
    speckle(g, s, r, 2000, 0.12);
  },
  wallpaper: (g, s, r) => {
    g.fillStyle = "#86806a";
    g.fillRect(0, 0, s, s);
    // vertical stripes + damask-ish motifs
    for (let x = 0; x < s; x += s / 8) {
      g.fillStyle = "rgba(60,70,40,0.25)";
      g.fillRect(x, 0, s / 32, s);
    }
    g.fillStyle = "rgba(70,55,35,0.35)";
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const cx = (i + 0.5 + (j % 2) * 0.5) * (s / 4), cy = (j + 0.5) * (s / 4);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          g.beginPath();
          g.ellipse(cx + Math.cos(a) * 9, cy + Math.sin(a) * 13, 4, 10, a, 0, Math.PI * 2);
          g.fill();
        }
      }
    // water damage drips
    for (let i = 0; i < 10; i++) {
      // soft-edged streaks that fade at both ends and wrap vertically (seamless tile)
      const x = r() * s, y0 = r() * s, len = s * (0.2 + r() * 0.6), w = 3 + r() * 12;
      for (const oy of [0, -s]) {
        const gr = g.createLinearGradient(0, y0 + oy, 0, y0 + oy + len);
        gr.addColorStop(0, "rgba(40,30,10,0)");
        gr.addColorStop(0.2, "rgba(40,30,10,0.3)");
        gr.addColorStop(1, "rgba(40,30,10,0)");
        g.fillStyle = gr;
        g.fillRect(x, y0 + oy, w, len);
      }
    }
    blotches(g, s, r, 18, 15, 60, 0.3);
    speckle(g, s, r, 3000, 0.1);
  },
  plaster: (g, s, r) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    blotches(g, s, r, 40, 10, 70, 0.22);
    blotches(g, s, r, 20, 10, 40, 0.15, false);
    g.strokeStyle = "rgba(0,0,0,0.5)";
    for (let i = 0; i < 4; i++) {
      g.lineWidth = 0.8;
      g.beginPath();
      let x = r() * s, y = r() * s;
      for (let k = 0; k < 20; k++) { g.lineTo(x, y); x += (r() - 0.5) * 20; y += r() * 10; }
      g.stroke();
    }
    speckle(g, s, r, 3000, 0.15);
  },
  fabric: (g, s, r) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i += 2) {
      g.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.06})`;
      g.fillRect(i, 0, 1, s);
      g.fillRect(0, i, s, 1);
    }
    // yellowed stains with dark rims
    for (let i = 0; i < 7; i++) {
      const x = r() * s, y = r() * s, rad = 15 + r() * 45;
      g.strokeStyle = "rgba(60,40,10,0.35)";
      g.lineWidth = 2;
      g.fillStyle = "rgba(150,120,40,0.2)";
      g.beginPath();
      g.ellipse(x, y, rad, rad * (0.6 + r() * 0.4), r() * 3, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    blotches(g, s, r, 10, 20, 60, 0.25);
  },
  rug: (g, s, r) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    // geometric oriental pattern
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        const cx = (i + 0.5) * (s / 8), cy = (j + 0.5) * (s / 8);
        g.fillStyle = (i + j) % 2 ? "rgba(140,110,60,0.45)" : "rgba(20,30,60,0.4)";
        g.beginPath();
        g.moveTo(cx, cy - 12); g.lineTo(cx + 12, cy); g.lineTo(cx, cy + 12); g.lineTo(cx - 12, cy);
        g.fill();
      }
    for (let i = 0; i < s; i += 2) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.08})`;
      g.fillRect(0, i, s, 1);
    }
    blotches(g, s, r, 14, 20, 60, 0.35); // worn
    blotches(g, s, r, 10, 10, 40, 0.2, false);
  },
  rust: (g, s, r) => {
    g.fillStyle = "#707070";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      const x = r() * s, y = r() * s, rad = 4 + r() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(${150 + r() * 60},${60 + r() * 30},20,${0.4 + r() * 0.4})`);
      gr.addColorStop(1, "rgba(120,50,20,0)");
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    speckle(g, s, r, 4000, 0.25);
  },
  grime: (g, s, r) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    blotches(g, s, r, 30, 8, 50, 0.25);
    speckle(g, s, r, 2500, 0.12);
  },
  smooth: (g, s, r) => {
    g.fillStyle = "#828282";
    g.fillRect(0, 0, s, s);
    blotches(g, s, r, 16, 4, 30, 0.12);
    // hairline crazing
    g.strokeStyle = "rgba(40,30,20,0.25)";
    g.lineWidth = 0.6;
    for (let i = 0; i < 25; i++) {
      g.beginPath();
      let x = r() * s, y = r() * s;
      for (let k = 0; k < 6; k++) { g.lineTo(x, y); x += (r() - 0.5) * 16; y += (r() - 0.5) * 16; }
      g.stroke();
    }
  },
};

interface LibDef {
  tex: keyof typeof P;
  scale: number; // texture repeats per meter
  color: number;
  rough: number;
  metal: number;
}

const LIB: Record<string, LibDef> = {
  M_Wood_Old: { tex: "wood", scale: 1.6, color: 0x5a3a24, rough: 0.8, metal: 0 },
  M_Wood_Dark: { tex: "wood", scale: 1.8, color: 0x2a1910, rough: 0.6, metal: 0 },
  M_Wood_Painted: { tex: "paint", scale: 1.3, color: 0xa9a394, rough: 0.85, metal: 0 },
  M_Floorboards: { tex: "floor", scale: 0.55, color: 0x4a3020, rough: 0.75, metal: 0 },
  M_Wallpaper: { tex: "wallpaper", scale: 0.9, color: 0x7d745a, rough: 0.92, metal: 0 },
  M_Plaster: { tex: "plaster", scale: 0.6, color: 0x8a847a, rough: 0.95, metal: 0 },
  M_Metal_Rust: { tex: "rust", scale: 3, color: 0x5a2c16, rough: 0.85, metal: 0.4 },
  M_Metal_Iron: { tex: "rust", scale: 4, color: 0x2a2a2a, rough: 0.55, metal: 0.8 },
  M_Brass: { tex: "grime", scale: 6, color: 0x9a7438, rough: 0.4, metal: 1 },
  M_Fabric_Stained: { tex: "fabric", scale: 1.4, color: 0x8e8268, rough: 0.95, metal: 0 },
  M_Fabric_Dark: { tex: "fabric", scale: 2, color: 0x3c1616, rough: 0.95, metal: 0 },
  M_Leather: { tex: "grime", scale: 4, color: 0x2e1c12, rough: 0.6, metal: 0 },
  M_Porcelain: { tex: "smooth", scale: 8, color: 0xd8cbbf, rough: 0.32, metal: 0 },
  M_Doll_Dress: { tex: "fabric", scale: 6, color: 0x5e4c55, rough: 0.9, metal: 0 },
  M_Hair: { tex: "wood", scale: 12, color: 0x2a1c12, rough: 0.7, metal: 0 },
  M_Paper: { tex: "grime", scale: 6, color: 0xb0a07a, rough: 0.9, metal: 0 },
  M_Rubber: { tex: "grime", scale: 6, color: 0x111111, rough: 0.8, metal: 0 },
  M_Rug: { tex: "rug", scale: 1.0, color: 0x6a2420, rough: 0.95, metal: 0 },
  M_Blood: { tex: "grime", scale: 4, color: 0x3a0505, rough: 0.3, metal: 0 },
};

const texCache = new Map<string, THREE.Texture>();
function tex(name: keyof typeof P) {
  let t = texCache.get(name);
  if (!t) {
    t = canvasTex(512, name.length * 7919 + 13, P[name]);
    texCache.set(name, t);
  }
  return t;
}

/** Shared uniforms (animated globally, e.g. by the director). */
export const globalUniforms = {
  uTime: { value: 0 },
};

function triplanar(def: LibDef): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: def.rough,
    metalness: def.metal,
  });
  const map = tex(def.tex);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tTri = { value: map };
    sh.uniforms.uTriScale = { value: def.scale };
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec3 tpos; attribute vec3 tnrm;
        varying vec3 vTP; varying vec3 vTN; varying float vWY;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vTP = tpos; vTN = tnrm;
        vWY = (modelMatrix * vec4(transformed, 1.0)).y;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D tTri; uniform float uTriScale;
        varying vec3 vTP; varying vec3 vTN; varying float vWY;`,
      )
      .replace(
        "#include <map_fragment>",
        `vec3 tw = pow(abs(normalize(vTN)), vec3(4.0)); tw /= (tw.x + tw.y + tw.z + 1e-5);
        vec3 tp = vTP * uTriScale;
        vec3 tx = texture2D(tTri, tp.zy).rgb * tw.x + texture2D(tTri, tp.xz).rgb * tw.y + texture2D(tTri, tp.xy).rgb * tw.z;
        diffuseColor.rgb *= tx * 2.0;
        float txl = dot(tx, vec3(0.333));
        // grime gradient: dirtier near the floor, darker toward the ceiling corners
        diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(0.0, 0.45, vWY)) * mix(0.75, 1.0, smoothstep(2.85, 2.2, vWY));`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (0.5 - txl) * 0.5, 0.04, 1.0);`,
      );
  };
  m.customProgramCacheKey = () => "tri";
  return m;
}

const libCache = new Map<string, THREE.Material>();

export function portraitTexture(stage: number): THREE.CanvasTexture {
  return canvasTex(512, 99 + stage, (g, s, r) => {
    // dark varnished oil painting of a family of four. stage 1: they all look at you, eyes white
    const bg = g.createRadialGradient(s / 2, s * 0.4, 20, s / 2, s / 2, s * 0.75);
    bg.addColorStop(0, "#4a3a22");
    bg.addColorStop(1, "#120c06");
    g.fillStyle = bg;
    g.fillRect(0, 0, s, s);
    const figs = [
      { x: 0.25, y: 0.42, h: 1.0 }, { x: 0.72, y: 0.4, h: 1.05 },
      { x: 0.42, y: 0.6, h: 0.7 }, { x: 0.6, y: 0.64, h: 0.6 },
    ];
    figs.forEach((f, i) => {
      const x = f.x * s, y = f.y * s, k = f.h * s * 0.11;
      // body
      g.fillStyle = "#1a120c";
      g.beginPath();
      g.ellipse(x, y + k * 3.2, k * 1.5, k * 2.4, 0, 0, Math.PI * 2);
      g.fill();
      // face
      const fg = g.createRadialGradient(x - k * 0.2, y - k * 0.2, 2, x, y, k);
      fg.addColorStop(0, "#c9b090");
      fg.addColorStop(1, "#5a4630");
      g.fillStyle = fg;
      g.beginPath();
      g.ellipse(x, y, k * 0.75, k, 0, 0, Math.PI * 2);
      g.fill();
      // hair
      g.fillStyle = "#140c06";
      g.beginPath();
      g.ellipse(x, y - k * 0.55, k * 0.85, k * 0.55, 0, Math.PI, Math.PI * 2);
      g.fill();
      // eyes
      const eyeCol = stage > 0 ? "#e8e0d0" : "#1a1008";
      g.fillStyle = eyeCol;
      for (const sx of [-0.3, 0.3]) {
        g.beginPath();
        g.ellipse(x + sx * k, y - k * 0.1, k * (stage ? 0.16 : 0.1), k * (stage ? 0.12 : 0.06), 0, 0, Math.PI * 2);
        g.fill();
        if (stage) {
          g.fillStyle = "#000";
          g.beginPath();
          g.arc(x + sx * k, y - k * 0.1, k * 0.05, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = eyeCol;
        }
      }
      // mouth
      g.strokeStyle = "#2a1408";
      g.lineWidth = 1.5;
      g.beginPath();
      if (stage) g.ellipse(x, y + k * 0.45, k * 0.18, k * 0.22, 0, 0, Math.PI * 2);
      else { g.moveTo(x - k * 0.2, y + k * 0.45); g.lineTo(x + k * 0.2, y + k * 0.45); }
      g.stroke();
      // the little girl's face is scratched out
      if (i === 3) {
        g.strokeStyle = "rgba(10,5,2,0.95)";
        g.lineWidth = 2.5;
        for (let j = 0; j < 26; j++) {
          g.beginPath();
          g.moveTo(x + (r() - 0.5) * k * 2, y + (r() - 0.5) * k * 2.2);
          g.lineTo(x + (r() - 0.5) * k * 2, y + (r() - 0.5) * k * 2.2);
          g.stroke();
        }
      }
    });
    // varnish cracks + grime
    blotches(g, s, r, 20, 20, 90, 0.35);
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = 0.5;
    for (let i = 0; i < 60; i++) {
      g.beginPath();
      let x = r() * s, y = r() * s;
      for (let k = 0; k < 5; k++) { g.lineTo(x, y); x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; }
      g.stroke();
    }
  }, false);
}

export const portraitMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });

/** emissive materials whose intensity the world animates */
export const bulbMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.5).multiplyScalar(4) });
export const flameMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.2).multiplyScalar(5) });
const glassMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa59a, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18, depthWrite: false,
});
const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.05, metalness: 0.2 });

export function libraryMaterial(name: string): THREE.Material | null {
  const base = name.replace(/\.\d+$/, "");
  const hit = libCache.get(base);
  if (hit) return hit;
  let m: THREE.Material | null = null;
  if (base === "M_Bulb") m = bulbMaterial;
  else if (base === "M_Flame") m = flameMaterial;
  else if (base === "M_Glass") m = glassMaterial;
  else if (base === "M_Eye") m = eyeMaterial;
  else if (base === "M_Portrait") m = portraitMaterial;
  else if (LIB[base]) m = triplanar(LIB[base]);
  if (m) libCache.set(base, m);
  return m;
}

/** materials that need the tpos/tnrm attributes */
export const needsTriplanar = (m: THREE.Material) => m.customProgramCacheKey?.() === "tri";
