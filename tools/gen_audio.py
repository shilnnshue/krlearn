# -*- coding: utf-8 -*-
"""批量生成韩语音频（edge-tts，免费）
- 字母：19 辅音 + 21 元音 + 8 代表收音
- 音节表：19×21 = 399 个无收音音节
- 单词 + 例句
- 语法例句（data/grammar.json 里的 ex）
支持断点续跑（已存在的文件跳过）
"""
import asyncio, json, os, sys, time
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUD = os.path.join(ROOT, "audio")
VOICE_F = "ko-KR-SunHiNeural"
VOICE_M = "ko-KR-InJoonNeural"
BASE = 0xAC00
IEUNG = 11
V_ORDER = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"]
IDX = {c: i for i, c in enumerate(V_ORDER)}

# 辅音读法用「辅音 + ㅡ」代表其音值（韩语教学惯例）
CONS_READ = {"ㄱ":"그","ㄲ":"끄","ㄴ":"느","ㄷ":"드","ㄸ":"뜨","ㄹ":"르","ㅁ":"므",
             "ㅂ":"브","ㅃ":"쁘","ㅅ":"스","ㅆ":"쓰","ㅇ":"응","ㅈ":"즈","ㅉ":"쯔",
             "ㅊ":"츠","ㅋ":"크","ㅌ":"트","ㅍ":"프","ㅎ":"흐"}
# 代表收音用典型例字
BATCHIM_READ = {"ㄱ":"억","ㄴ":"언","ㄷ":"엇","ㄹ":"얼","ㅁ":"엄","ㅂ":"업","ㅇ":"앙"}

SEM = asyncio.Semaphore(12)
done = skipped = 0
t0 = time.time()

# ---- 文本指纹清单 ----
# 词条 id 按数组顺序编，每次扩库都会整体重排，而 mp3 文件名用的就是 id。
# 只按「文件是否存在」跳过的话，重排后的旧文件会被误当成已生成 —— 文件名对、
# 内容却是上一个词（2026-11-23 踩过一次，459 条错乱）。
# 现在按「相对路径 → 文本 md5」校验：指纹对不上就重新生成。
MAN_PATH = os.path.join(ROOT, "data", "audio_manifest.json")
try:
    MAN = json.load(open(MAN_PATH, encoding="utf-8"))
except Exception:
    MAN = {}


def _key(path):
    return os.path.relpath(path, AUD).replace("\\", "/")


def _md5(t):
    import hashlib
    return hashlib.md5(t.encode("utf-8")).hexdigest()


async def say(text, path, voice):
    global done, skipped
    k, h = _key(path), _md5(text)
    if (os.path.exists(path) and os.path.getsize(path) > 500 and MAN.get(k) == h):
        skipped += 1
        return
    async with SEM:
        for attempt in range(3):
            try:
                c = edge_tts.Communicate(text, voice, rate="-10%")
                await c.save(path)
                MAN[k] = h
                done += 1
                if done % 40 == 0:
                    print("  ... %d 条 (%.0fs)" % (done, time.time() - t0), flush=True)
                return
            except Exception as e:
                if attempt == 2:
                    print("  [ERR] %s -> %s: %s" % (text, path, e), flush=True)
                    return
                await asyncio.sleep(1.2)


def tasks():
    letters = json.load(open(os.path.join(DATA, "letters.json"), encoding="utf-8"))
    words = json.load(open(os.path.join(DATA, "words.json"), encoding="utf-8"))
    out = []
    d = os.path.join(AUD, "letters"); os.makedirs(d, exist_ok=True)
    for c in letters["consonants"]:
        out.append((CONS_READ[c["char"]], os.path.join(d, "L%02d.mp3" % c["index"]), VOICE_F))
    for v in letters["vowels"]:
        txt = chr(BASE + (IEUNG * 21 + v["index"]) * 28)
        out.append((txt, os.path.join(d, "V%02d.mp3" % v["index"]), VOICE_F))
    for b in letters["batchim"]:
        if b["char"]:
            txt = BATCHIM_READ.get(b["char"], "으")
            out.append((txt, os.path.join(d, "T%02d.mp3" % b["index"]), VOICE_F))

    d = os.path.join(AUD, "syl"); os.makedirs(d, exist_ok=True)
    for L in range(19):
        for V in range(21):
            txt = chr(BASE + (L * 21 + V) * 28)
            out.append((txt, os.path.join(d, "s%02d%02d.mp3" % (L, V)), VOICE_F))

    d = os.path.join(AUD, "words"); os.makedirs(d, exist_ok=True)
    ds = os.path.join(AUD, "sent"); os.makedirs(ds, exist_ok=True)
    for w in words:
        out.append((w["korean"], os.path.join(d, w["id"] + ".mp3"), VOICE_F))
        for i, ex in enumerate(w.get("examples") or [], 1):
            out.append((ex["ko"], os.path.join(ds, "%s_%d.mp3" % (w["id"], i)), VOICE_F))

    # 语法例句。只念句子，不念语法形态本身 —— 67 条里有 31 条形态带
    # -아/어요、-(으)ㄹ 거예요 这类标注符号，直接丢给 TTS 会念成
    # 「아 슬래시 어요」，比不念更糟。
    ge = os.path.join(AUD, "grammar", "ex"); os.makedirs(ge, exist_ok=True)
    try:
        gram = json.load(open(os.path.join(DATA, "grammar.json"), encoding="utf-8"))
    except Exception:
        gram = []
    for g in gram:
        for i, ex in enumerate(g.get("ex") or [], 1):
            out.append((ex["kr"], os.path.join(ge, "%s_%d.mp3" % (g["id"], i)), VOICE_F))
    return out


async def main():
    tl = tasks()
    print("待处理音频：%d 条（清单已有 %d 条）" % (len(tl), len(MAN)), flush=True)
    await asyncio.gather(*[say(t, p, v) for (t, p, v) in tl])
    with open(MAN_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(MAN, f, ensure_ascii=False, indent=0)
    print("完成：新生成 %d 条，跳过 %d 条，耗时 %.0fs（清单 %d 条）"
          % (done, skipped, time.time() - t0, len(MAN)))


if __name__ == "__main__":
    asyncio.run(main())
