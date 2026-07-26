#!/usr/bin/env python3
import json, glob, re
from collections import defaultdict

base = "/var/lib/docker/volumes/rx06uazamupj1w98pvl2b1d9-engine-runs/_data/instances/live-midas-carry-v1_btc5m_primary/execution-audit"
files = sorted(glob.glob(base + "/engine-*.jsonl"))
settlements, submits, terminals, enter = [], [], [], {}
for f in files:
    for line in open(f, errors="replace"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "position_settled":
            settlements.append(e)
        elif t == "order_submit":
            submits.append(e)
        elif t == "order_terminal":
            terminals.append(e)
        elif t == "decision":
            d = e.get("diagnostics") or {}
            entry = d.get("entry") or {}
            if entry.get("ok") and e.get("intentCount", 0) > 0 and not d.get("inPosition"):
                g = entry.get("gates") or {}
                dist_g = g.get("distance")
                detail = dist_g.get("detail") if isinstance(dist_g, dict) else None
                dist = None
                if detail:
                    m = re.search(r"([0-9]+\.[0-9]+)", detail)
                    if m:
                        dist = float(m.group(1))
                enter[e.get("marketId")] = {
                    "ask": entry.get("ask"),
                    "dist": dist,
                    "secs": d.get("secsLeft"),
                    "z": d.get("z"),
                }

uniq = {}
for s in settlements:
    uniq[(s.get("fromMarketId"), round(float(s.get("pnlDelta") or 0), 6), s.get("settlementPrice"))] = s
S = list(uniq.values())

print("SUBMIT", {k: sum(1 for x in submits if x.get("kind") == k) for k in ("ENTER", "EXIT", "REVERSE")})
print("FILL", {k: sum(1 for x in terminals if x.get("kind") == k and x.get("filled")) for k in ("ENTER", "EXIT", "REVERSE")})
base_pnl = sum(float(s.get("pnlDelta") or 0) for s in S)
print("base", round(base_pnl, 3), "n", len(S))

for L in (0.8, 1.0, 1.2, 1.5, 2.0):
    rp = 0.0
    for s in S:
        qty = float(s.get("qty") or 0)
        ask = float(s.get("avgPrice") or 0)
        if qty > 0 and ask > 0:
            rp += float(s.get("pnlDelta") or 0) * ((L / ask) / qty)
    print("RP", L, round(rp, 3))

for mx in (0.94, 0.90, 0.85, 0.82, 0.80, 0.75):
    arr = [s for s in S if float(s.get("avgPrice") or 0) <= mx]
    print("maxAsk", mx, round(sum(float(s.get("pnlDelta") or 0) for s in arr), 3), "n", len(arr))

for dmin in (5, 8, 10, 12, 15, 20):
    p = 0.0
    sk = 0
    for s in S:
        ask = float(s.get("avgPrice") or 0)
        dist = (enter.get(s.get("fromMarketId")) or {}).get("dist")
        if ask >= 0.82 and dist is not None and dist < dmin:
            sk += 1
            continue
        p += float(s.get("pnlDelta") or 0)
    print("tierMinDist", dmin, round(p, 3), "sk", sk)

for R in (2, 3, 4, 5, 6):
    p = 0.0
    sk = 0
    for s in S:
        ask = float(s.get("avgPrice") or 0)
        if ask < 1 and ask / (1 - ask) > R:
            sk += 1
            continue
        p += float(s.get("pnlDelta") or 0)
    print("maxHarvestR", R, "maxAsk~", round(R / (1 + R), 3), round(p, 3), "sk", sk)

for c in (0.5, 0.8, 1.0, 1.2, 1.5):
    print("clip", c, round(sum(max(float(s.get("pnlDelta") or 0), -c) for s in S), 3))

print("keep_ask_le_0.82", round(sum(float(s.get("pnlDelta") or 0) for s in S if float(s.get("avgPrice") or 0) <= 0.82), 3))
print(
    "inverse_tier_0.5",
    round(sum(float(s.get("pnlDelta") or 0) * (0.5 if float(s.get("avgPrice") or 0) >= 0.82 else 1) for s in S), 3),
)

hy = 0.0
for s in S:
    ask = float(s.get("avgPrice") or 0)
    qty = float(s.get("qty") or 0)
    val = float(s.get("pnlDelta") or 0)
    if ask >= 0.82 and qty > 0 and ask > 0:
        hy += val * ((1.0 / ask) / qty)
    else:
        hy += val
print("RP1_only_highask", round(hy, 3))

# best practical: maxAsk 0.85 + inverse tier 0.5 on remaining high + clip conceptually via RP
combo = 0.0
n = 0
for s in S:
    ask = float(s.get("avgPrice") or 0)
    qty = float(s.get("qty") or 0)
    val = float(s.get("pnlDelta") or 0)
    if ask > 0.85:
        continue
    if ask >= 0.82 and qty > 0:
        val = val * ((1.0 / ask) / qty)
    combo += val
    n += 1
print("combo_maxAsk085_RP1high", round(combo, 3), "n", n)

print("BAND_EDGE")
bands = defaultdict(list)
for s in S:
    ask = float(s.get("avgPrice") or 0)
    if ask >= 0.90:
        b = "0.90+"
    elif ask >= 0.82:
        b = "0.82-0.89"
    elif ask >= 0.70:
        b = "0.70-0.81"
    elif ask >= 0.55:
        b = "0.55-0.69"
    else:
        b = "<0.55"
    bands[b].append((ask, float(s.get("pnlDelta") or 0)))
for b, arr in bands.items():
    wr = sum(1 for a, p in arr if p > 0) / max(1, sum(1 for a, p in arr if abs(p) > 1e-12))
    avg_ask = sum(a for a, _ in arr) / len(arr)
    print(
        b,
        "n",
        len(arr),
        "wr",
        round(wr, 3),
        "avgAsk",
        round(avg_ask, 3),
        "edge_pp",
        round((wr - avg_ask) * 100, 2),
        "pnl",
        round(sum(p for _, p in arr), 3),
    )
