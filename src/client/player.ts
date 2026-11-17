// Local first-person controller (client-predicted; host validates & may correct).
import * as THREE from "three";
import { collide, PLAYER, type Vec3 } from "../shared/level";

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector2();
  yaw = 0;
  pitch = 0;
  crouch = false;
  running = false;
  flashOn = true;
  private eye: number = PLAYER.eye;
  private bob = 0;
  private stepPhase = 0;
  private keys = new Set<string>();
  locked = false;
  frozen = false;
  /** flashlight lags the view slightly */
  private sway = new THREE.Euler();
  onStep?: () => void;
  onToggleFlash?: () => void;
  onInteract?: () => void;

  readonly camera: THREE.PerspectiveCamera;
  readonly flashlight: THREE.SpotLight;
  private flashRig = new THREE.Object3D();

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 30);
    this.camera.rotation.order = "YXZ";
    this.flashlight = new THREE.SpotLight(0xfff0d8, 22, 11, 0.43, 0.55, 2);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.normalBias = 0.015;
    this.flashlight.shadow.camera.near = 0.1;
    this.flashlight.shadow.camera.far = 11;
    this.flashlight.position.set(0.16, -0.18, 0.05); // held low-right
    this.flashlight.target.position.set(0, 0, -4);
    this.flashRig.add(this.flashlight, this.flashlight.target);
    this.camera.add(this.flashRig);

    addEventListener("keydown", (e) => {
      if (!this.locked) return;
      this.keys.add(e.code);
      if (e.code === "KeyF" && !e.repeat) { this.flashOn = !this.flashOn; this.onToggleFlash?.(); }
      if (e.code === "KeyE" && !e.repeat) this.onInteract?.();
      if (e.code === "KeyC" || e.code === "ControlLeft") this.crouch = true;
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "KeyC" || e.code === "ControlLeft") this.crouch = false;
    });
    addEventListener("blur", () => this.keys.clear());
    addEventListener("mousedown", (e) => {
      if (this.locked && e.button === 0) this.onInteract?.();
    });
    addEventListener("mousemove", (e) => {
      if (!this.locked || this.frozen) return;
      const s = 0.0022;
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * s));
      this.addSway(e.movementX, e.movementY);
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
    });
  }

  lock() { this.canvas.requestPointerLock?.(); }

  place(p: Vec3, yaw: number) {
    this.pos.set(p[0], 0, p[2]);
    this.yaw = yaw;
  }

  update(dt: number, isOpen: (id: string) => boolean) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (!this.frozen) {
      if (k.has("KeyW") || k.has("ArrowUp")) fz -= 1;
      if (k.has("KeyS") || k.has("ArrowDown")) fz += 1;
      if (k.has("KeyA") || k.has("ArrowLeft")) fx -= 1;
      if (k.has("KeyD") || k.has("ArrowRight")) fx += 1;
    }
    this.running = (k.has("ShiftLeft") || k.has("ShiftRight")) && !this.crouch && fz < 0;
    const speed = this.crouch ? PLAYER.crouch : this.running ? PLAYER.run : PLAYER.walk;
    const len = Math.hypot(fx, fz) || 1;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // local (fx, fz) -> world
    const wx = ((fx * c + fz * s) / len) * speed;
    const wz = ((-fx * s + fz * c) / len) * speed;
    const accel = fx || fz ? 10 : 12;
    this.vel.x += (wx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.y += (wz - this.vel.y) * Math.min(1, accel * dt);
    const p = { x: this.pos.x + this.vel.x * dt, z: this.pos.z + this.vel.y * dt };
    collide(p, PLAYER.radius, isOpen);
    this.pos.x = p.x;
    this.pos.z = p.z;

    // head bob + footsteps
    const v = this.vel.length();
    const targetEye = this.crouch ? PLAYER.eyeCrouch : PLAYER.eye;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 8);
    if (v > 0.2) {
      const f = this.running ? 2.1 : this.crouch ? 1.1 : 1.6;
      this.stepPhase += dt * f * Math.PI * 2 * 0.5;
      if (this.stepPhase > Math.PI) {
        this.stepPhase -= Math.PI;
        this.onStep?.();
      }
    }
    this.bob += ((v > 0.2 ? 1 : 0) - this.bob) * Math.min(1, dt * 6);
    const bobY = Math.abs(Math.sin(this.stepPhase)) * 0.045 * this.bob * (this.running ? 1.6 : 1);
    const bobX = Math.cos(this.stepPhase) * 0.02 * this.bob;

    this.camera.position.set(this.pos.x, this.eye + bobY, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, -bobX * 0.5);
    this.camera.position.x += Math.cos(this.yaw) * bobX;
    this.camera.position.z -= Math.sin(this.yaw) * bobX;

    // flashlight lags behind fast turns
    this.sway.x += (0 - this.sway.x) * Math.min(1, dt * 9);
    this.sway.y += (0 - this.sway.y) * Math.min(1, dt * 9);
    this.flashRig.rotation.set(this.sway.x + bobY * 0.4, this.sway.y + bobX * 0.6, 0);
  }

  /** mouse delta feeds sway (called by main from movement events) */
  addSway(dx: number, dy: number) {
    this.sway.y = Math.max(-0.12, Math.min(0.12, this.sway.y + dx * 0.0008));
    this.sway.x = Math.max(-0.12, Math.min(0.12, this.sway.x + dy * 0.0008));
  }

  forward(out = new THREE.Vector3()) {
    return this.camera.getWorldDirection(out);
  }
}
