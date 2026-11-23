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

from PIL import Image, ImageDraw

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


def dark_box(im, card, ratio=0.25):
    """在白卡里找出「二维码本体」的外接矩形。

    为什么要单独找：微信和支付宝导出的白卡留白比例不一样（微信的上下留白更宽，
    底下还多一行昵称），按白卡裁的话两张 fig 显示成同样 250px 宽，二维码本体
    却一个大一个小。按二维码本体对齐才能视觉一致。
    昵称文字是深色但笔画只占那一行的 10% 左右，阈值取 0.25 就能滤掉
    （取 0.15 时微信那行较长的昵称会被算进本体，导致高度多出 60px）。
    """
    x0, y0, x1, y1 = card
    px = im.convert("L").load()
    rows, cols = [], []
    for y in range(y0, y1):
        n = sum(1 for x in range(x0, x1, 2) if px[x, y] < 110)
        rows.append(n / ((x1 - x0) / 2))
    for x in range(x0, x1):
        n = sum(1 for y in range(y0, y1, 2) if px[x, y] < 110)
        cols.append(n / ((y1 - y0) / 2))
    ys = [y0 + i for i, v in enumerate(rows) if v >= ratio]
    xs = [x0 + i for i, v in enumerate(cols) if v >= ratio]
    if not xs or not ys:
        return card
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, src in SRC.items():
        if not os.path.exists(src):
            print("缺文件：", src)
            continue
        im = Image.open(src)
        card = find_card(im)
        bx0, by0, bx1, by1 = dark_box(im, card)

        # 二维码本体之外的区域（底部的昵称文字）先涂白。
        # 不涂的话，正方形往下多留的那几十像素静区会把昵称顶部切一条黑边进来，
        # 在页面白底上看着像脏污。
        clean = im.convert("RGB")
        draw = ImageDraw.Draw(clean)
        draw.rectangle([card[0], card[1], card[2], by0], fill=(255, 255, 255))
        draw.rectangle([card[0], by1, card[2], card[3]], fill=(255, 255, 255))

        # 以二维码本体为中心裁正方形，四周各留 11% 静区。
        # QR 规范要求 4 个模块宽的静区：348px 宽的码约 45 模块 → 每模块 7.7px，
        # 4 模块 = 31px，所以每边留白必须 > 31px，1.22 倍对应 38px，够。
        side = max(bx1 - bx0, by1 - by0) * 1.22
        side = min(side, card[2] - card[0], card[3] - card[1])
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        sx = max(card[0], min(int(round(cx - side / 2)), card[2] - int(side)))
        sy = max(card[1], min(int(round(cy - side / 2)), card[3] - int(side)))

        out = clean.crop((sx, sy, sx + int(side), sy + int(side)))
        out = out.resize((480, 480), Image.LANCZOS)
        dst = os.path.join(OUT, name + ".png")
        out.save(dst, "PNG", optimize=True)
        print("%-7s 原图 %s → 二维码本体 %s → 方形裁切 %s → 480×480  %d KB"
              % (name, im.size, (bx1 - bx0, by1 - by0),
                 (int(side), int(side)), os.path.getsize(dst) // 1024))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
