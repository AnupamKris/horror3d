// One-pass post: HDR scene RT -> (chromatic aberration, ACES, vignette, grain, fear/scare FX) -> screen.
// Plus dynamic resolution scaling to hold the frame budget.
import * as THREE from "three";

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const frag = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform float uTime, uFear, uScare, uExposure, uFade, uAspect;
uniform vec3 uFadeColor;
varying vec2 vUv;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float r2 = dot(cc * vec2(uAspect, 1.0), cc * vec2(uAspect, 1.0));
  // scare: brief distortion shake
  uv += uScare * 0.012 * vec2(sin(uTime * 91.0), cos(uTime * 77.0));
  float ca = 0.0015 + r2 * 0.006 + uFear * 0.004 + uScare * 0.02;
  vec3 col;
  col.r = texture2D(tScene, uv + cc * ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - cc * ca).b;
  col *= uExposure;
  col = aces(col);
  // desaturate & cool the image, more with fear
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l) * vec3(0.92, 0.97, 1.05), 0.25 + uFear * 0.35);
  // vignette (pulses with fear)
  float pulse = 0.5 + 0.5 * sin(uTime * (3.0 + uFear * 6.0));
  float vig = 1.0 - smoothstep(0.12 - uFear * 0.1 * pulse, 0.85, r2 * 1.6);
  col *= mix(0.25, 1.0, vig);
  col = mix(col, col * vec3(1.25, 0.6, 0.55), (1.0 - vig) * uFear * 0.6);
  // gamma
  col = pow(col, vec3(1.0 / 2.2));
  // film grain + scanline flicker
  float n = hash(uv * 1000.0 + fract(uTime * 7.13) * 100.0) - 0.5;
  col += n * (0.06 + uFear * 0.05);
  col *= 1.0 - 0.025 * sin(uTime * 50.0 + uv.y * 3.0) * uFear;
  col = mix(col, vec3(1.0, 0.95, 0.9), uScare * 0.25 * step(0.5, fract(uTime * 30.0)));
  col = mix(col, uFadeColor, uFade);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Post {
  rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms = {
    tScene: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFear: { value: 0 },
    uScare: { value: 0 },
    uExposure: { value: 1.7 },
    uFade: { value: 1 },
    uFadeColor: { value: new THREE.Color(0, 0, 0) },
    uAspect: { value: 1 },
  };
  /** dynamic resolution */
  scale = 1;
  private frameTimes: number[] = [];
  private w = 1;
  private h = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthBuffer: true,
    });
    this.uniforms.tScene.value = this.rt.texture;
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.applyScale();
    this.uniforms.uAspect.value = w / h;
  }

  private applyScale() {
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    this.rt.setSize(Math.max(2, Math.round(this.w * dpr * this.scale)), Math.max(2, Math.round(this.h * dpr * this.scale)));
  }

  /** feed frame delta; adjusts internal resolution between 0.55 and 1.0 */
  adapt(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 45) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    this.frameTimes.length = 0;
    let s = this.scale;
    if (p80 > 1 / 50) s = Math.max(0.55, s - 0.1);
    else if (p80 < 1 / 58 && s < 1) s = Math.min(1, s + 0.05);
    if (s !== this.scale) {
      this.scale = s;
      this.applyScale();
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.scene, this.cam);
  }
}
