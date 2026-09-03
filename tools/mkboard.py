#!/usr/bin/env python3
"""把一个 FEN 画成棋盘图, 用来测识别。

    python3 tools/mkboard.py "<fen>" -o /tmp/a.png [--flip] [--skew 0.12] [--noise 8]

--flip  按黑方在下画 (照片拍反了是最常见的情况, 而且是唯一"看起来仍然合法"的错法)
--skew  加一个透视形变, 模拟斜着拍
--noise 加噪点和轻微模糊

★ 合成图只能证明这条流水线是通的, 不能代表真实照片的准确率。真实照片有反光、
   手指遮挡、棋子立体阴影、桌面木纹干扰, 那些只能拿真照片测。
"""
import argparse
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
NAME_RED = {'K': '帅', 'A': '仕', 'B': '相', 'N': '马', 'R': '车', 'C': '炮', 'P': '兵'}
NAME_BLK = {'k': '将', 'a': '士', 'b': '象', 'n': '马', 'r': '车', 'c': '炮', 'p': '卒'}


def parse(fen):
    grid = [['' for _ in range(9)] for _ in range(10)]
    for r, part in enumerate(fen.split()[0].split('/')[:10]):
        c = 0
        for ch in part:
            if ch.isdigit():
                c += int(ch)
            else:
                if c < 9:
                    grid[r][c] = ch
                c += 1
    return grid


def render(fen, flip=False, skew=0.0, noise=0, s=64):
    grid = parse(fen)
    if flip:
        grid = [list(reversed(row)) for row in reversed(grid)]
    m = int(s * 1.1)
    W, H = m * 2 + s * 8, m * 2 + s * 9
    im = Image.new('RGB', (W, H), (242, 238, 228))
    d = ImageDraw.Draw(im)
    ink = (36, 34, 32)
    xy = lambda r, c: (m + c * s, m + r * s)

    for r in range(10):
        d.line([xy(r, 0), xy(r, 8)], fill=ink, width=2)
    for c in range(9):
        if c in (0, 8):
            d.line([xy(0, c), xy(9, c)], fill=ink, width=2)
        else:
            d.line([xy(0, c), xy(4, c)], fill=ink, width=2)
            d.line([xy(5, c), xy(9, c)], fill=ink, width=2)
    for r0 in (0, 7):
        d.line([xy(r0, 3), xy(r0 + 2, 5)], fill=ink, width=2)
        d.line([xy(r0, 5), xy(r0 + 2, 3)], fill=ink, width=2)
    d.rectangle([xy(0, 0)[0] - 8, xy(0, 0)[1] - 8, xy(9, 8)[0] + 8, xy(9, 8)[1] + 8],
                outline=ink, width=2)

    f = ImageFont.truetype(FONT, int(s * 0.58))
    for r in range(10):
        for c in range(9):
            ch = grid[r][c]
            if not ch:
                continue
            x, y = xy(r, c)
            rad = int(s * 0.44)
            red = ch.isupper()
            col = (176, 44, 36) if red else (30, 28, 26)
            d.ellipse([x - rad, y - rad, x + rad, y + rad],
                      fill=(250, 246, 236), outline=col, width=3)
            name = NAME_RED[ch] if red else NAME_BLK[ch]
            bb = d.textbbox((0, 0), name, font=f)
            d.text((x - (bb[2] - bb[0]) / 2 - bb[0], y - (bb[3] - bb[1]) / 2 - bb[1]),
                   name, font=f, fill=col)

    if skew:
        k = skew
        src = [(0, 0), (W, 0), (W, H), (0, H)]
        dst = [(W * k * 0.6, H * k * 0.35), (W * (1 - k * 0.2), 0),
               (W, H * (1 - k * 0.15)), (W * k * 0.1, H)]
        im = im.transform((W, H), Image.Transform.PERSPECTIVE,
                          _coeffs(dst, src), Image.Resampling.BICUBIC,
                          fillcolor=(210, 205, 196))
    if noise:
        px = im.load()
        rnd = random.Random(7)
        for _ in range(W * H // 6):
            x, y = rnd.randrange(W), rnd.randrange(H)
            v = rnd.randint(-noise, noise)
            r0, g0, b0 = px[x, y]
            px[x, y] = (max(0, min(255, r0 + v)), max(0, min(255, g0 + v)), max(0, min(255, b0 + v)))
        im = im.filter(ImageFilter.GaussianBlur(0.6))
    return im


def _coeffs(src, dst):
    import numpy as np
    A, B = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, dtype=float), np.array(B, dtype=float)).tolist()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('fen')
    ap.add_argument('-o', '--out', default='/tmp/board.png')
    ap.add_argument('--flip', action='store_true')
    ap.add_argument('--skew', type=float, default=0.0)
    ap.add_argument('--noise', type=int, default=0)
    ap.add_argument('--size', type=int, default=64)
    a = ap.parse_args()
    if not os.path.exists(FONT):
        sys.exit('没有中文字体: ' + FONT)
    render(a.fen, a.flip, a.skew, a.noise, a.size).save(a.out)
    print(a.out)
