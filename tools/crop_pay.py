# -*- coding: utf-8 -*-
"""把收款码长图裁成「二维码白卡」部分。

用法：python tools/crop_pay.py
输出：assets/pay/wechat.png（微信）、assets/pay/alipay.png（支付宝）
换码时改下面 SRC 里的两个路径，重跑即可。

两张原图都是「整张宣传图」：大色底 + 顶部推荐语 + 中间白卡（二维码 + 昵称）+ 底部 logo。
页面里要的是白卡，直接塞长图会显得很小、也不好看。
思路：按行统计「接近纯白」的像素占比，找出最长的一段连续高白占比行区间，再横向找白卡左右边界。
"""
import io
import os
import sys

from PIL import Image

SRC = {
    "wechat": r"D:\WeChatData\xwechat_files\wxid_hnyjetk72ryq22_e0f0\temp\RWTemp\2026-11\9e20f478899dc29eb19741386f9343c8\0135cfd17aea217a5b95b0833f3dc2f8.jpg",
    "alipay": r"D:\WeChatData\xwechat_files\wxid_hnyjetk72ryq22_e0f0\temp\RWTemp\2026-11\9e20f478899dc29eb19741386f9343c8\0a8a96a4a60ac5dd0b5d026f7d1a54ed.jpg",
}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "pay")
WHITE = 236          # 每通道 >= 这个值算白
ROW_RATIO = 0.12     # 白卡里二维码黑块占一半，行白占比其实只有 0.35 左右


def find_card(im):
    w, h = im.size
    px = im.convert("RGB").load()

    # 1) 逐行白占比
    rows = []
    for y in range(h):
        n = 0
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if r >= WHITE and g >= WHITE and b >= WHITE:
                n += 1
        rows.append(n / (w / 2))

    # 2) 最长连续高白段 → 白卡的上下边界
    best, cur = (0, 0), None
    for y, v in enumerate(rows):
        if v >= ROW_RATIO:
            cur = y if cur is None else cur
        else:
            if cur is not None and y - cur > best[1] - best[0]:
                best = (cur, y)
            cur = None
    if cur is not None and h - cur > best[1] - best[0]:
        best = (cur, h)

    y0, y1 = best
    if y1 - y0 < h * 0.2:
        raise SystemExit("没找到白卡区域（占比阈值需要调）")

    # 3) 在白卡高度中段逐列判断左右边界
    ym = (y0 + y1) // 2
    cols = []
    for x in range(w):
        n = 0
        for y in range(y0, y1, 3):
            r, g, b = px[x, y]
            if r >= WHITE and g >= WHITE and b >= WHITE:
                n += 1
        cols.append(n / len(range(y0, y1, 3)))
    xs = [x for x, v in enumerate(cols) if v >= 0.10]
    x0, x1 = (xs[0], xs[-1]) if xs else (0, w)
    # 白卡是圆角的，四角会漏出底色（蓝/绿）。往里收一点，别让脏角出现在页面上
    pad = max(6, int((x1 - x0) * 0.016))
    return x0 + pad, y0 + pad, x1 - pad, y1 - pad


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, src in SRC.items():
        if not os.path.exists(src):
            print("缺文件：", src)
            continue
        im = Image.open(src)
        box = find_card(im)
        card = im.crop(box).convert("RGB")
        # 二维码要方正好扫；白卡本身带昵称文字，比正方形略高，保持原比例更自然
        # 统一缩到宽 480，足够 2x 屏清晰，又不影响体积
        cw, ch = card.size
        if cw > 480:
            card = card.resize((480, round(ch * 480 / cw)), Image.LANCZOS)
        dst = os.path.join(OUT, name + ".png")
        card.save(dst, "PNG", optimize=True)
        print("%-7s 原图 %s → 裁切 %s → 输出 %s  %d KB"
              % (name, im.size, (box[2] - box[0], box[3] - box[1]),
                 card.size, os.path.getsize(dst) // 1024))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
