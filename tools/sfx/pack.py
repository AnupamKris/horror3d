"""Pack generated WAVs (assets_src/sfx) into web-ready MP3 + manifest (public/sfx).

  uv run --with soundfile --with numpy tools/sfx/pack.py

One-shots -> mono (they are HRTF-panned in game). Loops -> stereo. A gentle downward expander
removes the model's hiss floor between events. manifest.json = { id: variantCount }.
"""
import glob
import json
import os
import re

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "assets_src", "sfx")
DST = os.path.join(HERE, "..", "..", "public", "sfx")
LOOPS = {"amb_drone", "amb_wind"}


def expander(x: np.ndarray, sr: int, floor_db=-42.0, ratio=2.5) -> np.ndarray:
    """attenuate quiet parts below floor_db (relative to peak) with a smoothed gain curve"""
    mono = np.abs(x if x.ndim == 1 else x.mean(1))
    win = max(1, sr // 200)  # 5 ms
    env = np.sqrt(np.convolve(mono ** 2, np.ones(win) / win, mode="same")) + 1e-9
    db = 20 * np.log10(env / (env.max() + 1e-9))
    gain_db = np.where(db < floor_db, (db - floor_db) * (ratio - 1), 0.0)
    # smooth: fast attack, slow release
    g = 10 ** (gain_db / 20)
    out = np.empty_like(g)
    a, r, prev = 0.3, 0.002, 1.0
    for i, v in enumerate(g):
        prev = prev + (v - prev) * (a if v > prev else r)
        out[i] = prev
    return x * (out if x.ndim == 1 else out[:, None])


def main():
    os.makedirs(DST, exist_ok=True)
    manifest: dict[str, int] = {}
    total = 0
    for f in sorted(glob.glob(os.path.join(SRC, "*.wav"))):
        name = os.path.basename(f)[:-4]
        sid = re.sub(r"_\d+$", "", name)
        x, sr = sf.read(f, dtype="float32")
        if sid not in LOOPS:
            x = x.mean(1) if x.ndim > 1 else x
            x = expander(x, sr)
            x = x / (np.abs(x).max() + 1e-9) * 0.89
        out = os.path.join(DST, name + ".mp3")
        sf.write(out, x, sr, format="MP3", compression_level=0.45)
        manifest[sid] = manifest.get(sid, 0) + 1
        total += os.path.getsize(out)
    with open(os.path.join(DST, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"{sum(manifest.values())} files, {len(manifest)} sounds, {total / 1024:.0f} KB total")


if __name__ == "__main__":
    main()
