# 棋子字体

`kai.woff2` 是 **霞鹜文楷 LXGW WenKai** (Medium) 的子集, 只保留了这 24 个字:

```
帅仕相马车炮兵将士象卒楚河汉界一二三四五六七八九
```

原字体: https://github.com/lxgw/LxgwWenKai
授权: SIL Open Font License 1.1

子集化命令:

```bash
python3 -m fontTools.subset LXGWWenKai-Medium.ttf \
  --text="帅仕相马车炮兵将士象卒楚河汉界一二三四五六七八九" \
  --flavor=woff2 --output-file=kai.woff2 --layout-features='' --no-hinting --desubroutinize
```

为什么要自带: 象棋子面上的字向来是楷体, 换成黑体立刻就不像棋子。
但楷体不是任何平台的默认字体, macOS 有 STKaiti, Windows 有 KaiTi,
Linux 和多数手机浏览器什么都没有, 会静默退回黑体。25 个字的子集只有 4.9KB,
比赌用户机器上有楷体划算得多。
