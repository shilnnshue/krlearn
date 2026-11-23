# -*- coding: utf-8 -*-
"""音频体检：找出「文件名对、内容念错了词」的 mp3 并修复。

三步：
  1. 长度粗筛 —— 用「字节数 ≈ a × 音节数 + b」拟合（拿已确认正确的样本当基准），
     残差超过阈值的才进精查。避免为了查几条错把 1 万多条全部重合成。
  2. 精查 —— 逐条重新合成，与磁盘文件做字节比对（edge-tts 对同文本输出稳定）。
  3. 修复 —— 不一致的用新结果覆盖，同步更新 data/audio_manifest.json。

用法：
  python tools/audit_audio.py            # 粗筛 + 精查 + 修复
  python tools/audit_audio.py --dry      # 只报告，不动文件
"""
import asyncio
import hashlib
import io
import json
import os
import re
import statistics
import sys
import time

import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUD = os.path.join(ROOT, "audio")
VOICE, RATE = "ko-KR-SunHiNeural", "-10%"
TMP = os.path.join(ROOT, "_verifytmp")
SEM = asyncio.Semaphore(int(os.environ.get("KR_CONC", "24")))
DRY = "--dry" in sys.argv
STALE = "--stale" in sys.argv

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass


def md5f(p):
    with open(p, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def syll(t):
    """粗估读音音节数：谚文一字一音节，拉丁/数字折半，空格轻加权"""
    return (len(re.findall(r"[\uAC00-\uD7A3]", t))
            + len(re.findall(r"[A-Za-z0-9]", t)) * 1.2
            + t.count(" ") * 0.4)


def fit(pairs):
    """最小二乘：bytes = a*syll + b，返回 (a, b, sd)"""
    xs = [s for s, _ in pairs]
    ys = [b for _, b in pairs]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs) or 1
    a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    b = my - a * mx
    sd = statistics.pstdev([y - (a * x + b) for x, y in zip(xs, ys)]) or 1
    return a, b, sd


def collect(words):
    jobs = []   # (text, path, tag)

    # 单词：前 300 条当下拟合基准（这段历史最久、已多次验证）
    base = []
    for w in words[:300]:
        p = os.path.join(AUD, "words", w["id"] + ".mp3")
        if os.path.exists(p):
            base.append((syll(w["korean"]), os.path.getsize(p)))
    a, b, sd = fit(base)
    print("单词拟合 bytes≈%.0f×音节+%.0f  sd=%.0f  基准 %d 条" % (a, b, sd, len(base)))
    for w in words:
        p = os.path.join(AUD, "words", w["id"] + ".mp3")
        if not os.path.exists(p):
            continue
        z = (os.path.getsize(p) - (a * syll(w["korean"]) + b)) / sd
        if abs(z) > 2.5:
            jobs.append((w["korean"], p, w["id"]))

    # 例句：自己一套基准
    ex = [(w["id"], i, e) for w in words for i, e in enumerate(w.get("examples") or [], 1)]
    base = []
    for wid, i, e in ex[:300]:
        p = os.path.join(AUD, "sent", "%s_%d.mp3" % (wid, i))
        if os.path.exists(p):
            base.append((syll(e["ko"]), os.path.getsize(p)))
    a2, b2, sd2 = fit(base)
    print("例句拟合 bytes≈%.0f×音节+%.0f  sd=%.0f  基准 %d 条" % (a2, b2, sd2, len(base)))
    for wid, i, e in ex:
        p = os.path.join(AUD, "sent", "%s_%d.mp3" % (wid, i))
        if not os.path.exists(p):
            continue
        z = (os.path.getsize(p) - (a2 * syll(e["ko"]) + b2)) / sd2
        if abs(z) > 3:
            jobs.append((e["ko"], p, "%s_%d" % (wid, i)))

    return jobs


def collect_stale(words):
    """mtime 早于数据文件的音频 = 数据改过、音频没跟上。
    比长度粗筛更狠：长度相近的两句话改动了，长度法看不出来，时间戳能看出来。"""
    jobs = []
    ref_w = os.path.getmtime(os.path.join(DATA, "words.json"))
    for w in words:
        p = os.path.join(AUD, "words", w["id"] + ".mp3")
        if os.path.exists(p) and os.path.getmtime(p) < ref_w:
            jobs.append((w["korean"], p, w["id"]))
        for i, e in enumerate(w.get("examples") or [], 1):
            p = os.path.join(AUD, "sent", "%s_%d.mp3" % (w["id"], i))
            if os.path.exists(p) and os.path.getmtime(p) < ref_w:
                jobs.append((e["ko"], p, "%s_%d" % (w["id"], i)))

    conj = json.load(io.open(os.path.join(DATA, "conjugations.json"), encoding="utf-8"))
    ref_c = os.path.getmtime(os.path.join(DATA, "conjugations.json"))
    for wid, entry in conj.items():
        # 注意：变位音频文件名是 00..14（gen_conj_audio 用 enumerate 默认起点），
        # 前端 URLS.conj(id, i) 的 i 也是 0-based。这里必须一致，否则会把
        # 第 N 行的音频覆盖到第 N+1 行的文件上。
        for i, r in enumerate(entry["rows"]):
            p = os.path.join(AUD, "conj", wid, "%02d.mp3" % i)
            if os.path.exists(p) and os.path.getmtime(p) < ref_c:
                jobs.append((r["form"], p, "conj/%s/%02d" % (wid, i)))
    return jobs


async def probe(text, path, tag, man):
    tmp = os.path.join(TMP, hashlib.md5(tag.encode()).hexdigest()[:12] + ".mp3")
    async with SEM:
        for attempt in range(3):
            try:
                await edge_tts.Communicate(text, VOICE, rate=RATE).save(tmp)
                break
            except Exception:
                if attempt == 2:
                    return (tag, text, "err", 0, 0)
                await asyncio.sleep(1.2)
        a, b = os.path.getsize(path), os.path.getsize(tmp)
        same = md5f(path) == md5f(tmp)
        if not same and not DRY:
            os.replace(tmp, path)
            man[os.path.relpath(path, AUD).replace("\\", "/")] = hashlib.md5(text.encode("utf-8")).hexdigest()
        else:
            if os.path.exists(tmp):
                os.remove(tmp)
            # 确认正确也要 touch：不然 --stale 按 mtime 筛，每轮都会把同一批再查一遍
            os.utime(path, None)
        return (tag, text, "ok" if same else "bad", a, b)


async def main():
    os.makedirs(TMP, exist_ok=True)
    words = json.load(io.open(os.path.join(DATA, "words.json"), encoding="utf-8"))
    man_path = os.path.join(DATA, "audio_manifest.json")
    try:
        man = json.load(io.open(man_path, encoding="utf-8"))
    except Exception:
        man = {}

    jobs = collect_stale(words) if STALE else collect(words)
    lim = int(os.environ.get("KR_LIMIT", "0"))
    if lim and len(jobs) > lim:
        print("本轮只处理前 %d 条（共 %d 条待查，分批跑）" % (lim, len(jobs)), flush=True)
        jobs = jobs[:lim]
    lim = int(os.environ.get("KR_LIMIT", "0"))
    if lim and len(jobs) > lim:
        print("本轮只处理前 %d 条（共 %d 条待查，分批跑）" % (lim, len(jobs)), flush=True)
        jobs = jobs[:lim]
    label = "时间戳落后" if STALE else "长度粗筛可疑"
    print("%s %d 条，开始逐条精查（并发 %d）..." % (label, len(jobs), SEM._value), flush=True)
    t0 = time.time()
    res = await asyncio.gather(*[probe(t, p, tag, man) for t, p, tag in jobs])

    ok = [r for r in res if r[2] == "ok"]
    bad = [r for r in res if r[2] == "bad"]
    err = [r for r in res if r[2] == "err"]
    print("精查完成 %.0fs | 确认正确 %d | 念错 %d | 出错 %d" % (time.time() - t0, len(ok), len(bad), len(err)))
    if bad:
        print("--- 念错的条目（已%s）---" % ("记录" if DRY else "用新合成覆盖"))
        for tag, text, _, a, b in sorted(bad, key=lambda r: -abs((r[3] - r[4]) / max(r[4], 1))):
            print("  %-14s 应读「%s」 旧 %d bytes → 新 %d bytes" % (tag, text, a, b))

    if not DRY:
        with open(man_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(man, f, ensure_ascii=False, indent=0)
        log = os.path.join(DATA, "audio_fixed_log.jsonl")
        with io.open(log, "a", encoding="utf-8") as f:
            for tag, text, _, a, b in bad:
                f.write(json.dumps({"tag": tag, "text": text, "old": a, "new": b}, ensure_ascii=False) + "\n")
        print("修复记录已追加 → %s" % os.path.relpath(log, ROOT))


if __name__ == "__main__":
    asyncio.run(main())
