#!/usr/bin/env python3
"""照片识别: 本地专用 ONNX 棋盘模型。

    python3 tools/board_cv.py 棋盘.jpg        # 打印 JSON

纯 CPU、零 API 成本、照片不联网。它是产品的照片读盘主链路，不是 fallback。

它做的事和我们这条链路是同构的, 只是把"读盘"那一步换成了两段式神经网络:
  四角关键点 (RTMPose) → 透视矫正成俯视图 → 10×9 逐点 16 分类 (SwinV2)
后面那套 (方向投票 / 规则自检 / 确认盘) 完全复用。

★ 它还给两样用于把关的信息:
  1. **每个交叉点的置信度** —— 低置信的点直接进待核对
  2. **一个 `x` 类** = "这里有东西但不是能认的棋子" (被手挡住之类), 同样进待核对

★ 它不判方向。残局子少的时候会把红黑两端定反 (布棋盘那张就是), 但那正好被
   我们已有的"方向投票"自动修回来 —— 转反的局面帅将都出九宫, 规则一查就翻。

依赖 opencv + onnxruntime, 装在 cvmodel/.venv 里, 主服务不碰。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CVDIR = os.path.join(ROOT, 'cvmodel')
_VENV_CANDIDATES = [
    os.environ.get('XQ_CV_PYTHON'),
    os.path.join(CVDIR, '.venv', 'Scripts', 'python.exe'),
    os.path.join(CVDIR, '.venv', 'bin', 'python'),
]
VENV_PY = next((p for p in _VENV_CANDIDATES if p and os.path.exists(p)), '')
RUNNER = os.path.join(CVDIR, 'run_cv.py')
# 低于这个置信度的交叉点直接进待核对。0.5 是先验的起点, 还没调过。
LOW_CONF = float(os.environ.get('XQ_CV_LOW_CONF', '0.5'))


def available():
    return bool(VENV_PY) and os.path.exists(RUNNER)


def extract(image_path):
    """跟 board_vision.extract() 同形状的返回。图片必须是本地路径。"""
    if not available():
        return {'ok': False, 'error': 'CV 模型没装 (cvmodel/.venv)'}
    p = subprocess.run([VENV_PY, '-c', (
        'import json,sys; sys.path.insert(0, %r); import run_cv;'
        'r = run_cv.read_twoview(sys.argv[1]);'
        'print(json.dumps(r, ensure_ascii=False))' % CVDIR), image_path],
        capture_output=True, text=True, timeout=120, cwd=CVDIR)
    if p.returncode != 0 or not p.stdout.strip():
        return {'ok': False, 'error': 'CV 跑失败: ' + (p.stderr or '')[-300:]}
    raw = json.loads(p.stdout)
    if not raw:
        return {'ok': False, 'unreadable': True, 'error': '没找到棋盘 (四角关键点失败)'}

    # 它给的是摆正后的 10×9, 但**红黑两端可能定反** —— 交给规则投票
    ori, fen_board, chk = _best_orientation(raw['fen'])
    suspect, problems = set(), []
    flagged = set(suspect) | set(raw.get('unknown') or [])
    sc = raw.get('scores')
    if sc:
        flat = [c for row in sc for c in row]
        low = {i for i, v in enumerate(flat) if v is not None and v < LOW_CONF}
        # 方向如果被翻过, 置信度的下标也要跟着翻
        if ori == 'red_top':
            low = {89 - i for i in low}
        flagged |= low
    # 颜色归一化那一遍的分歧 —— 见 run_cv.read_twoview 顶上的说明。
    # 这一档专抓"字认对了、红黑认反了"那类错: 它们置信度 0.90+, 靠 LOW_CONF
    # 根本拦不住, 而那类错的后果是一枚子换了阵营 = 完全另一盘棋。
    dis = set(raw.get('disagree') or [])
    if ori == 'red_top':
        dis = {89 - i for i in dis}
    flagged |= dis
    for it in chk['issues']:
        flagged |= set(it.get('sqs') or [])
    hard = [i for i in chk['issues'] if i.get('hard')]

    # ★ 照片里红方在哪一侧 —— 用四个角点算, 不是用上面那个 ori。
    #   ori 说的是"这份网格要按哪个方向解释", 而网格本身已经被模型矫正过了,
    #   所以 ori 不等于"照片拍成什么样"。界面要按拍摄朝向画, 用错这个就会
    #   出现"照片里黑方朝着你, 画出来却是红方在下"。
    #   A0/A8 = 黑方底线两角, J0/J8 = 红方底线两角。
    #   另外: 方向投票如果把盘翻过来了, 说明角点的红黑标反了, 照片朝向也要跟着反。
    photo_ori = None
    kp = raw.get('keypoints')
    if kp and len(kp) == 4:
        black_y = (kp[0][1] + kp[1][1]) / 2
        red_y = (kp[2][1] + kp[3][1]) / 2
        photo_ori = 'red_top' if red_y < black_y else 'red_bottom'
        if ori == 'red_top':          # 规则把它翻过来了 = 角点标反了
            photo_ori = 'red_bottom' if photo_ori == 'red_top' else 'red_top'
    return {
        'ok': True, 'engine': 'cv',
        'fen': '%s w - - 0 1' % fen_board,
        'orientation': ori,
        'photo_orientation': photo_ori or ori,
        'clean': not hard and not problems,
        'issues': chk['issues'], 'shape_problems': problems,
        'uncertain': sorted(flagged), 'hint_side': chk.get('hint'),
        'note': raw.get('time', ''), 'attempts': 1,
        'model': 'chinese-chess-recognition (onnx)',
        'ms': 0, 'cost': 0.0,
    }


NAME = {'K': '红帅', 'A': '红仕', 'B': '红相', 'N': '红马', 'R': '红车', 'C': '红炮', 'P': '红兵',
        'k': '黑将', 'a': '黑士', 'b': '黑象', 'n': '黑马', 'r': '黑车', 'c': '黑炮', 'p': '黑卒'}


def _expand_fen(fen_board):
    cells = []
    for part in fen_board.split('/'):
        row = []
        for ch in part:
            row.extend([''] * int(ch) if ch.isdigit() else [ch])
        cells.extend((row + [''] * 9)[:9])
    return (cells + [''] * 90)[:90]


def _cells_to_fen(cells):
    rows = []
    for r in range(10):
        out, empty = '', 0
        for ch in cells[r * 9:(r + 1) * 9]:
            if not ch:
                empty += 1
            else:
                if empty:
                    out += str(empty)
                    empty = 0
                out += ch
        if empty:
            out += str(empty)
        rows.append(out)
    return '/'.join(rows)


def _validate(fen_board):
    p = subprocess.run(
        ['node', os.path.join(HERE, 'validate.js')],
        input=json.dumps({'fen': fen_board + ' w - - 0 1'}),
        capture_output=True, text=True, timeout=30)
    if p.returncode != 0 and not p.stdout:
        raise RuntimeError('自检没跑起来: ' + (p.stderr or '')[:300])
    return json.loads(p.stdout)


def _best_orientation(fen_board):
    direct = _cells_to_fen(_expand_fen(fen_board))
    rotated = _cells_to_fen(list(reversed(_expand_fen(fen_board))))
    candidates = []
    for orientation, board in [('red_bottom', direct), ('red_top', rotated)]:
        checked = _validate(board)
        hard = sum(1 for issue in checked.get('issues', []) if issue.get('hard'))
        candidates.append((hard, orientation, board, checked))
    _, orientation, board, checked = min(candidates, key=lambda item: item[0])
    return orientation, board, checked


if __name__ == '__main__':
    for a in sys.argv[1:]:
        print(json.dumps(extract(a), ensure_ascii=False, indent=1))
