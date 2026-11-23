# -*- coding: utf-8 -*-
"""修掉「扩库导致 id 重排、音频跟词条对不上」的问题。

问题根因：
  词条 id 是按数组顺序编的 wNNNN。每次往词库里追加/插入词条，后面的 id 全部重排，
  但 mp3 文件名用的就是 id。gen_audio.py 的跳过条件是「文件已存在」，于是重排后
  旧文件被当成「已生成」跳过 —— 文件名对，内容却是上一个词。

判定依据：
  data/legacy.json 记录了上一版（774 词）的 id → 韩文。对每个当前词条：
    - 旧库里同 id 是同一个词  → 文件正确，保留
    - 旧库里同 id 是别的词    → 文件错乱，删掉重生成
    - 旧库里没有这个 id       → 文件是本轮新生成的，正确

顺带建立 data/audio_manifest.json（相对路径 → 文本 md5），以后 gen_audio.py
按「文本指纹」而不是「文件是否存在」决定跳过，扩库再怎么重排都不会错。

用法：python tools/fix_audio_ids.py [--dry]
"""
import hashlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUD = os.path.join(ROOT, "audio")
try:                                  # 管道下默认块缓冲，进度会一直看不到
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

DRY = "--dry" in sys.argv
MANIFEST_ONLY = "--manifest-only" in sys.argv

VOICE_SUFFIX = ".mp3"


def rd(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def md5(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def rel(p):
    return os.path.relpath(p, AUD).replace("\\", "/")


def size_ok(p):
    return os.path.exists(p) and os.path.getsize(p) > 500


def main():
    legacy = rd(os.path.join(DATA, "legacy.json"))
    words = rd(os.path.join(DATA, "words.json"))
    old_max = max(int(k[1:]) for k in legacy)

    bad_ids = []
    for w in words:
        n = int(w["id"][1:])
        if n > old_max:                       # 旧库没有这个 id，本轮新生成
            continue
        old_ko = legacy.get(w["id"])
        if old_ko is not None and old_ko != w["korean"]:
            bad_ids.append(w["id"])

    print("错位词条: %d 个（%s … %s）" % (len(bad_ids), bad_ids[0] if bad_ids else "-", bad_ids[-1] if bad_ids else "-"))

    removed_w = removed_s = 0
    for wid in ([] if MANIFEST_ONLY else bad_ids):
        p = os.path.join(AUD, "words", wid + VOICE_SUFFIX)
        if os.path.exists(p):
            if not DRY:
                os.remove(p)
            removed_w += 1
        d = os.path.join(AUD, "sent")
        for name in os.listdir(d) if os.path.isdir(d) else []:
            if name.startswith(wid + "_") and name.endswith(VOICE_SUFFIX):
                if not DRY:
                    os.remove(os.path.join(d, name))
                removed_s += 1
    print("删除：单词 %d 条 / 例句 %d 条%s" % (removed_w, removed_s, "（dry run，未实际删除）" if DRY else ""))
    if DRY:
        return

    # ---- 重建 manifest：只记录现存文件的「当前正确文本」----
    man = {}
    for w in words:
        p = os.path.join(AUD, "words", w["id"] + VOICE_SUFFIX)
        if size_ok(p):
            man[rel(p)] = md5(w["korean"])
        for i, ex in enumerate(w.get("examples") or [], 1):
            p = os.path.join(AUD, "sent", "%s_%d%s" % (w["id"], i, VOICE_SUFFIX))
            if size_ok(p):
                man[rel(p)] = md5(ex["ko"])

    letters = rd(os.path.join(DATA, "letters.json"))
    CONS_READ = {"ㄱ": "그", "ㄲ": "끄", "ㄴ": "느", "ㄷ": "드", "ㄸ": "뜨", "ㄹ": "르", "ㅁ": "므",
                 "ㅂ": "브", "ㅃ": "쁘", "ㅅ": "스", "ㅆ": "쓰", "ㅇ": "응", "ㅈ": "즈", "ㅉ": "쯔",
                 "ㅊ": "츠", "ㅋ": "크", "ㅌ": "트", "ㅍ": "프", "ㅎ": "흐"}
    BATCHIM_READ = {"ㄱ": "억", "ㄴ": "언", "ㄷ": "엇", "ㄹ": "얼", "ㅁ": "엄", "ㅂ": "업", "ㅇ": "앙"}
    BASE, IEUNG = 0xAC00, 11
    for c in letters["consonants"]:
        p = os.path.join(AUD, "letters", "L%02d%s" % (c["index"], VOICE_SUFFIX))
        if size_ok(p):
            man[rel(p)] = md5(CONS_READ[c["char"]])
    for v in letters["vowels"]:
        p = os.path.join(AUD, "letters", "V%02d%s" % (v["index"], VOICE_SUFFIX))
        if size_ok(p):
            man[rel(p)] = md5(chr(BASE + (IEUNG * 21 + v["index"]) * 28))
    for b in letters["batchim"]:
        if not b["char"]:
            continue
        p = os.path.join(AUD, "letters", "T%02d%s" % (b["index"], VOICE_SUFFIX))
        if size_ok(p):
            man[rel(p)] = md5(BATCHIM_READ.get(b["char"], "으"))
    for L in range(19):
        for V in range(21):
            p = os.path.join(AUD, "syl", "s%02d%02d%s" % (L, V, VOICE_SUFFIX))
            if size_ok(p):
                man[rel(p)] = md5(chr(BASE + (L * 21 + V) * 28))

    # 变位形音频：词条 id 全部稳定（都是精选词），文本取自 conjugations.json
    conj = rd(os.path.join(DATA, "conjugations.json"))
    for wid, entry in conj.items():
        # 变位音频是 00..14（gen_conj_audio 用 enumerate 默认起点），前端 URLS.conj 也是 0-based
        for i, r in enumerate(entry["rows"]):
            p = os.path.join(AUD, "conj", wid, "%02d%s" % (i, VOICE_SUFFIX))
            if size_ok(p):
                man[rel(p)] = md5(r["form"])

    out = os.path.join(DATA, "audio_manifest.json")
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(man, f, ensure_ascii=False, indent=0)
    print("manifest 写入 %d 条 → %s" % (len(man), rel_path_show(out)))

    # ---- 还缺多少 ----
    def cnt(kind):
        d = os.path.join(AUD, kind)
        return len([n for n in os.listdir(d) if n.endswith(VOICE_SUFFIX)]) if os.path.isdir(d) else 0

    need_w = sum(1 for w in words if not size_ok(os.path.join(AUD, "words", w["id"] + VOICE_SUFFIX)))
    need_s = 0
    for w in words:
        for i in range(1, len(w.get("examples") or []) + 1):
            if not size_ok(os.path.join(AUD, "sent", "%s_%d%s" % (w["id"], i, VOICE_SUFFIX))):
                need_s += 1
    print("现有 words=%d sent=%d | 待生成 单词 %d / 例句 %d" % (cnt("words"), cnt("sent"), need_w, need_s))


def rel_path_show(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


if __name__ == "__main__":
    main()
