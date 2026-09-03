#!/usr/bin/env bash
# 重新生成页面自带的字体子集。
#
# 为什么要自带: 页面开了 COEP require-corp (SharedArrayBuffer 的前提, 没它引擎
# 起不来), 于是任何跨源的 @import / 字体请求都会被浏览器直接挡掉。
# Google Fonts 那条 @import 在这个页面上是死的。
#
# 拉丁字体只取 latin 子集, 中文按页面里真正会出现的字子集化。
# ★ 改了界面文案或者新增了会显示的汉字, 要重跑这个脚本, 否则新字会退回系统字体。
set -euo pipefail
cd "$(dirname "$0")"

# 1. 页面里真正会显示的汉字 (跳过注释)
python3 - <<'PY'
import re, pathlib
def strip(t):
    t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
    t = re.sub(r'(?m)^\s*//.*$', '', t)
    t = re.sub(r'<!--.*?-->', '', t, flags=re.S)
    return t
chars = set()
for f in ['../../index.html', '../../app.js', '../../rules.js']:
    for ch in strip(pathlib.Path(f).read_text()):
        if '一' <= ch <= '鿿' or '　' <= ch <= '〿' or '＀' <= ch <= '￯':
            chars.add(ch)
chars |= set('帅仕相马车炮兵将士象卒前中后平进退一二三四五六七八九十红黑第手层局和胜负')
pathlib.Path('/tmp/xq-cjk.txt').write_text(''.join(sorted(chars)))
print('glyphs:', len(chars))
PY

# 2. Noto Serif SC (思源宋体) -- 界面正文与记谱
#    源: https://github.com/google/fonts/raw/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf
for w in 400 600; do
  python3 -m fontTools.varLib.instancer /tmp/nssc.ttf wght=$w -o /tmp/nssc$w.ttf >/dev/null
  python3 -m fontTools.subset /tmp/nssc$w.ttf --text-file=/tmp/xq-cjk.txt \
    --flavor=woff2 --output-file=notoserifsc-$w.woff2 --layout-features='' --no-hinting
done

# 3. 棋子字 -- 霞鹜文楷 LXGW WenKai (OFL), 只要盘面上会出现的 24 个字
#    源: https://github.com/lxgw/LxgwWenKai/releases -> LXGWWenKai-Medium.ttf
python3 -m fontTools.subset /tmp/wk.ttf \
  --text="帅仕相马车炮兵将士象卒楚河汉界一二三四五六七八九" \
  --flavor=woff2 --output-file=kai.woff2 --layout-features='' --no-hinting --desubroutinize

# 4. 拉丁字体从 Google Fonts 取 latin 子集 (Space Grotesk / Geist Mono / Cinzel)
#    见本目录 README 里那段 python, 一次性活, 不常跑。
ls -la *.woff2
