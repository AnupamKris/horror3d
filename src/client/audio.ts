// Fully procedural horror audio (zero asset bytes). WebAudio + HRTF panning + generated reverb.
import type { Vec3 } from "../shared/level";
import type { SoundId } from "../shared/protocol";

export class Audio {
  ctx: AudioContext;
  private master: GainNode;
  private sfx: GainNode;
  private verb: ConvolverNode;
  private verbSend: GainNode;
  private noiseBuf: AudioBuffer;
  private heart = { next: 0, rate: 1 };
  private droneGain!: GainNode;
  private stepSide = 0;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(c.destination);
    this.sfx = c.createGain();
    this.sfx.connect(this.master);
    this.verb = c.createConvolver();
    this.verb.buffer = this.impulse(1.8, 2.6);
    this.verbSend = c.createGain();
    this.verbSend.gain.value = 0.5;
    this.verbSend.connect(this.verb).connect(this.master);
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.loadSamples();
  }

  // ---------------------------------------------------------------- recorded samples (public/sfx)
  /** sample id -> decoded takes. Missing ids fall back to the procedural synth. */
  private samples = new Map<string, AudioBuffer[]>();
  private lastTake = new Map<string, number>();
  private samplesReady: Promise<void> = Promise.resolve();

  private loadSamples() {
    this.samplesReady = (async () => {
      let manifest: Record<string, { count: number; loop: boolean }>;
      try {
        manifest = await (await fetch("/sfx/manifest.json")).json();
      } catch {
        return; // no sample pack: everything stays procedural
      }
      await Promise.all(
        Object.entries(manifest).map(async ([id, { count }]) => {
          const takes = await Promise.all(
            Array.from({ length: count }, async (_, i) => {
              try {
                const buf = await (await fetch(`/sfx/${id}_${i + 1}.ogg`)).arrayBuffer();
                return await this.ctx.decodeAudioData(buf);
              } catch (e) {
                console.warn("sfx failed", id, i + 1, e);
                return null;
              }
            }),
          );
          const ok = takes.filter((t): t is AudioBuffer => !!t);
          if (ok.length) this.samples.set(id, ok);
        }),
      );
    })();
  }

  has(id: string) { return this.samples.has(id); }

  /** play a random take (never the same twice in a row) with slight pitch variance */
  sample(id: string, pos?: Vec3, vol = 1, opts: { rate?: number; jitter?: number; wet?: number; delay?: number } = {}) {
    const takes = this.samples.get(id);
    if (!takes) return false;
    let i = (Math.random() * takes.length) | 0;
    if (takes.length > 1 && i === this.lastTake.get(id)) i = (i + 1) % takes.length;
    this.lastTake.set(id, i);
    const src = this.ctx.createBufferSource();
    src.buffer = takes[i];
    const jitter = opts.jitter ?? 0.05;
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
    src.connect(this.out(pos, vol, opts.wet ?? 0.5));
    src.start(this.ctx.currentTime + (opts.delay ?? 0));
    return true;
  }

  resume() { return this.ctx.resume(); }

  private impulse(sec: number, decay: number) {
    const c = this.ctx, n = c.sampleRate * sec, b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }

  setListener(pos: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }) {
    const l = this.ctx.listener, t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  /** output node for a sound: positional (HRTF) or head-locked */
  private out(pos?: Vec3, vol = 1, wet = 0.5): GainNode {
    const c = this.ctx, g = c.createGain();
    g.gain.value = vol;
    if (pos) {
      const p = c.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 0.8;
      p.rolloffFactor = 1.2;
      p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2];
      g.connect(p);
      p.connect(this.sfx);
      const s = c.createGain();
      s.gain.value = wet;
      p.connect(s).connect(this.verbSend);
    } else {
      g.connect(this.sfx);
      const s = c.createGain();
      s.gain.value = wet * 0.6;
      g.connect(s).connect(this.verbSend);
    }
    return g;
  }

  private noise(t0: number, dur: number, dest: AudioNode, type: BiquadFilterType, freq: number, q = 1) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    src.connect(f).connect(dest);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur);
    return { src, f };
  }

  private env(g: AudioParam, t0: number, a: number, peak: number, d: number) {
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  private tone(t0: number, freq: number, dur: number, dest: AudioNode, type: OscillatorType = "sine", peak = 0.5, a = 0.005) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    this.env(g.gain, t0, a, peak, dur);
    o.connect(g).connect(dest);
    o.start(t0); o.stop(t0 + a + dur + 0.05);
    return o;
  }

  // ---------------------------------------------------------------- ambience
  /** recorded ambience beds (loops), layered under the procedural fear drone */
  private async startBeds() {
    await this.samplesReady;
    const c = this.ctx;
    for (const [id, vol] of [["amb_house", 0.55], ["amb_wind", 0.35], ["amb_roomtone", 0.3]] as const) {
      const takes = this.samples.get(id);
      if (!takes) continue;
      const src = c.createBufferSource();
      src.buffer = takes[(Math.random() * takes.length) | 0];
      src.loop = true;
      const g = c.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(vol, c.currentTime + 5);
      src.connect(g).connect(this.master);
      src.start();
    }
  }

  startAmbience() {
    const c = this.ctx, t = c.currentTime;
    this.startBeds();
    this.droneGain = c.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.gain.linearRampToValueAtTime(0.5, t + 6);
    this.droneGain.connect(this.master);
    // low drone: detuned oscillators through a slowly sweeping lowpass
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 220; lp.Q.value = 4;
    lp.connect(this.droneGain);
    for (const [f, ty] of [[41.2, "sawtooth"], [41.6, "sawtooth"], [61.7, "triangle"], [87.3, "sine"]] as const) {
      const o = c.createOscillator();
      o.type = ty; o.frequency.value = f;
      const g = c.createGain();
      g.gain.value = 0.12;
      o.connect(g).connect(lp);
      o.start();
    }
    const lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = 0.05; lg.gain.value = 120;
    lfo.connect(lg).connect(lp.frequency);
    lfo.start();
    // wind through the boarded window: bandpassed noise with slow gusts
    const wind = c.createBufferSource();
    wind.buffer = this.noiseBuf; wind.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 0.8;
    const wg = c.createGain();
    wg.gain.value = 0.05;
    const glfo = c.createOscillator(), glg = c.createGain();
    glfo.frequency.value = 0.08; glg.gain.value = 0.04;
    glfo.connect(glg).connect(wg.gain);
    const flfo = c.createOscillator(), flg = c.createGain();
    flfo.frequency.value = 0.13; flg.gain.value = 250;
    flfo.connect(flg).connect(bp.frequency);
    const wp = c.createPanner();
    wp.panningModel = "HRTF";
    wp.positionX.value = 3.2; wp.positionY.value = 1.5; wp.positionZ.value = -0.2;
    wind.connect(bp).connect(wg).connect(wp).connect(this.droneGain);
    wind.start(); glfo.start(); flfo.start();
  }

  /** call every frame: heartbeat by fear, drone intensity */
  update(fear: number) {
    const t = this.ctx.currentTime;
    // with a recorded bed playing, the synth drone becomes just the fear-reactive layer
    const base = this.samples.has("amb_house") ? 0.08 : 0.35;
    if (this.droneGain) this.droneGain.gain.setTargetAtTime(base + fear * 0.5, t, 1.5);
    if (fear > 0.25 && t >= this.heart.next) {
      const bpm = 60 + fear * 90;
      const out = this.out(undefined, 0.25 + fear * 0.7, 0.05);
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 120;
      lp.connect(out);
      this.tone(t, 55, 0.12, lp, "sine", 0.9);
      this.tone(t + 0.16, 48, 0.16, lp, "sine", 0.7);
      this.heart.next = t + 60 / bpm;
    }
  }

  footstep(run: boolean, crouch: boolean) {
    const c = this.ctx, t = c.currentTime;
    const vol = crouch ? 0.12 : run ? 0.45 : 0.28;
    this.stepSide ^= 1;
    // recorded steps: dedicated walk takes if present, else the run takes played softer & lower
    const walkId = this.has("footstep") ? "footstep" : "footstep_run";
    const played = run
      ? this.sample("footstep_run", undefined, 0.6, { jitter: 0.07, wet: 0.25 })
      : this.sample(walkId, undefined, crouch ? 0.18 : 0.38, {
          rate: walkId === "footstep" ? 1 : 0.9, jitter: 0.07, wet: 0.25,
        });
    if (played) {
      if (Math.random() < 0.12) this.sample("floor_creak", undefined, (crouch ? 0.2 : 0.45) * (0.6 + Math.random() * 0.4), { jitter: 0.08, wet: 0.3 });
      return;
    }
    const out = this.out(undefined, vol, 0.35);
    this.noise(t, 0.09, out, "lowpass", 380 + Math.random() * 200, 1).f.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    this.tone(t, 70 + Math.random() * 20, 0.08, out, "sine", 0.6);
    if (Math.random() < 0.12) {
      // old boards
      if (!this.sample("floor_creak", undefined, (crouch ? 0.2 : 0.45) * (0.6 + Math.random() * 0.4), { jitter: 0.08, wet: 0.3 }))
        this.creak(undefined, 0.25 + Math.random() * 0.25, 0.35);
    }
  }

  // ---------------------------------------------------------------- one-shots
  play(id: SoundId, pos?: Vec3, vol = 1) {
    // recorded takes first (same id as the event), with a few remaps / layered tweaks
    switch (id) {
      case "hinge": if (this.sample("creak", pos, vol * 0.7, { rate: 1.15 })) return; break;
      case "lid":
        if (this.sample("lid", pos, vol)) return;
        if (this.sample("creak", pos, vol * 0.75, { rate: 0.8 })) return void this.knock(pos, vol * 0.4, 1);
        break;
      case "stinger": if (this.sample("stinger", undefined, vol * 1.1, { jitter: 0.02, wet: 0.35 })) return; break;
      case "music_box": if (this.sample("music_box", pos, vol * 0.8, { jitter: 0.01, wet: 0.8 })) return; break;
      case "whisper": if (this.sample("whisper", pos, vol * 1.1, { jitter: 0.04, wet: 0.25 })) return; break;
      case "giggle": if (this.sample("giggle", pos, vol, { jitter: 0.03, wet: 0.8 })) return; break;
      default: if (this.sample(id, pos, vol)) return;
    }
    switch (id) {
      case "creak": return this.creak(pos, vol, 0.9 + Math.random() * 0.8);
      case "hinge": return this.creak(pos, vol * 0.8, 0.7);
      case "whisper": return this.whisper(pos, vol);
      case "knock": return this.knock(pos, vol, 3);
      case "door_rattle": return this.rattle(pos, vol);
      case "steps_above": return this.stepsAbove(pos, vol);
      case "giggle": return this.giggle(pos, vol);
      case "music_box": return this.musicBox(pos, vol);
      case "drawer": return this.slide(pos, vol, 0.5);
      case "lid": return (this.creak(pos, vol * 0.7, 0.6), this.knock(pos, vol * 0.4, 1));
      case "unlock": return this.clicks(pos, vol, 3);
      case "pickup": return this.clicks(pos, vol * 0.6, 2);
      case "bulb_pop": return this.pop(pos, vol);
      case "stinger": return this.stinger(vol);
      case "thud": return this.knock(pos, vol * 0.8, 1);
      case "breath": return this.breath(pos, vol);
    }
  }

  creak(pos: Vec3 | undefined, vol: number, dur: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(pos, vol * 0.5);
    // stick-slip friction: pulse train with wandering rate into resonant bandpasses
    const o = c.createOscillator();
    o.type = "sawtooth";
    const f0 = 30 + Math.random() * 40;
    o.frequency.setValueAtTime(f0, t);
    const steps = 8;
    for (let i = 1; i <= steps; i++) o.frequency.linearRampToValueAtTime(f0 * (0.6 + Math.random() * 1.3), t + (dur * i) / steps);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.08);
    g.gain.setValueAtTime(0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [f, q] of [[600 + Math.random() * 300, 12], [1400 + Math.random() * 600, 9], [2500, 6]]) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
      o.connect(bp).connect(g);
    }
    g.connect(out);
    o.start(t); o.stop(t + dur + 0.05);
  }

  whisper(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(pos, vol, 0.7);
    const syll = 5 + ((Math.random() * 6) | 0);
    let tt = t;
    for (let i = 0; i < syll; i++) {
      const d = 0.08 + Math.random() * 0.22;
      const g = c.createGain();
      this.env(g.gain, tt, 0.03, 0.5 + Math.random() * 0.4, d);
      g.connect(out);
      const n = this.noise(tt, d + 0.1, g, "bandpass", 1500 + Math.random() * 2500, 3 + Math.random() * 4);
      n.f.frequency.linearRampToValueAtTime(1200 + Math.random() * 3000, tt + d);
      tt += d + Math.random() * 0.12;
    }
  }

  knock(pos: Vec3 | undefined, vol: number, count: number) {
    const c = this.ctx, out = this.out(pos, vol, 0.6);
    for (let i = 0; i < count; i++) {
      const t = c.currentTime + i * (0.28 + Math.random() * 0.1);
      const o = this.tone(t, 95, 0.14, out, "sine", 0.9, 0.002);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
      const g = c.createGain();
      this.env(g.gain, t, 0.002, 0.5, 0.05);
      g.connect(out);
      this.noise(t, 0.08, g, "bandpass", 900, 1.5);
    }
  }

  rattle(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, out = this.out(pos, vol, 0.4);
    for (let i = 0; i < 7; i++) {
      const t = c.currentTime + i * 0.07 + Math.random() * 0.02;
      const g = c.createGain();
      this.env(g.gain, t, 0.002, 0.6, 0.06);
      g.connect(out);
      this.noise(t, 0.08, g, "bandpass", 2500 + Math.random() * 1500, 6);
      this.tone(t, 140, 0.05, out, "triangle", 0.3);
    }
  }

  stepsAbove(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, out = this.out(pos, vol, 0.8);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 250;
    lp.connect(out);
    const n = 4 + ((Math.random() * 5) | 0);
    const slow = 0.55 + Math.random() * 0.3;
    for (let i = 0; i < n; i++) {
      const t = c.currentTime + i * slow;
      this.tone(t, 60, 0.18, lp, "sine", 0.9, 0.004);
      const g = c.createGain();
      this.env(g.gain, t, 0.003, 0.4, 0.1);
      g.connect(lp);
      this.noise(t, 0.12, g, "lowpass", 300);
    }
  }

  giggle(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, out = this.out(pos, vol * 0.5, 0.9);
    const base = 650 + Math.random() * 150;
    for (let i = 0; i < 4; i++) {
      const t = c.currentTime + i * 0.14;
      const o = c.createOscillator(), g = c.createGain(), vib = c.createOscillator(), vg = c.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(base * (1 - i * 0.04), t);
      o.frequency.exponentialRampToValueAtTime(base * 0.75, t + 0.1);
      vib.frequency.value = 28; vg.gain.value = 40;
      vib.connect(vg).connect(o.frequency);
      const f = c.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 2;
      this.env(g.gain, t, 0.01, 0.6, 0.09);
      o.connect(f).connect(g).connect(out);
      const ng = c.createGain();
      this.env(ng.gain, t, 0.005, 0.25, 0.05);
      ng.connect(out);
      this.noise(t, 0.06, ng, "highpass", 3000); // breathy "h"
      o.start(t); vib.start(t); o.stop(t + 0.15); vib.stop(t + 0.15);
    }
  }

  musicBox(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, out = this.out(pos, vol * 0.35, 0.9);
    // minor lullaby that slows and detunes as the spring winds down
    const notes = [76, 79, 83, 81, 79, 76, 74, 76, 79, 76, 71, 72, 71];
    let t = c.currentTime, dt = 0.32;
    notes.forEach((n, i) => {
      const f = 440 * Math.pow(2, (n - 69) / 12) * (1 - i * 0.004);
      this.tone(t, f, 1.2, out, "sine", 0.5, 0.002);
      this.tone(t, f * 3.01, 0.4, out, "sine", 0.12, 0.002);
      this.tone(t, f * 5.2, 0.15, out, "sine", 0.05, 0.002);
      t += dt;
      dt *= 1.06;
    });
  }

  slide(pos: Vec3 | undefined, vol: number, dur: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(pos, vol * 0.6, 0.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    const n = this.noise(t, dur, g, "bandpass", 700, 2);
    n.f.frequency.linearRampToValueAtTime(400, t + dur);
    this.knock(pos, vol * 0.4, 1);
  }

  clicks(pos: Vec3 | undefined, vol: number, n: number) {
    const c = this.ctx, out = this.out(pos, vol * 0.6, 0.3);
    for (let i = 0; i < n; i++) {
      const t = c.currentTime + i * 0.11;
      this.tone(t, 2400 + Math.random() * 800, 0.04, out, "square", 0.25, 0.001);
      const g = c.createGain();
      this.env(g.gain, t, 0.001, 0.5, 0.03);
      g.connect(out);
      this.noise(t, 0.05, g, "highpass", 4000);
    }
  }

  pop(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(pos, vol, 0.6);
    const g = c.createGain();
    this.env(g.gain, t, 0.001, 1, 0.15);
    g.connect(out);
    this.noise(t, 0.2, g, "highpass", 1500);
    for (let i = 0; i < 6; i++) this.tone(t + 0.1 + Math.random() * 0.4, 4000 + Math.random() * 3000, 0.08, out, "sine", 0.15);
  }

  stinger(vol: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(undefined, vol, 0.5);
    // dissonant string-ish cluster + noise slam
    for (const f of [110, 116.5, 155.6, 164.8, 233, 246.9, 329.6, 349.2]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f * 1.02, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.97, t + 1.8);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 2.3);
    }
    const ng = c.createGain();
    this.env(ng.gain, t, 0.005, 1.0, 0.6);
    ng.connect(out);
    this.noise(t, 0.7, ng, "lowpass", 2500);
    const sub = this.tone(t, 50, 1.2, out, "sine", 1, 0.005);
    sub.frequency.exponentialRampToValueAtTime(28, t + 1);
  }

  breath(pos: Vec3 | undefined, vol: number) {
    const c = this.ctx, t = c.currentTime, out = this.out(pos, vol * 0.8, 0.3);
    for (const [st, d, f] of [[0, 1.1, 900], [1.3, 1.6, 600]] as const) {
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t + st);
      g.gain.exponentialRampToValueAtTime(0.6, t + st + d * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + st + d);
      g.connect(out);
      this.noise(t + st, d, g, "bandpass", f, 1.2);
    }
  }
}
