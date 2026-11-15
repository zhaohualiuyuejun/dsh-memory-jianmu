# -*- coding: utf-8 -*-
"""build-starmap.py —— 年轮 claim → 3D 星图数据（V1）
只读：<dataRoot>/year/<persona>/claims.jsonl 与 claim-vec 缓存
只写：$JIANMU_STARMAP_OUT（默认脚本旁 data/）
0 网络、0 LLM、0 新依赖（numpy）
"""
import json, os, sys, hashlib, math
import numpy as np
from pathlib import Path

HOME = os.path.expanduser("~")
DATA_ROOT = os.environ.get("JIANMU_DATA_ROOT") or str(Path(HOME) / ".dsh" / "memory-jianmu")
VEC_DIR = os.environ.get("JIANMU_CLAIM_VEC") or str(Path(HOME) / ".dsh" / "session-recall" / "claim-vec")
OUT = os.environ.get("JIANMU_STARMAP_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DIM = 4096

# ── 枝数公式：数据量决定，不是固定 25 ─────────────────────────────
def branch_count(n):
    return int(max(8, min(30, round(math.sqrt(n / 10.0)))))

# ── 读 claim（latest-wins，保留首次出现顺序）──────────────────────
def load_claims(persona):
    file = os.path.join(DATA_ROOT, "year", persona, "claims.jsonl")
    latest, order = {}, []
    for line in open(file, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        c = json.loads(line)
        cid = c.get("claimId")
        if not cid:
            continue
        if cid not in latest:
            order.append(cid)
        latest[cid] = c
    out = []
    for cid in order:
        c = latest[cid]
        if c.get("status") == "active" and c.get("derivedFrom"):
            out.append(c)
    return out

sha1 = lambda s: hashlib.sha1(str(s).encode()).hexdigest()

def load_vecs(persona=None):
    """所有 claim-vec 桶的并集：文本 sha1 -> 向量行"""
    key2vec = {}
    for fn in sorted(os.listdir(VEC_DIR)):
        if not fn.endswith(".f32.json"):
            continue
        binp = os.path.join(VEC_DIR, fn[:-5])
        if not os.path.exists(binp):
            continue
        try:
            m = json.load(open(os.path.join(VEC_DIR, fn), encoding="utf-8"))
        except Exception:
            continue
        if m.get("dim") != DIM or not isinstance(m.get("keys"), list):
            continue
        arr = np.asarray(np.memmap(binp, dtype=np.float32, mode="r")).reshape(-1, DIM)
        if arr.shape[0] != len(m["keys"]):
            continue
        for i, k in enumerate(m["keys"]):
            if k not in key2vec:
                key2vec[k] = arr[i].copy()
        del arr
    return key2vec

def text_of(c):
    return (str(c.get("title") or "") + "\n" + str(c.get("body") or ""))[:1200]

# ── 球面 k-means（与判定实验同算法）──────────────────────────────
def kmeans(X, k, iters=30, seed=42):
    rng = np.random.default_rng(seed)
    n = X.shape[0]
    cen = np.empty((k, X.shape[1]), np.float32)
    cen[0] = X[rng.integers(n)]
    best = X @ cen[0]
    for j in range(1, k):
        p = np.clip(1 - best, 0, None) ** 2
        s = p.sum()
        cen[j] = X[rng.integers(n)] if s <= 0 else X[rng.choice(n, p=p / s)]
        best = np.maximum(best, X @ cen[j])
    lab = None
    for _ in range(iters):
        lab = (X @ cen.T).argmax(1)
        for j in range(k):
            m = lab == j
            if m.any():
                v = X[m].sum(0); nv = np.linalg.norm(v)
                if nv > 0:
                    cen[j] = v / nv
    return (X @ cen.T).argmax(1), cen

def pca_1d(Y):
    """返回 [-1,1] 的第一主成分投影（语义顺序）"""
    if len(Y) < 2:
        return np.zeros(len(Y), np.float32)
    Z = Y - Y.mean(0)
    try:
        u, s, vt = np.linalg.svd(Z, full_matrices=False)
        p = Z @ vt[0]
    except Exception:
        p = np.zeros(len(Y), np.float32)
    rng = p.max() - p.min()
    return (p / rng).astype(np.float32) if rng > 0 else np.zeros(len(Y), np.float32)

def build(persona):
    claims = load_claims(persona)
    kv = load_vecs()
    rows, sel = [], []
    miss = 0
    for c in claims:
        hit = kv.get(sha1(text_of(c))[:20])
        if hit is None:
            miss += 1
            continue
        rows.append(hit); sel.append(c)
    X = np.asarray(rows, dtype=np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    N = len(sel)
    k = branch_count(N)
    print(f"{persona}: claims={len(claims)} 有向量={N} 缺={miss} → 枝数 k={k}")

    lab, cen = kmeans(X, k, seed=42)
    sizes = np.bincount(lab, minlength=k)
    # 稳定编号：大枝在前
    order = sorted(range(k), key=lambda j: (-sizes[j], j))
    remap = {old: new for new, old in enumerate(order)}
    lab = np.array([remap[int(j)] for j in lab])
    sizes = np.bincount(lab, minlength=k)   # 重编号后重算（否则下面按新 id 取到旧尺寸）

    # 布局参数：星带塔（25 条星带，上小下大）
    H = 88.0                     # 主干高（加高：俯视时层与层更容易分辨）
    Y_TOP, Y_BOT = 0.94, 0.05    # 最高/最低星带的相对高度
    R_MIN, R_MAX = 9.0, 64.0     # 星带半径范围（放大：俯视时同心环拉得更开）
    branch_info = []
    positions = np.zeros((N, 3), np.float32)
    subs = np.zeros(N, np.int32)
    confs = np.zeros(N, np.float32)
    times = np.zeros(N, np.float64)

    # 星带顺序：条数少的在上、多的在下（上小下大）
    band_order = sorted(range(k), key=lambda j: (int(sizes[j]), j))
    band_pos = {j: i for i, j in enumerate(band_order)}

    for j in range(k):
        idx = np.where(lab == j)[0]
        n = len(idx)
        if n == 0:
            continue
        nsub = int(max(2, min(6, round(math.sqrt(n / 60.0)))))
        sub_lab = np.zeros(n, np.int32)
        if nsub >= 2 and n >= nsub * 3:
            sl, _ = kmeans(X[idx], nsub, seed=100 + j)
            ss = np.bincount(sl, minlength=nsub)
            so = sorted(range(nsub), key=lambda x: (-ss[x], x))
            srm = {o: ni for ni, o in enumerate(so)}
            sub_lab = np.array([srm[int(x)] for x in sl], np.int32)
        subs[idx] = sub_lab

        bi = band_pos[j]
        tp = bi / max(1, k - 1)                    # 0 = 最上最小，1 = 最下最大
        y0 = H * (Y_TOP - (Y_TOP - Y_BOT) * tp)
        R = R_MIN + (R_MAX - R_MIN) * (tp ** 0.85)
        thick = 0.35 + 0.55 * tp                   # 星带越下越厚（整体收薄，环与环之间留空）
        # 星带相位：每条错开一点，避免上下对齐成栅栏
        phase = bi * 0.61803398875 * math.tau
        nsubs = int(sub_lab.max()) + 1 if n else 1
        seg = math.tau / max(1, nsubs)

        sub_arcs = []
        for s in range(nsubs):
            sidx = idx[sub_lab == s]
            if len(sidx) == 0:
                continue
            proj = pca_1d(X[sidx])
            rank_sorted = np.argsort(np.argsort(proj))
            m = len(sidx)
            gap = 0.06 * seg
            a0 = phase + s * seg + gap / 2
            a1 = phase + (s + 1) * seg - gap / 2
            for order_i, gi in enumerate(sidx):
                # 子簇内按 PCA 排序沿弧线排布（有语义顺序）
                f = (rank_sorted[order_i] + 0.5) / m
                ang = a0 + (a1 - a0) * f
                # 星带自身的起伏 + 厚度抖动
                wave = 0.30 * thick * math.sin(ang * 1.0 + bi * 0.9)
                rad = R + np.random.default_rng(abs(hash((persona, j, s, int(gi)))) % (2**32)).normal(0, thick * 0.55)
                yy = y0 + wave + np.random.default_rng(abs(hash((persona, 'y', j, s, int(gi)))) % (2**32)).normal(0, 0.28)
                positions[gi] = np.array([math.cos(ang) * rad, yy, math.sin(ang) * rad], np.float32)
            sub_arcs.append({"s": s, "a0": round(a0, 4), "a1": round(a1, 4), "n": int(m)})

        branch_info.append({"id": j, "n": n, "subBranches": nsubs,
                            "y": round(y0, 3), "r": round(R, 3), "thick": round(thick, 3),
                            "bandIndex": bi, "subArcs": sub_arcs})

    # 时间与置信
    for i, c in enumerate(sel):
        a = (c.get("derivedFrom") or [{}])[0]
        times[i] = float(a.get("t") or 0)
        conf = c.get("confidence")
        confs[i] = float(conf) if isinstance(conf, (int, float)) else 0.6
    t_min, t_max = float(times.min()), float(times.max())

    # 自动名（簇内高频 hint）
    auto = {}
    for j in range(k):
        idx = np.where(lab == j)[0]
        if len(idx) == 0:
            auto[j] = f"簇{j}"
            continue
        from collections import Counter
        hs = Counter(str(sel[i].get("topicHint") or "").strip() for i in idx)
        top = [h for h, _ in hs.most_common(2) if h]
        auto[j] = " · ".join(top) if top else f"簇{j}"

    # 名称覆盖（按人格分文件，避免两棵树编号串味）
    ov_file = os.path.join(OUT, f"name-overrides-{persona}.json")
    ov = {}
    if os.path.exists(ov_file):
        try:
            ov = json.load(open(ov_file, encoding="utf-8"))
        except Exception:
            ov = {}
    names = {j: ov.get(str(j), auto[j]) for j in range(k)}

    # 输出
    os.makedirs(OUT, exist_ok=True)
    binp = os.path.join(OUT, f"starmap-{persona}.bin")
    with open(binp, "wb") as f:
        for i in range(N):
            f.write(np.array([*positions[i], confs[i], times[i], float(lab[i]), float(subs[i])], dtype=np.float32).tobytes())

    meta = []
    for i, c in enumerate(sel):
        a = (c.get("derivedFrom") or [{}])[0]
        meta.append({
            "id": c.get("claimId"),
            "title": c.get("title") or "",
            "topic": c.get("topicHint") or "",
            "branch": int(lab[i]),
            "sub": int(subs[i]),
            "kind": c.get("kind") or "",
            "epistemic": c.get("epistemic") or "",
            "conf": round(float(confs[i]), 3),
            "t": int(times[i]),
            "body": c.get("body") or "",
            "quote": a.get("quote") or "",
            "chunkId": a.get("chunkId") or "",
            "persona": persona,
        })
    with open(os.path.join(OUT, f"starmap-{persona}.meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)

    # 着色大区（按人格分文件；缺省归"其他"）
    rfile = os.path.join(OUT, f"regions-{persona}.json")
    regions = {}
    if os.path.exists(rfile):
        try:
            regions = json.load(open(rfile, encoding="utf-8"))
        except Exception:
            regions = {}

    stats = {
        "builtAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "persona": persona,
        "claims": len(claims), "points": N, "missingVectors": miss,
        "k": k, "kFormula": "clamp(round(sqrt(N/10)),8,30)",
        "tRange": [int(t_min), int(t_max)],
        "layout": {"mode": "bands", "yTop": Y_TOP, "yBot": Y_BOT, "rMin": R_MIN, "rMax": R_MAX},
        "tree": {"height": H},
        "branches": [{"id": b["id"], "name": names[b["id"]], "n": b["n"],
                      "subBranches": b["subBranches"],
                      "region": regions.get(str(b["id"]), "其他"),
                      "y": b["y"], "r": b["r"], "thick": b["thick"],
                      "bandIndex": b["bandIndex"], "subArcs": b["subArcs"]}
                     for b in branch_info if b["n"] > 0],
        "sizeRange": [int(sizes.min()), int(sizes.max())],
    }
    with open(os.path.join(OUT, f"stats-{persona}.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, f"auto-names-{persona}.json"), "w", encoding="utf-8") as f:
        json.dump(auto, f, ensure_ascii=False, indent=2)
    print(f"  → {binp} ({os.path.getsize(binp)/1048576:.1f}MB)  {N} 点 / {k} 枝")
    from collections import Counter
    for j in range(k):
        idx = np.where(lab == j)[0]
        if len(idx) == 0:
            continue
        hs = Counter(str(sel[i].get("topicHint") or "").strip() for i in idx)
        print(f"   b{j:02d} n={len(idx):4d} sub={int(subs[idx].max())+1} | " + "、".join(f"{h}({v})" for h, v in hs.most_common(3)))
    print("  自动名：", " | ".join(f"{j}:{auto[j]}" for j in range(min(k, 28))))

if __name__ == "__main__":
    for p in (sys.argv[1:] or ["alice", "bob"]):
        build(p)
