/* ================= 中国象棋规则 =================
   纯逻辑, 不碰 DOM, 不碰引擎。棋盘用一维 Int8Array(90), 下标 = row*9+col。
   row 0 是黑方底线 (屏幕最上), row 9 是红方底线。红为正数, 黑为负数。
   走法在内部一律用 [from, to] 两个下标表示, 只有跟引擎和记谱打交道时才转成字符串。 */

const W = 9, H = 10, NSQ = 90;

// 1 帅 2 仕 3 相 4 马 5 车 6 炮 7 兵
const K = 1, A = 2, B = 3, N = 4, R = 5, C = 6, P = 7;

const FEN_CH = { k: K, a: A, b: B, n: N, r: R, c: C, p: P };
const CH_FEN = { [K]: 'k', [A]: 'a', [B]: 'b', [N]: 'n', [R]: 'r', [C]: 'c', [P]: 'p' };

// 红黑各自的子名。红用"帅仕相兵", 黑用"将士象卒", 马车炮同名。
const NAME_RED   = { [K]: '帅', [A]: '仕', [B]: '相', [N]: '马', [R]: '车', [C]: '炮', [P]: '兵' };
const NAME_BLACK = { [K]: '将', [A]: '士', [B]: '象', [N]: '马', [R]: '车', [C]: '炮', [P]: '卒' };

// 红方记谱用汉字数字, 黑方用阿拉伯数字。这是通行棋谱的写法, 不是随便定的。
const NUM_RED = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const NUM_BLK = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

const rowOf = s => (s / 9) | 0;
const colOf = s => s % 9;
const sq = (r, c) => r * 9 + c;
const inBoard = (r, c) => r >= 0 && r < H && c >= 0 && c < W;

// 九宫: 列 3..5, 红 row 7..9, 黑 row 0..2。
// 上下界都要写死: 只写 r>=7 的话, 红仕从 d1 往前一步会算出 row 10 这个不存在的格子,
// 越界读 Int8Array 得到 undefined, 于是凭空多出两步棋 (起始局面 46 而不是 44)。
const inPalace = (r, c, side) =>
  c >= 3 && c <= 5 && (side > 0 ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2));
// 己方半场 (相/象不能过河)
const ownHalf = (r, side) => (side > 0 ? r >= 5 : r <= 4);

/* ---------- 局面 ---------- */

class Position {
  constructor(fen) { this.setFen(fen || START_FEN); }

  setFen(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board = new Int8Array(NSQ);
    let r = 0, c = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { r++; c = 0; continue; }
      if (ch >= '1' && ch <= '9') { c += +ch; continue; }
      const low = ch.toLowerCase();
      const t = FEN_CH[low];
      if (t) this.board[sq(r, c)] = (ch === low ? -t : t);
      c++;
    }
    this.side = (parts[1] === 'b') ? -1 : 1;   // 1 = 红走, -1 = 黑走
    this.halfmove = +(parts[4] || 0);
    this.fullmove = +(parts[5] || 1);
  }

  fen() {
    let s = '';
    for (let r = 0; r < H; r++) {
      let empty = 0;
      for (let c = 0; c < W; c++) {
        const p = this.board[sq(r, c)];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        const ch = CH_FEN[Math.abs(p)];
        s += p > 0 ? ch.toUpperCase() : ch;
      }
      if (empty) s += empty;
      if (r < H - 1) s += '/';
    }
    return `${s} ${this.side > 0 ? 'w' : 'b'} - - ${this.halfmove} ${this.fullmove}`;
  }

  clone() { const p = Object.create(Position.prototype); p.board = this.board.slice();
    p.side = this.side; p.halfmove = this.halfmove; p.fullmove = this.fullmove; return p; }

  kingSq(side) {
    for (let s = 0; s < NSQ; s++) if (this.board[s] === side * K) return s;
    return -1;
  }

  /* ---------- 伪合法走法 ---------- */
  // 只管走子规则, 不管走完自己是否被将。合法性交给 legalMoves 统一过滤。
  pseudoMoves(side) {
    const bd = this.board, out = [];
    const push = (from, to) => {
      const t = bd[to];
      if (t === 0 || (t > 0) !== (side > 0)) out.push([from, to]);
    };
    for (let s = 0; s < NSQ; s++) {
      const p = bd[s];
      if (!p || (p > 0) !== (side > 0)) continue;
      const t = Math.abs(p), r = rowOf(s), c = colOf(s);

      if (t === K) {
        for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nr = r + dr, nc = c + dc;
          if (inPalace(nr, nc, side)) push(s, sq(nr, nc));
        }
      } else if (t === A) {
        for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const nr = r + dr, nc = c + dc;
          if (inPalace(nr, nc, side)) push(s, sq(nr, nc));
        }
      } else if (t === B) {
        for (const [dr, dc] of [[2,2],[2,-2],[-2,2],[-2,-2]]) {
          const nr = r + dr, nc = c + dc;
          if (!inBoard(nr, nc) || !ownHalf(nr, side)) continue;
          if (bd[sq(r + dr / 2, c + dc / 2)]) continue;   // 塞象眼
          push(s, sq(nr, nc));
        }
      } else if (t === N) {
        for (const [dr, dc] of [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
          const nr = r + dr, nc = c + dc;
          if (!inBoard(nr, nc)) continue;
          // 蹩马腿: 长边方向上紧邻的那一格
          const lr = Math.abs(dr) === 2 ? r + dr / 2 : r;
          const lc = Math.abs(dc) === 2 ? c + dc / 2 : c;
          if (bd[sq(lr, lc)]) continue;
          push(s, sq(nr, nc));
        }
      } else if (t === R || t === C) {
        for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          let nr = r + dr, nc = c + dc;
          // 第一段: 一路空格
          while (inBoard(nr, nc) && !bd[sq(nr, nc)]) {
            out.push([s, sq(nr, nc)]);
            nr += dr; nc += dc;
          }
          if (!inBoard(nr, nc)) continue;
          if (t === R) { push(s, sq(nr, nc)); continue; }
          // 炮: 越过炮架之后, 找到的第一个子才能吃
          nr += dr; nc += dc;
          while (inBoard(nr, nc) && !bd[sq(nr, nc)]) { nr += dr; nc += dc; }
          if (inBoard(nr, nc)) push(s, sq(nr, nc));
        }
      } else if (t === P) {
        const fwd = side > 0 ? -1 : 1;          // 红方向上 (row 减小)
        const nr = r + fwd;
        if (inBoard(nr, c)) push(s, sq(nr, c));
        if (!ownHalf(r, side)) {                // 过河后才能横走
          for (const dc of [1, -1]) if (inBoard(r, c + dc)) push(s, sq(r, c + dc));
        }
      }
    }
    return out;
  }

  // 白脸将: 两个将帅同一纵线且中间无子, 这个局面非法
  kingsFace() {
    const a = this.kingSq(1), b = this.kingSq(-1);
    if (a < 0 || b < 0) return false;
    if (colOf(a) !== colOf(b)) return false;
    const c = colOf(a);
    for (let r = Math.min(rowOf(a), rowOf(b)) + 1; r < Math.max(rowOf(a), rowOf(b)); r++)
      if (this.board[sq(r, c)]) return false;
    return true;
  }

  inCheck(side) {
    const k = this.kingSq(side);
    if (k < 0) return true;
    for (const [, to] of this.pseudoMoves(-side)) if (to === k) return true;
    return false;
  }

  legalMoves(side) {
    side = side || this.side;
    const out = [];
    for (const mv of this.pseudoMoves(side)) {
      const nx = this.clone();
      nx.applyRaw(mv);
      if (!nx.inCheck(side) && !nx.kingsFace()) out.push(mv);
    }
    return out;
  }

  applyRaw([from, to]) {
    this.board[to] = this.board[from];
    this.board[from] = 0;
    this.side = -this.side;
  }

  apply(mv) {
    const cap = this.board[mv[1]];
    if (cap || Math.abs(this.board[mv[0]]) === P) this.halfmove = 0; else this.halfmove++;
    if (this.side < 0) this.fullmove++;
    this.applyRaw(mv);
    return cap;
  }

  // 'checkmate' 绝杀 | 'stalemate' 困毙 (象棋里也算输) | null
  terminal() {
    if (this.legalMoves(this.side).length) return null;
    return this.inCheck(this.side) ? 'checkmate' : 'stalemate';
  }
}

/* ---------- UCI 坐标 ---------- */
// 引擎用 a..i 表示列 (左到右), 1..10 表示行 (下到上)。row = 10 - rank。
const sqToUci = s => String.fromCharCode(97 + colOf(s)) + (10 - rowOf(s));
const uciToSq = u => sq(10 - parseInt(u.slice(1), 10), u.charCodeAt(0) - 97);
const moveToUci = ([f, t]) => sqToUci(f) + sqToUci(t);
const uciToMove = u => {
  const m = u.match(/^([a-i])(10|[1-9])([a-i])(10|[1-9])/);
  if (!m) return null;
  return [uciToSq(m[1] + m[2]), uciToSq(m[3] + m[4])];
};

/* ---------- 中文记谱 ----------
   红方纵线从右往左数一到九, 黑方从左往右数 1 到 9 (都是"从自己那侧看的右边起数")。
   我第一版把红方数反了, 所以这里写死一个函数, 别再在别处手算。 */
const fileNum = (col, side) => (side > 0 ? 9 - col : col + 1);
const numStr = (n, side) => (side > 0 ? NUM_RED[n] : NUM_BLK[n]);

function moveToChinese(pos, mv) {
  const [from, to] = mv;
  const p = pos.board[from];
  if (!p) return moveToUci(mv);
  const side = p > 0 ? 1 : -1, t = Math.abs(p);
  const name = (side > 0 ? NAME_RED : NAME_BLACK)[t];
  const fr = rowOf(from), fc = colOf(from), tr = rowOf(to), tc = colOf(to);

  // 同一纵线上有几个同种子: 有就改用 前/后 (或 前中后) 代替纵线号
  const sameFile = [];
  for (let r = 0; r < H; r++) if (pos.board[sq(r, fc)] === p) sameFile.push(r);
  let head;
  if (sameFile.length >= 2) {
    // "前" 指更靠近对方底线的那个
    sameFile.sort((a, b) => side > 0 ? a - b : b - a);
    const idx = sameFile.indexOf(fr);
    const tags = sameFile.length === 2 ? ['前', '后']
               : sameFile.length === 3 ? ['前', '中', '后']
               : sameFile.map((_, i) => numStr(i + 1, side));
    head = tags[idx] + name;
  } else {
    head = name + numStr(fileNum(fc, side), side);
  }

  if (tr === fr) return head + '平' + numStr(fileNum(tc, side), side);

  const fwd = side > 0 ? (tr < fr) : (tr > fr);
  const verb = fwd ? '进' : '退';
  // 车炮兵将走直线, 报的是步数; 马相仕走斜线, 报的是落点纵线
  const straight = (t === R || t === C || t === P || t === K);
  const arg = straight ? Math.abs(tr - fr) : fileNum(tc, side);
  return head + verb + numStr(arg, side);
}

/* ---------- 谁在打谁 ----------
   pseudoMoves 不能直接拿来当攻击图: 炮沿空格滑过去的那些格子它并不能吃,
   真正能吃的只有隔一个炮架之后的第一个子。同理"防守"也走同一条规则,
   炮隔着炮架保护自己人和隔着炮架吃对方是同一件事。

   返回 90 个数组, 第 s 个是 side 方所有能打到 s 的子, 每项 {t, from}。
   带上 from 是因为界面要从攻击者那一格拉线过来: 只知道"有一个炮在打它"
   画不出线, 得知道是哪个炮。 */
function bearers(pos, side) {
  const bd = pos.board;
  const out = Array.from({ length: NSQ }, () => []);
  let src = -1;
  const add = (to, t) => { if (to >= 0 && to < NSQ) out[to].push({ t, from: src }); };

  for (let s = 0; s < NSQ; s++) {
    const p = bd[s];
    if (!p || (p > 0) !== (side > 0)) continue;
    const t = Math.abs(p), r = rowOf(s), c = colOf(s);
    src = s;

    if (t === K) {
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]])
        if (inPalace(r + dr, c + dc, side)) add(sq(r + dr, c + dc), t);
    } else if (t === A) {
      for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]])
        if (inPalace(r + dr, c + dc, side)) add(sq(r + dr, c + dc), t);
    } else if (t === B) {
      for (const [dr, dc] of [[2,2],[2,-2],[-2,2],[-2,-2]]) {
        const nr = r + dr, nc = c + dc;
        if (!inBoard(nr, nc) || !ownHalf(nr, side)) continue;
        if (bd[sq(r + dr / 2, c + dc / 2)]) continue;
        add(sq(nr, nc), t);
      }
    } else if (t === N) {
      for (const [dr, dc] of [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
        const nr = r + dr, nc = c + dc;
        if (!inBoard(nr, nc)) continue;
        const lr = Math.abs(dr) === 2 ? r + dr / 2 : r;
        const lc = Math.abs(dc) === 2 ? c + dc / 2 : c;
        if (bd[sq(lr, lc)]) continue;
        add(sq(nr, nc), t);
      }
    } else if (t === R) {
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        let nr = r + dr, nc = c + dc;
        while (inBoard(nr, nc) && !bd[sq(nr, nc)]) { nr += dr; nc += dc; }
        if (inBoard(nr, nc)) add(sq(nr, nc), t);
      }
    } else if (t === C) {
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        let nr = r + dr, nc = c + dc;
        while (inBoard(nr, nc) && !bd[sq(nr, nc)]) { nr += dr; nc += dc; }   // 找炮架
        if (!inBoard(nr, nc)) continue;
        nr += dr; nc += dc;
        while (inBoard(nr, nc) && !bd[sq(nr, nc)]) { nr += dr; nc += dc; }
        if (inBoard(nr, nc)) add(sq(nr, nc), t);
      }
    } else if (t === P) {
      const fwd = side > 0 ? -1 : 1;
      if (inBoard(r + fwd, c)) add(sq(r + fwd, c), t);
      if (!ownHalf(r, side)) for (const dc of [1, -1]) if (inBoard(r, c + dc)) add(sq(r, c + dc), t);
    }
  }
  return out;
}

// 只用来比"谁换谁划算", 不是引擎的估值
const PIECE_VAL = { [K]: 1000, [R]: 9, [C]: 4.5, [N]: 4, [B]: 2, [A]: 2, [P]: 1 };

/* 盘上有哪些子是松的。
   'loose'  = 白丢: 没人守, 或者对方用更便宜的子就能换掉它
   'press'  = 有压力: 守得住但打的人比守的人多
   象棋手在盘上第一眼扫的就是这个, 引擎不会告诉你 (它只给一个总分)。 */
/* 控制图: 如果对方的子站到这个点上, 我能不能吃掉它。
   和 bearers() 不是一回事, 这一点之前搞混了 ——
   bearers 回答的是"谁正在打谁的**子**", 所以车只登记射线上第一个有子的格,
   中间的空格一个都不登记。拿它画"控制"就等于说车不控制自己射线上的空格,
   而车线正是象棋里最要紧的控制。(Codex 2026-08-23 指出。)

   逐个兵种的判据都是同一句话: **对方的子站上来我吃不吃得掉。**
     车  射线上直到第一个有子的格为止, 空格和那个子都算 (子站上来就成了第一个)
     炮  **只**算中间恰好隔着一个子的格。空格站上子会变成炮架而不是靶子,
         所以炮不控制它前面的空格 —— 这条和车正相反, 也是炮最容易被人算错的地方
     马  蹩腿之后的八个落点
     其余 走法即吃法, 和 bearers 一致 */
function controlCount(pos, side) {
  const bd = pos.board;
  const out = new Int8Array(NSQ);
  // 一、其余兵种 (走法即吃法): bearers 已经算好了, 但要排掉车和炮
  const b = bearers(pos, side);
  for (let i = 0; i < NSQ; i++)
    for (const x of b[i]) if (x.t !== R && x.t !== C) out[i]++;

  // 二、车: 射线上直到第一个有子的格为止, 空格和那个子都算
  for (let s = 0; s < NSQ; s++) {
    const p = bd[s];
    if (!p || (p > 0) !== (side > 0) || Math.abs(p) !== R) continue;
    const r = rowOf(s), c = colOf(s);
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      let nr = r + dr, nc = c + dc;
      while (inBoard(nr, nc)) {
        out[sq(nr, nc)]++;
        if (bd[sq(nr, nc)]) break;
        nr += dr; nc += dc;
      }
    }
  }

  // 三、炮: 只算隔着恰好一个子的那些格 (空格和第一个子都算)
  for (let s = 0; s < NSQ; s++) {
    const p = bd[s];
    if (!p || (p > 0) !== (side > 0) || Math.abs(p) !== C) continue;
    const r = rowOf(s), c = colOf(s);
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      let nr = r + dr, nc = c + dc, screens = 0;
      while (inBoard(nr, nc)) {
        const occ = bd[sq(nr, nc)];
        if (screens === 1) out[sq(nr, nc)]++;   // 过了架子, 这一格归它控制
        if (occ) { screens++; if (screens === 2) break; }
        nr += dr; nc += dc;
      }
    }
  }
  return out;
}

function looseSquares(pos) {
  const br = { 1: bearers(pos, 1), '-1': bearers(pos, -1) };
  const out = [];
  for (let s = 0; s < NSQ; s++) {
    const p = pos.board[s];
    if (!p) continue;
    const side = p > 0 ? 1 : -1, t = Math.abs(p);
    if (t === K) continue;                       // 将帅另有一套 (被将), 不算挂子
    const att = br[-side][s], def = br[side][s];
    if (!att.length) continue;
    const cheapest = Math.min(...att.map(x => PIECE_VAL[x.t]));
    let kind = null;
    if (!def.length) kind = 'loose';
    else if (cheapest < PIECE_VAL[t]) kind = 'loose';
    else if (att.length > def.length) kind = 'press';
    if (kind) out.push({ sq: s, kind, att, def, val: PIECE_VAL[t] });
  }
  return out;
}

/* 局面指纹: 只看子力布局和轮谁走, 不看回合数。
   重复判定要的是"同一个局面又出现了", 手数不是局面的一部分。 */
const posKey = p => p.fen().split(' ').slice(0, 2).join(' ');

/* ---------- 长将判负 ----------
   中国象棋和国际象棋在这里分道扬镳: 三次重复**不是**自动和棋。
   一方如果靠不停将军来逼平, 那是长将, **判负**。

   判据 (取常见的通用规则, 不含各地细则):
   局面第三次出现时, 回看构成这个循环的那一段着法 —— 某一方在循环里**每一手都在
   将军**, 那一方判负; 两方都长将则和。

   ★ 只做长将, **不做长捉**。长捉 (反复捉子逼和) 的判定要区分"捉"和"跟", 要分
   有根无根, 各地规则还不一致, 那是一整套细则不是一个函数。所以循环里没有一方
   构成长将时, 这里返回 'draw', 界面照旧提示重复而不替人裁定。

   hist: [{ fenBefore, uci, side }], 和 app.js 里的棋谱同构。
   返回 null (还没三次重复) / { loser } / { draw: true }。 */
function repetitionVerdict(hist, cur) {
  const key = posKey(cur);
  // 找出这个局面之前出现过的位置 (走这一手**之前**的局面)
  const at = [];
  for (let i = 0; i < hist.length; i++) {
    if (posKey(new Position(hist[i].fenBefore)) === key) at.push(i);
  }
  if (at.length < 2) return null;          // 加上当前这次才第三次

  // 循环 = 从最早那次到现在之间的所有着法
  const from = at[at.length - 2];
  const seg = hist.slice(from);
  if (!seg.length) return null;

  // 每一方在循环里是不是每一手都在将军
  const allCheck = { 1: true, '-1': true }, moved = { 1: false, '-1': false };
  for (const h of seg) {
    const before = new Position(h.fenBefore);
    const mv = uciToMove(h.uci);
    if (!mv) return null;
    const after = new Position(h.fenBefore);
    after.apply(mv);
    const side = h.side;
    moved[side] = true;
    // 走完之后对方是不是被将
    if (!after.inCheck(-side)) allCheck[side] = false;
  }
  const redPerp = moved[1] && allCheck[1];
  const blkPerp = moved[-1] && allCheck[-1];
  if (redPerp && !blkPerp) return { loser: 1 };
  if (blkPerp && !redPerp) return { loser: -1 };
  return { draw: true };
}

/* ---------- 局面自检 ----------
   给"从外面搬进来的局面"用 —— 照片识别、手工摆棋、别人贴的 FEN。

   ★ 这套约束是白拿的, 而且强得出奇。象棋里有五类子的**可达格集合是固定的**:
   仕只有 5 个点, 相只有 7 个, 兵过河前只能待在自己出发的那一列 (过河前不能横走),
   王只在九宫内, 双王不能照面。也就是说 32 枚子里有 22 枚的位置受硬约束。

   这正好对上识别的失败模式: 认字很少错 ("馬"和"车"谁都认得), 错的是**落到哪个
   交叉点** —— 而错格几乎必然把某枚受约束的子挪到一个它到不了的地方。所以不需要
   模型自己判断对不对, 让它交答案, 这里逐条查。查出来的 code 回灌给它重问一次,
   比重试一遍碰运气有用得多。

   返回 [{ code, msg, sqs, hard }]。hard = 这个局面根本不可能在合法棋局里出现。 */

// 仕/相 的可达格 (side: 1 红 / -1 黑)。列出来比推导清楚, 而且不会写错。
function advisorSquares(side) {
  return side > 0 ? [sq(9,3), sq(9,5), sq(8,4), sq(7,3), sq(7,5)]
                  : [sq(0,3), sq(0,5), sq(1,4), sq(2,3), sq(2,5)];
}
function elephantSquares(side) {
  return side > 0 ? [sq(9,2), sq(9,6), sq(7,0), sq(7,4), sq(7,8), sq(5,2), sq(5,6)]
                  : [sq(0,2), sq(0,6), sq(2,0), sq(2,4), sq(2,8), sq(4,2), sq(4,6)];
}

const MAX_OF = { [K]: 1, [A]: 2, [B]: 2, [N]: 2, [R]: 2, [C]: 2, [P]: 5 };

function positionIssues(pos) {
  const out = [], bd = pos.board;
  const nameOf = (side, t) => (side > 0 ? NAME_RED : NAME_BLACK)[t];
  const add = (code, msg, sqs, hard = true) => out.push({ code, msg, sqs: sqs || [], hard });

  for (const side of [1, -1]) {
    const who = side > 0 ? '红' : '黑';
    const mine = [];
    for (let s = 0; s < NSQ; s++) if (bd[s] && (bd[s] > 0) === (side > 0)) mine.push(s);

    // 子数上限
    const cnt = {};
    for (const s of mine) { const t = Math.abs(bd[s]); cnt[t] = (cnt[t] || 0) + 1; }
    for (const t of [K, A, B, N, R, C, P]) {
      if ((cnt[t] || 0) > MAX_OF[t])
        add('count', `${who}方${nameOf(side, t)}有 ${cnt[t]} 个, 最多 ${MAX_OF[t]}`,
            mine.filter(s => Math.abs(bd[s]) === t));
    }

    // 王: 恰好一个, 且在九宫内
    const kings = mine.filter(s => Math.abs(bd[s]) === K);
    if (kings.length === 0) add('noking', `盘上没有${who}方的${nameOf(side, K)}`, []);
    for (const s of kings) {
      if (!inPalace(rowOf(s), colOf(s), side))
        add('kingout', `${who}方${nameOf(side, K)}在九宫之外`, [s]);
    }

    // 仕/相 的可达格
    const advOk = new Set(advisorSquares(side)), eleOk = new Set(elephantSquares(side));
    for (const s of mine) {
      const t = Math.abs(bd[s]);
      if (t === A && !advOk.has(s))
        add('advisor', `${who}方${nameOf(side, A)}到不了这个点 (只有 5 个点)`, [s]);
      if (t === B && !eleOk.has(s))
        add('elephant', `${who}方${nameOf(side, B)}到不了这个点 (只有 7 个点)`, [s]);
      if (t === P) {
        const r = rowOf(s);
        // 兵不可能出现在自己河界后面 (它只往前走)
        if (side > 0 ? r > 6 : r < 3)
          add('pawnback', `${who}方${nameOf(side, P)}在自己的河界后面`, [s]);
        // 过河前不能横走, 所以还没过河的兵必须留在出发的那一列 (偶数列)
        else if ((side > 0 ? r >= 5 : r <= 4) && colOf(s) % 2 === 1)
          add('pawnfile', `${who}方${nameOf(side, P)}还没过河, 不可能在这一列`, [s]);
      }
    }
    if (mine.length > 16) add('total', `${who}方有 ${mine.length} 枚子, 最多 16 枚`, mine);
  }

  // 双王照面: 这个局面在合法棋局里不可能存在 (谁走成这样谁就已经输了)
  const kr = pos.kingSq(1), kb = pos.kingSq(-1);
  if (kr >= 0 && kb >= 0 && colOf(kr) === colOf(kb)) {
    let blocked = false;
    const c = colOf(kr);
    for (let r = Math.min(rowOf(kr), rowOf(kb)) + 1; r < Math.max(rowOf(kr), rowOf(kb)); r++)
      if (bd[sq(r, c)]) { blocked = true; break; }
    if (!blocked) add('facing', '帅将照面, 中间没有子', [kr, kb]);
  }
  return out;
}

/* 轮谁走从照片里恢复不出来 —— 但有时候局面自己会说。
   一方正在被将, 那必然轮它走 (否则上一手是对方留着自己被将, 不合法)。
   返回 1 / -1 / null。这是**提示**, 不是结论: 没被将的时候无从判断。 */
function sideToMoveHint(pos) {
  const rc = pos.inCheck(1), bc = pos.inCheck(-1);
  if (rc && !bc) return 1;
  if (bc && !rc) return -1;
  return null;
}

if (typeof module !== 'undefined') module.exports = {
  Position, START_FEN, W, H, NSQ, K, A, B, N, R, C, P,
  positionIssues, sideToMoveHint, advisorSquares, elephantSquares,
  sq, rowOf, colOf, sqToUci, uciToSq, moveToUci, uciToMove, moveToChinese,
  NAME_RED, NAME_BLACK, fileNum, numStr,
  bearers, controlCount, looseSquares, PIECE_VAL, posKey, repetitionVerdict,
};
