/* ================= 难度分档 =================
   独立成一个文件, 因为 tests/bench.js 必须跑**同一份**逻辑。
   分档模型和跑分脚本各留一份拷贝的话, 跑出来的分不代表页面上的行为。 */

/* 难度分档。
   ★ 这里换过一次模型, 原因值得写下来。

   第一版是对引擎分数做 softmax, 温度越高越飘。问题是**人的错误不是均匀撒开的**。
   真人的模式是"大部分手不错 + 偶尔一个大漏", 而恒温采样给出的是"每一手都差一点" ——
   它从来下不出一段好棋。跟它下的感觉是"这机器一直在犯小错", 不是"这人水平一般
   但偶尔崩一下"。手感完全不对。

   现在按**漏着率**建模: 绝大多数手取接近最优的, 只以概率 blunder 真的走坏一手,
   坏的幅度落在 badLoss 这个区间里。档位调的是犯错频率和幅度, 不是每手的噪声。

   另外弱档优先采用云库标为"正着"的着法 (bookPrior): 开局和常见中局有数据。
   ★ 更正: 这一条原来叫 humanPrior, 说法是"走真人走过的棋"。实测证明云库的 winrate
   只是它 score 的换算, 不是对局统计, 所以那个说法不成立。它真正的价值是
   "公认的正规着法是哪几条" —— 让弱档走正路而不是走冷僻的怪着, 这个目的仍然成立,
   只是理由要说对。

   时间预算只用来保证引擎判断可靠, **不再拿它当难度旋钮** ——
   NNUE 的四层已经在业余高手之上, 靠搜得浅来变弱是行不通的。 */
const LEVELS = [
  { name: '入门', ms: 400,  multipv: 12, blunder: 0.34, badLoss: [80, 600], bookPrior: true  },
  { name: '业余', ms: 700,  multipv: 10, blunder: 0.17, badLoss: [50, 300], bookPrior: true  },
  { name: '较强', ms: 1400, multipv: 6,  blunder: 0.07, badLoss: [30, 140], bookPrior: true  },
  { name: '全力', ms: 3000, multipv: 1,  blunder: 0,    badLoss: [0, 0],    bookPrior: false },
];

/* 将杀分。杀一和杀十必须分得开 —— 全压成 ±30000 的话, 弱档在挑"损失落在
   某个区间"的着法时会把所有杀着当成完全等价, 而快一步是有意义的。
   ★ 这一份必须和 app.js 的 cpOf 是同一个公式。两边各写一套是这个项目
   已经吃过亏的事 (跑分脚本抄一份被测逻辑, 测的就不是产品了)。 */
const mateScore = m => Math.sign(m) * (30000 - Math.min(200, Math.abs(m)) * 50);
const scoreOf = c => (c.mate != null ? mateScore(c.mate) : c.score);

/* 选一手棋。返回 {uci, kind}, kind 用来在日志里说明这一手是怎么来的。

   顺序: 先掷漏着骰子; 没漏就在"接近最优"里挑, 且优先挑真人也走的那一步。 */
function pickMove(cands, lv, cloud) {
  if (!cands.length) return null;
  if (!lv.blunder && !lv.bookPrior) return { uci: cands[0].uci, kind: null };

  const best = scoreOf(cands[0]);
  const loss = c => best - scoreOf(c);

  // 掷骰子: 这一手要不要真的走坏
  if (lv.blunder && Math.random() < lv.blunder) {
    const [lo, hi] = lv.badLoss;
    const bad = cands.filter(c => loss(c) >= lo && loss(c) <= hi);
    if (bad.length) {
      const c = bad[Math.floor(Math.random() * bad.length)];
      return { uci: c.uci, kind: `漏着 · 让 ${(loss(c) / 100).toFixed(2)} 兵` };
    }
    // 这个局面根本没有那么坏的着法可走 (比如只此一手), 就正常走
  }

  // 不漏的时候: 在接近最优的那几手里挑, 优先挑云库里真人也走的
  const good = cands.filter(c => loss(c) <= 25);
  if (lv.bookPrior && cloud) {
    /* 权重用云库的 rank 和 score, 不用 winrate ——
       winrate 是 score 的确定性换算, 拿它加权等于拿 score 加权还多绕一道;
       而且开局所有着法的 winrate 都挤在 50 上下, 实际效果是均匀乱挑,
       于是正着炮二平五和冷僻的炮二平一被同等对待, 下出来就是"这机器开局很怪"。
       rank 才是定性 (2 = "!" 正着, 1 = "*" 可走, 0 = "?" 未知)。
       只在最高 rank 那一档里按 score 挑。 */
    const human = good.filter(c => cloud.has(c.uci));
    if (human.length) {
      const top = Math.max(...human.map(c => cloud.get(c.uci).rank || 0));
      const pool = human.filter(c => (cloud.get(c.uci).rank || 0) === top);
      const best2 = Math.max(...pool.map(c => cloud.get(c.uci).score || 0));
      let tot = 0;
      const w = pool.map(c => {
        const v = Math.exp(((cloud.get(c.uci).score || 0) - best2) / 30);
        tot += v; return v;
      });
      let x = Math.random() * tot;
      for (let i = 0; i < pool.length; i++) {
        x -= w[i];
        if (x <= 0) return { uci: pool[i].uci, kind: (typeof window !== 'undefined' && window.t) ? window.t('lvl.book') : '云库正着' };
      }
    }
  }
  const c = good[Math.floor(Math.random() * good.length)] || cands[0];
  return { uci: c.uci, kind: null };
}

if (typeof module !== 'undefined') module.exports = { LEVELS, pickMove, scoreOf };
