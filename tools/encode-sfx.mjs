// Encode raw ElevenLabs WAV downloads in assets/ -> public/sfx/<name>_<n>.ogg (Opus) + manifest.json
// - maps files to game sound ids by filename prefix (the prompt text ElevenLabs uses as the filename)
// - peak-normalizes every take, one-shots -> mono (HRTF panner needs mono), loops -> stereo
// - loops: tail crossfaded into head so they repeat seamlessly
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const SRC = "assets";
const DST = "public/sfx";

/** filename prefix -> [sound id, kind, target peak dB] */
const MAP = [
  ["Breathy_little_girl", "whisper", "oneshot", -3],
  ["Dark_ambient_drone", "amb_house", "loop", -6],
  ["Faint_creepy_little", "giggle", "oneshot", -3],
  ["Long_slow_creak", "creak", "oneshot", -3],
  ["Old_broken_music_box", "music_box", "oneshot", -4],
  ["Single_old_wooden_fl", "floor_creak", "oneshot", -4],
  ["Slow_raspy_breathing", "breath", "oneshot", -3],
  ["Sudden_violent_horro", "stinger", "oneshot", -1],
  // future downloads (prompts from the sound brief)
  ["Cold_night_wind", "amb_wind", "loop", -8],
  ["Quiet_room_tone", "amb_roomtone", "loop", -10],
  ["Old_wooden_drawer", "drawer", "oneshot", -3],
  ["Heavy_wooden_trunk", "lid", "oneshot", -3],
  ["Old_iron_skeleton", "unlock", "oneshot", -3],
  ["Someone_yanking", "door_rattle", "oneshot", -3],
  ["Picking_up_a_small", "pickup", "oneshot", -6],
  ["Incandescent_light", "bulb_pop", "oneshot", -2],
  ["Three_slow_heavy", "knock", "oneshot", -3],
  ["Slow_heavy_footsteps", "steps_above", "oneshot", -3],
  ["Dull_soft_thud", "thud", "oneshot", -4],
  ["Single_footstep", "footstep", "oneshot", -4],
  ["Single_hurried", "footstep_run", "oneshot", -4],
];

const LOOP_XFADE = 2.0;

function probe(file) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const max = Number(/max_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? 0);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  const seconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0;
  return { max, seconds };
}

fs.mkdirSync(DST, { recursive: true });
for (const f of fs.readdirSync(DST)) if (f.endsWith(".ogg")) fs.rmSync(path.join(DST, f));

const manifest = {};
const files = fs.readdirSync(SRC).filter((f) => /\.(wav|mp3|ogg|flac)$/i.test(f)).sort();
let bytes = 0;
for (const f of files) {
  const m = MAP.find(([prefix]) => f.startsWith(prefix));
  if (!m) { console.warn("unmapped:", f); continue; }
  const [, id, kind, peak] = m;
  const src = path.join(SRC, f);
  const n = (manifest[id]?.count ?? 0) + 1;
  manifest[id] = { count: n, loop: kind === "loop" };
  const out = path.join(DST, `${id}_${n}.ogg`);
  const { max, seconds } = probe(src);
  const gain = (peak - max).toFixed(2);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", src];
  if (kind === "loop") args.push("-i", src); // second copy of the input for the head (asplit+atrim stalls)
  if (kind === "loop") {
    // body = [H, end], head = [0, H] with H = X + 0.1 (acrossfade needs both inputs longer than the fade).
    // output = body, its last X crossfaded with head[0, X], then head[X, H] -> wraps exactly to body start (H)
    const X = Math.min(LOOP_XFADE, seconds / 4);
    const H = X + 0.1;
    args.push("-filter_complex",
      `[0:a]atrim=start=${H},asetpts=PTS-STARTPTS[body];[1:a]atrim=0:${H},asetpts=PTS-STARTPTS[head];` +
      `[body][head]acrossfade=d=${X}:c1=tri:c2=tri,volume=${gain}dB[out]`, "-map", "[out]",
      "-ac", "2", "-c:a", "libopus", "-b:a", "80k");
  } else {
    // trim trailing silence, normalize, mono
    args.push("-af", `volume=${gain}dB,areverse,silenceremove=start_periods=1:start_threshold=-60dB,areverse`,
      "-ac", "1", "-c:a", "libopus", "-b:a", "48k");
  }
  args.push("-ar", "48000", out);
  execFileSync(ffmpeg, args);
  const size = fs.statSync(out).size;
  bytes += size;
  console.log(`${f.slice(0, 26).padEnd(27)} -> ${path.basename(out).padEnd(20)} ${(size / 1024).toFixed(1).padStart(6)} KB  gain ${gain} dB`);
}
fs.writeFileSync(path.join(DST, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`total ${(bytes / 1024).toFixed(0)} KB, ${Object.keys(manifest).length} sounds`);
