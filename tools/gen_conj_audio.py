# -*- coding: utf-8 -*-
"""生成变位形音频：audio/conj/{word_id}/{row_index}.mp3
让变位表每一个形式都能点听——这是相对「识日」的差异化能力
"""
import asyncio, json, os, time
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUD = os.path.join(ROOT, "audio", "conj")
VOICE = "ko-KR-SunHiNeural"
SEM = asyncio.Semaphore(14)
done = skipped = 0
t0 = time.time()


# 指纹清单：和 gen_audio.py 同一套机制。变位形文本改过（引擎修 bug 后）时，
# 光看「文件存在」会跳过旧内容 —— 曾经因此把第 N 行的音频错接到第 N+1 行。
MAN_PATH = os.path.join(DATA, "audio_manifest.json")
try:
    MAN = json.load(open(MAN_PATH, encoding="utf-8"))
except Exception:
    MAN = {}


def _key(path):
    return os.path.relpath(path, os.path.dirname(AUD)).replace("\\", "/")


def _md5(t):
    import hashlib
    return hashlib.md5(t.encode("utf-8")).hexdigest()


async def say(text, path):
    global done, skipped
    k, h = _key(path), _md5(text)
    if (os.path.exists(path) and os.path.getsize(path) > 400 and MAN.get(k) == h):
        skipped += 1
        return
    async with SEM:
        for attempt in range(3):
            try:
                await edge_tts.Communicate(text, VOICE, rate="-10%").save(path)
                MAN[k] = h
                done += 1
                if done % 60 == 0:
                    print("  ... %d 条 (%.0fs)" % (done, time.time() - t0), flush=True)
                return
            except Exception as e:
                if attempt == 2:
                    print("  [ERR] %s: %s" % (path, e), flush=True)
                    return
                await asyncio.sleep(1.2)


async def main():
    conj = json.load(open(os.path.join(DATA, "conjugations.json"), encoding="utf-8"))
    tl = []
    for wid, obj in conj.items():
        d = os.path.join(AUD, wid)
        os.makedirs(d, exist_ok=True)
        for i, row in enumerate(obj["rows"]):
            tl.append((row["form"], os.path.join(d, "%02d.mp3" % i)))
    print("变位音频待处理：%d 条（%d 个词条）" % (len(tl), len(conj)), flush=True)
    await asyncio.gather(*[say(t, p) for (t, p) in tl])
    with open(MAN_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(MAN, f, ensure_ascii=False, indent=0)
    print("完成：新生成 %d，跳过 %d，耗时 %.0fs（清单 %d 条）" % (done, skipped, time.time() - t0, len(MAN)))


if __name__ == "__main__":
    asyncio.run(main())
