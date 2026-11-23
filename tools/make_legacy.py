# -*- coding: utf-8 -*-
"""生成旧 id → 韩文 的映射表。

词库从 774 扩到 5926 后，word id 全部重排；用户 localStorage 里的
progress 是按旧 id 存的，不迁移就会「张冠李戴」——点开新词发现已经是
别的一个词，但进度还在。

这里按上一版 build_data.py 的取词逻辑精确复现旧顺序，产出一份映射，
前端启动时据此把旧进度搬到新 id 上。
"""
import csv, io, json, os

D = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(D)

cur = json.load(io.open(os.path.join(ROOT, "data/words.json"), encoding="utf-8"))
# 精选词（人工编写那批）在旧版里也是前 315 条，id 没动过
rich = [w for w in cur if not w["src"]]
assert len(rich) == 315, len(rich)

legacy = {w["id"]: w["korean"] for w in rich}
used = {w["korean"] for w in rich}

with open(os.path.join(D, "nikl_vocab_zh.csv"), encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# 旧版：只取 A 级 + 명/동/형，按 CSV 原顺序，跳过精选词已有的
n = 0
for r in rows:
    if not r["nikl_grade"].startswith("A"):
        continue
    if r["pos"] not in ("명", "동", "형"):
        continue
    ko = r["word"].strip()
    if not ko or not r["meaning"].strip() or not r["example_ko"].strip():
        continue
    if ko in used:
        continue
    used.add(ko)
    n += 1
    legacy["w%04d" % (315 + n)] = ko

print("旧词条数", len(legacy), "（精选 315 + 官方 %d）" % n)
out = os.path.join(ROOT, "data/legacy.json")
io.open(out, "w", encoding="utf-8", newline="\n").write(
    json.dumps(legacy, ensure_ascii=False, separators=(",", ":")))
print("写出", out, os.path.getsize(out), "字节")
