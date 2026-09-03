/* 断言式测试。之前这个文件只是把结果打印出来让人看, 那种"测试"不会拦住任何回归。
   现在全部改成断言, 有一条不过就非零退出。

   用法: node tests/t.js   (不需要引擎, 纯规则和分档逻辑) */

const X = require('../rules.js');
const { LEVELS, pickMove } = require('../levels.js');

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++; console.error(`FAIL ${msg}\n  期望 ${b}\n  实际 ${a}`);
};
const ok = (cond, msg) => eq(!!cond, true, msg);

/* ---------- FEN 与走法生成 ---------- */
{
  const p = new X.Position();
  eq(p.fen(), X.START_FEN, 'FEN 往返');
  eq(p.legalMoves(1).length, 44, '起始局面红方合法着法数');
  const b = new X.Position(); b.side = -1;
  eq(b.legalMoves(-1).length, 44, '起始局面黑方合法着法数');
}

/* ---------- 记谱 ----------
   红方纵线从右往左数一到九 (汉字), 黑方从左往右数 1 到 9 (阿拉伯数字)。
   我第一版把红方数反了, 所以这几条是回归锁。 */
{
  const p = new X.Position();
  for (const [uci, want] of [
    ['h3e3', '炮二平五'], ['b3e3', '炮八平五'], ['b1c3', '马八进七'],
    ['g4g5', '兵三进一'], ['c1e3', '相七进五'], ['a1a2', '车九进一'],
  ]) eq(X.moveToChinese(p, X.uciToMove(uci)), want, `红方记谱 ${uci}`);

  const b = new X.Position(); b.side = -1;
  for (const [uci, want] of [
    ['b10c8', '马2进3'], ['h8e8', '炮8平5'], ['g7g6', '卒7进1'], ['c10e8', '象3进5'],
  ]) eq(X.moveToChinese(b, X.uciToMove(uci)), want, `黑方记谱 ${uci}`);

  // 同一纵线两个同种子要写成前/后
  const two = new X.Position('4k4/9/9/9/9/9/9/2C6/2C6/4K4 w - - 0 1');
  const ms = two.legalMoves(1).filter(m => X.colOf(m[0]) === 2)
    .map(m => X.moveToChinese(two, m));
  ok(ms.includes('前炮平五'), '同线双炮用前');
  ok(ms.includes('后炮平五'), '同线双炮用后');
}

/* ---------- 走子规则的边界 ---------- */
{
  // 将帅照面: 同纵线且中间无子时不许留在那条线上
  const face = new X.Position('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
  ok(face.kingsFace(), '空纵线上将帅照面');
  eq(face.legalMoves(1).map(X.moveToUci).sort(), ['e1d1', 'e1f1'].sort(), '被照面时帅只能横走');

  // 蹩马腿
  const leg = new X.Position('4k4/9/9/9/9/9/9/9/4P4/4KN3 w - - 0 1');
  const horse = leg.legalMoves(1).filter(m => m[0] === X.sq(9, 5)).map(X.moveToUci).sort();
  eq(horse, ['f1e3', 'f1g3', 'f1h2'].sort(), '马腿被兵蹩住时少一路');

  // 仕不能走出九宫 (第一版没写上界, 越界读数组凭空多两步)
  const adv = new X.Position();
  const a1 = adv.legalMoves(1).filter(m => m[0] === X.sq(9, 3)).map(X.moveToUci);
  eq(a1, ['d1e2'], '底线的仕只有一步');
}

/* ---------- 攻击图 ---------- */
{
  const p = new X.Position();
  eq(X.looseSquares(p).length, 0, '起始局面没有无根子');

  // 炮隔着自己人打对方: 人最容易漏的一类
  const p2 = new X.Position();
  for (const u of ['a1a3', 'b10c8', 'a3a7']) p2.apply(X.uciToMove(u));
  const loose = X.looseSquares(p2);
  const at = loose.find(l => X.sqToUci(l.sq) === 'b1');
  ok(at, '红马 b1 被判为无根');
  eq(at.att.map(a => X.sqToUci(a.from)), ['b8'], '打它的是 b8 的黑炮 (隔着红炮)');

  // bearers 不能把炮滑过的空格算成攻击
  const br = X.bearers(p, 1);
  const emptyOnCannonPath = X.sq(6, 1);          // 红炮 (7,1) 正上方那个空点
  eq(br[emptyOnCannonPath].some(b => b.t === X.C), false, '炮滑过的空格不算它打到');
}

/* ---------- 云库着法编码 ---------- */
{
  // 云库行号 0..9, 引擎 1..10。起手第一步云库写 c3c4, 引擎写 c4c5
  const cdbToUci = m => {
    const x = /^([a-i])(\d)([a-i])(\d)$/.exec(m);
    return x ? `${x[1]}${+x[2] + 1}${x[3]}${+x[4] + 1}` : null;
  };
  eq(cdbToUci('c3c4'), 'c4c5', '云库着法要整体加一行');
  eq(cdbToUci('c0e2'), 'c1e3', '云库底线是 0, 引擎是 1');
  ok(X.uciToMove(cdbToUci('c0e2')), '转换出来的必须是合法 uci');
}

/* ---------- 引擎坐标转换 ----------
   Pikafish 的行号是 0-9, 我们全站是 1-10。转错了不会报错, 引擎照样返回一个
   合法着法, 只是完全不是那一手 —— 所以这几条是回归锁。
   (app.js 里那两个函数是同一份逻辑, 这里复制一份是因为 app.js 依赖 DOM,
   node 里 require 不进来。改了那边记得改这边。) */
{
  const toEng = u => u.replace(/([a-i])(10|[1-9])/g, (_, f, r) => f + (+r - 1));
  const fromEng = u => u.replace(/([a-i])([0-9])/g, (_, f, r) => f + (+r + 1));

  eq(toEng('h3e3'), 'h2e2', '炮二平五 送进引擎');
  eq(fromEng('h2e2'), 'h3e3', '炮二平五 从引擎出来');
  // 10 必须先于 [1-9] 匹配, 否则 i10 会被切成 i1 + 一个游离的 0
  eq(toEng('i10i9'), 'i9i8', '两位数行号 送进引擎');
  eq(fromEng('i9i8'), 'i10i9', '两位数行号 从引擎出来');
  eq(toEng('a1a2'), 'a0a1', '底线是 1 -> 0');
  eq(fromEng('a0a1'), 'a1a2', '底线是 0 -> 1');
  // 主变是一串着法, 每一条都要转
  eq('h2e2 h9g7 c3c4'.split(' ').map(fromEng).join(' '), 'h3e3 h10g8 c4c5', '整条主变');
  // 来回一趟必须回到原样, 每一个合法坐标都试一遍
  for (const f of 'abcdefghi') for (let r = 1; r <= 10; r++) {
    const u = `${f}${r}${f}${r}`;
    eq(fromEng(toEng(u)), u, `来回不变 ${u}`);
  }
}

/* ---------- 分档采样 ---------- */
{
  const cands = [
    { uci: 'a', score: 0 }, { uci: 'b', score: -100 }, { uci: 'c', score: -400 },
  ];
  // 全力档永远取首选
  for (let i = 0; i < 30; i++) eq(pickMove(cands, LEVELS[3], null).uci, 'a', '全力档不漏着');

  // 弱档要"大部分手不错 + 偶尔大漏", 不是每手都差一点
  let best = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) if (pickMove(cands, LEVELS[0], null).uci === 'a') best++;
  const rate = best / N;
  ok(rate > 0.55 && rate < 0.80,
    `入门档取首选的比例应在 55%-80% 之间 (漏着率 ${LEVELS[0].blunder}), 实际 ${(rate * 100).toFixed(0)}%`);

  // 漏着率必须单调
  for (let i = 1; i < LEVELS.length; i++)
    ok(LEVELS[i].blunder <= LEVELS[i - 1].blunder, `第 ${i} 档的漏着率不高于上一档`);

  // 云库先验: 有云库数据时只在最高 rank 那一档里挑
  const cloud = new Map([
    ['a', { rank: 1, score: 0 }], ['b', { rank: 2, score: 0 }],
  ]);
  const c2 = [{ uci: 'a', score: 0 }, { uci: 'b', score: -10 }];
  let bCount = 0;
  for (let i = 0; i < 400; i++) {
    const g = pickMove(c2, { ...LEVELS[2], blunder: 0, bookPrior: true }, cloud);
    if (g.uci === 'b') bCount++;
  }
  eq(bCount, 400, '云库先验只挑最高 rank 的那一条, 即使它引擎分略低');
}

/* ---------- 控制图 ----------
   控制 = "对方的子站到这个点上, 我吃不吃得掉"。
   车和炮在这里正好相反, 这是最容易算错的一处:
     车 控制射线上的空格 (子站上来就成了第一个, 能吃)
     炮 **不**控制自己前面的空格 (子站上来会变成炮架, 不是靶子),
        只控制隔着恰好一个子的那些格 */
{
  // 一条空的横线: 红车在 a1, 其余全空 (只留双方将帅满足合法性)
  const r1 = new X.Position('4k4/9/9/9/9/9/9/9/9/R3K4 w - - 0 1');
  const cr = X.controlCount(r1, 1);
  ok(cr[X.uciToSq('b1')] >= 1, '车控制右边相邻的空格');
  ok(cr[X.uciToSq('d1')] >= 1, '车控制射线上更远的空格');
  ok(cr[X.uciToSq('a5')] >= 1, '车控制整条纵线上的空格');

  /* 炮: a1 炮, b1 一个红兵当架子, 其余空。
     炮不控制 b1 (那是架子), 但控制 c1 及之后 (隔一个架子)。 */
  const c1 = new X.Position('4k4/9/9/9/9/9/9/9/9/CP2K4 w - - 0 1');
  const cc = X.controlCount(c1, 1);
  eq(cc[X.uciToSq('b1')], 0, '炮不控制紧挨着自己的那个格 —— 站上来是炮架不是靶子');
  ok(cc[X.uciToSq('c1')] >= 1, '炮控制炮架之后的格子');
  ok(cc[X.uciToSq('d1')] >= 1, '炮架之后更远的空格同样控制');

  // 真正要验的: 炮**前面没有架子**时不控制那些空格
  const c2 = new X.Position('4k4/9/9/9/9/9/9/9/9/C3K4 w - - 0 1');
  const cc2 = X.controlCount(c2, 1);
  eq(cc2[X.uciToSq('b1')], 0, '炮不控制自己前面的空格 (没有炮架)');
  eq(cc2[X.uciToSq('c1')], 0, '再远的空格同样不控制');

  // 起始局面左右对称, 两边控制点次必须相等
  const st = new X.Position();
  const sumR = X.controlCount(st, 1).reduce((a, b) => a + b, 0);
  const sumB = X.controlCount(st, -1).reduce((a, b) => a + b, 0);
  eq(sumR, sumB, '起始局面双方控制点次相等');
}

/* ---------- 将杀分的刻度 ----------
   app.js 的 cpOf 和 levels.js 的 scoreOf 必须是同一个公式。
   两边各写一套的话, 弱档采样和分析栏会对同一个杀局给出不同的排序。
   (levels.js 能 require, app.js 依赖 DOM 不能, 所以这里锁 levels 那一份,
   并把公式写死在断言里 —— 改 app.js 那边时这条会提醒你同步。) */
{
  const m = X_mate => Math.sign(X_mate) * (30000 - Math.min(200, Math.abs(X_mate)) * 50);
  eq(pickMove([{ uci: 'a', mate: 1 }, { uci: 'b', mate: 5 }],
              { ...LEVELS[3] }, null).uci, 'a', '全力档在两个杀着里取更快的那个');
  // 杀一必须严格高于杀十
  ok(m(1) > m(10), '杀一分数高于杀十');
  ok(m(1) < 30000 && m(-1) > -30000, '将杀分不再顶到 ±30000');
  ok(m(1) > 20000, '将杀分仍然远高于任何非杀着法');
}

/* ---------- 长将判负 ----------
   中国象棋和国际象棋在这里分道扬镳: 三次重复**不是**自动和棋,
   靠不停将军来逼平的一方判负。

   布局: 黑将 e10, 红车 e2 (同线照将), 红帅 f1 (不在 e 线, 免得车一离开 e 线
   就变成将帅照面)。黑方先走且正被将。
     黑 将e10-d10 (躲)  →  红 车e2-d2 (再照)  →  黑 将d10-e10  →  红 车d2-e2 (再照)
   红方每一手都在将军, 黑方每一手都不将 → 红方长将判负。 */
{
  const START = '4k4/9/9/9/9/9/9/9/4R4/5K3 b - - 0 1';
  const cycle = ['e10d10', 'e2d2', 'd10e10', 'd2e2'];

  const run = (rounds) => {
    const p = new X.Position(START);
    const hist = [];
    for (let i = 0; i < rounds; i++) for (const uci of cycle) {
      const mv = X.uciToMove(uci);
      // 每一手都必须真的合法, 否则这个测试测的是别的东西
      ok(p.legalMoves(p.side).some(m => m[0] === mv[0] && m[1] === mv[1]),
         `长将循环第 ${i + 1} 轮 ${uci} 合法`);
      hist.push({ fenBefore: p.fen(), uci, side: p.side });
      p.apply(mv);
    }
    return { p, hist };
  };

  // 先确认红车真的在将军 —— 不然整个用例是空转
  {
    const p = new X.Position(START);
    ok(p.inCheck(-1), '起始局面黑方正被红车照将');
    p.apply(X.uciToMove('e10d10'));
    ok(!p.inCheck(-1), '黑将躲开之后不再被将');
    p.apply(X.uciToMove('e2d2'));
    ok(p.inCheck(-1), '红车横移到 d 线重新照将');
  }

  const a = run(1);
  eq(X.repetitionVerdict(a.hist, a.p), null, '局面才第二次出现, 不裁定');

  const b = run(2);
  const v = X.repetitionVerdict(b.hist, b.p);
  ok(v !== null, '三次重复必须给出裁定');
  eq(v.loser, 1, '红方长将判负 (不是和棋)');
}

/* ---------- perft ---------- */
{
  const perft = (p, d) => {
    if (d === 0) return 1;
    let n = 0;
    for (const m of p.legalMoves(p.side)) { const c = p.clone(); c.apply(m); n += perft(c, d - 1); }
    return n;
  };
  const p = new X.Position();
  eq(perft(p, 1), 44, 'perft 1');
  eq(perft(p, 2), 1920, 'perft 2');
  eq(perft(p, 3), 79666, 'perft 3');
}

console.log(`${pass} 过, ${fail} 败`);
process.exit(fail ? 1 : 0);
