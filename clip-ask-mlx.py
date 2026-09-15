#!/usr/bin/env python3
"""Ask a local MLX vision model a yes/no question about each clip, as video.

    python3 clip-ask-mlx.py --dir clipmp4 \
        --q "Do these show human hands manipulating or fixing a watch?"

Unlike the Ollama path, the model is given the mp4 itself, so it sees the clip
as a video rather than as a handful of stills. Everything runs locally.
"""
import argparse, json, pathlib, sys, time

MODEL = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--q", required=True)
ap.add_argument("--model", default=MODEL)
ap.add_argument("--fps", type=float, default=8.0)
ap.add_argument("--limit", type=int, default=10)
ap.add_argument("--out", default="clip-ask-mlx-results.json")
args = ap.parse_args()

try:
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
except ImportError:
    sys.exit("mlx-vlm is not installed:  pip3 install mlx-vlm")

clips = sorted(p for p in pathlib.Path(args.dir).iterdir() if p.suffix.lower() == ".mp4")[: args.limit]
if not clips:
    sys.exit(f"no .mp4 files in {args.dir} -- run ./webp2clips.sh first")

print(f"loading {args.model} (first run downloads it) ...", flush=True)
model, processor = load(args.model)
config = model.config
print(f"{len(clips)} clip(s), {args.fps} fps\n")

instruction = (
    args.q
    + "\n\nAnswer with JSON only, exactly: "
      '{"answer": "yes" or "no", "confidence": 0.0-1.0, "reason": "one short sentence"}'
)

results, yes = [], 0
for i, clip in enumerate(clips, 1):
    prompt = apply_chat_template(processor, config, instruction, num_videos=1)
    t0 = time.time()
    out = generate(model, processor, prompt, video=[str(clip)],
                   max_tokens=120, temperature=0.0, verbose=False)
    text = out if isinstance(out, str) else getattr(out, "text", str(out))
    secs = time.time() - t0

    try:
        start, end = text.index("{"), text.rindex("}") + 1
        parsed = json.loads(text[start:end])
    except Exception:
        parsed = {"answer": "?", "confidence": 0.0, "reason": text.strip()[:120]}

    parsed["clip"] = clip.name
    results.append(parsed)
    yes += parsed.get("answer") == "yes"
    print(f"  [{i}] {str(parsed.get('answer','?')).upper():3} "
          f"({float(parsed.get('confidence',0)):.2f}, {secs:.1f}s)  {clip.stem[:56]}")
    print(f"      {parsed.get('reason','')}")

print(f"\n=== {yes} yes / {len(results) - yes} no, of {len(results)} ===")
pathlib.Path(args.out).write_text(
    json.dumps({"dir": args.dir, "question": args.q, "model": args.model,
                "fps": args.fps, "results": results}, indent=2) + "\n")
print(f"written to {args.out}")
