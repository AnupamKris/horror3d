"""Batch-generate game SFX with Sony Woosh-DFlow (run inside the woosh-sfx uv env).

  cd C:\\Users\\anupa\\Code\\woosh-sfx
  uv run python ..\\horror3d\\tools\\sfx\\gen_sfx.py [--only id1,id2] [--takes 6]

For each sound it generates `takes` candidates (batched), ranks them by CLAP-free heuristics
(loudness, onset, low silence), keeps the best `variants`, trims to `seconds`, normalizes, fades,
and writes WAV to horror3d/assets_src/sfx/<id>_<n>.wav. Loops get an equal-power crossfade seam.
Prints timing so we can see how it performs.
"""
import argparse
import json
import os
import sys
import time

import torch
import torchaudio

WOOSH = os.getcwd()
sys.path.insert(0, WOOSH)
from woosh.components.base import LoadConfig  # noqa: E402
from woosh.inference.flowmap_sampler import sample_euler  # noqa: E402
from woosh.model.flowmap_from_pretrained import FlowMapFromPretrained  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "assets_src", "sfx")
SR = 48000
FRAMES = 501  # latent frames (model native length)


def rms(x):
    return float(torch.sqrt(torch.mean(x ** 2)) + 1e-9)


def score(a: torch.Tensor) -> float:
    """higher = better: loud enough, not mostly silence, no clipping-dominated mush"""
    mono = a.mean(0)
    win = SR // 20
    n = mono.numel() // win
    env = mono[: n * win].reshape(n, win).pow(2).mean(1).sqrt()
    active = float((env > env.max() * 0.08).float().mean())
    peak = float(mono.abs().max())
    crest = peak / rms(mono)
    return active * 0.5 + min(crest, 12) / 12 * 0.3 + min(rms(mono) * 10, 1) * 0.2


def trim(a: torch.Tensor, seconds: float) -> torch.Tensor:
    """start at the first onset, cut to length, short fades, peak-normalize to -1 dBFS"""
    mono = a.mean(0).abs()
    thr = mono.max() * 0.05
    idx = int(torch.nonzero(mono > thr)[0]) if (mono > thr).any() else 0
    start = max(0, idx - int(0.01 * SR))
    n = int(seconds * SR)
    a = a[:, start : start + n]
    fi, fo = int(0.004 * SR), min(int(0.25 * SR), a.shape[1] // 3)
    a[:, :fi] *= torch.linspace(0, 1, fi)
    a[:, -fo:] *= torch.linspace(1, 0, fo) ** 2
    return a / a.abs().max().clamp(min=1e-6) * 0.89


def make_loop(a: torch.Tensor) -> torch.Tensor:
    """equal-power crossfade the tail into the head -> seamless loop"""
    xf = int(0.8 * SR)
    body, tail = a[:, :-xf].clone(), a[:, -xf:]
    t = torch.linspace(0, 1, xf)
    body[:, :xf] = body[:, :xf] * torch.sin(t * torch.pi / 2) + tail * torch.cos(t * torch.pi / 2)
    return body / body.abs().max().clamp(min=1e-6) * 0.7


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--takes", type=int, default=0, help="candidates per sound (default variants*2)")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--cfg", type=float, default=4.5)
    args = ap.parse_args()

    spec = json.load(open(os.path.join(HERE, "prompts.json"), encoding="utf-8"))
    jobs = [(s, False) for s in spec["sounds"]] + [(s, True) for s in spec["loops"]]
    if args.only:
        keep = set(args.only.split(","))
        jobs = [j for j in jobs if j[0]["id"] in keep]
    os.makedirs(OUT, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.perf_counter()
    ldm = FlowMapFromPretrained(LoadConfig(path="checkpoints/Woosh-DFlow")).eval().to(device)
    print(f"model loaded on {device} in {time.perf_counter() - t0:.1f}s", flush=True)
    if device == "cuda":
        print(f"vram after load: {torch.cuda.memory_allocated() / 2**30:.2f} GB", flush=True)

    total_audio = 0.0
    tg = time.perf_counter()
    for s, is_loop in jobs:
        takes = args.takes or max(2, s["variants"] * 2)
        noise = torch.randn(takes, 128, FRAMES).to(device)
        cond = ldm.get_cond({"audio": None, "description": [s["prompt"]] * takes}, no_dropout=True, device=device)
        t1 = time.perf_counter()
        with torch.inference_mode():
            x = sample_euler(model=ldm, noise=noise, cond=cond, num_steps=args.steps,
                             renoise=[0, 0.5, 0.5, 0.3][: args.steps] + [0.3] * max(0, args.steps - 4), cfg=args.cfg)
            audio = ldm.autoencoder.inverse(x).float().cpu()
        if device == "cuda":
            torch.cuda.synchronize()
        dt = time.perf_counter() - t1
        total_audio += audio.shape[0] * audio.shape[-1] / SR
        ranked = sorted(range(takes), key=lambda i: -score(audio[i]))
        for k, i in enumerate(ranked[: s["variants"]]):
            a = audio[i]
            a = make_loop(a) if is_loop else trim(a, s["seconds"])
            path = os.path.join(OUT, f"{s['id']}_{k}.wav")
            torchaudio.save(path, a, SR)
        print(f"{s['id']:12s} {takes} takes, {audio.shape[-1] / SR:.1f}s each, {dt:.2f}s  -> kept {s['variants']}", flush=True)

    wall = time.perf_counter() - tg
    print(f"\nDONE: {total_audio:.0f}s of audio generated in {wall:.1f}s ({total_audio / wall:.1f}x realtime)")
    if device == "cuda":
        print(f"peak vram: {torch.cuda.max_memory_allocated() / 2**30:.2f} GB")


if __name__ == "__main__":
    main()
