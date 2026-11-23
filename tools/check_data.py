# -*- coding: utf-8 -*-
"""发布前数据自检：数据内部一致性 + 数据与音频文件的对齐。

比 audit_audio.py 便宜得多（不做任何网络请求），可以每次改完词库就跑。
查的是「结构性错误」：
  - id 重复 / 断号、字段缺失、词性非法
  - 词本引用了不存在的词
  - 变位表的 key 不在词库里、行数不对
  - 该有的 mp3 不存在、体积异常
  - 音频指纹清单与当前文本不符（说明文本改了但音频没重生成）

用法：python tools/check_data.py
退出码：0 全过；1 有 FAIL
"""
import hashlib
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUD = os.path.join(ROOT, "audio")

POS_OK = {"名词", "动词", "形容词", "副词", "依存名词", "冠形词", "专有名词",
          "代名词", "数词", "感叹词", "补助谓词", "口语副词", "短语"}

fails = []
warns = []


def rd(name):
    with io.open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def fail(msg):
    fails.append(msg)


def warn(msg):
    warns.append(msg)


def md5(t):
    return hashlib.md5(t.encode("utf-8")).hexdigest()


def size_ok(p, lo=400):
    return os.path.exists(p) and os.path.getsize(p) >= lo


def main():
    words = rd("words.json")
    decks = rd("decks.json")
    conj = rd("conjugations.json")
    letters = rd("letters.json")

    # ---------- 1. 词条 ----------
    ids = set()
    by_id = {}
    for w in words:
        wid = w.get("id") or ""
        if not re.fullmatch(r"w\d{4,}", wid):
            fail("词条 id 格式异常: %r" % wid)
            continue
        if wid in ids:
            fail("词条 id 重复: %s" % wid)
        ids.add(wid)
        by_id[wid] = w
        if not (w.get("korean") or "").strip():
            fail("%s 韩文为空" % wid)
        if not (w.get("chinese") or "").strip():
            fail("%s 中文释义为空" % wid)
        if w.get("pos") not in POS_OK:
            # 允许「感叹词/名词」这种复合词性（例如 대박），但每一段都得是合法词性
            parts = [x.strip() for x in (w.get("pos") or "").split("/")]
            if not all(p in POS_OK for p in parts if p):
                fail("%s 词性非法: %r" % (wid, w.get("pos")))
        if w.get("topik") not in (1, 2, 3, 4, 5):
            fail("%s TOPIK 等级异常: %r" % (wid, w.get("topik")))
        exs = w.get("examples") or []
        if not exs:
            fail("%s 没有例句" % wid)
        for i, e in enumerate(exs, 1):
            if not (e.get("ko") or "").strip() or not (e.get("zh") or "").strip():
                fail("%s 第 %d 条例句缺 ko/zh" % (wid, i))
            if e.get("level") not in (1, 2, 3):
                fail("%s 第 %d 条例句 level 异常: %r" % (wid, i, e.get("level")))

    # id 连续性（w0001..wNNNN 不该有空洞）
    nums = sorted(int(w[1:]) for w in ids)
    if nums:
        expect = list(range(nums[0], nums[-1] + 1))
        holes = set(expect) - set(nums)
        if holes:
            fail("词条 id 断号 %d 个，例如 %s" % (len(holes), sorted(holes)[:5]))
        if nums[0] != 1:
            warn("词条 id 不是从 w0001 开始（第一个是 w%04d）" % nums[0])

    # ---------- 2. 词本 ----------
    deck_ids = set()
    for d in decks:
        did = d.get("id")
        if did in deck_ids:
            fail("词本 id 重复: %s" % did)
        deck_ids.add(did)
        ws = d.get("words") or []
        if not ws:
            fail("词本「%s」是空的" % d.get("name"))
        ghost = [x for x in ws if x not in by_id]
        if ghost:
            fail("词本「%s」引用了不存在的词条 %d 个，例如 %s" % (d.get("name"), len(ghost), ghost[:3]))
        if len(ws) != len(set(ws)):
            fail("词本「%s」内部有重复词条" % d.get("name"))

    covered = set()
    for d in decks:
        if d.get("id") != "all":
            covered.update(d.get("words") or [])
    if "all" in deck_ids:
        allset = set(next(d for d in decks if d["id"] == "all")["words"])
        if allset != ids:
            fail("「全库」词本与 words.json 不一致（缺 %d / 多 %d）"
                 % (len(ids - allset), len(allset - ids)))
    else:
        warn("没有 id=all 的全库词本")
    miss_deck = ids - covered
    if miss_deck:
        warn("%d 个词条不属于任何词本（只在词典里能搜到）" % len(miss_deck))

    # ---------- 3. 变位 ----------
    for wid, obj in conj.items():
        if wid not in by_id:
            fail("变位表 key 不在词库里: %s" % wid)
            continue
        if obj.get("korean") != by_id[wid].get("korean"):
            fail("变位表 %s 的韩文与词库不一致: %r vs %r"
                 % (wid, obj.get("korean"), by_id[wid].get("korean")))
        rows = obj.get("rows") or []
        if len(rows) != 15:
            fail("变位表 %s 只有 %d 行（应为 15）" % (wid, len(rows)))
        for i, r in enumerate(rows):
            for k in ("label", "tag", "form", "note"):
                if k not in r:
                    fail("变位表 %s 第 %d 行缺字段 %s" % (wid, i, k))
            if not (r.get("form") or "").strip():
                fail("变位表 %s 第 %d 行 form 为空" % (wid, i))
        if wid in by_id and by_id[wid].get("src") == "nikl":
            warn("%s 是官方词表词却出了变位表（可能不准）" % wid)

    # ---------- 4. 音频文件 ----------
    miss_w = miss_s = miss_c = 0
    for w in words:
        if not size_ok(os.path.join(AUD, "words", w["id"] + ".mp3")):
            miss_w += 1
        for i in range(1, len(w.get("examples") or []) + 1):
            if not size_ok(os.path.join(AUD, "sent", "%s_%d.mp3" % (w["id"], i))):
                miss_s += 1
    for wid, obj in conj.items():
        for i in range(len(obj.get("rows") or [])):   # 0-based，文件名 00.mp3
            if not size_ok(os.path.join(AUD, "conj", wid, "%02d.mp3" % i)):
                miss_c += 1
    if miss_w:
        fail("单词音频缺失 %d 条" % miss_w)
    if miss_s:
        fail("例句音频缺失 %d 条" % miss_s)
    if miss_c:
        fail("变位音频缺失 %d 条" % miss_c)

    # ---------- 5. 指纹清单 ----------
    man_path = os.path.join(DATA, "audio_manifest.json")
    if not os.path.exists(man_path):
        warn("没有 audio_manifest.json，生成脚本会退化成「只判文件存在」")
    else:
        man = rd("audio_manifest.json")
        stale = same = 0
        for w in words:
            k = "words/%s.mp3" % w["id"]
            if k in man:
                if man[k] == md5(w["korean"]):
                    same += 1
                else:
                    stale += 1
            for i, e in enumerate(w.get("examples") or [], 1):
                k = "sent/%s_%d.mp3" % (w["id"], i)
                if k in man:
                    if man[k] == md5(e["ko"]):
                        same += 1
                    else:
                        stale += 1
        for wid, obj in conj.items():
            for i, r in enumerate(obj.get("rows") or []):
                k = "conj/%s/%02d.mp3" % (wid, i)
                if k in man:
                    if man[k] == md5(r["form"]):
                        same += 1
                    else:
                        stale += 1
        if stale:
            fail("音频指纹不符 %d 条 —— 文本改过但音频没重生成，跑 audit_audio.py" % stale)
        print("指纹清单：核对 %d 条，一致 %d" % (same + stale, same))

    # ---------- 6. 字母表 ----------
    n_con = len(letters.get("consonants") or [])
    n_vow = len(letters.get("vowels") or [])
    n_bat = len(letters.get("batchim") or [])
    if (n_con, n_vow) != (19, 21):
        fail("字母表辅音/元音数量异常: %d / %d（应为 19 / 21）" % (n_con, n_vow))
    for d, pat, cnt in (("letters", None, n_con + n_vow), ("syl", None, 399)):
        if os.path.isdir(os.path.join(AUD, d)):
            have = len([f for f in os.listdir(os.path.join(AUD, d)) if f.endswith(".mp3")])
            if have < cnt:
                fail("%s 目录音频不足：%d / %d" % (d, have, cnt))

    # ---------- 语法栏目 ----------
    try:
        gram = rd("grammar.json")
    except FileNotFoundError:
        gram = None
        warn("没有 data/grammar.json，语法栏目会是空页（跑 python tools/build_grammar.py）")
    except Exception as e:
        gram = None
        fail("grammar.json 解析失败：%s" % e)

    gex = 0
    if isinstance(gram, list):
        if not gram:
            fail("grammar.json 是空数组")
        need = ("id", "form", "level", "cat", "attach", "meaning", "desc", "ex", "note", "cmp")
        gseen = set()
        for i, g in enumerate(gram):
            tag = g.get("id") or ("#%d" % i)
            if g.get("id") in gseen:
                fail("语法 id 重复：%s" % tag)
            gseen.add(g.get("id"))
            if not re.match(r"^g\d{3}$", str(g.get("id", ""))):
                fail("语法 id 格式不对（应为 gNNN）：%s" % tag)
            for k in need:
                if k not in g:
                    fail("语法 %s 缺字段 %s" % (tag, k))
            if g.get("level") not in ("初级", "中级", "高级"):
                fail("语法 %s level 非法：%s" % (tag, g.get("level")))
            ex = g.get("ex") or []
            if len(ex) < 2:
                fail("语法 %s 例句少于 2 条（%d）" % (tag, len(ex)))
            for j, e in enumerate(ex):
                gex += 1
                kk = str(e.get("kr", "")).strip()
                zz = str(e.get("zh", "")).strip()
                if not kk or not zz:
                    fail("语法 %s 第 %d 条例句不完整" % (tag, j + 1))
                elif not kk.endswith((".", "?", "!")):
                    fail("语法 %s 第 %d 条韩语例句没加标点：%s" % (tag, j + 1, kk))

        # 语法例句音频：audio/grammar/ex/gNNN_n.mp3
        try:
            gman = rd("audio_manifest.json")
        except Exception:
            gman = {}
        miss_g = gstale = gsame = 0
        for g in gram:
            gid = g.get("id")
            for j, e in enumerate(g.get("ex") or [], 1):
                fn = "%s_%d.mp3" % (gid, j)
                if not size_ok(os.path.join(AUD, "grammar", "ex", fn)):
                    miss_g += 1
                rel = "grammar/ex/" + fn
                if rel in gman:
                    if gman[rel] == md5(str(e.get("kr", ""))):
                        gsame += 1
                    else:
                        gstale += 1
        if miss_g:
            fail("语法例句音频缺失 %d 条（跑 python tools/gen_audio.py）" % miss_g)
        if gstale:
            fail("语法例句音频指纹不符 %d 条（例句改过但音频没重生成）" % gstale)
        if gsame or gstale:
            print("语法音频：核对 %d 条，一致 %d" % (gsame + gstale, gsame))
    elif gram is not None:
        fail("grammar.json 应该是数组")

    # ---------- 报告 ----------
    print("词条 %d | 词本 %d | 变位 %d | 例句 %d"
          % (len(words), len(decks), len(conj), sum(len(w.get("examples") or []) for w in words)))
    if isinstance(gram, list) and gram:
        print("语法 %d 条 | 语法例句 %d 条" % (len(gram), gex))
    if warns:
        print("\n提示 %d 条：" % len(warns))
        for m in warns[:8]:
            print("  · " + m)
    if fails:
        print("\n失败 %d 条：" % len(fails))
        for m in fails[:30]:
            print("  ✗ " + m)
        print("\nRESULT: FAIL")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    sys.exit(main())
