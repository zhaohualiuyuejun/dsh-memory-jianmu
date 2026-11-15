# -*- coding: utf-8 -*-
"""layout-blades.py —— V10 布局：星云旋臂（每个主题一条悬臂，中心留主干）
只读：$JIANMU_STARMAP_OUT/starmap-<p>.bin / stats-<p>.json（V8 原样）
只写：$JIANMU_STARMAP_OUT/starmap-<p>-blade.bin / blades-<p>.json
0 网络、0 LLM、numpy
"""
import json, os, math, sys
import numpy as np

OUT = os.environ.get("JIANMU_STARMAP_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
FLOATS = 7


def build(p):
    stats = json.load(open(os.path.join(OUT, f"stats-{p}.json"), encoding="utf-8"))
    raw = np.fromfile(os.path.join(OUT, f"starmap-{p}.bin"), dtype=np.float32).reshape(-1, FLOATS)
    n, k, H = len(raw), stats["k"], stats["tree"]["height"]
    by_id = {b["id"]: b for b in stats["branches"]}
    # V19：所有旋臂统一外径 → 俯视时末端落在同一个标准圆上（原来是各枝 b["r"] 长短不齐）
    R_EDGE = max(float(b["r"]) for b in stats["branches"])
    out = raw.copy()
    params = []

    for j in range(k):
        idx = np.where(raw[:, 5].astype(int) == j)[0]
        b = by_id.get(j)
        if b is None or len(idx) == 0:
            continue
        tp = b["bandIndex"] / max(1, k - 1)          # 0 = 上/小，1 = 下/大
        y0, r1 = float(b["y"]), float(b["r"])         # 接在树干上的高度 / 刀片长度
        r0 = 2.4                                      # 从树干表面长出来
        theta0 = (b["bandIndex"] * 2.399963229728653) % (2 * math.pi)  # 黄金角均匀铺开
        sweep = -(1.15 + 0.85 * tp)                   # 负号 = 拖尾；数值收小 → 旋臂更张开、铺得更开
        drop = 12.0 + 26.0 * tp                       # 悬臂向外伸展时向下旋（主视图往下垂）
        drop = min(drop, max(3.0, y0 - 1.0))          # 别垂到地面以下
        width = 3.2 + 4.2 * tp                        # 下大上小（旋臂宽度）

        subs = raw[idx, 6].astype(int)
        nsub = int(subs.max()) + 1
        rng = np.random.default_rng(9000 + j)
        wsub = width * 0.90                            # 子簇合并成同一片刀（只用来保持点序）

        for s in range(nsub):
            sidx = idx[subs == s]
            if len(sidx) == 0:
                continue
            mid = (nsub - 1) * 0.5
            dphi = (s - mid) * 0.012                  # 子簇只错开一丝，合成一片刀
            sw = sweep + (s - mid) * 0.012
            ri = drop * (1.0 + 0.012 * (s - mid))
            for gi in sidx:
                f = 0.035 + 0.965 * rng.random() ** 0.92
                ang = theta0 + dphi + sw * f ** 1.18
                rad = r0 + (r1 - r0) * f
                y = y0 - ri * f ** 1.35
                cx, cz = math.cos(ang) * rad, math.sin(ang) * rad
                # 水平面切线 → 法线，用于刀片厚度方向
                f2 = f + 0.002
                a2 = theta0 + dphi + sw * f2 ** 1.18
                r2 = r0 + (r1 - r0) * f2
                tx, tz = math.cos(a2) * r2 - cx, math.sin(a2) * r2 - cz
                L = math.hypot(tx, tz) or 1.0
                nx, nz = -tz / L, tx / L
                w = wsub * (0.30 + 0.70 * math.sin(math.pi * f) ** 0.55) * (1.0 - 0.30 * f ** 4)
                u = float(np.clip(rng.normal(0, w * 0.38), -w * 0.50, w * 0.50))
                v = float(rng.normal(0, 0.16 + 0.20 * tp))
                out[gi, 0] = cx + nx * u
                out[gi, 1] = y + v
                out[gi, 2] = cz + nz * u

        params.append({"id": j, "theta0": round(theta0, 4), "sweep": round(sweep, 4),
                       "drop": round(drop, 3), "r0": r0, "r1": round(r1, 3),
                       "width": round(width, 3), "nsub": nsub, "y": round(y0, 3)})

    binp = os.path.join(OUT, f"starmap-{p}-blade.bin")
    with open(binp, "wb") as f:
        f.write(out.tobytes())
    with open(os.path.join(OUT, f"blades-{p}.json"), "w", encoding="utf-8") as f:
        json.dump({"persona": p, "mode": "blade", "height": H, "branches": params},
                  f, ensure_ascii=False, indent=1)
    print(f"{p}: {n} 点 / {k} 刀 → {binp} ({os.path.getsize(binp)/1048576:.1f}MB)")


def discover_personas():
    """默认 = OUT 里已有 stats-<p>.json 的人格（只布局 build-starmap.py 真产出过的人）。
    不再回退到 alice/bob 测试夹具。"""
    try:
        names = os.listdir(OUT)
    except OSError:
        return []
    return sorted(f[len("stats-"):-len(".json")] for f in names
                  if f.startswith("stats-") and f.endswith(".json") and len(f) > len("stats-.json"))

if __name__ == "__main__":
    personas = sys.argv[1:] or discover_personas()
    if not personas:
        print(f"[starmap] 没有可布局的人格：{OUT} 下没有 stats-*.json", file=sys.stderr)
        sys.exit(1)
    built = 0
    for p in personas:
        stats = os.path.join(OUT, f"stats-{p}.json")
        binp = os.path.join(OUT, f"starmap-{p}.bin")
        if not (os.path.isfile(stats) and os.path.isfile(binp)):
            print(f"[starmap] 跳过 {p}：缺 {stats} 或 {binp}", file=sys.stderr)
            continue
        build(p)
        built += 1
    if built == 0:
        sys.exit(1)
