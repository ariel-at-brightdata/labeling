"""Fail when a channel_id appears twice in scored_csv/ — inside one file or across files (one home per channel)."""
import csv, glob, sys
from collections import defaultdict

seen = defaultdict(list); bad = 0
for path in sorted(glob.glob("scored_csv/*.csv")):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        ids = [(r.get("channel_id") or "").strip() for r in csv.DictReader(fh)]
    ids = [i for i in ids if i]
    dup = len(ids) - len(set(ids))
    if dup:
        print(f"DUPLICATE ROWS: {path} has {dup} repeated channel_id values"); bad += dup
    for i in set(ids):
        seen[i].append(path)
across = {i: p for i, p in seen.items() if len(p) > 1}
for i, p in sorted(across.items()):
    print(f"CROSS-FILE: {i} in {', '.join(p)}")
bad += len(across)
print(f"checked {len(seen):,} channels in {len(set(sum(seen.values(), [])))} files — {bad} problems")
sys.exit(1 if bad else 0)
