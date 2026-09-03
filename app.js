/* ================= 象棋 · 界面与引擎 =================
   规则在 rules.js, 这里只管画棋盘、驱动引擎、组织界面。
   引擎是 Pikafish 的 WebAssembly 版 (我们自己编的), 跑在你自己的浏览器里。 */

/* ---------- 引擎 ----------
   Pikafish, 编成 WebAssembly 跑在本机浏览器里。构建配方和我们打的补丁在
   `pikafish-wasm/`, 许可见 `engine/README.md`。

   ★★ 行号差一。
   Pikafish 的 UCI 坐标行号是 **0-9** (红方底线是 0), 我们整套规则、记谱、
   URL 参数用的是 **1-10** (和 rules.js 一致, 也是之前 Fairy-Stockfish 的约定)。
   同一手炮二平五, 我们写 h3e3, Pikafish 写 h2e2。

   不转的话满盘着法整体错位一行, 而且**不会报错** —— 引擎照样返回一个合法着法,
   只是完全不是那一手。所以转换必须焊在这一层: 进引擎的着法一律 toEng,
   出引擎的着法一律 fromEng, 除了这个类以外全站只认 1-10。
   (chessdb 云库也是 0-9, 那一处的转换在 cloudQuery 里, 是同一个道理。) */

// 我们的 1-10 → 引擎的 0-9。"10" 必须排在 [1-9] 前面, 否则 i10 会被当成 i1
const toEng = u => u.replace(/([a-i])(10|[1-9])/g, (_, f, r) => f + (+r - 1));
// 引擎的 0-9 → 我们的 1-10
const fromEng = u => u.replace(/([a-i])([0-9])/g, (_, f, r) => f + (+r + 1));

class Engine {
  constructor() { this.ready = false; this.busy = false; this.queue = []; this.dead = null; }

  async init(onProgress) {
    onProgress && onProgress('载入引擎');
    const Pikafish = window.Pikafish;
    this.sf = await Pikafish({ locateFile: f => 'engine/' + f });
    this.listeners = [];
    this.sf.addMessageListener(l => {
      /* ★ 引擎自己报的致命错误必须被接住。
         权重读不了的时候 Pikafish 打完这几行就 exit(1) —— 进程没了,
         `bestmove` 永远不会来。不看这些行的话, 上层只会看到一个永不 resolve
         的 promise, 界面就永远停在"思考中"。 */
      // 第一条 ERROR 才说明白是什么坏了; 最后一条永远是"引擎即将终止", 没信息量
      if (/^info string ERROR:/.test(l) && !this.lastError) {
        this.lastError = l.replace(/^info string ERROR:\s*/, '');
      }
      if (/will be terminated now/.test(l)) this.die(this.lastError || '引擎自行终止');
      for (const fn of this.listeners) fn(l);
    });

    /* 权重 50MB, 是首次打开最慢的一步。serve.py 给 .nnue 发 immutable 缓存头,
       所以只有第一次要等; 但第一次要等多久取决于网速, 所以这里报进度。 */
    onProgress && onProgress('载入权重 50MB');
    await this.loadNet(onProgress, false);

    this.send('uci');
    /* 这里**没有** UCI_Variant。那是 Fairy-Stockfish 的多棋种选项,
       Pikafish 只下象棋, 发过去是未知命令。 */
    this.send('setoption name EvalFile value /pikafish.nnue');
    this.send('setoption name UCI_ShowWDL value true');
    this.send('setoption name Hash value 64');
    /* 线程数上限是 12 —— 构建时 PTHREAD_POOL_SIZE=12, 而 emscripten 只有回到
       事件循环才能长新 worker, 我们的 postMessage 是同步调用的, 池子不够不会
       扩容而是死锁。所以这是硬上限不是建议值。 */
    const th = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
    if (crossOriginIsolated) this.send(`setoption name Threads value ${th}`);
    this.threads = crossOriginIsolated ? th : 1;
    /* 注: 这里**没有**设 nodestime。设了它搜索就按节点数计时, 同一局面在不同机器上
       结果一致 (可复现), 但代价是快的机器不会因为快而搜得更深, 对局体验变差。
       复盘想要可复现的话应该单独在复盘里开, 还没做。之前这里的注释写成
       "已经用 nodestime 保证可复现", 是假的。 */
    await this.isready();

    /* ★ readyok **不代表权重是好的**。
       Pikafish 直到第一个 `go` 才去解析权重, 之前 uci / isready 一律正常回。
       所以坏权重的表现是: 页面自检通过、分析按钮亮着, 你一按分析引擎当场自杀,
       而且是静默的 —— 2026-08-25 G 遇到的"走两步就一直显示思考中"就是这条路。
       这里先花几毫秒搜一层, 把这个判断提前到自检里, 顺便逼引擎真的读一次权重。 */
    onProgress && onProgress('校验权重');
    if (!await this.probe()) {
      /* 最可能的成因是浏览器缓存里存了一份坏的或者和引擎版本对不上的权重 ——
         serve.py 给 .nnue 发的是 immutable 七天, 不会自己去重新校验,
         所以坏一次就会一直坏下去。带 cache: 'reload' 重新拉一份再试。 */
      onProgress && onProgress('权重可疑, 重新下载');
      this.dead = null; this.lastError = null;
      await this.loadNet(onProgress, true);
      this.send('setoption name EvalFile value /pikafish.nnue');
      await this.isready();
      if (!await this.probe()) {
        throw new Error('权重装不上' + (this.lastError ? ': ' + this.lastError : ''));
      }
    }

    this.ready = true;
    onProgress && onProgress('就绪');
  }

  /* 拉权重并检查它是完整的。fresh=true 绕过 HTTP 缓存。
     只信 Content-Length: 服务端发的是真实文件长度, 对不上就是没拿全。 */
  async loadNet(onProgress, fresh) {
    const url = 'engine/pikafish.nnue' + (fresh ? '?fresh=' + Date.now() : '');
    /* 公网静态托管 (GitHub Pages) 对 .nnue 只给十分钟的 max-age, 每次打开都要重拉 52MB。
       所以自己存一份进 Cache Storage; serve.py 那条路有 immutable 头, 存不存都一样。 */
    let store = null;
    try { store = window.caches ? await caches.open('xq-net-v1') : null; } catch (e) { store = null; }
    let r = (!fresh && store) ? await store.match(url).catch(() => null) : null;
    if (r) onProgress && onProgress('权重来自本地缓存');
    else {
      r = await fetch(url, fresh ? { cache: 'reload' } : undefined);
      if (!r.ok) throw new Error(`权重下载失败 HTTP ${r.status}`);
      if (store) { try { await store.put(url, r.clone()); } catch (e) { /* 存不下就每次拉 */ } }
    }
    /* 只在没有内容编码时才拿 Content-Length 对账: 托管商一旦 gzip 了这个文件,
       头里写的是压缩后的长度, 解出来的字节数对不上不代表没拿全。 */
    const enc = (r.headers.get('content-encoding') || 'identity').toLowerCase();
    const want = enc === 'identity' ? (+r.headers.get('content-length') || 0) : 0;
    const buf = await r.arrayBuffer();
    if (want && buf.byteLength !== want) {
      if (store) { try { await store.delete(url); } catch (e) {} }
      throw new Error(`权重不完整: 收到 ${buf.byteLength} 字节, 应为 ${want}`);
    }
    if (buf.byteLength < 1e7) throw new Error(`权重太小 (${buf.byteLength} 字节), 多半是错误页`);
    this.sf.FS.writeFile('/pikafish.nnue', new Uint8Array(buf));
    onProgress && onProgress(`权重 ${(buf.byteLength / 1048576).toFixed(0)}MB 就位`);
  }

  /* 搜一层。回来了说明引擎真的能用; 没回来 (或者引擎死了) 说明不能用。 */
  probe() {
    return new Promise(res => {
      if (this.dead) return res(false);
      const done = ok => { this.off(fn); clearTimeout(timer); res(ok); };
      /* die() 会给所有在等的 listener 补发一个假 bestmove 把它们放掉,
         所以这里必须再看一眼 dead —— 否则引擎正是死在这次探测上, 探测反而报"通过"。 */
      const fn = l => { if (l.startsWith('bestmove')) done(!this.dead); };
      const timer = setTimeout(() => done(false), 10000);
      this.on(fn);
      this.send('position startpos');
      this.send('go depth 1');
    });
  }

  /* 引擎没了。把在飞的活全部放掉, 否则队列会一直 busy, 后面每一次分析都排在
     一个永远不会回来的任务后面 —— 那就是"整页的引擎功能一起哑掉"。 */
  die(why) {
    if (this.dead) return;
    this.dead = why || '引擎已终止';
    this.ready = false;
    for (const fn of [...(this.listeners || [])]) { try { fn('bestmove (none)'); } catch (e) {} }
    this.listeners = [];
    this.onDeath && this.onDeath(this.dead);
  }

  send(cmd) { if (!this.dead) this.sf.postMessage(cmd); }

  // 局面已经变了就别让它算完, 直接掐。bestmove 仍会回来, 队列不会卡住。
  stop() { if (this.ready) this.send('stop'); }

  isready() {
    return new Promise(res => {
      // 引擎可能在这之前就死了 (坏权重), readyok 永远不来。别把自检吊死在这。
      const done = () => { this.off(fn); clearTimeout(timer); res(); };
      const fn = l => { if (l === 'readyok') done(); };
      const timer = setTimeout(done, 15000);
      this.on(fn); this.send('isready');
    });
  }

  on(fn) { this.listeners.push(fn); }
  off(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }

  /* 分析一个局面。返回 { candidates, bestByDepth, maxDepth }。
     candidates 是最终深度上的 MultiPV 列表, 分数一律换算成"轮到走的那方"的视角。
     bestByDepth 记录每一层的首选着法, 这是"可发现深度"的原始数据。 */
  analyze(fen, { depth = 0, ms = 0, multipv = 1, onInfo = null, searchmoves = null } = {}) {
    return this.enqueue(() => new Promise(res => {
      if (this.dead) {
        return res({ candidates: [], bestByDepth: new Map(), scoreByDepth: new Map(),
                     maxDepth: 0, nodes: 0, nps: 0, bestmove: null, agrees: true,
                     failed: this.dead });
      }
      /* 只显示"完整的一层"。
         一层的 MultiPV 是一条条到的, 而且时间到了会在半层上被打断。如果把不同层的
         行混在一张表里, 就会出现第 3 名的分比第 2 名还高这种自相矛盾的排序,
         界面上看就是数字在乱跳。所以攒够这一层该有的条数才整体换掉, 半层的一律丢弃。 */
      const pend = new Map();            // 本层收到的行
      const bestByDepth = new Map();     // depth -> 首选着法
      const scoreByDepth = new Map();    // depth -> 首选分数, 算"可发现深度"要逐层比
      let pendDepth = -1;
      let full = [], fullDepth = 0;      // 最后一个完整层
      let nodes = 0, nps = 0;

      const expected = Math.min(multipv, new Position(fen).legalMoves().length || 1);

      const flush = () => {
        if (pend.size < expected) return;          // 半层, 不要
        full = [...pend.values()].sort((a, b) => a.rank - b.rank);
        fullDepth = pendDepth;
        if (onInfo) onInfo({ depth: fullDepth, nodes, nps, candidates: full });
      };

      /* ★ 看门狗。
         整个 analyze 只在 `bestmove` 上 resolve, 所以丢一个 bestmove
         = 这个 promise 永远挂着 = enqueue 的 busy 永远是 true
         = 之后**所有**分析/人机/复盘全部排在它后面, 一起哑掉。
         引擎自杀是已知的一条路 (坏权重), 但不必知道全部成因才防得住:
         超时就放人, 把队列还回去, 并且明说引擎不对劲。
         宽限给到搜索时限的两倍 + 15 秒 —— 慢机器上搜索本来就会超时一点,
         这里要抓的是"永远不回来", 不是"慢了一点"。 */
      const budget = (ms > 0 ? ms * 2 : 60000) + 15000;
      const timer = setTimeout(() => {
        this.off(fn);
        this.die(`搜索超时 ${(budget / 1000) | 0}s 没有返回结果`);
        res({ candidates: full, bestByDepth, scoreByDepth, maxDepth: fullDepth,
              nodes, nps, bestmove: null, agrees: true, failed: this.dead });
      }, budget);

      const fn = line => {
        if (line.startsWith('info ')) {
          const n = /\bnodes (\d+)/.exec(line); if (n) nodes = +n[1];
          const sp = /\bnps (\d+)/.exec(line);  if (sp) nps = +sp[1];
          const d = /\bdepth (\d+)/.exec(line);
          const sc = /\bscore (cp|mate) (-?\d+)/.exec(line);
          const pv = /\bpv (.+)$/.exec(line);
          if (!d || !sc || !pv) return;
          const dep = +d[1];
          const mp = /\bmultipv (\d+)/.exec(line);
          const idx = mp ? +mp[1] : 1;
          const wdl = /\bwdl (\d+) (\d+) (\d+)/.exec(line);
          const rec = {
            rank: idx, depth: dep,
            score: sc[1] === 'cp' ? +sc[2] : null,
            mate: sc[1] === 'mate' ? +sc[2] : null,
            // 解析留着 (调试和以后想重新评估时有用), 但**胜势不走它**, 原因见 advOf
            wdl: wdl ? [+wdl[1], +wdl[2], +wdl[3]] : null,
            // 引擎的 0-9 在这里就换成我们的 1-10, 再往外传的全是我们的坐标
            pv: pv[1].trim().split(/\s+/).map(fromEng),
          };
          rec.uci = rec.pv[0];
          if (idx === 1) {
            bestByDepth.set(dep, rec.uci);
            scoreByDepth.set(dep, cpOf(rec));
          }
          if (dep !== pendDepth) { pendDepth = dep; pend.clear(); }
          pend.set(idx, rec);
          flush();
        } else if (line.startsWith('bestmove')) {
          this.off(fn);
          clearTimeout(timer);
          // 一整层都没搜完的极端情况 (时间给得太少), 只好拿半层顶上
          if (!full.length && pend.size) {
            full = [...pend.values()].sort((a, b) => a.rank - b.rank);
            fullDepth = pendDepth;
          }
          /* ★ `bestmove` 才是 UCI 协议里引擎给出的最终选择。
             在这之前我们只取"最后一个完整 MultiPV 层的第一名", 而搜索是按毫秒掐断的 ——
             它可能正停在下一层搜到一半的地方, 那一层的信息全被丢掉, 但引擎自己
             是把它算进去了的。两者绝大多数时候一样, 但"绝大多数"不是接口契约。
             现在把它带出去, 由调用方决定怎么用, 并且在不一致时把首选换成它。 */
          const bm = /^bestmove\s+(\S+)/.exec(line);
          const bestmove = bm && bm[1] !== '(none)' ? fromEng(bm[1]) : null;
          /* 和最后一个完整 MultiPV 层的第一名是否一致。**必须在动 full 之前算**,
             之前是重排之后才算, 于是重排成功时它永远报"一致", 这个字段等于没用。 */
          const agrees = !bestmove || !full.length || full[0].uci === bestmove;
          /* ★ 不重排候选表。
             第一版在不一致时把 bestmove 那条挪到第一位 —— 那是错的:
             挪完之后 candidates[0] 不再是分最高的那一条, 而下游 (差距列、
             "另有 N 步相差不到 0.55 兵"、复盘的 gap、弱档采样) 全都默认
             candidates[0] 分最高, 于是会算出负的损失和乱掉的排序。
             候选表是"按分排序的搜索结果", 它有自己的不变量, 不能为了显示需要
             去破坏它。bestmove 单独带出去, 由调用方决定怎么用。 */
          res({ candidates: full, bestByDepth, scoreByDepth, maxDepth: fullDepth,
                nodes, nps, bestmove, agrees, failed: this.dead || null });
        }
      };

      this.on(fn);
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`position fen ${fen}`);
      const sm = searchmoves ? ` searchmoves ${toEng(searchmoves)}` : '';
      this.send((ms > 0 ? `go movetime ${ms}` : `go depth ${depth || 12}`) + sm);
    }));
  }

  enqueue(job) {
    return new Promise((res, rej) => {
      this.queue.push({ job, res, rej });
      this.pump();
    });
  }
  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    document.body.classList.add('busy');
    const { job, res, rej } = this.queue.shift();
    try { res(await job()); } catch (e) { rej(e); }
    this.busy = false;
    if (!this.queue.length) document.body.classList.remove('busy');
    this.pump();
  }
}


/* ---------- chessdb 云库 ----------
   https://www.chessdb.cn 的中国象棋云库, 公开 API, 无 key。

   ★★ 更正 (2026-08-23): 我一度把返回里的 `winrate` 当成"真人实战胜率", 那是错的。
   实测三个完全不同的局面, score:1 一律回 winrate:50.08, score:-1 一律回 49.92 ——
   它是 score 的一个确定性换算, 不是从对局统计出来的。官方文档也从没说过数据来自
   真人棋谱, 没有对局数、没有样本来源、没有水平段。
   所以这个库应当理解成**一个公共的云端引擎库 + 着法定性**, 不是人类棋谱库:
     score  它自己的评估
     rank   它自己的定性 (2 = "!" 正着, 1 = "*" 可走, 0 = "?" 未知)
     winrate 就是 score 换算出来的百分数, 没有额外信息
   用它的价值在于"公认的正规着法是哪几条", 不在于"人实际怎么走"。

   learn=0: 默认参数会把查询到的局面提交进它的学习队列。我们的棋不必往公共库里送。 */
const CLOUD = 'https://www.chessdb.cn/chessdb.php';
const cloudCache = new Map();

/* ★ 云库和引擎的着法编码差一行。
   chessdb 的行号是 0..9 (红方底线是 0), 引擎/我们用的是 1..10 (红方底线是 1)。
   所以文档里起手第一步写作 c3c4, 同一步在引擎那边是 c4c5。
   两边的 FEN 是一样的, 只有着法字符串要转。第一版没转, 结果云库回来的 c6c5
   在我们盘上指向一个空格, 整张表的实战列全空。 */
const cdbToUci = m => {
  const x = /^([a-i])(\d)([a-i])(\d)$/.exec(m);
  return x ? `${x[1]}${+x[2] + 1}${x[3]}${+x[4] + 1}` : null;
};
// 反向转换 (uci -> 云库) 暂时用不上: 我们只读云库不写云库, learn=0

async function cloudQuery(fen) {
  if (cloudCache.has(fen)) return cloudCache.get(fen);
  const url = `${CLOUD}?action=queryall&learn=0&board=${encodeURIComponent(fen)}`;
  let out = null;
  try {
    const txt = await fetch(url, { mode: 'cors' }).then(r => r.text());
    if (/^(unknown|invalid|checkmate|stalemate|nobestmove)/.test(txt.trim())) out = null;
    else {
      out = new Map();
      for (const item of txt.trim().split('|')) {
        const f = Object.fromEntries(item.split(',').map(kv => {
          const i = kv.indexOf(':'); return [kv.slice(0, i), kv.slice(i + 1)];
        }));
        const uci = f.move ? cdbToUci(f.move) : null;
        if (uci) out.set(uci, {
          score: +f.score, rank: +f.rank,
          winrate: f.winrate === undefined ? null : parseFloat(f.winrate),
          note: f.note || '',
        });
      }
    }
  } catch (e) { out = null; }   // 打不开就当没有, 云库只是加分项不是依赖
  cloudCache.set(fen, out);
  return out;
}

/* ---------- 棋盘绘制 ---------- */

/* 三套盘面主题。
   The public copy keeps the visual tokens local and self-contained。
   纸 = 把棋盘当一张图表画, 和其余界面同一个体系;
   木 / 竹 = 传统棋盘的暖色, 换主题时页面底色也跟着走一点, 不然冷暖打架。 */
/* 主题 token。命名按 DESIGN.md 的两条轴走:
     crimson / ink   = 谁的 (红方 / 黑方)
     alert           = 危险 (无根/受攻的高亮和攻击线)
     rule* / mute    = 结构色, 永远不参与表意
   rimSide 表示"棋子最外那圈用行棋方的颜色画"。纸主题是印刷体系, 棋子就该是
   纸上一个墨圈; 木/竹是材质体系, 最外圈是木头本色, side 色留给刻进去的那圈。 */
const THEMES = {
  paper: {
    name: '纸',
    canvasBg: '#ffffff',
    paper: '#f4f6f9', field: '#e8ecf1',
    rule: '#9daabb', ruleSoft: '#e1e6ec', ruleStrong: '#75839a',
    ink: '#0c0e12', mute: '#79828e',
    crimson: '#ab2f27',
    redFace: '#ffffff', blkFace: '#ffffff',
    frameLine: '#41506a', edge: '#aab4c0', frameText: '#79828e',
    alert: '#e0533c',      // 警示高亮 (无根/受攻)。和朱红分开, 免得红子上的高亮糊成一团
    rimSide: true, rimAlpha: 1, ringGap: 0.085,
    page: { bg: '#ffffff', paper: '#fafbfc', rule: '#c4ccd6', ruleSoft: '#e1e6ec' },
  },
  wood: {
    name: '木',
    canvasBg: '#faf6ee',
    paper: '#e7d3ac', field: '#e2cfa8',
    rule: '#b39a6a', ruleSoft: '#cbb68c', ruleStrong: '#87693c',
    ink: '#231f19', mute: '#7d6b4c',
    crimson: '#a8281e',
    redFace: '#f7efdc', blkFace: '#f7efdc',
    frameLine: '#7a6039', edge: '#a3855a', frameText: '#4a3819', bevel: '#e0cda8',
    alert: '#d4472c',
    grain: { alpha: .032, warp: 1 },
    pieceEdge: '#c8ad81', carve: 'rgba(255,252,244,.62)',
    rimSide: false, ringGap: 0.075,
    page: { bg: '#faf6ee', paper: '#fffdf8', rule: '#ddd0b6', ruleSoft: '#ece2d1' },
  },
  bamboo: {
    name: '竹',
    canvasBg: '#fcfbf6',
    paper: '#efece0', field: '#e9e5d5',
    rule: '#c8c2ab', ruleSoft: '#ddd8c6', ruleStrong: '#948d74',
    ink: '#1d1f1a', mute: '#8b8874',
    crimson: '#a8332a',
    redFace: '#fdfbf3', blkFace: '#fdfbf3',
    frameLine: '#857e67', edge: '#b6b0a0', frameText: '#5e5945', bevel: '#e6e2d2',
    alert: '#cf5138',
    grain: { alpha: .022, warp: .7 },
    pieceEdge: '#d6d1bd', carve: 'rgba(255,255,252,.55)',
    rimSide: false, ringGap: 0.075,
    page: { bg: '#fcfbf6', paper: '#fffefa', rule: '#d5d0bd', ruleSoft: '#e8e4d6' },
  },
};
let TH = THEMES.paper;

// 象棋子面上的字向来是楷体, 换成黑体立刻就不像棋子了
const PIECE_FONT = '"XQKai","Kaiti SC","STKaiti","KaiTi","楷体","Noto Serif SC",serif';
const RIVER_FONT = PIECE_FONT;
// 盘上的数字一律等宽 (曲线刻度、变化预览的序号)。楷体的数字在小字号上认不清。
const MONO_FONT = '"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace';

// 纵线号: 红方从右往左一到九, 黑方从左往右 1 到 9
const FILE_RED = ['九','八','七','六','五','四','三','二','一'];
const FILE_BLK = ['1','2','3','4','5','6','7','8','9'];

const R0v = (v, dpr) => Math.round(v * dpr) / dpr;

const fileFont = (ch, s) => /[0-9]/.test(ch)
  ? `500 ${(s * 0.25).toFixed(1)}px "Geist Mono",ui-monospace,monospace`
  : `${(s * 0.3).toFixed(1)}px ${RIVER_FONT}`;

class BoardView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.sel = -1;          // 选中的格子
    this.targets = [];      // 选中子的合法落点
    this.lastMove = null;   // [from,to]
    this.arrows = [];       // [{from,to,strength}] 分析箭头
    this.arrowSig = '';     // 上次画的箭头指纹, 相同就不重画
    this.flip = false;      // 执黑时翻转, 让自己在下方
    this.anim = null;       // 走子动画
    this.hover = -1;
    this.pos = null;        // 最后一次画的局面, 动画帧要用
    this.checkSq = -1;      // 正被将的那个帅/将
    this.layer = 'loose';   // 盘面图层: none / loose / control
    this.threatMove = null; // 对方在等着走的那一步
    /* 变化预览。鼠标停在一条候选上时, 把它之后的几步一起画出来。
       和"对局态"是又一对互斥模式 (DESIGN.md 第九节): 预览期间盘上不画对方威胁,
       因为威胁用的就是"虚线 + 空心头"那一档, 而变化里第二手起也归这一档。
       两者永不同时出现, 读的人也就不用反查。
       它必须是瞬时的 —— 2026-08-23 删掉的那一版是**点了就常驻**四支带编号的箭,
       满盘线看不出哪支是自己点的。悬停不同: 手一移开盘面就干净了。 */
    this.preview = null;    // [{from,to,side}] 主变前几步, 从当前局面数起
    /* 摆棋态。和对局态**互斥**: 摆棋的时候盘上不画无根、不画控制、不画箭头,
       所以警示色这一档在此刻只有一个意思 —— "这个点要你看一眼"。
       见 DESIGN.md 第九节。 */
    this.setupMode = false;
    this.unsure = null;     // Set<sq>: 识别没把握 / 自检挑出来的点
  }

  layout() {
    const cssW = this.cv.clientWidth || 480;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    /* 8 列间距 + 左右各 1.15 个间距的边。
       边留这么宽是因为外框那条墨线要画在棋子之外 (棋子半径 0.42 个间距),
       墨线再往外还得放得下纵线号。边留 1.0 的时候墨线会从边上的棋子底下穿过去,
       被切成一段一段。

       ★ 格距和边距都先取整到**设备像素**再换算回 CSS 像素。
       不取整的话每一条格线和每一个棋子圆心都落在半个像素上: 线被抗锯齿糊成
       两像素宽且深浅不一, 相邻棋子的圆心互相错开小半个像素。肉眼说不出哪里不对,
       只会觉得"没对齐、不精致"。这一条是整个棋盘观感的关键。 */
    const sDev = Math.max(8, Math.floor(cssW * dpr / 10.3));
    const mDev = Math.round(sDev * 1.15);
    const wDev = sDev * 8 + mDev * 2;
    const hDev = sDev * 9 + mDev * 2;
    this.cv.width = wDev;
    this.cv.height = hDev;
    this.cv.style.height = (hDev / dpr) + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.px = 1 / dpr;              // 一个设备像素有多少 CSS 像素
    this.half = 0.5 / dpr;          // 描 1 设备像素的线要偏半个像素才不糊
    this.s = sDev / dpr; this.m = mDev / dpr;
    this.cssW = wDev / dpr; this.cssH = hDev / dpr;
    this.buildGrain();
  }

  /* 木纹。
     没有木纹的"木色棋盘"只是一块土黄色的板子, 这是它看着廉价的原因。
     做法是一次性画进一张离屏 canvas 再当图案铺上去:
     ① 必须离屏缓存, 否则每帧重新随机会像在闪;
     ② 只有横向长条和极低的透明度, 木头的纹理是顺纹的, 加噪点只会脏。 */
  buildGrain() {
    const g = TH.grain;
    this.grainCv = null;
    if (!g) return;
    const w = Math.round(this.cssW), h = Math.round(this.cssH);
    if (!w || !h) return;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d');
    let seed = 20260823;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    /* 木纹。第一版是撒一把随机短线, 那不是木纹, 是划痕。
       真木板的样子由三件事决定, 缺一件就假:
         ① 纹路是**贯通整块板**的长线, 不是断续的小段
         ② 疏密**成带**分布 (早材疏、晚材密), 不是均匀撒开
         ③ 偶尔出现"山形"—— 弦切板上那种一圈套一圈的抛物线, 木头最认脸的特征
       另外要顺着**长边**走: 这块板竖着比横着长, 所以纹路走竖向。 */
    const vertical = h >= w;
    const L = vertical ? w : h;          // 横跨方向的长度
    const N = vertical ? w : h;

    // ① 密度成带: 先生成一条低频的疏密曲线
    const bands = [];
    for (let i = 0; i < 9; i++) bands.push({ p: rnd(), w: 0.06 + rnd() * 0.2, a: 0.25 + rnd() * 0.9 });
    const density = u => {
      let d = 0.45;
      for (const b of bands) d += b.a * Math.exp(-Math.pow((u - b.p) / b.w, 2));
      return d;
    };

    c.lineCap = 'round';
    let u = 0;
    while (u < 1) {
      const d = density(u);
      u += (0.0026 + 0.009 / d) * (0.6 + rnd() * 0.9);
      if (u >= 1) break;
      const pos0 = u * N;
      const dark = rnd() < 0.62;
      c.strokeStyle = dark ? '#000' : '#fff';
      c.globalAlpha = g.alpha * (0.25 + rnd() * 0.8) * Math.min(1.4, d);
      c.lineWidth = 0.5 + rnd() * (dark ? 1.9 : 1.1);
      // ② 贯通: 一条线走完整块板, 中间用几段贝塞尔轻轻摆
      const wob = (4 + rnd() * 9) * g.warp;
      c.beginPath();
      const seg = 4, step = L / seg;
      let prev = pos0;
      if (vertical) c.moveTo(pos0, 0); else c.moveTo(0, pos0);
      for (let k = 1; k <= seg; k++) {
        const nx = pos0 + (rnd() - 0.5) * wob;
        const mid = (prev + nx) / 2;
        if (vertical) c.quadraticCurveTo(mid, step * (k - 0.5), nx, step * k);
        else c.quadraticCurveTo(step * (k - 0.5), mid, step * k, nx);
        prev = nx;
      }
      c.stroke();
    }

    // ③ 山形: 两三组套叠的抛物线
    for (let i = 0; i < 3; i++) {
      const cx0 = rnd() * N;
      const y0 = rnd() * L * 0.8;
      const dark = rnd() < 0.6;
      for (let k = 0; k < 5 + (rnd() * 5 | 0); k++) {
        const spread = (0.03 + k * 0.016) * N;
        const height = (0.16 + k * 0.05) * L;
        c.strokeStyle = dark ? '#000' : '#fff';
        c.globalAlpha = g.alpha * (0.2 + rnd() * 0.45);
        c.lineWidth = 0.5 + rnd() * 1.2;
        c.beginPath();
        if (vertical) {
          c.moveTo(cx0 - spread, y0 + height);
          c.quadraticCurveTo(cx0, y0 - height * 0.55, cx0 + spread, y0 + height);
        } else {
          c.moveTo(y0 + height, cx0 - spread);
          c.quadraticCurveTo(y0 - height * 0.55, cx0, y0 + height, cx0 + spread);
        }
        c.stroke();
      }
    }

    this.grainCv = off;
    this.buildPieceTex();
  }

  /* 棋子端面的年轮。
     真棋子是从一根圆木棒上横切下来的, 所以子面看到的是**年轮**, 不是顺纹 ——
     棋盘用顺纹、棋子用年轮, 这一条差别就是"有材质"和"贴了张木纹图"的分界。
     做三张不同的, 按格子下标取, 免得满盘棋子长得一模一样。
     只用极低透明度的同心细弧: 不加高光不加渐变, 那些一上就是廉价感的来源。 */
  buildPieceTex() {
    this.pieceTex = null;
    if (!TH.grain) return;
    const r = Math.max(6, Math.round(this.s * 0.42 * this.dpr));
    const d = r * 2;
    const out = [];
    let seed = 991;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let v = 0; v < 3; v++) {
      const cv = document.createElement('canvas');
      cv.width = d; cv.height = d;
      const c = cv.getContext('2d');
      // 年轮的圆心不在正中, 偏一点才像真木头
      const ox = r + (rnd() - .5) * r * 1.1, oy = r + (rnd() - .5) * r * 1.1;
      for (let k = 0; k < 26; k++) {
        const rad = (k + 1) * (r / 9) * (0.75 + rnd() * 0.5);
        c.strokeStyle = rnd() < .5 ? '#000' : '#fff';
        c.globalAlpha = 0.035 * (0.4 + rnd());
        c.lineWidth = 0.5 + rnd() * 1.4;
        c.beginPath();
        c.arc(ox, oy, rad, rnd() * 6.28, rnd() * 6.28 + 3.2 + rnd() * 3);
        c.stroke();
      }
      out.push(cv);
    }
    this.pieceTex = out;
  }

  // 描线用: 把坐标推到设备像素的正中间
  ln(v) { return Math.round(v * this.dpr) / this.dpr + this.half; }
  // 线宽用: 取整数个设备像素, 否则边缘永远是灰的
  lw(k) { return Math.max(1, Math.round(k * this.dpr)) / this.dpr; }

  xy(r, c) {
    const rr = this.flip ? (H - 1 - r) : r;
    const cc = this.flip ? (W - 1 - c) : c;
    return [this.m + cc * this.s, this.m + rr * this.s];
  }
  hit(px, py) {
    const cc = Math.round((px - this.m) / this.s);
    const rr = Math.round((py - this.m) / this.s);
    if (cc < 0 || cc >= W || rr < 0 || rr >= H) return -1;
    const dx = px - (this.m + cc * this.s), dy = py - (this.m + rr * this.s);
    if (Math.hypot(dx, dy) > this.s * 0.6) return -1;
    return sq(this.flip ? (H - 1 - rr) : rr, this.flip ? (W - 1 - cc) : cc);
  }

  /* 走子动画。棋子已经落在 to 上了, 所以画的时候把 to 跳过,
     改在 from 到 to 的插值位置上画一次。190ms, 缓出。 */
  animateMove(from, to, done) {
    this.anim = { from, to, t0: performance.now(), dur: 190, done };
    const step = () => {
      if (!this.anim) return;
      const k = (performance.now() - this.anim.t0) / this.anim.dur;
      if (k >= 1) { const d = this.anim.done; this.anim = null; this.draw(this.pos); d && d(); return; }
      this.draw(this.pos);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  draw(pos) {
    if (!pos) return;
    this.pos = pos;
    const { ctx, s, m } = this;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = TH.paper;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const p0 = this.xy(0, 0), p1 = this.xy(H - 1, W - 1);
    const x0 = Math.min(p0[0], p1[0]), y0 = Math.min(p0[1], p1[1]);
    const x1 = Math.max(p0[0], p1[0]), y1 = Math.max(p0[1], p1[1]);
    /* 版面分三层, 和真棋盘一样: 棋子活动的**盘面** / 一圈实体**边框** / 边框上的坐标。
       pad = 盘面往外扩多少 (必须大于棋子半径 0.42, 否则边框会被边线上的棋子切断),
       边框宽度就是 m - pad, 坐标居中写在这条带子里。
       之前坐标是浮在盘面外的空白上的, 整块板子没有"边"这个概念, 所以不像一件东西。 */
    /* pad 是外框双线离盘面的距离。取 0.50 格: 刚好在棋子半径 (0.44) 之外,
       所以边线上坐满棋子时外框也不会被切成一段一段。
       坐标写在外框之外那条空带里。 */
    const pad = s * 0.50;
    const gap2 = s * 0.085;               // 双线之间的缝
    const R0 = v => Math.round(v * this.dpr) / this.dpr;
    /* 棋盘整块一个底色就够, 不做深色包边。
       G: "棋盘本身是可以很简洁的" —— 之前那圈深木色包边把注意力从棋子上抢走了。 */
    /* 画布整块是**页面底色**, 只有外框以内才铺棋盘的底。
       之前整张画布都刷成棋盘色, 于是坐标、留白全在灰底上, 整件东西读起来是
       "一块灰色卡片"而不是"一张印在纸上的棋盘" —— 那正是 G 说的没有现代感。
       现在棋盘有自己的边界, 边界之外是纸。 */
    ctx.fillStyle = TH.canvasBg || TH.paper;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const bx0 = x0 - pad - gap2, by0 = y0 - pad - gap2;
    const bw = (x1 - x0) + (pad + gap2) * 2, bh = (y1 - y0) + (pad + gap2) * 2;
    ctx.fillStyle = TH.paper;
    ctx.fillRect(R0(bx0), R0(by0), R0(bw), R0(bh));
    if (!this.grainCv && TH.grain) this.buildGrain();
    if (this.grainCv) {
      // 木纹只长在棋盘上, 不长到画布边缘
      ctx.save();
      ctx.beginPath(); ctx.rect(R0(bx0), R0(by0), R0(bw), R0(bh)); ctx.clip();
      ctx.drawImage(this.grainCv, 0, 0, this.cssW, this.cssH);
      ctx.restore();
    }

    /* 河界不填色。
       真棋盘的河就是两条河岸线之间的一段空白, 字写在里面。之前铺了一块灰,
       结果是: ① 那块灰的上下边缘等于凭空多出两根横线跟网格抢;
       ② 走到河岸上的棋子有一半泡在灰里, 看着像没对齐;
       ③ 在一张近白的纸上, 一块灰就是一块洗不掉的污渍。
       盘面上不出现填充色块 —— 这是 DESIGN.md 第二节定死的。 */

    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    const thin = this.lw(s * 0.014);

    // 内部网格。#c4ccd6 那档在白底上 1px 几乎看不见, 主网格要用 rule-strong,
    // 九宫斜线和位标再降一档, 让"格线 / 九宫 / 位标"三层分得开。
    ctx.strokeStyle = TH.ruleStrong;
    ctx.lineWidth = thin;
    ctx.beginPath();
    for (let r = 0; r < H; r++) {
      const [ax, ay] = this.xy(r, 0), [bx] = this.xy(r, W - 1);
      ctx.moveTo(this.ln(ax), this.ln(ay)); ctx.lineTo(this.ln(bx), this.ln(ay));
    }
    for (let c = 0; c < W; c++) {
      if (c === 0 || c === W - 1) {
        const [x, ya] = this.xy(0, c), [, yb] = this.xy(H - 1, c);
        ctx.moveTo(this.ln(x), this.ln(ya)); ctx.lineTo(this.ln(x), this.ln(yb));
      } else {
        const [x, a0] = this.xy(0, c), [, a1] = this.xy(4, c);
        ctx.moveTo(this.ln(x), this.ln(a0)); ctx.lineTo(this.ln(x), this.ln(a1));
        const [, b0] = this.xy(5, c), [, b1] = this.xy(H - 1, c);
        ctx.moveTo(this.ln(x), this.ln(b0)); ctx.lineTo(this.ln(x), this.ln(b1));
      }
    }
    ctx.stroke();

    /* 九宫斜线。之前降了一档 (TH.rule), 在纸主题上几乎消失, 九宫这个象棋里
       最要紧的区域反而是盘上最弱的图形。现在和主网格同档 —— 它靠"只有这里有斜线"
       就已经区分得开, 不需要再靠减淡。 */
    ctx.strokeStyle = TH.ruleStrong;
    ctx.beginPath();
    for (const [ra, rb] of [[0, 2], [7, 9]]) {
      const a = this.xy(ra, 3), b = this.xy(rb, 5), c2 = this.xy(ra, 5), d = this.xy(rb, 3);
      ctx.moveTo(this.ln(a[0]), this.ln(a[1])); ctx.lineTo(this.ln(b[0]), this.ln(b[1]));
      ctx.moveTo(this.ln(c2[0]), this.ln(c2[1])); ctx.lineTo(this.ln(d[0]), this.ln(d[1]));
    }
    ctx.stroke();

    /* 盘面边线 + 外框, 传统棋盘那道双线。
       两条线粗细必须不一样: 等粗的双线在小尺寸下糊成一条毛边, 看起来像画错了。
       外面那条重, 里面那条和网格同粗 —— 这样它读起来是"网格的收口", 不是第二个框。 */
    ctx.lineWidth = thin;
    ctx.strokeStyle = TH.ruleStrong;
    ctx.strokeRect(this.ln(x0), this.ln(y0), R0(x1 - x0), R0(y1 - y0));
    ctx.lineWidth = this.lw(s * 0.026);
    ctx.strokeStyle = TH.frameLine || TH.ink;
    const op = pad + gap2;
    ctx.strokeRect(this.ln(x0 - op), this.ln(y0 - op), R0((x1 - x0) + op * 2), R0((y1 - y0) + op * 2));
    ctx.lineWidth = thin;
    ctx.strokeStyle = TH.rule;
    ctx.strokeRect(this.ln(x0 - pad), this.ln(y0 - pad), R0((x1 - x0) + pad * 2), R0((y1 - y0) + pad * 2));

    // 炮位兵位角标: 它是盘面的装饰不是信息, 压到网格之下一档
    ctx.save();
    ctx.globalAlpha = .55;
    ctx.strokeStyle = TH.ruleStrong;
    ctx.lineWidth = thin;
    for (const [r, c] of [[2,1],[2,7],[7,1],[7,7],[3,0],[3,2],[3,4],[3,6],[3,8],[6,0],[6,2],[6,4],[6,6],[6,8]])
      this.tick(r, c);
    ctx.restore();

    /* 楚河汉界。字要压在两条河岸线之间正中, 字号只到 0.42 格 ——
       之前 0.6 格 + 0.34 格字距, 两个字被拉得互不相干, 而且"界"正好压在
       河岸上的兵头上。它是版心里的一处题字, 不是标题。 */
    const [rx0, ry0] = this.xy(4, 0), [rx1, ry1] = this.xy(5, W - 1);
    ctx.fillStyle = TH.mute;
    ctx.globalAlpha = .62;
    ctx.font = `${(s * 0.36).toFixed(1)}px ${RIVER_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const my = (ry0 + ry1) / 2, spanx = rx1 - rx0;
    // 0.25/0.75 正好落在第 3 和第 7 条纵线上, 河岸上一有子就压住字。挪到纵线之间
    this.spaced('楚河', rx0 + spanx * 0.28, my, s * 0.16);
    this.spaced('汉界', rx0 + spanx * 0.72, my, s * 0.16);
    ctx.globalAlpha = 1;

    // 纵线号: 上面黑方 1-9, 下面红方九到一。写在外框之外, 贴着框而不是浮在半空
    ctx.fillStyle = TH.frameText || TH.mute;
    const cy0 = y0 - op - s * 0.30, cy1 = y1 + op + s * 0.30;
    for (let c = 0; c < W; c++) {
      const [x] = this.xy(0, c);
      const top = this.flip ? FILE_RED[c] : FILE_BLK[c];
      const bot = this.flip ? FILE_BLK[c] : FILE_RED[c];
      ctx.font = fileFont(top, s);
      ctx.fillText(top, x, cy0);
      ctx.font = fileFont(bot, s);
      ctx.fillText(bot, x, cy1);
    }

    /* ═══ 盘面的视觉语言 ═══
       之前是想到一个信息就给它挑个没被占用的画法, 结果同一个圆环既表示"选中"
       又表示"无根", 同一组角标既表示"最后一手"又表示"可吃"。五套画法各说各的,
       看的人无从知道盘上出现的东西属于哪一类。

       现在固定成四层, 每一类信息只归一种形状, 不许串:

         第一层  状态      → 格子底色    选中 / 最后一手 / 悬停 / 被将
         第二层  能去哪    → 点和环      空点是实心小点, 可吃是套住那个子的环
         第三层  建议威胁  → 箭头        我方金色实线, 对方墨色虚线
         第四层  子的属性  → 子上角标    无根

       层序也是画序: 底色垫在最下面, 角标压在棋子上面。 */

    /* ── 状态环 ──
       ★ 只用环和点, 不用填充。
       之前每个状态画一个半透明的圆晕 (落点 17% 的金、选中 26% 的金), 在一张
       近白的纸上那就是一块洗不掉的污渍, 这是"不精致"最直接的观感来源。
       环是有笔画的东西, 晕不是 —— 印刷品上只有笔画。

       颜色一律是**走这一手的那一方**的颜色。金色现在专属引擎建议。
       之前上一手的起点、上一手的落点、引擎推荐三样全是金的, 所以按了分析根本
       看不出它指哪一个。 */
    const ringAt = (sq2, color, alpha, r, w) => {
      const [cxx, cyy] = this.xy(rowOf(sq2), colOf(sq2));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = this.lw(s * w);
      ctx.beginPath();
      ctx.arc(R0(cxx), R0(cyy), s * r, 0, 7);
      ctx.stroke();
      ctx.restore();
    };
    const sideCol = sd => sd > 0 ? TH.crimson : TH.ink;

    if (this.lastMove) {
      /* 上一手: 起点和落点各一个细环, 用走这一手那一方的颜色。
         起点淡一档 (那里已经空了), 落点重一档 (子在那)。两个环之间不连线 ——
         线这个形状归"一步棋的建议/威胁", 上一手是已经发生的事实, 不该长得像建议。 */
      const [f, t] = this.lastMove;
      const mover = (pos.board[t] || 0) > 0 ? 1 : -1;
      /* 起点这个环要和棋子同大 (0.44): 之前是 0.30, 正好压在炮位角标的四个尖上,
         叠出一个 ⊕ 的图案。同大之后它读起来是"这里刚才有一枚子", 正是它的意思。 */
      ringAt(f, sideCol(mover), .28, 0.44, 0.020);
      ringAt(t, sideCol(mover), .60, 0.50, 0.024);
    }
    if (this.hover >= 0 && this.hover !== this.sel)
      ringAt(this.hover, TH.ink, .18, 0.44, 0.020);
    if (this.checkSq >= 0) {
      // 被将: 帅/将外面一道朱红重环。它比任何别的标记都粗, 因为它比什么都急
      ringAt(this.checkSq, TH.crimson, .9, 0.52, 0.05);
    }

    if (this.layer === 'control' && !this.setupMode) this.drawControl(pos);

    // ── 能去哪 ──
    if (this.sel >= 0) {
      // 用行棋方自己的颜色: 这些点是"我能去的地方", 跟我同色才读得出归属
      const mine = sideCol(pos.board[this.sel]);
      /* 选中的子 vs 可以吃的子: 同色 (都是"我此刻的意图"), 但**半径和粗细必须分开**。
         第一版两者都是 0.50 / 0.038, 于是我选中的那枚和我能吃的那枚长得一模一样。
         选中 = 紧贴棋子的一道重环 (像被攥住);
         可吃 = 离得远一圈的一道细环 (像被圈定的猎物)。 */
      ringAt(this.sel, mine, .95, 0.47, 0.055);
      ctx.save();
      for (const t of this.targets) {
        const [tx2, ty2] = this.xy(rowOf(t), colOf(t));
        if (pos.board[t]) {
          ctx.beginPath();
          ctx.arc(R0(tx2), R0(ty2), s * 0.55, 0, 7);
          ctx.lineWidth = this.lw(s * 0.028);
          ctx.strokeStyle = mine; ctx.globalAlpha = .8; ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.fillStyle = mine; ctx.globalAlpha = .48;
          ctx.arc(R0(tx2), R0(ty2), s * 0.115, 0, 7); ctx.fill();
        }
      }
      ctx.restore();
    }

    /* 无根/受攻的高亮和攻击线都垫在棋子之下 —— 它是"这个子的背景",
       压在棋子上就成了盖住棋子的一块色。 */
    if (this.setupMode) this.drawUnsure(pos);
    else if (this.layer === 'loose') this.drawLoose(pos);

    // 箭杆同理, 让棋子盖在上面
    this.arrowPass(pos, 'under');

    // 棋子
    const skip = this.anim ? this.anim.to : -1;
    for (let i = 0; i < NSQ; i++) {
      if (i === skip) continue;
      const p = pos.board[i];
      if (p) {
        const [x, y] = this.xy(rowOf(i), colOf(i));
        this.piece(x, y, p, i === this.sel);
      }
    }
    /* ── 箭头的头和起点环: 画在棋子**之上** ──
       杆已经在棋子之下画过了 (见上面 arrowPass('under'))。
       这么分层是因为整支箭都压在棋子上时, 长箭头会从棋子身上割过去,
       看起来像把棋子切开了; 而整支箭都藏在棋子之下时, 走一两格的着法
       (象棋的绝大多数) 又会被两端的棋子完全盖住。
       杆在下、头在上: 长箭从棋子背后穿过, 短箭至少露出一个头。 */
    this.arrowPass(pos, 'over');

    // 正在飞的那颗
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const e = 1 - Math.pow(1 - k, 3);
      const [fx, fy] = this.xy(rowOf(this.anim.from), colOf(this.anim.from));
      const [tx, ty] = this.xy(rowOf(this.anim.to), colOf(this.anim.to));
      const p = pos.board[this.anim.to];
      if (p) this.piece(fx + (tx - fx) * e, fy + (ty - fy) * e, p, false);
    }
  }

  /* 松子图层。棋盘上除了棋子什么都不承载, 是这个界面之前最大的问题:
     象棋手第一眼扫的是"谁挂着、谁在被打", 而这件事引擎根本不告诉你 (它只给一个总分)。
     这里把它直接画在盘上, 并且从每个打它的子拉一条线过去 —— 光标一个红圈只说
     "这里有问题", 拉了线才说得清"是谁在打它"。 */
  /* 无根 / 受攻 图层。
     ★ 2026-08-23 从"角标"改成"高亮"。G: "你那个红点其实有点诡异, 我觉得有个
     highlight 的感觉会更好。" 他是对的 —— 角标是给密集列表用的形状, 盘上一个
     孤零零的实心小点读起来像脏了一块, 而不像一条信息。

     现在: 子底下垫一层警示色的圆, **严重程度用浓淡表示**, 不换形状也不换颜色
     (无根重, 受攻轻)。这是 DESIGN.md "盘面上不出现填充色块"的第二个例外, 判据是
     ——填色只允许**垫在一枚棋子底下**当高亮, 绝不允许单独出现在空的交叉点上。
     空点上的填色没有归属, 那才是之前那些"污渍"的来源。

     警示色单独定 (TH.alert), 不复用朱红: 朱红是红方的颜色, 红子底下垫朱红会糊成
     一团, 而且"这个子危险"和"这个子是红方的"是两件事。 */
  drawLoose(pos) {
    const { ctx, s } = this;
    const list = looseSquares(pos);
    this.looseInfo = { loose: 0, press: 0 };
    if (!list.length) return;

    ctx.save();
    for (const it of list) {
      const [x, y] = this.xy(rowOf(it.sq), colOf(it.sq));
      const loose = it.kind === 'loose';
      if (loose) this.looseInfo.loose++; else this.looseInfo.press++;

      // 高亮垫在棋子底下, 比棋子略大一圈, 边缘不描线 —— 描了就又变成一个环
      ctx.globalAlpha = loose ? 0.30 : 0.14;
      ctx.fillStyle = TH.alert || TH.crimson;
      ctx.beginPath();
      ctx.arc(R0v(x, this.dpr), R0v(y, this.dpr), s * 0.55, 0, 7);
      ctx.fill();

      /* 只给真·无根的子拉线, 受攻的不拉: 满盘虚线就成噪音了。

         ★ 线的浓淡按**丢的是什么子**分档 (2026-08-26)。
         原来所有攻击线都是同一个 alpha .55 + 同一个线宽, 于是"车照着我的马"
         和"卒盯着我的卒"画得一模一样。实际后果是: 那条决定这一手怎么走的线
         (丢一个马) 淡到看不见, 而旁边那条对方威胁箭 (丢一个象, 便宜一半) 是
         深色实心头, 一眼就抢走全部注意力 —— 视觉体量按类别分配, 没按轻重分配。
         G 2026-08-26 在这个局面上完全没看到车, 只看到炮, 因此读不懂引擎为什么
         让他上马。信息在屏幕上, 但没有体量, 等于没发生 (DESIGN.md 第六节)。

         分档用的是无根高亮已有的那套语言 —— 不换形状不换颜色, 只用浓淡,
         所以不需要在 DESIGN.md 里新开一条。 */
      if (loose) {
        const heavy = it.val >= PIECE_VAL[N];   // 车马炮算重子, 兵卒士象算轻子
        ctx.globalAlpha = heavy ? .82 : .5;
        ctx.strokeStyle = TH.alert || TH.crimson;
        ctx.lineWidth = this.lw(s * (heavy ? 0.042 : 0.024));
        ctx.setLineDash([s * 0.16, s * 0.12]);
        for (const at of it.att) {
          const [ax, ay] = this.xy(rowOf(at.from), colOf(at.from));
          const ang = Math.atan2(y - ay, x - ax), back = s * 0.5;
          ctx.beginPath();
          ctx.moveTo(ax + Math.cos(ang) * back, ay + Math.sin(ang) * back);
          ctx.lineTo(x - Math.cos(ang) * back, y - Math.sin(ang) * back);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /* 摆棋态: 标出"要你看一眼"的点。

     形状用的是无根高亮那一档 (子底下垫一层警示色), 颜色也是同一个警示色 ——
     按 DESIGN.md 第二节这本该是冲突的, 一个画法不许有两个意思。这里成立的理由是
     **模式互斥**: 摆棋的时候盘上没有无根、没有控制、没有箭头, 两个意思永远不会
     同时出现在一张盘上。第九节把这条写进了规范。

     空的交叉点上不许垫填色 (那是没有归属的污渍), 所以空点用一道细的警示环。
     点一下就消 —— 那个动作的意思是"我看过了, 没问题"。 */
  drawUnsure(pos) {
    const { ctx, s } = this;
    const set = this.unsure;
    if (!set || !set.size) return;
    ctx.save();
    for (const sqi of set) {
      const [x, y] = this.xy(rowOf(sqi), colOf(sqi));
      const cx = R0v(x, this.dpr), cy = R0v(y, this.dpr);
      if (pos.board[sqi]) {
        ctx.globalAlpha = 0.30;
        ctx.fillStyle = TH.alert || TH.crimson;
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.55, 0, 7); ctx.fill();
      } else {
        ctx.globalAlpha = 0.72;
        ctx.strokeStyle = TH.alert || TH.crimson;
        ctx.lineWidth = this.lw(s * 0.022);
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.34, 0, 7); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* 控制图层: 每个交叉点谁打得多。象棋讲控制线和制高点, 但没有任何界面画出来过。
     只画差值不画绝对数, 因为"谁说了算"才是要看的东西。 */
  drawControl(pos) {
    const { ctx, s } = this;
    /* ★ 用 controlCount 不是 bearers。
       bearers 回答的是"谁正在打谁的**子**" —— 车只登记射线上第一个有子的格,
       中间的空格一个都不登记。拿它画"控制"等于说车不控制自己射线上的空格,
       而车线正是象棋里最要紧的控制。这个图层从做出来到 2026-08-23 一直是错的,
       名字叫"控制", 画的却是攻击图。 */
    const r = controlCount(pos, 1), b = controlCount(pos, -1);
    ctx.save();
    for (let i = 0; i < NSQ; i++) {
      const d = r[i] - b[i];
      if (!d) continue;
      const [x, y] = this.xy(rowOf(i), colOf(i));
      ctx.globalAlpha = Math.min(.22, .07 + Math.abs(d) * .05);
      ctx.fillStyle = d > 0 ? TH.crimson : TH.ink;
      // 菱形不是方块: 方块跟棋子的圆抢形状, 满盘小方块看着像噪点
      const k = s * (0.16 + Math.min(3, Math.abs(d)) * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, y - k); ctx.lineTo(x + k, y); ctx.lineTo(x, y + k); ctx.lineTo(x - k, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // canvas 没有 letter-spacing, 手动摊开
  spaced(text, cx, cy, gap) {
    const { ctx } = this;
    const ws = [...text].map(ch => ctx.measureText(ch).width);
    const total = ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
    let x = cx - total / 2;
    ctx.textAlign = 'left';
    for (let i = 0; i < ws.length; i++) { ctx.fillText([...text][i], x, cy); x += ws[i] + gap; }
    ctx.textAlign = 'center';
  }

  tick(r, c) {
    const { ctx, s } = this;
    const [x, y] = this.xy(r, c);
    const g = s * 0.1, len = s * 0.17;
    ctx.beginPath();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      if (c === 0 && sx < 0) continue;
      if (c === W - 1 && sx > 0) continue;
      const gx = this.ln(x + sx * g), gy = this.ln(y + sy * g);
      ctx.moveTo(gx, this.ln(y + sy * (g + len)));
      ctx.lineTo(gx, gy);
      ctx.lineTo(this.ln(x + sx * (g + len)), gy);
    }
    ctx.stroke();
  }

  piece(x, y, p, selected) {
    const { ctx, s } = this;
    const red = p > 0;
    const ink = red ? TH.crimson : TH.ink;
    const rad = Math.round(s * 0.425 * this.dpr) / this.dpr;
    const cx = Math.round(x * this.dpr) / this.dpr;
    const cy = Math.round(y * this.dpr) / this.dpr;

    /* 棋子分两种画法, 因为两种主题是两个体系:

       纸  = 印刷体系。棋子就是纸上一枚墨圈, 圈用**行棋方的颜色**。
             之前红子外面套一圈蓝灰 (#aab4c0), 那圈灰是廉价感的直接来源:
             一枚红子的边凭什么是灰的。而且当时同心画了三道圈 (外沿 / 倒角棱 /
             刻槽), 三道近乎等距的细圈在小尺寸下糊成一片, 那不是精致是脏。
             现在只留一道, 它同时是子的边界和子的归属。

       木/竹 = 材质体系。棋子是一块车出来的木饼, 最外那圈是**木头本色**,
             面上刻一道槽, 槽才用行棋方的颜色。这一档保留倒角环带 —— 材质感
             全在那条带上, 描一条线替代不了, 一条线只会让棋子像贴纸。 */
    const bevel = TH.bevel;
    if (TH.pieceEdge) {
      ctx.beginPath(); ctx.arc(cx, cy + this.lw(s * 0.04), rad, 0, 7);
      ctx.fillStyle = TH.pieceEdge; ctx.fill();
    }

    const faceCol = red ? TH.redFace : TH.blkFace;
    const inner = rad - (bevel ? this.lw(s * 0.07) : 0);

    if (bevel) {
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7);
      ctx.fillStyle = bevel; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, 7);
    ctx.fillStyle = faceCol; ctx.fill();

    if (this.pieceTex) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7); ctx.clip();
      const tex = this.pieceTex[(Math.abs(Math.round(cx) * 7 + Math.round(cy) * 13)) % this.pieceTex.length];
      ctx.drawImage(tex, cx - rad, cy - rad, rad * 2, rad * 2);
      ctx.restore();
    }

    if (TH.rimSide) {
      // 印刷体系: 一道圈, 行棋方的颜色, 就是全部
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7);
      ctx.lineWidth = this.lw(s * 0.030);
      ctx.strokeStyle = ink;
      ctx.stroke();
    } else {
      // 材质体系: 倒角和子面之间的那道棱 + 最外沿 + 刻槽
      if (bevel) {
        ctx.beginPath(); ctx.arc(cx, cy, inner, 0, 7);
        ctx.lineWidth = this.lw(s * 0.01);
        ctx.strokeStyle = TH.edge || TH.ruleStrong;
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7);
      ctx.lineWidth = this.lw(s * 0.016);
      ctx.strokeStyle = TH.edge || TH.ruleStrong;
      ctx.stroke();

      const ring = inner - this.lw(s * TH.ringGap);
      if (TH.carve) {
        ctx.beginPath(); ctx.arc(cx, cy + this.lw(1), ring, 0, 7);
        ctx.lineWidth = this.lw(s * 0.028);
        ctx.strokeStyle = TH.carve; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, ring, 0, 7);
      ctx.lineWidth = this.lw(s * 0.028);
      ctx.strokeStyle = ink; ctx.stroke();
    }

    ctx.font = `${(rad * 1.12).toFixed(1)}px ${PIECE_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const ch = (red ? NAME_RED : NAME_BLACK)[Math.abs(p)];
    /* 光学居中: 用字形真实的上下边界算, 不要拿 baseline 加一个魔数偏移。
       楷体各字高度不一致 ("一" 和 "馬" 差很多), 固定偏移会让一盘棋里
       有的字偏上有的字偏下。 */
    const m = ctx.measureText(ch);
    const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
    const bl = (asc !== undefined && desc !== undefined)
      ? cy + (asc - desc) / 2 : cy + rad * 0.38;
    const base = Math.round(bl * this.dpr) / this.dpr;

    // 刻字: 下沿先一道浅色 (刻痕的受光面), 再压上墨色
    if (TH.carve) {
      ctx.fillStyle = TH.carve;
      ctx.fillText(ch, cx, base + this.lw(1));
    }
    ctx.fillStyle = ink;
    ctx.fillText(ch, cx, base);
    /* 选中态不在这里画。它是"我此刻的意图", 归覆盖层的粗环那一类,
       而这个方法只负责把一枚棋子画出来。之前选中会把子面换成金色 ——
       金色现在专属引擎建议, 不许在别处出现 (DESIGN.md 第二节)。 */
  }

  /* 这一屏上到底有哪几支箭。两趟 (杆在下 / 头在上) 共用这一份定义,
     免得两边各写一次然后颜色对不上。

     ★ 颜色一律是**走这一步的那一方的颜色**, 没有第三种颜色。
     之前建议箭是金色的, 那是为了和"上一手"区分开; 但上一手后来改成只用细环,
     那个冲突早就不存在了, 金色就成了纯粹多出来的一种颜色 —— 既难看,
     又要给纸/木/竹每个主题单独配一版。
     现在: 建议 = 行棋方的颜色 + 实线; 威胁 = 对方的颜色 + 虚线。
     两者天然一红一黑, 不需要第三种颜色就分得开, 而且颜色本身在说"这是谁的一步"。
     整个盘面从此只有朱红、墨、灰。 */
  arrowList(pos) {
    const col = sd => sd > 0 ? TH.crimson : TH.ink;
    /* 预览期间**只画这条变化**, 别的一律让位。
       第一手是"接下来真要走的那一步" → 实线实心头;
       第二手起是推演出来还没发生的 → 虚线空心头。两档都是本来就有的画法,
       没有为这个功能新开形状, 也没有新开颜色 (颜色仍旧只说这一手是谁走的)。
       顺序不靠颜色也不靠粗细: 起点环里写一个序号 —— 那个环本来就在,
       只是以前是空的。递减的不透明度做二次提示, 越靠后越淡。 */
    if (this.preview && this.preview.length) {
      return this.preview.map((m, i) => ({
        from: m.from, to: m.to, color: col(m.side),
        dashed: i > 0, alpha: Math.max(.34, .95 - i * 0.12), step: i + 1,
      }));
    }
    const out = this.arrows.map(a => ({ ...a, color: col(pos.side) }));
    if (this.threatMove) {
      out.push({ from: this.threatMove[0], to: this.threatMove[1],
                 color: col(-pos.side), dashed: true, alpha: .7 });
    }
    return out;
  }

  arrowPass(pos, phase) {
    for (const a of this.arrowList(pos)) this.arrow({ ...a, phase });
  }

  /* 一步棋画成一支箭。分两趟画:
       phase 'under' —— 只画杆, 在棋子之下
       phase 'over'  —— 画箭头和起点环, 在棋子之上

     为什么要分: 整支箭压在棋子上时, 长箭会从棋子身上割过去 (看着像把子切开了);
     整支箭藏在棋子下时, 走一两格的着法 —— 象棋的绝大多数 —— 又被两端的棋子
     完全盖住。杆在下头在上, 两种情况都成立。

     几何是定死的比例, 不随距离变形: 杆从起点圆心外 0.30 格出发, 箭尖停在落点
     圆心外 0.13 格。走一格的着法也还剩得下杆和一个完整的头。

     ★ 盘上不写标签。名字 (引擎首选 / 对方威胁) 放在棋盘正下方的图例里 ——
     写在盘上时两个标签会互相撞、会盖住棋子、会把虚线切断, 那比"要记约定"更糟。
     盘面只承载几何, 命名交给图例。 */
  arrow({ from, to, color, dashed, alpha, phase, step }) {
    const { ctx, s } = this;
    const [x0, y0] = this.xy(rowOf(from), colOf(from));
    const [x1, y1] = this.xy(rowOf(to), colOf(to));
    const a = Math.atan2(y1 - y0, x1 - x0);
    const col = color || TH.ink;
    const A = alpha !== undefined ? alpha : 0.92;
    const head = s * 0.25;

    const sx = x0 + Math.cos(a) * s * 0.30, sy = y0 + Math.sin(a) * s * 0.30;
    const tipx = x1 - Math.cos(a) * s * 0.13, tipy = y1 - Math.sin(a) * s * 0.13;
    // 杆收在箭头根部, 不伸进三角里 —— 伸进去在虚线下会露出一截
    const ex = tipx - Math.cos(a) * head * 0.92, ey = tipy - Math.sin(a) * head * 0.92;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.globalAlpha = A;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;

    if (phase === 'under') {
      if (Math.hypot(ex - sx, ey - sy) > 1) {
        ctx.lineWidth = this.lw(s * 0.040);
        if (dashed) ctx.setLineDash([s * 0.15, s * 0.11]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      return;
    }

    const headPath = () => {
      ctx.beginPath();
      ctx.moveTo(tipx, tipy);
      ctx.lineTo(tipx - Math.cos(a) * head + Math.cos(a + Math.PI / 2) * head * 0.46,
                 tipy - Math.sin(a) * head + Math.sin(a + Math.PI / 2) * head * 0.46);
      ctx.lineTo(tipx - Math.cos(a) * head + Math.cos(a - Math.PI / 2) * head * 0.46,
                 tipy - Math.sin(a) * head + Math.sin(a - Math.PI / 2) * head * 0.46);
      ctx.closePath();
    };
    // 纸色外套: 头和起点环压在棋子上, 落在红字黑字木纹上都要读得清
    ctx.globalAlpha = 1;
    ctx.strokeStyle = TH.paper;
    ctx.lineWidth = this.lw(s * 0.05);
    headPath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x0, y0, s * 0.30, 0, 7); ctx.stroke();

    ctx.globalAlpha = A;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    /* 实心头 = 已经确定要发生的一步 (引擎建议我走的);
       空心头 = 只是推演出来、还没发生的 (对方的威胁)。不看颜色也分得出。 */
    headPath();
    if (dashed) { ctx.lineWidth = this.lw(s * 0.024); ctx.stroke(); }
    else ctx.fill();
    // 起点环: 一格的着法上, 光看杆分不清是从哪个子出发的
    ctx.lineWidth = this.lw(s * 0.022);
    ctx.beginPath(); ctx.arc(x0, y0, s * 0.30, 0, 7); ctx.stroke();

    /* 变化里的第几手。
       序号写在**已经存在的起点环里**, 不新开一个记号, 也不在盘上写名字 ——
       名字 (第几选 / 这一支是什么) 仍旧归棋盘下方那行图例 (DESIGN.md 三之二),
       盘上只放一个序数, 一个字符, 撞不到别的东西。
       没有序号的箭 (对局中的引擎首选 / 对方威胁) 走的还是老路径, 一个字都不多画。 */
    if (step) {
      const r = s * 0.155;
      const bx = x0 - Math.cos(a) * s * 0.30, by = y0 - Math.sin(a) * s * 0.30;
      ctx.globalAlpha = 1;
      ctx.fillStyle = TH.paper;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.fill();
      ctx.globalAlpha = A;
      ctx.strokeStyle = col; ctx.lineWidth = this.lw(s * 0.02);
      ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = `500 ${(s * 0.19).toFixed(1)}px ${MONO_FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(step), bx, by + s * 0.008);
    }
    ctx.restore();
  }
}


/* ---------- 全局评估曲线 ----------
   S.evals[i] = 第 i 手之前那个局面的评估 (红方视角, 单位是分)。
   i 从 0 到 hist.length, 所以 0 是开局, hist.length 是当前局面。
   它是慢慢填满的: 分析跑过一次填一个, 引擎走一步填一个, 复盘一次全填满。
   填不上的段落用直线接过去, 测到的点单独打一个刻度, 别让人把插值当数据。 */

/* ---------- 形势带 ----------
   棋盘正下方那条横贯全宽的东西。2026-08-23 重做。

   之前这里是一条 56px 高的评估曲线, 里面只有一根发丝线和右端一个刻度 ——
   整页拉远看, 它是一条什么都读不出来的死带子。而真正有内容的"形势分段"
   (均势 → 红优势 → 黑胜势) 被埋在复盘里, 不跑复盘根本看不见。

   现在把两件事合成一个: 底下是分段色块, 上面是评估折线, 常驻。
   它同时是这一页唯一的强水平元素, 用来撑住整页的结构 —— 之前棋盘和右栏
   视觉重量一样, 没有任何东西告诉眼睛先看哪里。

   分段的降噪 (中值滤波 + 合并短段) 和复盘里那套是同一份, 见 phaseSegments()。 */

// 把逐手胜势切成"形势段"。复盘和形势带共用, 两边各写一份的话一定会分叉。
function phaseSegments(advs, upto) {
  const idx = [];
  for (let i = 0; i <= upto; i++) if (advs[i] !== undefined) idx.push(i);
  if (!idx.length) return [];
  const med3 = k => {
    const a = [advs[idx[Math.max(0, k - 1)]], advs[idx[k]], advs[idx[Math.min(idx.length - 1, k + 1)]]];
    return a.slice().sort((x, y) => x - y)[1];
  };
  const runs = () => {
    const out = [];
    idx.forEach((i, k) => {
      const name = phaseText(med3(k));
      const last = out[out.length - 1];
      if (last && last.name === name) { last.to = i; last.n++; }
      else out.push({ name, from: i, to: i, n: 1 });
    });
    return out;
  };
  const merge = (list, minRun) => {
    const out = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && r.n < minRun) { last.to = r.to; last.n += r.n; }
      else out.push({ ...r });
    }
    const fin = [];
    for (const r of out) {
      const last = fin[fin.length - 1];
      if (last && last.name === r.name) { last.to = r.to; last.n += r.n; }
      else fin.push({ ...r });
    }
    return fin;
  };
  let segs = runs();
  for (let minRun = 2; segs.length > 8 && minRun <= 6; minRun++) segs = merge(segs, minRun);
  if (segs.length > 2) segs = merge(segs, 2);
  return segs;
}

class CurveView {
  constructor(canvas) { this.cv = canvas; this.ctx = canvas.getContext('2d'); }

  /* 高度是自适应的。只分析了当前一个局面时, 一条 84px 的带子里几乎全是空白 ——
     那是一大块什么都不说的留白, 比没有更糟。数据点不够就缩成一条矮带。 */
  layout(h) {
    const w = this.cv.clientWidth || 480;
    this.hCss = h || this.hCss || 84;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cv.style.height = this.hCss + 'px';
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(this.hCss * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = this.hCss;
  }

  // 数据点少于三个就没有"走向"可言, 缩到只够放一行说明
  fit(nPts) {
    const want = nPts >= 3 ? 84 : 30;
    if (this.hCss !== want || !this.w) this.layout(want);
  }

  draw(evals, advs, n, cursor) {
    const pts = [];
    for (let i = 0; i <= n; i++) if (evals[i] !== undefined) pts.push(i);
    this.fit(pts.length);
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const segsAll = phaseSegments(advs || [], n);
    // 分段带只在真的有段可画的时候才占地方
    const BAND = (pts.length >= 3 && segsAll.length) ? 17 : 0;
    const top = h - BAND - (BAND ? 4 : 0);
    const mid = top / 2;
    const X = i => n ? (i / n) * (w - 2) + 1 : w / 2;
    const A = i => (advs && advs[i] !== undefined) ? advs[i] : winProb(evals[i]);
    const Y = i => mid - (A(i) - .5) * 2 * (mid - 3);

    ctx.font = '9px "Geist Mono",ui-monospace,monospace';
    ctx.textBaseline = 'middle';

    /* 空状态要长得像有意为之: 一条中线 + 一句说明, 不留悬空的刻度 */
    if (!pts.length) {
      ctx.strokeStyle = TH.ruleSoft || TH.rule; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid + .5); ctx.lineTo(w, mid + .5); ctx.stroke();
      ctx.fillStyle = TH.mute; ctx.textAlign = 'left';
      ctx.fillText('开启分析或运行复盘后, 这里显示整局的形势走向', 2, mid);
      return;
    }

    // ── 底下的分段带 ──
    const segs = segsAll;
    const by = h - BAND;
    if (BAND) {
      for (const sg of segs) {
        const x0 = X(sg.from), x1 = sg.to >= n ? w : X(sg.to + 1);
        const even = sg.name === '均势';
        const red = sg.name.startsWith('红');
        ctx.fillStyle = even ? (TH.ruleSoft || TH.rule) : (red ? TH.crimson : TH.ink);
        ctx.globalAlpha = even ? .5 : .13;
        ctx.fillRect(x0, by, Math.max(1, x1 - x0), BAND);
        ctx.globalAlpha = 1;
        // 段与段之间留一道白缝, 不画分隔线 —— 缝比线安静
        ctx.fillStyle = TH.paper;
        ctx.fillRect(x1 - .5, by, 1, BAND);
        // 段名写在段里, 放不下就不写 (宁可空着也不要压成一团)
        const label = sg.name;
        const tw = ctx.measureText(label).width;
        if (x1 - x0 > tw + 10) {
          ctx.fillStyle = even ? TH.mute : (red ? TH.crimson : TH.ink);
          ctx.textAlign = 'center';
          ctx.fillText(label, (x0 + x1) / 2, by + BAND / 2 + .5);
        }
      }
    }

    // 中线
    ctx.strokeStyle = TH.ruleSoft || TH.rule;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid + .5); ctx.lineTo(w, mid + .5); ctx.stroke();

    // 游标: 结构不是表意, 用灰阶, 画在数据下面
    const cur = cursor < 0 ? n : cursor;
    ctx.strokeStyle = TH.ruleStrong; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(cur) + .5, 0); ctx.lineTo(X(cur) + .5, by); ctx.stroke();

    if (pts.length === 1) {
      const i = pts[0];
      ctx.fillStyle = evals[i] >= 0 ? TH.crimson : TH.ink;
      ctx.beginPath(); ctx.arc(X(i), Y(i), 2.2, 0, 7); ctx.fill();
      return;
    }

    // 面积: 红方占优填在中线以上, 黑方以下
    for (const [sign, color] of [[1, TH.crimson], [-1, TH.ink]]) {
      ctx.beginPath();
      ctx.moveTo(X(pts[0]), mid);
      for (const i of pts) ctx.lineTo(X(i), Y(i));
      ctx.lineTo(X(pts[pts.length - 1]), mid);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = color;
      ctx.globalAlpha = .18;
      if (sign > 0) ctx.fillRect(0, 0, w, mid); else ctx.fillRect(0, mid, w, top);
      ctx.restore();
    }

    // 折线
    ctx.beginPath();
    pts.forEach((i, k) => { const x = X(i), y = Y(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = TH.ink; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.stroke();

    // 实测点打刻度, 免得把插值当成数据
    ctx.fillStyle = TH.ink;
    for (const i of pts) { const x = X(i), y = Y(i); ctx.fillRect(x - .75, y - .75, 1.5, 1.5); }

    /* ── 关键的手 ──
       复盘跑完之后, 把败着/漏着/妙手/好棋直接标在曲线上。
       G: "那种关键的落子, 在复盘的局势榜上, 其实是要有具体的点的, 就方便我可以过去"。
       他是对的: 曲线告诉你"哪里塌下去了", 但塌下去的那一手是第几手、叫什么,
       之前只能去右栏的列表里对着手数找。标在曲线上, 点一下就跳过去。

       形状按 DESIGN.md 的轴走: 颜色仍然是走子方的颜色, 四个等级用**形状**分开,
       不另造颜色。规范见 DESIGN.md 第二节"曲线上的关键手"。

       ★ 2026-08-25 重画。原来只有两档区别: 空心=好 / 实心=坏, 轻重靠半径
       3.2 与 4.2 之差。那个差在 84px 高的带子里根本看不出来 —— G 的原话是
       "我都不知道哪些是好的, 哪些是妙手, 哪些是问题手"。四个等级挤在两种画法上,
       等于没分。现在改成两条正交的轴:
         空心 / 实心  = 好 / 坏      (原来就有, 保留)
         加不加第二层 = 重 / 轻      (新增, 这才是"妙手 vs 好棋"的区别)
       于是四个等级各有一个不会认错的形状, 而且全部从圆派生。 */
    if (this.marks) {
      for (const m of this.marks) {
        if (m.i > n) continue;
        const x = X(m.i), y = Y(Math.min(m.i, n));
        const col = m.side > 0 ? TH.crimson : TH.ink;
        const heavy = m.kind === '妙手' || m.kind === '败着';
        const good = m.kind === '妙手' || m.kind === '好棋';
        const r = 3.2;
        /* 垫底色必须是**页面底色** `TH.page.bg`, 不是棋盘的纸色 `TH.paper`。
           这条曲线画在页面上, 不画在棋盘上, 两者并不相等 (纸主题里是
           #ffffff 对 #f4f6f9)。原来垫的是棋盘纸色, 于是每个记号背后都有一圈
           比页面略深的灰晕 —— 单看不明显, 但败着那一圈外环一旦留缝, 缝里
           那点灰就变成一个看得见的光环了。重的那一档垫得更宽, 给外圈让位。 */
        ctx.beginPath(); ctx.arc(x, y, (heavy ? r + 2.6 : r) + 1.6, 0, 7);
        ctx.fillStyle = (TH.page && TH.page.bg) || TH.paper; ctx.fill();

        ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
        if (good) { ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); }
        else { ctx.fillStyle = col; ctx.fill(); }

        if (heavy) {
          /* 第二层对好坏两边是**同一个东西**: 外面再套一圈, 中间留一道底色的缝。
             这样两条轴才真的正交 —— 圆心填没填色只说好坏, 有没有外圈只说轻重,
             读的人不需要同时比较两处。
             第一版让妙手在环里点一颗实心, 那颗心把"实心=坏"这条主线索给踩了:
             一个圆心是实的记号, 第一眼读到的就是"坏", 得再看一层才纠正回来。 */
          ctx.beginPath(); ctx.arc(x, y, r + 2.4, 0, 7);
          ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
    }
  }

  // 命中曲线上的某个标记 (点它要跳到那一手, 而不是跳到光标所在的手)
  markAt(px, py) {
    if (!this.marks || !this.marks.length) return null;
    const n = S.hist.length;
    const X = i => n ? (i / n) * (this.w - 2) + 1 : this.w / 2;
    let best = null, bd = 12;
    for (const m of this.marks) {
      const d = Math.abs(X(m.i) - px);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  plyAt(px) {
    const n = S.hist.length;
    if (!n) return -1;
    return Math.max(0, Math.min(n, Math.round(((px - 1) / (this.w - 2)) * n)));
  }
}

/* ---------- 应用 ---------- */

const $ = id => document.getElementById(id);

const S = {
  pos: new Position(),
  hist: [],            // {uci, mv, zh, fenBefore, side}
  /* 这一局是从哪个局面开始的。摆棋 / 读图 / ?fen= 进来的残局**不是**开局,
     而 hist 在那条路径上是空的 —— 所以"退到没有棋谱时该回到哪"这件事,
     除了这里没有第二个地方记着。
     2026-08-27 之前 undo() 在 hist 空了以后 fallback 到 START_FEN,
     于是摆一个残局走几手再连按悔棋, 最后一下会**静默换成标准开局**:
     盘上三十二个子, 棋谱空的, 而人以为自己只是多点了一下。 */
  baseFen: START_FEN,
  cursor: -1,          // 棋谱浏览位置; -1 表示跟着最新
  mode: 0,             // 0 人机, 1 双人同机
  mySide: 1,
  level: 2,
  hint: 0,             // 0 关, 1 元信息, 2 全开
  analysisOn: false,
  thinking: false,
  review: null,
  lastAnalysis: null,
  lastAnalysisFen: null,
  evals: [],           // 逐手评估, 兵值, 红方视角 (右上角那个读数)
  advs: [],            // 逐手胜势 0..1, 红方视角, 来自引擎 WDL (曲线的纵轴)
  mates: {},           // ply -> {winner, n}: 这个局面是不是绝杀, 谁杀, 还剩几步
  over: null,          // 终局: {t, loser, winner, name, why}; null = 还在下
  legend: null,        // 棋盘下方的箭头图例: {pick, threat} 或 {preview:[...]}
  hoverUci: null,      // 鼠标停在候选表哪一行上 (面板重画之后靠它恢复预览)
  flipView: null,      // 画面朝向: null 跟着执子方, true 黑在下, false 红在下
  label: null,         // 标注模式: {items:[{img,fen,tag}], i}
  photo: null,         // 读图进来的那张原图 (data URL), 确认时钉在旁边做参照
  photoFolded: false,  // 原图面板收起来了没有 (存 localStorage)
};

let eng, view, curve;

/* ----- 小工具 ----- */

const cpText = cp => (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
function scoreText(rec) {
  if (rec.mate !== null && rec.mate !== undefined) return (rec.mate > 0 ? '杀 ' : '被杀 ') + Math.abs(rec.mate);
  return cpText(rec.score);
}

// 主变翻成可读的连续计划。每一步都要在新局面上记谱, 不能拿根局面重复转换。
function pvToChinese(posIn, pv, limit = 5) {
  const p = new Position(posIn.fen());
  const out = [];
  for (const u of (pv || []).slice(0, limit)) {
    const mv = uciToMove(u);
    if (!mv || !p.board[mv[0]]) break;
    out.push(moveToChinese(p, mv));
    p.apply(mv);
  }
  return out;
}
// 分数转成红方视角
/* 将杀局面的分数。
   ★ 之前一律压成 ±30000, 于是"杀一"和"杀十"在所有比较里都是同一个数,
   候选表的"差距"列和"另有 N 步相差不到 0.55 兵"这类宽度判断在杀棋局面里
   会全部失真 —— 五条杀着看起来完全等价, 而实际上快一步是有意义的。
   现在按杀的步数递减, 仍然远高于任何非杀着法。 */
// mateScore 的公式在 levels.js (index.html 里先加载它), 这里直接用同一份 —
// 两边各写一套的话, 分档采样和分析栏会对同一个杀局给出不同的排序。
const cpOf = rec => (rec.mate !== null && rec.mate !== undefined) ? mateScore(rec.mate) : rec.score;

const toRed = (rec, sideToMove) => {
  return cpOf(rec) * sideToMove;
};
/* 胜势 = 一个 0..1 的优势指数, 用来画形势带、形势分档, 和算"这一手丢了多少"。

   ★★ 为什么**不**用引擎的 WDL, 尽管我们开着 `UCI_ShowWDL` 也在解析它。
   Pikafish 的 WDL 是一个近乎阶跃的函数。2026-08-23 实测:

       开局      cp=  21   wdl 58/928/14   adv=0.522
       多一兵    cp=  57   wdl 178/818/4   adv=0.587
       多一马    cp= 353   wdl 1000/0/0    adv=1.000
       多一车    cp= 607   wdl 1000/0/0    adv=1.000
       多车马炮  cp= 948   wdl 1000/0/0    adv=1.000

   过了大约 +3 兵它就一律报 1.000 —— 分不出"多一马"和"多一车还带彩"。
   拿一局真棋 (40 手) 逐手采样, **74% 的局面 adv 被压成 0 或 1**。
   对引擎自己没问题 (那些局面之间它确实都必胜), 但我们这把尺子的用途是
   **给同一局面的两步棋做可比的相对刻度**, 而阶跃函数在大半个棋局上分辨率为零 ——
   已经赢定的局面里再走一步大漏, 算出来的损失是 0, 复盘会当它没发生。

   所以退回 logistic, 但**除数不是拍的**: 取 WDL 还没饱和那一段
   (0.03 < adv < 0.97) 反解 k = cp / ln(adv/(1-adv)), 中位数 227, 取 230。
   也就是说这条曲线在引擎自己有分辨力的区间里和引擎一致, 只是把它外推到
   引擎放弃分辨的区间去。

   ★ 它**仍然不是校准过的胜率**。Stockfish 系的 WDL 常数本身就是拿国际象棋
   对局拟的, 我们又在它上面拟了一层。所以界面上一律叫"胜势"不叫"胜率" ——
   要变成真胜率, 得留出一批象棋棋谱做 reliability calibration, 还没做。 */
const WP_K = 230;
const winProb = cp => 1 / (1 + Math.exp(-cp / WP_K));

// 一条候选 → 行棋方视角的胜势 0..1
function advOf(rec) {
  if (!rec) return 0.5;
  if (rec.mate !== null && rec.mate !== undefined) return rec.mate > 0 ? 1 : 0;
  return winProb(rec.score);
}
// 同上, 但换成红方视角
const advRed = (rec, sideToMove) => sideToMove > 0 ? advOf(rec) : 1 - advOf(rec);

function setStatus(html, spinning) {
  $('status').innerHTML = (spinning ? '<span class="spin"></span>' : dotFor()) + '<span id="statusText">' + html + '</span>';
}
function dotFor() {
  if (S.pos.terminal()) return '<span class="dot idle"></span>';
  return `<span class="dot ${S.pos.side > 0 ? 'r' : 'b'}"></span>`;
}

function log(...parts) { $('log').innerHTML = parts.filter(Boolean).join('<span style="opacity:.4">·</span>'); }

/* ----- 渲染 ----- */

function render() {
  const viewPos = displayPos();
  /* 内部表示永远是规范的 (row 0 = 黑方底线, 引擎和规则都按这个来),
     **画出来朝哪边是另一回事**。这两件事之前是混在一起的:
     照片是从黑方那边拍的, 转正之后确认盘却按红在下画, 于是人要对着原图核对时
     得在脑子里把整盘转 180 度 —— 而那正是最容易看漏一枚子的时刻。
     S.flipView: null = 跟着执子方走 (老行为), true/false = 明确指定。 */
  view.flip = (S.flipView !== null && S.flipView !== undefined)
    ? !!S.flipView : (S.mySide < 0 && S.mode === 0);
  view.setupMode = !!S.setup;
  view.unsure = S.setup ? S.setup.unsure : null;
  /* 摆棋态不画被将的重环: 半盘还没摆完的时候"被将"没有意义,
     而那道环是全盘最重的一个标记, 出现一次就抢走一次注意力。 */
  view.checkSq = (!S.setup && viewPos.inCheck(viewPos.side)) ? viewPos.kingSq(viewPos.side) : -1;
  view.draw(viewPos);
  // 视角按钮跟着实际朝向走 —— 读图会替人把它扳过去, 按钮不同步就成了假的
  const fg = $('flipGrp');
  if (fg) fg.querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', (b.dataset.f === '1') === !!view.flip));
  renderSheet();
  renderTop();
  renderTaken();
  renderCurve();
  renderLayerRead();
  /* WebMCP (webmcp.js): the set of tools an agent may call mirrors what is on screen,
     so every redraw is a chance for that set to change. The hook is here and nowhere else. */
  if (window.agentSync) agentSync();
}

// 浏览棋谱时显示历史局面, 否则显示当前局面
function displayPos() {
  if (S.setup) return S.setup.pos;
  if (S.cursor < 0 || S.cursor >= S.hist.length) return S.pos;
  const p = new Position(S.hist[S.cursor].fenBefore);
  return p;
}

const FULL_SET = { [R]: 2, [N]: 2, [B]: 2, [A]: 2, [C]: 2, [P]: 5 };

function renderTaken() {
  const pos = displayPos();
  const have = { 1: {}, '-1': {} };
  for (let i = 0; i < NSQ; i++) {
    const p = pos.board[i];
    if (!p) continue;
    const k = p > 0 ? 1 : -1, t = Math.abs(p);
    have[k][t] = (have[k][t] || 0) + 1;
  }
  // 子力值只用来给个粗略的差, 不参与任何判断, 引擎的评估才是准的
  const VAL = { [R]: 9, [N]: 4, [C]: 4.5, [B]: 2, [A]: 2, [P]: 1 };
  const gone = side => {
    const out = [];
    let lost = 0;
    for (const t of [R, C, N, B, A, P]) {
      const n = FULL_SET[t] - (have[side][t] || 0);
      for (let i = 0; i < n; i++) out.push((side > 0 ? NAME_RED : NAME_BLACK)[t]);
      lost += n * VAL[t];
    }
    return { txt: out.join(''), lost };
  };
  const r = gone(1), b = gone(-1);
  const diff = r.lost - b.lost;   // 红丢得多 = 黑占便宜
  // 掉下来的子按它本来的颜色显示: 卒是黑的就画墨色, 兵是红的就画朱红。
  // 反过来按"被谁吃"上色只会让人读错。
  $('taken').innerHTML =
    (b.txt ? `<span class="b">${b.txt}</span>` : '') +
    (r.txt ? `<span class="r">${r.txt}</span>` : '') +
    (!r.txt && !b.txt ? `<em>${t('taken.none')}</em>` : '') +
    (diff !== 0 ? `<span class="bal">${t(diff > 0 ? 'side.black' : 'side.red')} +${Math.abs(diff).toFixed(diff % 1 ? 1 : 0)}</span>` : '');
}

function renderLayerRead() {
  const el = $('layerRead'); if (!el) return;
  /* 摆棋态不画无根/控制, 那这行读数就必须一起消失。留着的话它报的是**上一个**
     局面的数, 而盘上正在被改 —— 一个和盘面对不上的数字比没有数字糟糕得多。 */
  if (S.setup) { el.textContent = ''; return; }
  if (view.layer === 'control') { el.textContent = t('read.control'); return; }
  if (view.layer !== 'loose') { el.textContent = ''; return; }
  const i = view.looseInfo || { loose: 0, press: 0 };
  el.innerHTML = (i.loose || i.press)
    ? (i.loose ? `<b>${t('read.loose', { n: i.loose })}</b>` : '') + (i.loose && i.press ? ' · ' : '') +
      (i.press ? `<i>${t('read.press', { n: i.press })}</i>` : '')
    : t('read.loose', { n: 0 });
}

/* 棋盘下方的箭头图例。
   盘上那两支箭原来各自带一个标签, 结果它们会互相撞、会盖住棋子、还会把虚线
   切断 (G 2026-08-23 截图指出)。名字挪到这里: 盘面只承载几何, 命名交给图例。
   线样也照着盘上画 —— 实线实心头 = 要发生的, 虚线空心头 = 推演的。 */
function renderLegend() {
  const el = $('legend');
  if (!el) return;
  const L = S.legend;
  const has = L && (L.preview || L.pick || L.threat);
  el.hidden = !has;
  if (!has) { el.innerHTML = ''; return; }
  const item = (kind, o, name) => {
    const c = o.side > 0 ? 'r' : 'k';
    return `<span class="lg ${c}"><i class="${kind}"></i>` +
           `<em>${name}</em><b>${o.zh}</b></span>`;
  };
  /* 变化预览的时候这一行整个换掉, 不和首选/威胁并列。
     盘上此刻只有这一条变化 (arrowList 里把别的都让掉了), 图例跟着只说这一件事 ——
     图例和盘面不一致比没有图例更糟。序号和盘上起点环里那个数字是同一套,
     一眼对得上, 于是"盘上只放几何、命名交给图例"这条仍然成立。 */
  if (L.preview) {
    // agent 画的箭头走同一条预览通道, 只是标题换成它给的那句 (webmcp.js show_on_board)
    el.innerHTML = `<span class="lgh">${L.previewTitle || t('legend.preview')}</span>` +
      L.preview.map((m, i) =>
        `<span class="pv ${m.side > 0 ? 'r' : 'k'}"><i>${i + 1}</i><b>${m.zh}</b></span>`).join('');
    return;
  }
  let h = '';
  if (L.pick) h += item('solid', L.pick, L.pick.rank ? t('legend.choice', { n: L.pick.rank }) : t('legend.enginePick'));
  if (L.threat) h += item('dash', L.threat, t('legend.threat'));
  el.innerHTML = h;
}

/* 曲线的图例。
   DESIGN.md 三之二: 任何需要"先学会一套编码"才能读的图形都欠一个名字, 而那个
   名字要待在图形旁边的空地上。盘上那两支箭一直有图例, 曲线上的关键手却没有 ——
   于是四个形状全靠猜。G 2026-08-25: "我都不知道哪些是好的, 哪些是妙手,
   哪些是问题手"。他问的不是形状不够看, 是没人告诉他形状是什么意思。

   只列**这一局真的出现过的**等级。列出一个没发生的等级等于让人去盘上找一个
   不存在的记号, 而空状态要长得像有意为之 (第六节)。 */
const CURVE_MARKS = ['妙手', '好棋', '漏着', '败着'];
const MARK_CLASS = { 妙手: 'brill', 好棋: 'good', 漏着: 'miss', 败着: 'blunder' };

function renderCurveLegend() {
  const el = $('curveLegend');
  if (!el) return;
  const pts = S.evals.filter(v => v !== undefined).length;

  // 还没跑过复盘: 与其空着, 不如说清这些记号什么时候才会出现
  if (!curve.marks || !curve.marks.length) {
    if (pts < 3 || S.review) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="hint">跑一次复盘, 妙手 / 好棋 / 漏着 / 败着 会直接标在这条线上</span>';
    return;
  }

  const have = CURVE_MARKS.filter(g => curve.marks.some(m => m.kind === g));
  el.hidden = false;
  el.innerHTML = have.map(g =>
    `<span class="cl"><i class="cm ${MARK_CLASS[g]}"></i>${g}</span>`).join('') +
    `<span class="hint">${t('legend.hint')}</span>`;
}

function renderCurve() {
  if (!curve) return;
  /* 曲线上要标的关键手。只在复盘跑过之后才有 —— 对局中我们并不知道哪一手是败着,
     知道了也不该告诉正在下棋的人。 */
  curve.marks = !S.review ? null : S.review.plies
    .filter(p => {
      const g = GRADE(p);
      return g === '败着' || g === '漏着' || g === '妙手' || g === '好棋';
    })
    /* 一盘崩掉的棋能标出二十几个点, 那条曲线就成了一串珠子, 反而找不到重点。
       按损失排序只留最重的十二个 —— 复盘要看的是"最该回去看的那几手",
       不是"所有不完美的手"。 */
    .sort((a, b) => (b.probLoss || 0) - (a.probLoss || 0))
    .slice(0, 12)
    .map(p => {
      const g = GRADE(p);
      /* i 是**画在哪**: 评估的下跌出现在这一手走完之后, 也就是 evals[p.i+1]。
         ply 是**点了跳到哪**: 要跳到这一手本身 (右栏那份失误列表跳的也是 p.i),
         不然点一个败着会跳到它的下一手, 看到的是对方的应着。
         两者差一, 之前只存了一个, 点下去总是差一手。 */
      return { i: p.i + 1, ply: p.i, side: p.side, zh: p.zh, grade: g, kind: g };
    });
  curve.draw(S.evals, S.advs, S.hist.length, S.cursor);
  renderCurveLegend();
  /* 主读数: 一个大字的判断 + 一个小字的精度。
     这是整页最该一眼看到的东西, 之前它是 11px 等宽字缩在右栏顶上,
     而棋盘底下那条带子里什么都没有。 */
  const at = S.cursor < 0 ? S.hist.length : S.cursor;
  /* 当前这一手不一定测过 (复盘还在通扫、或者只分析过几个局面), 这时候往回找
     最近一个测过的。直接写"尚无数据"是不对的 —— 图里明明有线, 读数却说没数据,
     看的人只会以为坏了。但**必须把是哪一手写出来**, 否则就是拿别的局面的数
     冒充当前局面。 */
  let k = at;
  while (k >= 0 && S.evals[k] === undefined) k--;
  const now = $('curveNow');
  if (k < 0) {
    now.innerHTML = `<b>${t('curve.now')}</b><span>${t('curve.nodata')}</span>`;
    $('curveAt').textContent = S.hist.length ? t('curve.at', { k: at, n: S.hist.length }) : '';
    return;
  }
  const v = S.evals[k], a = S.advs[k];
  /* 绝杀在这里必须自己说自己。
     压成兵值之后杀棋和"多两个车"长得一样 (都是 red 大优), 胜势更是直接顶到 1.000,
     于是整页最大的那个读数在有杀的时候写的是"红胜势" —— 和领先很多完全分不开。
     G 2026-08-27: "我现在都看不出来那个绝杀无解了"。 */
  const mt = S.mates[k];
  const word = mt ? `${mt.winner > 0 ? '红' : '黑'}方绝杀`
    : a !== undefined ? phaseText(a) : (v >= 0 ? '红方占先' : '黑方占先');
  /* 显示用的翻译。内部 word 保持中文 —— 下面的 startsWith('红') 靠它判红黑上色。 */
  const wordTx = mt ? t('curve.mateBy', { s: t(mt.winner > 0 ? 'side.red' : 'side.black') })
    : a !== undefined ? band(word)
    : t('curve.ahead', { s: t(v >= 0 ? 'side.red' : 'side.black') });
  /* 刚走的那一手值多少。
     位置分回答"现在谁占先", 但人落完子想知道的是"我刚才那一下把局面推向了哪边" ——
     那是两个数, 后者以前一个地方都没有 (只有复盘跑完才在棋谱里补上标签)。
     ★ 用**走子方自己的视角**: 正数 = 这一手替他把局面往好里推。位置分那一栏是
     红方视角, 两个视角混在一行里必须各自写清是谁的, 所以前面钉一个"红/黑"。
     颜色仍然只表示"谁的" (DESIGN.md 第二节), 不给涨跌发绿色和红色。
     只在**看的就是最新那一手**且前后两个局面都实测过的时候才显示 ——
     拿插值算差值等于把插值当数据。 */
  let delta = '';
  if (k === at && at >= 1 && S.evals[at - 1] !== undefined && S.hist[at - 1]) {
    const mover = S.hist[at - 1].side;
    const d = (v - S.evals[at - 1]) * mover;
    delta = `<span class="dv ${mover > 0 ? 'r' : 'k'}">` +
            `${t('curve.delta', { s: t(mover > 0 ? 'side.red' : 'side.black') })} ` +
            `${d >= 0 ? '+' : '−'}${Math.abs(d / 100).toFixed(2)}</span>`;
  }
  now.innerHTML = `<b class="${word.startsWith('红') ? 'r' : ''}">${wordTx}</b>` +
    (mt ? `<span class="mate">${t('curve.mate', { n: mt.n })}</span>`
        : `<span>${t(v >= 0 ? 'side.red' : 'side.black')} +${Math.abs(v / 100).toFixed(2)} ${t('unit.pawn')}</span>`) + delta;
  $('curveAt').textContent = !S.hist.length ? ''
    : k === at ? t('curve.at', { k: at, n: S.hist.length })
    : t('curve.stale', { k });
}

function renderTop() {
  $('metaMode').textContent = S.setup ? t('head.setup')
    : (S.mode === 0
       ? `${t('head.mode.vsEngine')} · ${t(S.mySide > 0 ? 'head.side.red' : 'head.side.black')} · ${t('lvl.' + S.level)}`
       : t('head.mode.twoPlayer'));
  if (S.setup) {
    if (S.setup.busy) setStatus(t('status.reading'), true);
    else setStatus(`${t('head.setup')} · ${t(S.setup.side > 0 ? 'setup.redFirst' : 'setup.blackFirst')}`, false);
    return;
  }
  if (S.over) {
    setStatus(`${t('st.win', { s: t(S.over.winner > 0 ? 'side.red' : 'side.black') })} · ${S.over.name}`, false);
  } else if (S.thinking) {
    setStatus(t('st.thinking'), true);
  } else {
    const chk = S.pos.inCheck(S.pos.side) ? ' · ' + t('st.check') : '';
    setStatus(t('st.toMove', { s: t(S.pos.side > 0 ? 'side.red' : 'side.black') }) + chk, false);
  }
}

function renderSheet() {
  const el = $('sheet');
  let html = '';
  for (let i = 0; i < S.hist.length; i += 2) {
    const no = i / 2 + 1;
    html += `<div class="n">${no}</div>`;
    for (const j of [i, i + 1]) {
      const h = S.hist[j];
      if (!h) { html += '<div></div>'; continue; }
      const cur = (S.cursor === j) || (S.cursor < 0 && j === S.hist.length - 1);
      const rv = S.review && S.review.plies[j];
      let tag = '', bad = '';
      if (rv) {
        const g = GRADE(rv);
        if ((rv.probLoss || 0) >= G_BAD.缓手) {
          tag = `<span class="tag">-${(rv.probLoss).toFixed(0)}</span>`;
          if ((rv.probLoss || 0) >= G_BAD.漏着) bad = ' bad';
        } else if (g === '妙手' || g === '好棋') {
          tag = `<span class="tag">${g}</span>`;
          bad = ' good';
        }
      }
      html += `<div class="m${h.side > 0 ? ' red' : ''}${cur ? ' cur' : ''}${bad}" data-i="${j}">${h.zh}${tag}</div>`;
    }
  }
  el.innerHTML = html || `<div class="n"></div><div class="empty">${t('sheet.empty')}</div>`;
  $('sheetMeta').textContent = S.hist.length ? t('sheet.count', { n: S.hist.length }) : '';
  el.scrollTop = el.scrollHeight;
}

/* 谁在打我的子 —— 纯规则算的, 不等引擎也不花引擎的钱。

   引擎交出来的是一个分和一条主变, 它从来不说"你这个子没人守, 而且正被车照着"。
   而人看不懂引擎建议的最常见原因恰恰是这个: 它推荐的那一手是在躲一个人根本
   没注意到的攻击, 于是那一手看起来像是自己往对方炮口上撞。

   2026-08-26 G 在一个局面上问"为什么该上马, 上马不是送给对方炮吃吗"。真因是
   他的马正被一路直通的车照着而且无根 —— 盘面用警示色说了, 分析栏却一个字没提,
   而分析栏里唯一那句文字威胁 (对方威胁 炮三进七) 讲的是另一个子。
   两个东西各说各的, 没人把它们并成一句话。

   数据 `looseSquares()` 早就算好了 (连攻击者是哪个子、在哪一格都带着),
   这里只做一件事: 翻成棋谱的说法接进分析栏。用词照 DESIGN.md 第四节, 只用
   "无根 / 受攻"这两个本来就有的词, 不新造画法也不新开颜色。 */
const LOOSE_MAX = 4;   // 列太长就不是提醒而是噪音了, 余下的只报个数

function looseCallout(pos) {
  const stm = pos.side;
  // 一枚子写成"马8"/"车二": 名字 + 它所在的纵线号, 号按各自一方的数法
  const name = (s) => {
    const p = pos.board[s], sd = p > 0 ? 1 : -1;
    return (sd > 0 ? NAME_RED : NAME_BLACK)[Math.abs(p)] + numStr(fileNum(colOf(s), sd), sd);
  };
  const mine = looseSquares(pos).filter(x => (pos.board[x.sq] > 0) === (stm > 0));
  if (!mine.length) return '';
  /* 无根排在受攻前面, 同一档里贵的排前面。
     无根是白丢, 受攻是守得住但有压力 —— 这是两种紧迫程度, 不该按棋盘顺序混着列。 */
  mine.sort((a, b) => a.kind === b.kind ? b.val - a.val : (a.kind === 'loose' ? -1 : 1));
  const shown = mine.slice(0, LOOSE_MAX);
  const rest = mine.length - shown.length;
  const line = (it) =>
    `<b>${t(it.kind === 'loose' ? 'loose.loose' : 'loose.attacked')}</b> ` +
    `<span class="pc">${name(it.sq)}</span>` +
    `<span class="by">← ${it.att.map(a => name(a.from)).join(' ')}</span>`;
  return `<div class="callout loose">${shown.map(line).join('<br>')}` +
    `<span class="hint">${rest ? t('loose.more', { n: rest }) : ''}${t('loose.before')}</span></div>`;
}

/* 绝杀要有体量。

   在这之前, "三步杀"和"多两个车"在界面上的差别是候选表某一格里写着 `杀 3` 而不是
   `+9.48` —— 一个 11px 的等宽读数, 挨着四个长得一样的读数。而这两件事对下棋的人
   根本不是同一个量级: 一个是"局面很好", 另一个是"这局已经结束了, 只是还没落子"。
   G 2026-08-27: "我现在都看不出来那个绝杀无解了"。

   ★ 敢写"无解"是因为它按定义就成立: 候选表按分排序, 第一名都是被杀,
   那就没有一步不被杀。反过来"我杀"那一侧不写无解 —— 对方还有得挑, 只是挑不掉结果。
   (DESIGN.md 第四节: 自称的指标要写清边界。)

   杀法整条列出来, 不只报一个数字。"三步杀"最没用的形态就是只告诉你有,
   不告诉你怎么走 —— 那句话唯一的效果是让人知道自己没看见。 */
function mateBanner(res, pos) {
  const best = res.candidates[0];
  if (!best || best.mate === null || best.mate === undefined) return '';
  const n = Math.abs(best.mate);
  const win = best.mate > 0;
  const stm = pos.side;
  const who = (win ? stm : -stm) > 0 ? '红' : '黑';
  // 杀法要走满整条主变: N 步杀是 2N-1 个 ply, 最后一手是将死的那一下
  const line = pvToChinese(pos, best.pv || [best.uci], Math.max(1, n * 2 - 1));
  return `<div class="mateban ${win ? '' : 'lose'}">` +
    `<b>${who}方 ${n} 步绝杀</b>` +
    `<span class="tag">${win ? '你在杀' : '无解'}</span>` +
    (line.length ? `<div class="line">` + line.map((z, i) =>
        `<b class="${(i % 2 === 0) === (stm > 0) ? 'r' : 'k'}">${z}</b>`).join('') + `</div>` : '') +
    `<span class="hint">${win
      ? '对方怎么应都逃不掉, 这条线走到底就是将死。'
      : '这一栏列的是能拖最久的那条, 不是能活下来的那条 —— 引擎的首选都被杀, 就没有不被杀的一步。'}` +
    `</span></div>`;
}

function renderAnalysis(res, meta, posIn) {
  const sec = $('anaBody');
  if (!res) { sec.innerHTML = `<div class="note">${t('ana.press')}</div>`; return; }

  // 局面必须由调用方传进来。自己去 displayPos() 拿的话, 用户在搜索途中翻棋谱,
  // 记谱就会用错局面, 表里会出现根本走不了的着法。
  const pos = posIn || displayPos();
  const stm = pos.side;
  // 浏览棋谱时, 把当时实战走的那一手在候选表里点出来
  const playedUci = (S.cursor >= 0 && S.hist[S.cursor]) ? S.hist[S.cursor].uci : null;
  const best = res.candidates[0];
  if (!best) { sec.innerHTML = `<div class="note">${t('ana.noMoves')}</div>`; return; }

  /* 这里原来还有一条评估条 + "红略优 红 +0.82"。删掉了 ——
     棋盘正下方那条形势带已经把同一个读数用更大的字、更靠近棋盘的位置显示了,
     两个一起摆在一屏里, 读的人第一反应是"这两个是不是不一样"。
     一个事实只放一个地方。右栏这一节的活是"引擎想走哪一步", 从大标题直接开始。 */

  const bestScore = cpOf(best);

  // 条形按"比首选差多少"画, 而且刻度按本次候选的实际跨度归一化。
  // 固定刻度会让五条候选看起来一样长, 那条就白画了。
  const scores = res.candidates.map(c => cpOf(c));
  const rawSpread = bestScore - Math.min(...scores);
  const spread = Math.max(60, rawSpread);
  // 候选之间本来就没差别的时候, 五条一样长的条是纯噪音。整列去掉,
  // 底下那句"这里比较宽松"已经把话说完了。
  const hasBar = rawSpread >= 50;

  const cloud = S.cloud && S.cloud.fen === pos.fen() ? S.cloud.data : null;
  // 云库对这个局面一条都没有的话, 空着的"实战"列只是噪音, 整列去掉
  /* 云库那一列只在**能区分**的时候才显示。
     开局常常五个候选云库全标"正着", 那一整列每行都写同一个词, 是噪音不是信息。 */
  const cloudVals = res.candidates.map(c => {
    const v = cloud && cloud.get(c.uci);
    return v ? (v.rank >= 2 ? '正着' : v.rank === 1 ? '可走' : '') : '';
  });
  /* 只在这一列**真的分得开**的时候才显示。
     原来的判据是"去重后多于一种", 但 ['正着','','','',''] 也满足它 ——
     结果就是一列只有第一行有字、下面全空, 看起来是坏了不是信息少
     (DESIGN.md 第六节)。要至少两行有值, 且这些值不全一样。 */
  const filled = cloudVals.filter(Boolean);
  const hasCloud = filled.length >= 2 && new Set(filled).size > 1;

  /* 每个候选后面标一句它到底干了什么。引擎只给一个分, 分不告诉你这一步是吃子、
     将军, 还是把自己一个挂着的子解开了。这些全是规则算得出来的, 不花引擎的钱。 */
  const annotate = (mv) => {
    const tags = [];
    const cap = pos.board[mv[1]];
    if (cap) tags.push(t('ann.capture', { s: (cap > 0 ? NAME_RED : NAME_BLACK)[Math.abs(cap)] }));
    const after = new Position(pos.fen());
    after.apply(mv);
    if (after.inCheck(after.side)) tags.push(t('ann.check'));
    const before = looseSquares(pos).filter(l => (pos.board[l.sq] > 0) === (stm > 0) && l.kind === 'loose').length;
    const now = looseSquares(after).filter(l => (after.board[l.sq] > 0) === (stm > 0) && l.kind === 'loose').length;
    if (now < before) tags.push(t('ann.defend'));
    else if (now > before) tags.push(t('ann.loose', { n: now }));
    return tags;
  };

  let rows = '';
  res.candidates.forEach((c, i) => {
    const mv = uciToMove(c.uci);
    if (!mv) return;
    const zh = moveToChinese(pos, mv);
    const sc = cpOf(c);
    const d = sc - bestScore;
    // 留 6px 底: 排最后那条如果算到 0 就整根消失, 看着像渲染坏了
    const w = Math.round(6 + 46 * Math.max(0, Math.min(1, 1 + d / spread)));
    const wr = cloudVals[i];
    const tags = annotate(mv);
    rows += `<tr data-uci="${c.uci}" class="${c.uci === playedUci ? 'played' : ''}"><td>${i + 1}</td>` +
      `<td>${zh}${tags.length ? `<span class="ann">${tags.join(' ')}</span>` : ''}</td>` +
      `<td>${scoreText(c)}</td>` +
      `<td>${i === 0 ? '' : (d / 100).toFixed(2)}</td>` +
      (hasCloud ? `<td class="wr">${wr}</td>` : '') +
      (hasBar ? `<td><span class="barwrap"><span class="bar" style="width:${w}px"></span></span></td>` : '') +
      `</tr>`;
  });

  // 可替代性: 前两名差距小说明这一步随便走都行, 差距大说明是关键时刻
  let gap = null;
  if (res.candidates.length >= 2) {
    const s2 = cpOf(res.candidates[1]);
    gap = bestScore - s2;
  }
  const critical = gap !== null && gap >= 90;

  /* 表之前先给一句判断。
     一张按分排序的候选表回答的是"哪一步最好", 但落子之前真正要先知道的是
     "这里到底有多难选" —— 只有一步站得住, 和五步都行, 是两种完全不同的处境,
     而它们在表里长得一模一样。

     宽度用"落后首选不到 0.55 兵"来数。这个数必须和标题口径一致:
     只要 gap 超过 0.55, 可行数按定义就是 1, 所以标题一律由可行数决定,
     gap 只用来说明差距有多大。 */
  const VIABLE = 55;
  const viable = res.candidates.filter(c => {
    const sc = cpOf(c);
    return bestScore - sc < VIABLE;
  }).length;
  const bestZh = moveToChinese(pos, uciToMove(best.uci));

  /* 标题就是这一步棋本身。
     之前写的是"唯 X 可行""先判此处可行之着有几路"这种判断句 —— 又文绉绉又要读一遍
     才知道引擎想走哪。人打开分析栏第一眼要的就是"它想走哪一步", 那就把那一步
     直接大字放上去, 旁边跟着分。宽度信息降级成副标题一行。 */
  /* 引擎的最终结论 (UCI bestmove) 和候选表第一名不一致时, 说出来。
     搜索是按毫秒掐断的, 掐断时它可能正停在下一层搜到一半 —— 那一层没进候选表,
     但引擎自己算进去了。之前的做法是把 bestmove 偷偷挪到第一位, 那会破坏
     "候选表按分排序"这个下游都依赖的不变量。现在不动表, 只如实标注。 */
  const disagree = res.bestmove && !res.agrees ? res.bestmove : null;

  const sub = gap === null ? t('ana.calculating')
    : viable <= 1 && gap >= 150 ? t('ana.only', { n: (gap / 100).toFixed(2) })
    : viable <= 1 ? t('ana.secondGap', { n: (gap / 100).toFixed(2) })
    : t('ana.alternatives', { n: viable - 1, gap: (VIABLE / 100).toFixed(2) });

  sec.innerHTML =
    `<div class="decision-head">` +
      `<div class="decision-kicker">${t('ana.best')}</div>` +
      `<div class="decision-title"><em>${bestZh}</em>` +
        `<span class="sc">${scoreText(best)}</span></div>` +
      `<p class="decision-dek">${sub}</p>` +
    `</div>` +
    mateBanner(res, pos) +
    /* 受攻清单紧跟在首选下面, 排在候选表之前。
       它是读懂那一手的前提而不是补充说明 —— 引擎推荐的着法多半就是在处理这几枚子,
       放到表格后面等于让人先困惑一遍再看到答案。 */
    looseCallout(pos) +
    `<table class="cand"><thead><tr><th></th><th>${t('ana.move')}</th><th>${t('ana.score')}</th><th>${t('ana.gap')}</th>` +
    (hasCloud ? `<th>${t('ana.cloud')}</th>` : '') + (hasBar ? '<th></th>' : '') + `</tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<div class="varline" id="varline"></div>` +
    (disagree
      ? `<div class="callout"><b>引擎最终选的是另一手</b> ` +
        `候选表按最后一个完整搜索层排序, 而搜索是按时间掐断的 —— 掐断时它可能正在
         下一层。引擎交出来的最终着法是 <b class="n">${(() => {
           const m2 = uciToMove(disagree);
           return m2 ? moveToChinese(pos, m2) : disagree;
         })()}</b>。<span class="hint">两者绝大多数时候一样, 不一样时以引擎的最终着法为准</span></div>`
      : '') +
    `<div class="methodline">${t('ana.methodLine')}</div>`;

  /* 原来这里有一段"云库真人胜率和引擎评估背离"的提示, 已删。
     那个提示成立的前提是两个数来自不同的来源 (一个算的一个测的), 而实测表明
     云库的 winrate 就是它自己 score 的换算 —— 两个引擎的评估之间的差异没有
     那种解释力, 说成"客观最优 vs 实战易走"是编的。 */

  $('anaMeta').textContent = meta || '';

  /* 点一行只在盘上画**这一步**, 后续变化用文字列在表下面。
     之前是把主变前四手一起画成带编号的箭头 —— 满盘四条线, 根本看不出点的是哪一步,
     也分不清那是我的计划还是对方的应着。一次只强调一件事。 */
  let picked = best.uci;   // 当前"点中"的那一条; 悬停结束要恢复成它
  const showLine = (uci) => {
    const c = res.candidates.find(x => x.uci === uci);
    const mv = uciToMove(uci);
    if (!mv) return;
    picked = uci;
    /* 名字要说清这一支箭是什么。首选写"引擎首选", 点了别的候选写第几选 ——
       之前两种情况画出来一模一样, 看的人不知道盘上这支箭是引擎推荐的
       还是自己刚才点的那条。 */
    const rank = res.candidates.findIndex(x => x.uci === uci);
    const zh = moveToChinese(pos, mv);
    view.arrows = [{ from: mv[0], to: mv[1] }];
    /* 箭的名字放在棋盘下方的图例里, 不写在盘上。
       写在盘上时两支箭的标签会互相撞、会盖住棋子、会把虚线切断。 */
    S.legend = { ...(S.legend || {}), pick: { zh, rank: rank <= 0 ? 0 : rank + 1, side: stm } };
    renderLegend();
    view.arrowSig = 'pick:' + uci;
    view.draw(pos);
    writeVar(pvToChinese(pos, c && c.pv ? c.pv : [uci], 6));
  };

  const writeVar = (line) => {
    const el = $('varline');
    if (!el) return;
    el.innerHTML = line.length < 2 ? '' :
      `<span class="lab">${t('ana.after')}</span>` +
      line.map((z, i) => `<b class="${(i % 2 === 0) === (stm > 0) ? 'r' : 'k'}">${z}</b>`).join('');
  };

  /* 悬停 = 把这条变化之后的几步一起摆到盘上。
     点击仍旧只画**那一步** (那是"我要走的") —— 两件事分给两个动作:
     点是决定, 停是打量。2026-08-23 删掉的那一版把两者合在点击里, 结果满盘四条线
     常驻, 分不清哪支是自己刚点的。悬停天生是瞬时的, 手一移开盘面就干净了。 */
  const previewFor = (uci) => {
    const c = res.candidates.find(x => x.uci === uci);
    const pv = (c && c.pv && c.pv.length) ? c.pv : [uci];
    const p = new Position(pos.fen());
    const out = [];
    for (const u of pv.slice(0, PREVIEW_PLIES)) {
      const mv = uciToMove(u);
      // 主变每一步都要在**新局面**上验一次: 引擎给的 pv 后段偶尔会带上
      // 走不了的着法 (换位表命中的残留), 照着画会画出一支凭空出现的箭
      if (!mv || !p.board[mv[0]]) break;
      if (!p.legalMoves(p.side).some(m => m[0] === mv[0] && m[1] === mv[1])) break;
      out.push({ from: mv[0], to: mv[1], side: p.side, zh: moveToChinese(p, mv) });
      p.apply(mv);
    }
    return out;
  };

  sec.querySelectorAll('tr[data-uci]').forEach(tr => {
    tr.onclick = () => {
      sec.querySelectorAll('tr').forEach(x => x.classList.remove('sel'));
      tr.classList.add('sel');
      showLine(tr.dataset.uci);
    };
    tr.onmouseenter = () => {
      S.hoverUci = tr.dataset.uci;
      const line = previewFor(tr.dataset.uci);
      showPreview(line, pos);
      /* 表格下面那行"之后 …"也要跟着走。
         不跟的话屏幕上会同时挂着两条**不同**的变化: 盘上和图例是手底下这一条,
         而"之后"那一行还写着上次点中的那条。两个都对, 合起来就读不懂了。 */
      if (line.length >= 2) writeVar(line.map(m => m.zh));
    };
    tr.onmouseleave = () => {
      if (S.hoverUci === tr.dataset.uci) S.hoverUci = null;
      clearPreview(pos);
      showLine(picked);   // 盘上的箭、图例、"之后"那一行一起恢复成点中的那条
    };
  });
  // 默认就把首选摆出来, 不用点
  showLine(best.uci);
  /* 搜索途中这个面板每层重画一次, innerHTML 一换, 正被悬停的那一行就没了 ——
     它的 mouseleave 永远不会来, 预览于是卡在盘上直到下一次走子。
     所以重画之后按记着的那条候选自己恢复一次 (它还在就重摆, 不在就撤掉)。 */
  if (S.hoverUci && res.candidates.some(c => c.uci === S.hoverUci)) {
    const row = sec.querySelector(`tr[data-uci="${S.hoverUci}"]`);
    if (row) row.classList.add('hov');
    showPreview(previewFor(S.hoverUci), pos);
  } else {
    S.hoverUci = null;
    clearPreview(pos);
  }
}

/* 一条变化最多摆几步。
   六步是象棋一个"回合半"的自然长度 (我 / 对方 / 我 / 对方 / 我 / 对方),
   再长盘上就开始出现同一枚子的第三支箭, 那时候读的是杂技不是棋。 */
const PREVIEW_PLIES = 6;

function showPreview(line, pos) {
  /* 只有一步的"变化"不是变化 —— 那正是点击已经画好的东西, 换一套画法只会闪一下。 */
  if (!line || line.length < 2) return clearPreview(pos);
  view.preview = line;
  S.legend = { ...(S.legend || {}), preview: line };
  renderLegend();
  view.arrowSig = 'pv:' + line.map(m => `${m.from}-${m.to}`).join(',');
  view.draw(pos || displayPos());
}

function clearPreview(pos) {
  if (!view || !view.preview) return;
  view.preview = null;
  if (S.legend) { S.legend = { ...S.legend }; delete S.legend.preview; }
  renderLegend();
  view.arrowSig = '';
  view.draw(pos || displayPos());
}

/* ----- 分析 ----- */

let anaToken = 0;

/* 引擎死了要有体量。
   这条和终局那条是同一个教训: 一件事发生了却没有任何视觉体量, 等于没发生 ——
   在这里的表现就是界面一直挂着"思考中", 而实际上根本没有人在思考。 */
function engineDied(why) {
  S.thinking = false;
  $('anaMode').textContent = t('ana.broken');
  const el = $('anaBody');
  if (el) {
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'callout hot';
    box.innerHTML = `<b>引擎已停止</b> ${String(why).replace(/[<>&]/g, '')}` +
      '<span class="hint">分析和人机都不会再动了。多半是权重那 50MB 没拿全或者' +
      '浏览器缓存里存了一份坏的, 重载会绕过缓存重新下一次。</span>';
    const btn = document.createElement('button');
    btn.className = 'act'; btn.textContent = '重载引擎';
    btn.onclick = () => location.reload();
    box.appendChild(btn);
    el.appendChild(box);
  }
  $('selfcheck').innerHTML = `<span class="err">${t('sc.prefix')} · ${t('sc.stopped')} · ` +
    String(why).replace(/[<>&]/g, '').slice(0, 120) + '</span>';
  render();
}

/* 关掉分析要真的关掉: 作废 token、掐搜索、清盘上标记、把面板恢复原状。
   原来只改了个文字和箭头, 在途的搜索算完还会把结果写回来, 于是"关了还在动"。 */
function stopAnalysis() {
  anaToken++;
  S.lastAnalysis = null; S.lastAnalysisFen = null; S.threat = null;
  if (eng) eng.stop();
  view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null; view.threatMove = null;
  S.legend = null; renderLegend();
  $('anaMode').textContent = t('ana.off');
  $('anaMeta').textContent = '';
  renderAnalysis(null);
  render();
}

async function runAnalysis() {
  if (!eng.ready) return;
  const target = displayPos();
  if (target.terminal()) return;
  /* 轮到对方走的时候不分析。
     人要看的是自己这边该怎么走, 引擎思考自己那一手的过程对棋手没有意义,
     而且它会把评估栏和候选表整个翻到对方视角, 看着像数据在乱跳。 */
  if (S.mode === 0 && S.cursor < 0 && target.side !== S.mySide) {
    $('anaMode').textContent = t('ana.waiting');
    return;
  }
  const fen = target.fen();
  const token = ++anaToken;
  $('anaMode').textContent = t('ana.thinking');
  eng.stop();
  cloudQuery(fen).then(data => {
    if (token !== anaToken) return;
    S.cloud = { fen, data };
    if (S.lastAnalysis && S.lastAnalysisFen === fen) renderAnalysis(S.lastAnalysis, null, target);
  });
  const res = await eng.analyze(fen, {
    ms: 4000, multipv: 5,
    onInfo: info => {
      if (token !== anaToken) return;
      $('anaMode').textContent = t('ana.depth', {n: info.depth});
      if (info.depth < 5) return;   // 前几层没信息量, 画了只是闪
      renderAnalysis({ candidates: info.candidates, maxDepth: info.depth },
        `${(info.nodes / 1000 | 0)}k 节点`, target);
      /* 读数也边搜边给, 不等四秒搜完。
         右栏已经在逐层刷新了, 而棋盘底下那条形势带却要等到最后才动 ——
         同一次搜索的两个出口不同步, 看着像其中一个坏了。
         绝杀尤其: 引擎第六层就看见了, 主读数却还写着"尚无数据"。 */
      noteEval(S.cursor < 0 ? S.hist.length : S.cursor, info.candidates[0], target.side);
    },
  });
  if (res.failed) return engineDied(res.failed);
  if (token !== anaToken || displayPos().fen() !== fen) return;   // 期间局面变了, 结果作废
  S.lastAnalysis = res;
  S.lastAnalysisFen = fen;
  $('anaMode').textContent = t('ana.depth', {n: res.maxDepth});
  renderAnalysis(res, `${(res.nodes / 1000 | 0)}k 节点`, target);
  noteEval(S.cursor < 0 ? S.hist.length : S.cursor, res.candidates[0], target.side);

  const th = await runThreat(target, token);
  if (token !== anaToken || !th) return;
  S.threat = { fen, ...th };
  const el = document.createElement('div');
  el.className = 'callout threat';
  el.innerHTML = `<b>对方威胁</b> <span class="mv">${th.zh}</span>` +
    `<span class="hint">若此手虚耗, 对方即走此着</span>`;
  $('anaBody').appendChild(el);
  // 盘上用一条虚线标出来, 和候选箭头分开
  view.threatMove = th.mv;
  S.legend = { ...(S.legend || {}), threat: { zh: th.zh, side: -target.side } };
  renderLegend();
  view.draw(target);
}


/* 对方在等着走什么。
   把当前局面的走棋方翻过来搜一小会儿, 等于问"如果这一手让给你, 你会走哪"。
   这是下棋的人真正想知道的问题, 而所有引擎界面都只回答"我该走哪"。
   被将的时候没意义 (必须应将), 直接跳过。 */
async function runThreat(pos, token) {
  if (pos.inCheck(pos.side)) return null;
  const flipped = new Position(pos.fen());
  flipped.side = -flipped.side;
  if (flipped.kingsFace() || flipped.inCheck(flipped.side)) return null;
  const fen = flipped.fen();
  const r = await eng.analyze(fen, { ms: 900, multipv: 1 });
  if (r.failed || token !== anaToken) return null;
  const c = r.candidates[0];
  if (!c) return null;
  const mv = uciToMove(c.uci);
  if (!mv || !flipped.board[mv[0]]) return null;
  return { zh: moveToChinese(flipped, mv), mv, score: c.score, depth: r.maxDepth };
}

/* ----- 引擎走子 ----- */

/* 把一次搜索的结果记进曲线。ply = 这个局面在棋谱里的位置。
   兵值和胜势分开存: 曲线的纵轴画胜势 (那才是"局面往谁那边倒"),
   鼠标停上去要显示的读数是兵值。两个刻度来源不同, 不能互相换算回去。 */
function noteEval(ply, best, sideToMove) {
  if (!best) return;
  S.evals[ply] = toRed(best, sideToMove);
  S.advs[ply] = advRed(best, sideToMove);
  /* 杀棋要单独记一份。
     兵值那一栏走 mateScore() 压成一个很大的分, 胜势压成 0 或 1 —— 两个刻度
     都留不下"还有几步"这件事, 而那正是绝杀里唯一重要的数。
     winner = 谁在杀 (带符号的一方), n = 还有几步。 */
  if (best.mate !== null && best.mate !== undefined) {
    S.mates[ply] = { winner: best.mate > 0 ? sideToMove : -sideToMove, n: Math.abs(best.mate) };
  } else {
    delete S.mates[ply];
  }
  renderCurve();
}

/* 每手一个读数。
   在这之前, 评估只在三种时候产生: 引擎轮到自己走 (顺手记一个)、开着分析、跑复盘。
   人机对局里那正好是**一半的局面** —— 引擎走完之后轮到人的那个局面从来没人测。
   于是棋盘底下那条形势带在人思考的整段时间里都写着"第 N 手 · 之后未测",
   也就是最需要看的那一刻它是空的。G 2026-08-27: "每次下完一步之后, 当前这盘棋的
   评分你给我列出来"。

   这里不是"分析"的廉价替身, 是另一件事: 分析要五条候选、四秒、云库和威胁,
   这里只要一个数。400ms / MultiPV 1 —— 比引擎自己走一步便宜一个数量级,
   人还没来得及看清盘面它就回来了。

   两条不能省的守卫:
   ① 已经有更贵的读数就不覆盖 (分析和复盘测得比这准, 别用便宜的盖掉);
   ② 回来的时候局面必须还是当时那个 —— 引擎是一条队列, 排到它的时候
      人可能已经又走了两步, 把旧分写进新的 ply 就是拿别的局面的数冒充。 */
let evalToken = 0;

async function quickEval() {
  if (!eng || !eng.ready || S.setup || S.over) return;
  const pos = S.pos;
  if (pos.terminal()) return;
  const ply = S.hist.length;
  if (S.evals[ply] !== undefined) return;
  const fen = pos.fen(), stm = pos.side;
  const token = ++evalToken;
  const r = await eng.analyze(fen, { ms: 400, multipv: 1 });
  if (r.failed) return engineDied(r.failed);
  if (token !== evalToken || S.hist.length !== ply || S.pos.fen() !== fen) return;
  noteEval(ply, r.candidates[0], stm);
}

let moveToken = 0;

async function engineMove() {
  if (S.over || S.pos.terminal()) return;
  const token = ++moveToken;
  S.thinking = true; renderTop();
  const lv = LEVELS[S.level];
  const t0 = performance.now();
  const ply = S.hist.length, stm = S.pos.side, fen = S.pos.fen();
  // 云库查询和引擎搜索并行, 不让它拖慢落子
  const cloudP = lv.bookPrior ? cloudQuery(fen) : Promise.resolve(null);
  /* 边搜边把读数写出去, 不等它搜完。
     高档位一步要想两三秒, 而这几秒正是人刚落完子盯着盘面的时候 —— 那时候
     形势带写着"之后未测"就等于每一手都空一次。前几层没信息量, 从第 6 层起。 */
  const res = await eng.analyze(fen, { ms: lv.ms, multipv: lv.multipv,
    onInfo: info => {
      if (token !== moveToken || info.depth < 6) return;
      noteEval(ply, info.candidates[0], stm);
    } });
  if (res.failed) return engineDied(res.failed);   // 引擎没了就别装作在想, 否则轮到它走就永远卡住
  if (token !== moveToken) return;   // 期间重开或悔棋了, 这一手作废
  noteEval(ply, res.candidates[0], stm);

  /* 引擎认输。真人棋手在被绝杀之前很久就推枰了, 引擎一路顶到被将死才停,
     那既不像人也让人白走十几手。判据用胜势不用兵值: 兵值到 -15 兵在残局是必败,
     在中局可能还有反扑。连续三手胜势低于 4% 才认 —— 一手的抖动不算数。
     入门/业余档不认输: 那两档本来就该让你把杀着走出来。 */
  const a0 = res.candidates[0] ? advOf(res.candidates[0]) : 0.5;
  S.hopeless = a0 < 0.04 ? (S.hopeless || 0) + 1 : 0;
  if (S.level >= 2 && S.mode === 0 && S.hopeless >= 3 && S.hist.length >= 12) {
    S.thinking = false;
    onGameOver('resign', stm, '引擎认输, 局面已无可为');
    return;
  }

  const cloud = await cloudP;
  if (token !== moveToken) return;
  const got = pickMove(res.candidates, lv, cloud);
  S.thinking = false;
  /* 引擎一个候选都没给回来。之前这里直接 return, 棋盘就停在那儿不动也不说话 ——
     那正是"看起来卡死了"的另一条路径。报错不静默。 */
  if (!got) {
    log('引擎未给出着法', '按重开或悔棋继续');
    renderTop();
    return;
  }
  log(`${lv.name} · ${res.maxDepth} 层 · ${((performance.now() - t0) / 1000).toFixed(1)}s`, got.kind);
  /* ★ 引擎给的着法要先验合法再落。
     Pikafish 的坐标行号是 0-9 而我们全站是 1-10, 转换错了**不会报错** ——
     错位一行之后往往仍然是一个"看起来正常"的着法, 会被安安静静地走出来,
     整盘棋从此不知所云。这一层守卫的成本是几微秒, 换的是这类错误必然当场暴露。 */
  const mv = uciToMove(got.uci);
  if (!mv || !S.pos.legalMoves(S.pos.side).some(m => m[0] === mv[0] && m[1] === mv[1])) {
    log(`<span class="err">引擎给了不合法的着法 ${got.uci}</span>`, '坐标转换可能出错了');
    renderTop();
    return;
  }
  doMove(mv);
}

/* ----- 走子 ----- */

// posKey 在 rules.js 里 (repetitionVerdict 也要用同一份指纹定义)

function repetitionCount() {
  const now = posKey(S.pos);
  let n = 1;
  for (const h of S.hist) {
    const p = new Position(h.fenBefore);
    if (posKey(p) === now) n++;
  }
  return n;
}

function doMove(mv) {
  if (!mv) return;
  const zh = moveToChinese(S.pos, mv);
  const fenBefore = S.pos.fen();
  const side = S.pos.side;
  S.pos.apply(mv);
  S.hist.push({ uci: moveToUci(mv), mv, zh, fenBefore, side });
  S.cursor = -1;
  view.lastMove = mv;
  view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
  view.threatMove = null;
  S.lastAnalysis = null; S.threat = null;
  anaToken++;
  if (eng) eng.stop();
  render();
  view.animateMove(mv[0], mv[1]);
  saveGame();

  say(`${side > 0 ? '红' : '黑'} ${zh}` + (S.pos.inCheck(S.pos.side) ? ', 将军' : ''));

  // 走完这一手轮到谁, 谁就是没棋可走的那一方 = 输家
  const t = S.pos.terminal();
  if (t) { onGameOver(t, S.pos.side); return; }

  /* 重复局面。中国象棋里三次重复**不是**自动和棋 ——
     靠不停将军逼平的一方判负 (长将)。判定在 rules.js 的 repetitionVerdict。
     长捉 (反复捉子) 规则细得多, 没做, 所以那种情况只提示不裁定。 */
  const verdict = repetitionVerdict(S.hist, S.pos);
  if (verdict && verdict.loser !== undefined) {
    onGameOver('perpetual', verdict.loser, '长将判负');
    return;
  }
  const rep = repetitionCount();
  if (rep >= 3 && S.repeat !== rep) {
    S.repeat = rep;
    log(`局面第 ${rep} 次重复`, verdict && verdict.draw
      ? '双方都不构成长将, 未作裁定 (长捉规则未实现)'
      : '此处仅作提示');
  }

  const engineWillMove = S.mode === 0 && S.pos.side !== S.mySide;
  if (S.analysisOn) runAnalysis();
  else if (S.hint === 1) hintMeta();

  if (engineWillMove) setTimeout(engineMove, 220);
  /* 别人不管这个局面的时候才自己测一个。
     引擎马上要走 → 它开搜之前就会记一个 (engineMove 里的 noteEval), 重复;
     分析开着 → runAnalysis 会记一个更准的。剩下的情况 (双人同机、
     人机里刚轮到人、载入的残局没开分析) 以前一个数都没有, 现在有。 */
  else if (!S.analysisOn) quickEval();
}

/* 「我想走这一步, 行不行」。
   元信息这一档的完整形态: 不告诉你该走哪, 但你说出一步它能判。

   ★ 这个函数是**人和 agent 共用的同一份判据** —— 页面上那个输入框和
   webmcp.js 的 check_my_move 都调它。两边同一个答案, 是"agent 只能拿到人
   能拿到的东西"这条规则在这一档的兑现; 各写一套迟早会漂。

   算法和复盘里那一栏一致 (probLoss): 本方此刻的胜势, 减去走完这一手之后
   (在对方视角取补) 的胜势, 乘 100。**首选是什么全程不出现在返回值里。** */
async function checkMove(pos, mv) {
  const fen = pos.fen();
  const before = await eng.analyze(fen, { ms: 700, multipv: 2 });
  if (before.failed) return { failed: before.failed };
  const bestAdv = before.candidates[0] ? advOf(before.candidates[0]) : 0.5;
  const wasTop = before.candidates[0] && moveToUci(mv) === before.candidates[0].uci;

  const after = new Position(fen); after.apply(mv);
  let myAdv;
  if (after.terminal()) {
    /* 走完就终局: 引擎搜不了, 也不需要搜。对方无着可走 = 我方赢定。 */
    myAdv = 1;
  } else {
    const res2 = await eng.analyze(after.fen(), { ms: 700, multipv: 1 });
    if (res2.failed) return { failed: res2.failed };
    myAdv = res2.candidates[0] ? 1 - advOf(res2.candidates[0]) : bestAdv;
  }
  const probLoss = Math.max(0, (bestAdv - myAdv) * 100);
  const verdict = wasTop ? '正着' : probLoss >= G_BAD.漏着 ? '有问题'
    : probLoss >= G_BAD.缓手 ? '偏软' : '可走';
  return { verdict, probLoss, wasTop, gone: fen !== pos.fen() };
}

// 元信息提示: 只说"这里要不要小心", 不说该走哪一步
async function hintMeta() {
  if (S.mode === 0 && S.pos.side !== S.mySide) return;
  const fen = S.pos.fen();
  const res = await eng.analyze(fen, { ms: 700, multipv: 2 });
  if (res.failed) return engineDied(res.failed);
  if (S.pos.fen() !== fen) return;
  const [a, b] = res.candidates;
  if (!a || !b) return;
  const gap = (a.score ?? 0) - (b.score ?? 0);
  $('anaBody').innerHTML = (gap >= 90
    ? `<div class="callout hot"><b>${t('meta.narrow')}</b> ${t('meta.narrowNote')}</div>`
    : `<div class="callout">${t('meta.loose')}</div>`) + askBoxHtml();
  bindAskBox();
  $('anaMode').textContent = t('ana.meta');
}

/* 元信息档里给人的那个入口。棋手本来就是用记谱在脑子里说话的,
   所以这里收的就是"炮二平五"这种写法, 跟 agent 那个工具收的一模一样。 */
function askBoxHtml() {
  return `<div class="askmove">
    <label for="askMoveIn">${t('meta.askLabel')}</label>
    <input id="askMoveIn" type="text" spellcheck="false" placeholder="${t('meta.askPlaceholder')}">
    <button type="button" class="act sm" id="askMoveBtn">${t('meta.askBtn')}</button>
    <div class="askout" id="askMoveOut"></div>
  </div>`;
}

function bindAskBox() {
  const inp = $('askMoveIn'), btn = $('askMoveBtn'), out = $('askMoveOut');
  if (!inp || !btn) return;
  const run = async () => {
    const text = inp.value.trim();
    if (!text) return;
    const pos = displayPos();
    const mv = parseMoveText(pos, text);
    if (!mv) { out.className = 'askout bad'; out.textContent = t('meta.askIllegal'); return; }
    out.className = 'askout'; out.textContent = t('meta.askThinking');
    const r = await checkMove(pos, mv);
    if (r.failed) { out.className = 'askout bad'; out.textContent = String(r.failed); return; }
    out.className = 'askout ' + (r.verdict === '有问题' ? 'bad' : r.verdict === '正着' ? 'good' : '');
    out.textContent = `${t('verdict.' + r.verdict)} · ${t('meta.askLoss', { n: r.probLoss.toFixed(1) })}`;
  };
  btn.onclick = run;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
}

/* 记谱或 UCI -> 着法。webmcp.js 里那份 parseMove 是同一个意思, 但它要返回错误对象,
   这里只要成或不成。 */
function parseMoveText(pos, text) {
  const raw = String(text || '').trim().toLowerCase();
  const legal = pos.legalMoves(pos.side);
  if (/^[a-i](10|[1-9])[a-i](10|[1-9])$/.test(raw)) {
    const mv = uciToMove(raw);
    return (mv && legal.some(m => m[0] === mv[0] && m[1] === mv[1])) ? mv : null;
  }
  const want = String(text || '').replace(/[\s　]+/g, '');
  const hits = legal.filter(m => moveToChinese(pos, m).replace(/[\s　]+/g, '') === want);
  return hits.length === 1 ? hits[0] : null;
}

/* 终局。
   ★ 在 2026-08-23 之前, 这里只往日志行和读屏区写一句话, 顶栏的状态也只是一行
   10px 的等宽小字。所以一盘棋被将死之后, 屏幕上唯一的变化是引擎不再落子 ——
   G 的原话是"就好像直接卡死了"。他是对的: 一件事发生了却没有任何视觉体量,
   等于没发生。

   现在终局是一条横贯棋盘宽度的结果栏, 上下两道墨线, 结果用大字。
   `who` 是**赢家**, 不是输家 —— 之前只写"X方负", 要读的人自己反一下。 */
function onGameOver(t, loserSide, why) {
  const loser = loserSide !== undefined ? loserSide : S.pos.side;
  const winner = -loser;
  const name = t === 'checkmate' ? '绝杀' : t === 'stalemate' ? '困毙'
    : t === 'perpetual' ? '长将' : '认输';
  S.over = { t, loser, winner, name, why: why ||
    (t === 'stalemate' ? '无着可走, 象棋里困毙同样判负' : '') };
  S.thinking = false;
  anaToken++;
  if (eng) eng.stop();
  say(`${winner > 0 ? '红' : '黑'}方胜, ${name}`);
  log(`${winner > 0 ? '红' : '黑'}方胜`, name);
  renderResult();
  render();
}

function renderResult() {
  const el = $('result');
  if (!el) return;
  if (!S.over) { el.hidden = true; el.innerHTML = ''; return; }
  const { winner, name, why } = S.over;
  const mine = S.mode === 0 ? (winner === S.mySide ? '你赢了' : '你输了') : null;
  el.hidden = false;
  el.className = 'result' + (winner > 0 ? ' red' : '');
  el.innerHTML =
    `<b>${winner > 0 ? '红方胜' : '黑方胜'}</b>` +
    `<span class="how">${name}</span>` +
    (mine ? `<span class="mine">${mine}</span>` : '') +
    (why ? `<span class="why">${why}</span>` : '') +
    `<button class="act again" id="againBtn">再来一局</button>`;
  const b = $('againBtn');
  if (b) b.onclick = () => newGame();
}

// 认输。可逆: 悔棋或重开就当没发生过, 所以不弹确认框挡路
function resign() {
  if (S.over || !S.hist.length) return;
  onGameOver('resign', S.mySide, '主动认输');
}

/* 悔棋。
   ★ 两件事在 2026-08-27 之前是错的, 而且互相掩护:
   ① 退到没有棋谱时回的是 START_FEN 而不是**这一局自己的起点**, 所以摆进来的
      残局会在最后一下悔棋时被换成标准开局 —— 没有任何提示, 盘上突然三十二个子。
   ② 那一下同时把人走的全部着法丢掉, 却和前面每一次悔棋长得一模一样。
   现在 ① 用 S.baseFen 修掉, ② 补一次确认 —— 只在"这一局有自己的起点"
   且"这一下会把棋谱清空"时才问, 平常连着悔棋不受影响。 */
async function undo() {
  if (!S.hist.length) return;
  const backOf = () => (S.mode === 0 && S.hist.length >= 2) ? 2 : 1;
  if (S.baseFen !== START_FEN && S.hist.length <= backOf()) {
    const n = S.hist.length;
    const okd = await askConfirm({
      title: '退回到你摆进来的那个局面?',
      body: `这一局是从一个载入的局面开始的, 不是从开局。` +
            `再悔一次棋谱就空了, 你走的 ${n} 手会一起去掉。`,
      ok: '退回去',
    });
    // 等确认的这几秒里引擎可能已经走了一手, 所有和长度有关的量必须重算
    if (!okd || !S.hist.length) return;
  }
  const back = backOf();
  moveToken++; S.thinking = false; if (eng) eng.stop();
  for (let i = 0; i < back && S.hist.length; i++) S.hist.pop();
  S.pos = new Position(S.hist.length ? S.hist[S.hist.length - 1].fenBefore : S.baseFen);
  if (S.hist.length) S.pos.apply(S.hist[S.hist.length - 1].mv);
  view.lastMove = S.hist.length ? S.hist[S.hist.length - 1].mv : null;
  view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
  S.cursor = -1; S.review = null; $('revSec').hidden = true;
  S.lastAnalysis = null;
  S.over = null; renderResult();   // 悔一步就当那盘还没结束
  S.evals.length = Math.min(S.evals.length, S.hist.length + 1);
  S.advs.length = Math.min(S.advs.length, S.hist.length + 1);
  for (const k of Object.keys(S.mates)) if (+k > S.hist.length) delete S.mates[k];
  render();
  if (S.analysisOn) runAnalysis();
}

function newGame() {
  moveToken++; anaToken++; S.thinking = false; S.reviewing = false;
  if (eng) eng.stop();
  S.gameId = null;          // 不换 id 的话新一局会覆盖上一局
  S.flipView = null;        // 视角回到跟着执子方走; 上一局是读图进来的不该留到下一局
  S.photo = null; showPhoto();
  S.repeat = null; S.hopeless = 0;
  S.pos = new Position();
  S.baseFen = START_FEN;    // 摆棋那条路径会在 newGame 之后自己改回来
  S.hist = []; S.cursor = -1; S.review = null; S.lastAnalysis = null; S.lastAnalysisFen = null; S.evals = []; S.advs = []; S.mates = {};
  S.over = null; renderResult();
  view.lastMove = null; view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
  $('revSec').hidden = true;
  $('anaSec').hidden = false;
  $('exitReviewBtn').hidden = true; $('reviewBtn').hidden = false;
  $('anaBody').innerHTML =
    `<div class="decision-head"><div class="decision-kicker">${t('ana.kicker')}</div>` +
    `<div class="decision-title">${t('ana.titleOff')}</div>` +
    `<p class="decision-dek">${t('ana.dek')}</p></div>` +
    `<div class="methodline">${t('ana.method')}</div>`;
  log('');
  render();
  if (S.mode === 0 && S.pos.side !== S.mySide) setTimeout(engineMove, 300);
  else if (S.analysisOn) runAnalysis();
}

/* "重开"按钮走这条, 内部调用 (摆棋确认、再来一局) 直接走 newGame()。
   载入的残局是人手工摆进来或者拍照认出来的, 重开会把它换成标准开局而且**补不回来**
   —— 这正是那句"点过了直接回到初始棋盘"里真正丢东西的一步。 */
async function newGameAsk() {
  if (S.baseFen !== START_FEN) {
    const okd = await askConfirm({
      title: '重开会丢掉你摆的局面',
      body: '这一局是从一个载入的局面开始的。重开摆回标准开局, 那个局面没有别处存着。',
      ok: '重开',
    });
    if (!okd) return;
  }
  newGame();
}

/* ----- 复盘 ----- */

function renderReviewProgress(phase, at, total) {
  const pct = total ? Math.round(at / total * 100) : 0;
  $('revBody').innerHTML = `<div class="review-progress">` +
    `<div class="phase"><span>${phase}</span><span>${at} / ${total}</span></div>` +
    `<div class="track"><i style="width:${pct}%"></i></div>` +
    `<p>${phase === '通扫'
      ? '以同一预算通扫全局, 取得每手基线, 此阶段不作判定。'
      : '仅对确有损失的着法加算, 以区分浅层就该看出的和本次预算内查不出的。'}</p>` +
    `</div>`;
}

/* 复盘读数。
   用语按棋谱惯例: 缓手 / 漏着 / 败着, 不自造词。
   均亏同时给兵值和胜势点数: 兵值在已经大优大劣的局面里会失真, 胜势点数不会。 */
/* 着法评级。
   ★ 判据一律用**胜势点**, 不用兵值。
   "亏一个兵"在不同局面里根本不是一回事: 均势时丢一兵约 7.5 个胜势点,
   已经赢定的局面里 (+12 兵) 丢一兵不到 1 个点。兵是引擎的内部刻度,
   胜势才是"离赢远了多少"。
   一步棋好不好, 标准就是它把赢的概率往哪边推, 吃不吃子只是个附带现象。

   负面三级用棋谱本来的说法。正面三级:
     正着 = 走的就是引擎首选
     好棋 = 是首选, 而且换任何别的走法都会丢掉 ≥8 个胜势点 (你守住了本会丢的东西)
     妙手 = 在好棋之上再加一条: 浅搜六层内找不到这一手 (它不是一眼能看见的) */
const G_BAD = { 缓手: 3, 漏着: 8, 败着: 16 };     // 胜势点
const G_ONLY = 8;                                  // 好棋: 次选比它差这么多胜势点

/* 形势分档。
   胜势点是一个连续量, 但人读棋不是读小数的 —— 读的是"现在是均势还是已经赢定了"。
   这两件事需要分开的词, 而且这些词象棋里本来就有, 不用自造:

     均势   双方大致持平
     略优   有一点便宜, 但远谈不上赢
     优势   明显占先, 走对了能扩大
     大优   胜利已经在望, 只要不出错
     胜势   基本定局

   ★ 分界是**我们自己划的**, 不是从棋谱统计出来的。胜势点本身就没有拿象棋对局
   校准过 (见 advOf 上面那段), 所以这几个词读的是"引擎评估的量级", 不是
   "赢棋的概率有多大"。别把 90% 当成"十盘能赢九盘"。

   adv 是行棋方或红方视角的 0..1, 传进来之前先定好视角。 */
const PHASES = [
  { min: 0.90, name: '胜势' },
  { min: 0.75, name: '大优' },
  { min: 0.62, name: '优势' },
  { min: 0.55, name: '略优' },
  { min: 0.45, name: '均势' },
  { min: 0.38, name: '略劣' },
  { min: 0.25, name: '劣势' },
  { min: 0.10, name: '大劣' },
  { min: -1,   name: '败势' },
];
const PHASE = adv => PHASES.find(p => adv >= p.min).name;
// 红方视角的 adv → "红优势" / "均势" / "黑大优" 这种说法
function phaseText(advRedVal) {
  const n = PHASE(advRedVal);
  if (n === '均势') return '均势';
  // 分档表是对称的, 红方视角落在下半段时换成"黑方 + 对应的上半段词"
  const mirror = { 略劣: '略优', 劣势: '优势', 大劣: '大优', 败势: '胜势' };
  return mirror[n] ? '黑' + mirror[n] : '红' + n;
}
const GRADE = p => {
  const L = p.probLoss || 0;
  if (L >= G_BAD.败着) return '败着';
  if (L >= G_BAD.漏着) return '漏着';
  if (L >= G_BAD.缓手) return '缓手';
  if (p.brilliant)     return '妙手';
  if (p.wasTop && (p.onlyGapP || 0) >= G_ONLY) return '好棋';
  if (p.wasTop)        return '正着';
  return null;
};

async function runReview() {
  if (!S.hist.length) { log('尚无棋谱可复盘'); return; }
  $('revSec').hidden = false;
  $('exitReviewBtn').hidden = false;
  $('reviewBtn').hidden = true;
  $('anaSec').hidden = true;
  S.reviewing = true;

  /* 两阶段。第一阶段用一遍浅搜扫完整局, 第二阶段只对被标出来的关键节点深挖。
     第一阶段能只搜一遍是因为: 走完第 i 手之后的局面, 就是第 i+1 手之前的局面。
     所以对 N+1 个局面各搜一次 (MultiPV 1), 就同时拿到了每一手的"最佳分"和
     "实战着的分" (= 下一个局面最佳分取反)。比每手开 MultiPV 6 快好几倍且精确。 */
  const SCAN_MS = 260, DEEP_MS = 1600;
  const fens = S.hist.map(h => h.fenBefore).concat([S.pos.fen()]);
  const scan = [], scanAdv = [], top = [], gaps = [], gapsP = [];
  for (let i = 0; i < fens.length; i++) {
    if (!S.reviewing) return;
    $('revMeta').textContent = `通扫 ${i + 1}/${fens.length}`;
    renderReviewProgress('通扫', i + 1, fens.length);
    const p = new Position(fens[i]);
    if (p.terminal()) { scan.push(null); scanAdv.push(null); top.push(null); gaps.push(0); gapsP.push(0); continue; }
    // MultiPV 2: 多这一条才知道"当时是不是只有这一步好", 好棋和妙手全靠它
    const r = await eng.analyze(fens[i], { ms: SCAN_MS, multipv: 2 });
    // 复盘要跑几十次搜索, 引擎一死就全是空结果, 不如当场停下来说清楚
    if (r.failed) { S.reviewing = false; return engineDied(r.failed); }
    const c = r.candidates[0], c2 = r.candidates[1];
    const sc = c ? (cpOf(c)) : null;
    const sc2 = c2 ? (cpOf(c2)) : null;
    scan.push(sc);
    // 胜势单独存一条: 它来自引擎的 WDL, 不是拿 sc 换算的, 所以不能事后补算
    scanAdv.push(c ? advOf(c) : null);
    top.push(c ? c.uci : null);
    // ★ gap 同时留兵值和胜势点。兵值是引擎的内部刻度, 真正说明问题的是胜势:
    //   同样差 1 兵, 在均势里可能是 10 个胜势点, 在已经大优的局面里不到 2 个。
    gaps.push(sc !== null && sc2 !== null ? sc - sc2 : 0);
    gapsP.push(c && c2 ? (advOf(c) - advOf(c2)) * 100 : 0);
    if (c) { S.evals[i] = toRed(c, p.side); S.advs[i] = advRed(c, p.side); renderCurve(); }
  }

  const plies = S.hist.map((h, i) => {
    const bs = scan[i], ns = scan[i + 1];
    const ps = (ns === null || ns === undefined) ? bs : -ns;
    /* 实战着的胜势 = 下一个局面对方胜势的补。
       通扫只搜了每个局面一次, 走完第 i 手的局面就是第 i+1 手之前的局面,
       在那里轮到对方走, 所以对方的胜势 a 对应我这边 1-a。 */
    const ba = scanAdv[i], na = scanAdv[i + 1];
    const pa = (na === null || na === undefined) ? ba : 1 - na;
    const probLoss = (ba === null || pa === null)
      ? 0 : Math.max(0, (ba - pa) * 100);
    return {
      i, uci: h.uci, zh: h.zh, side: h.side,
      loss: (bs === null || ps === null) ? 0 : Math.max(0, bs - ps),
      probLoss,
      wasTop: top[i] === h.uci,      // 走的就是引擎首选
      onlyGap: gaps[i] || 0,         // 当时首选比次选好多少 (兵)
      onlyGapP: gapsP[i] || 0,       // 同上, 胜势点
      best: '', bestUci: null, revealDepth: null, deep: false, brilliant: false,
    };
  });
  S.review = { plies };
  renderSheet();
  renderCurve();      // ★ 曲线上的关键手是从 S.review 现算的, 不重画就一个都不出现

  // 第二阶段: 只深挖真正亏了东西的那几手, 顺便拿到"可发现深度"
  /* 深挖两类: 一类是真亏了的 (要判它当时多早能看出来),
     一类是"走对了而且当时只有这一步" —— 那可能是妙手, 但得先证明浅搜找不到它。 */
  const bad = plies.filter(p => (p.probLoss || 0) >= 2.5)
    .sort((a, b) => b.probLoss - a.probLoss).slice(0, 10);
  const cand = plies.filter(p => (p.probLoss || 0) < 1 && p.wasTop && (p.onlyGapP || 0) >= 8)
    .sort((a, b) => b.onlyGapP - a.onlyGapP).slice(0, 4);
  const flagged = bad.concat(cand);
  for (let k = 0; k < flagged.length; k++) {
    if (!S.reviewing) return;
    const pl = flagged[k];
    $('revMeta').textContent = `加算 ${k + 1}/${flagged.length}`;
    renderReviewProgress('加算', k + 1, flagged.length);
    const fen = S.hist[pl.i].fenBefore;
    const r = await eng.analyze(fen, { ms: DEEP_MS, multipv: 6 });
    if (r.failed) { S.reviewing = false; return engineDied(r.failed); }
    const best = r.candidates[0];
    if (best) {
      pl.bestUci = best.uci;
      pl.best = moveToChinese(new Position(fen), uciToMove(best.uci));
      const bs = cpOf(best);
      const played = r.candidates.find(c => c.uci === pl.uci);
      if (played) {
        const ps = cpOf(played);
        pl.loss = Math.max(0, bs - ps);
        pl.probLoss = Math.max(0, (advOf(best) - advOf(played)) * 100);
        pl.rank = played.rank;
      }
      if (r.candidates[1]) {
        const s2 = cpOf(r.candidates[1]);
        pl.bestGap = Math.max(0, bs - s2);
      }
    }
    /* 可发现深度 = 最浅的那一层 d, 使得从 d 层往后, 引擎给实战着的评估
       就一直比首选差 50 分以上。
       做法是再跑一遍 `go searchmoves <实战着>`, 拿到实战着自己的逐层评分,
       和首选的逐层评分对着看。
       之前那版只看"首选是不是这一手", 结果任何一步坏棋都报 1 层, 没有分辨力。 */
    const r2 = await eng.analyze(fen, { ms: DEEP_MS, multipv: 1, searchmoves: pl.uci });
    if (r2.failed) { S.reviewing = false; return engineDied(r2.failed); }
    let reveal = null;
    const deps = [...r.scoreByDepth.keys()].filter(d => r2.scoreByDepth.has(d)).sort((a, b) => a - b);
    const diffs = deps.map(d => ({ d, diff: r.scoreByDepth.get(d) - r2.scoreByDepth.get(d) }));
    pl.series = diffs.map(x => ({ d: x.d, diff: Math.max(0, x.diff) }));
    /* ★★ 2026-08-25 重写。原来是单阈值 + "一跌破就清零":
           `if (diff >= 50) { if (reveal === null) reveal = d } else reveal = null`
       它有两个叠在一起的毛病, 18 个错手重复测量里有 8 个在整个量程上乱跳
       (同一手 1400ms 测三次给出 11 / 10 / 4, 3000ms 给 5), 而界面给两端印的字
       是"浅层即可见"和"深层才暴露" —— 意思正好相反。

       ① **终点依赖**: "一跌破就清零"等价于"从 d 层起持续落后**到搜索停下的那一层**"。
          而那一层是浮动的 (movetime 是墙钟), 同一条曲线跑到第 7 层停就报 2,
          跑到第 15 层停就报 11。报出来的数是"搜索在哪停"的函数, 不是这手棋的性质。
       ② **硬阈值架在摆动的曲线上**: 实测某手从第 2 层起就落后五六十分, 中间
          第 8/9/10 层是 45/39/49 —— 离阈值差一分, 却把前面九层的判断全部作废。

       逐层曲线本身是**确定性的** (1400ms 和 3000ms 每一层的分一模一样),
       所以这不是引擎噪音, 全部是判据的问题。

       现在: 进场 50 分, 出场 25 分 (迟滞), 曲线在阈值附近抖一两层不推翻已成立的
       判断; 并且要求至少还有两层能确认, 免得把最后一层的穿越当成结论。
       这就是 DESIGN.md 第六之二那条 (连续量切档前先降噪) —— 当初为形势分段写的,
       这里一直没用上。 */
    const ENTER = 50, EXIT = 25, CONFIRM = 2;
    for (let k = 0; k < diffs.length; k++) {
      if (diffs[k].diff < ENTER) continue;
      const tail = diffs.slice(k + 1);
      if (tail.length < CONFIRM) break;      // 太靠近终点, 确认不了, 当未检出
      if (tail.every(x => x.diff >= EXIT)) { reveal = diffs[k].d; break; }
    }
    /* 实战着不在深搜的前几名里时, 上面 r 拿不到它的分, 损失会一直沿用
       通扫那 260ms 的粗估 —— 而最严重的错恰恰最容易掉出候选表。
       r2 是专门只搜这一手的, 拿它的终值回填。 */
    if (!r.candidates.some(c => c.uci === pl.uci) && r2.candidates[0] && best) {
      const bs2 = cpOf(best);
      const c2 = r2.candidates[0];
      const ps2 = cpOf(c2);
      pl.loss = Math.max(0, bs2 - ps2);
      pl.probLoss = Math.max(0, (advOf(best) - advOf(c2)) * 100);
    }
    pl.revealDepth = reveal;
    pl.maxDepth = r.maxDepth;

    /* ★ 用这次 1600ms 深搜的结论刷新 wasTop / onlyGapP。
       它们本来是 260ms 通扫算出来的, 而正面评级 (正着 / 好棋 / 妙手) 全建立在
       这两个字段上 —— 深搜已经认为实战着不是首选了, 它却还沿用浅扫时的身份
       被标成"妙手"。**正面标签要比负面标签更保守**: 夸错了比漏夸伤害大得多,
       因为它会让人把一步运气当成本事。 */
    if (best) {
      pl.wasTop = best.uci === pl.uci;
      if (r.candidates[1]) {
        pl.onlyGapP = Math.max(0, (advOf(best) - advOf(r.candidates[1])) * 100);
      }
    }

    /* 这一手走完, 我自己有没有多出无根的子。
       纯规则算, 不花引擎的钱, 而且它区分的是**性质**不是**程度**:
       "走完之后车没人守了"和"算不到第八层"是两种完全不同的失误, 引擎的分看不出差别。 */
    {
      const b0 = new Position(fen), a0 = new Position(fen);
      a0.apply(uciToMove(pl.uci));
      const was = new Set(looseSquares(b0)
        .filter(x => x.kind === 'loose' && (b0.board[x.sq] > 0) === (pl.side > 0)).map(x => x.sq));
      pl.newLoose = looseSquares(a0)
        .filter(x => x.kind === 'loose' && (a0.board[x.sq] > 0) === (pl.side > 0) && !was.has(x.sq)).length;
    }

    /* 妙手 = 这一手是对的, 但**浅搜找不到**。
       判据用同一套逐层数据反过来读: 六层以内引擎的首选一直不是它,
       说明它不是一眼能看见的着法。这和可发现深度是同一个机制的正反两面 ——
       一个说"这错本来该看出来", 一个说"这手本来看不出来"。 */
    if ((pl.probLoss || 0) < 1 && pl.wasTop && (pl.onlyGapP || 0) >= 8) {
      /* ★ 判据修正: 原来是"任意一个 ≤6 的层没选它"就算妙手。
         但 1-2 层的搜索几乎从不和深搜一致, 所以那个条件几乎恒真, 妙手成了白送。
         正确的问法是"到了浅搜的**末端**它仍然没被选中" —— 取 5 和 6 两层,
         都没选中才算"浅层看不出来"。 */
      const d5 = r.bestByDepth.get(5), d6 = r.bestByDepth.get(6);
      pl.brilliant = (d5 !== undefined || d6 !== undefined) &&
                     (d5 === undefined || d5 !== pl.uci) &&
                     (d6 === undefined || d6 !== pl.uci);
    }
    pl.deep = true;
    S.review = { plies };
    renderReview();
    renderSheet();
    renderCurve();
  }
  $('revMeta').textContent = '';
  S.reviewing = false;
  renderReview();
  /* ★ 2026-08-25: 这里原来只重画右栏的复盘面板, 从不重画曲线。
     而曲线上的关键手是 renderCurve() 从 S.review 现算的 —— 于是复盘跑完之后
     曲线上一个记号都没有, 要等到下一次 render() (点一下棋谱、走一手、切主题)
     才凭空冒出来。G 问"哪些是好的哪些是妙手"的时候, 他面前那条线是真的什么都没标。
     形状画得再清楚, 不画出来都等于零。 */
  renderCurve();
}

function renderReview() {
  const ps = S.review.plies;
  const mine = ps.filter(p => S.mode === 1 ? true : p.side === S.mySide);
  const errs = mine.filter(p => (p.probLoss || 0) >= G_BAD.缓手);
  const scanned = errs.filter(p => p.deep);
  const shallow = scanned.filter(p => p.revealDepth !== null && p.revealDepth <= 6);
  const deep = scanned.filter(p => p.revealDepth === null || p.revealDepth > 6);
  const avgProb = mine.length ? mine.reduce((a, p) => a + (p.probLoss || 0), 0) / mine.length : 0;
  const counts = { 妙手: 0, 好棋: 0, 正着: 0, 缓手: 0, 漏着: 0, 败着: 0 };
  for (const p of mine) { const g = GRADE(p); if (g) counts[g]++; }
  /* 原来这里叫"与引擎同手": 走的是不是引擎首选。
     但那个指标和我们自己强调的"着法宽度"打架 —— 一个局面有五步都在 0.55 兵以内时,
     选了第二好的不该算错。现在改成**没有明显损失的比例** (亏不到 3 个胜势点),
     等价着法一视同仁。 */
  const clean = mine.filter(p => (p.probLoss || 0) < G_BAD.缓手).length;
  const acc = mine.length ? clean / mine.length * 100 : 0;

  let html = '';

  /* 形势分段不在这里再画一遍。
     棋盘正下方那条形势带已经常驻显示同一件事, 而且更大、更靠近棋盘。
     同一个事实在一屏之内出现两次, 读的人第一反应是"这两个是不是不一样"。
     一个事实只放一个地方。 */

  /* 第三格是本局最重的一手。原来是"折合兵/手", 删掉的理由:
     ① 我们整套评级建立在"兵值在不同局面不是一回事"上, 就不该把兵值和胜势点
        并排当同级读数摆出来, 那是在教人做我们自己警告过的换算;
     ② 兵值里混着将杀分, 一盘有杀的棋能算出"均亏 31 兵"这种没有意义的数。
     "最重的一手"和均值同刻度, 而且它才是复盘真正要找的东西。 */
  const worst = mine.reduce((a, p) => (p.probLoss || 0) > ((a && a.probLoss) || 0) ? p : a, null);

  html += `<div class="band">` +
    `<div class="hero"><b>${avgProb.toFixed(1)}</b><span>均亏 · 胜势点/手</span></div>` +
    `<div><b>${acc.toFixed(0)}%</b><span>无明显损失</span></div>` +
    `<div class="${worst && worst.probLoss >= G_BAD.漏着 ? 'hot' : ''}">` +
      `<b>${worst && worst.probLoss ? '-' + worst.probLoss.toFixed(0) : '0'}</b>` +
      `<span>${worst && worst.probLoss ? `最重一手 · 第 ${worst.i + 1} 手` : '无失着'}</span></div>` +
    `</div>`;

  /* ── 分级 ──
     每一档后面直接写判据。之前只有六个词和六个数字, 看的人无从知道
     "缓手"和"漏着"到底差在哪, 那六个计数就只是六个不知从哪来的数。 */
  const GTIP = {
    妙手: `是首选, 次选差 ≥${G_ONLY} 点, 且五六层的浅搜找不到它`,
    好棋: `是首选, 且换别的走法会丢 ≥${G_ONLY} 点`,
    正着: '走的就是引擎首选',
    缓手: `丢 ${G_BAD.缓手}-${G_BAD.漏着} 点`,
    漏着: `丢 ${G_BAD.漏着}-${G_BAD.败着} 点`,
    败着: `丢 ≥${G_BAD.败着} 点`,
  };
  const row = (list, cls) => `<div class="grades">` + list.map(g =>
    `<span class="${cls} ${counts[g] ? 'on' : ''}" title="${GTIP[g]}">` +
    `${g} <b>${counts[g]}</b><i>${GTIP[g]}</i></span>`).join('') + `</div>`;
  html += row(['妙手', '好棋', '正着'], 'good') + row(['缓手', '漏着', '败着'], '');

  if (scanned.length) {
    html += `<div class="split">` +
      `<div class="${shallow.length ? 'hot' : ''}"><b>${shallow.length}</b>六层内可察</div>` +
      `<div><b>${deep.length}</b>本次预算内未检出</div>` +
      `</div>`;
  }

  const bright = mine.filter(p => p.brilliant || (p.deep && p.wasTop && p.onlyGap >= 120))
    .sort((a, b) => b.onlyGap - a.onlyGap).slice(0, 3);
  if (bright.length) {
    html += `<div class="subhead">走得好的 <span>${bright.length}</span></div>`;
    for (const p of bright) {
      html += `<div class="errline good" data-i="${p.i}">` +
        `<div class="hd"><span class="no">第 ${p.i + 1} 手</span>` +
        `<span class="mv">${p.zh}</span><span class="grade">${GRADE(p)}</span>` +
        `<span class="loss ok">守住 ${(p.onlyGapP || 0).toFixed(1)} 点</span></div>` +
        `<div class="sub"><span>${p.brilliant ? '五六层的浅搜选不到这一手' : '换任何别的走法都会丢掉这些优势'}</span></div></div>`;
    }
  }

  /* 一句话说清这一盘主要栽在哪。
     ★ 它只是**本局的观察**, 不是棋手画像 —— 一盘棋的样本量不够支撑后者,
     所以句子里必须带上"本局"和条数, 而且只在某一类确实占主导时才说。 */
  /* ★ 这几个名字全部降级成**可观测的事实**, 不再是对棋手认知的诊断。
     Codex 2026-08-23 指出得对: 原来叫"子力漏检 / 强制手漏检 / 短线验证不足 /
     长算不足", 那是在断言下棋的人*没做什么心理动作* —— 而代码根本没检查过
     实战着有没有漏将、漏吃、漏捉, 也没证明新出现的无根子就是损失的原因。
     推断链很弱, 结论却被包装成明确的认知诊断加训练处方。

     最难堪的一条是"长算不足": 它把"本次预算内没检出"直接说成"要算很深才看得出",
     而 README 和 DESIGN.md 自己写着这两件事不能划等号。自己的规范先违反了。

     现在每一档只说这一手在数据上是什么样子, 不说人当时在想什么。 */
  const KIND = p => p.newLoose > 0 ? '走后有子失守'
    : (p.revealDepth !== null && p.revealDepth <= 3) ? '浅层即可见'
    : (p.revealDepth !== null && p.revealDepth <= 6) ? '六层内可见'
    : '本次预算内未检出';
  const deepErrs = errs.filter(p => p.deep);
  if (deepErrs.length >= 2) {
    const by = {};
    for (const p of deepErrs) {
      const k = KIND(p);
      (by[k] = by[k] || { n: 0, loss: 0 });
      by[k].n++; by[k].loss += p.probLoss || 0;
    }
    const total = deepErrs.reduce((a, p) => a + (p.probLoss || 0), 0) || 1;
    const [k, v] = Object.entries(by).sort((a, b) => b[1].loss - a[1].loss)[0];
    if (v.n >= 2 && v.loss / total >= 0.4) {
      /* 只陈述共同点, 不开处方。
         "落子前先扫对方的将吃捉"这种建议听起来很像洞察, 但它建立在
         "这个错是因为你没扫强制手"这个我们并没有验证过的因果上。
         把观察给人, 让人自己解释 —— 这一步之所以能给出来, 是因为它是
         真的从数据里读出来的, 而不是我编的。 */
      const NOTE = {
        走后有子失守: '共同点是走完之后自己多出没人守的子。',
        浅层即可见: '共同点是引擎在很浅的搜索里就已经看出来了。',
        六层内可见: '共同点是引擎六层以内能看出来。',
        本次预算内未检出: '共同点是引擎在本次给的时间里都没检出 —— 只能说明这一批不容易被发现, 不能说明它们需要算得很深。',
      };
      html += `<div class="callout"><b>本局失误的共同点: ${k}</b> ` +
        `${deepErrs.length} 条证据里 ${v.n} 条落在这一档, 占损失的 ` +
        `${(v.loss / total * 100).toFixed(0)}%。${NOTE[k]}` +
        `<span class="hint">这是对着法的观察, 不是对你的判断 —— 我们没有证据说明你当时在想什么。` +
        `而且一盘棋只够说本局, 同一类跨多局重复出现才谈得上是你的问题。</span></div>`;
    }
  }

  const listed = errs.filter(p => p.deep).sort((a, b) => b.loss - a.loss).slice(0, 6);
  if (listed.length) html += `<div class="subhead">走失的 <span>${listed.length} / ${errs.length}</span></div>`;
  for (const p of listed) {
    const d = p.revealDepth, g = GRADE(p) || '缓手';
    html += `<div class="errline" data-i="${p.i}">` +
      `<div class="hd"><span class="no">第 ${p.i + 1} 手</span>` +
      `<span class="mv">${p.zh}</span><span class="grade">${g}</span>` +
      `<span class="loss">-${(p.probLoss || 0).toFixed(1)} 点</span></div>` +
      // 从最浅那层就已经落后的错, 曲线是一条贴底的直线 -> 画出来是一整块实心色,
      // 什么都读不出。这种情况不画图, 让下面那行"N 层可察"把话说完
      (p.series && p.series.length > 2 && p.revealDepth !== null &&
       p.revealDepth > p.series[0].d
        ? `<canvas class="spark" data-ply="${p.i}"></canvas>` : '') +
      `<div class="sub"><span>${KIND(p)}</span>` +
      `<span>${d === null ? `${p.maxDepth || '?'} 层内未检出` : d + ' 层可察'}</span>` +
      (p.best ? `<span>正着 ${p.best}</span>` : '') + `</div></div>`;
  }

  /* 样本量必须写在脸上。一盘棋的读数只能定位这一盘,
     跨局重复出现的同一类错误才配叫棋手的问题。 */
  html += `<div class="methodline">` +
    (mine.length < 20
      ? `样本 ${mine.length} 手, 仅足以定位本局。`
      : `样本 ${mine.length} 手。`) +
    `评级按胜势点算不按兵值: 均势时丢一个兵约 7.5 个胜势点, 已经赢定时不到 1 个。` +
    `好棋的判据是"换别的走法会丢掉多少优势", 与吃不吃子无关。` +
    `可发现深度只回答"当时多早能看出", 不等同于人的思考深度。</div>`;

  $('revBody').innerHTML = html;
  $('revBody').querySelectorAll('.errline').forEach(el => {
    el.onclick = () => browseTo(+el.dataset.i);
  });
  $('revBody').querySelectorAll('.spark').forEach(cv => {
    const pl = ps[+cv.dataset.ply];
    if (pl && pl.series) drawSpark(cv, pl.series, pl.revealDepth);
  });
  renderSheet();
}

/* 每个失误配一张小图: 横轴是引擎搜到第几层, 纵轴是这一手比正着差多少。
   它回答的是"这个错当时多早能看出来" —— 曲线在第几层塌下去, 就是第几层能察觉。

   ★ 2026-08-23 重画。之前那版 26px 高、没有任何刻度、没有轴, 只是一条红线,
   看的人不知道横轴是什么、纵轴是什么、那条金色竖线又是什么 (G: "也做得不清晰")。
   现在给三样东西: 横轴标出层数, 纵轴标出阈值, 检出层单独标一个词。 */
function drawSpark(cv, series, reveal) {
  if (!series.length) return;
  const w = cv.clientWidth || 240, h = 46;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const PADB = 12;                       // 底下留给层数刻度
  const plotH = h - PADB - 3;
  const d0 = series[0].d, maxD = series[series.length - 1].d;
  /* 纵轴封顶 8 个兵。某一层一旦看到杀, 分差是几万, 不封顶的话这一个点
     会把其余所有点压成贴着零线的一条直线, 曲线就什么都看不出来了。 */
  const CAP = 800;
  const clamp = v => Math.min(v, CAP);
  const maxV = Math.max(150, ...series.map(p => clamp(p.diff)));
  const span = Math.max(1, maxD - d0);
  const X = d => ((d - d0) / span) * (w - 26) + 1;
  const Y = v => 3 + (v / maxV) * plotH;   // 往下是越差, 和"塌下去"这个直觉一致

  ctx.font = '8px "Geist Mono",ui-monospace,monospace';
  ctx.textBaseline = 'middle';

  // 零线: 和正着一样好
  ctx.strokeStyle = TH.ruleSoft || TH.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Y(0) + .5); ctx.lineTo(w - 24, Y(0) + .5); ctx.stroke();

  // 50 分那条线就是判定阈值, 画出来才知道曲线是从哪里穿过去的
  const yT = Y(50);
  ctx.strokeStyle = TH.rule;
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(0, yT + .5); ctx.lineTo(w - 24, yT + .5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = TH.mute; ctx.textAlign = 'left';
  ctx.fillText('0.5 兵', w - 22, yT);

  // 面积 + 折线
  ctx.beginPath();
  ctx.moveTo(X(d0), Y(0));
  for (const p of series) ctx.lineTo(X(p.d), Y(clamp(p.diff)));
  ctx.lineTo(X(maxD), Y(0));
  ctx.closePath();
  ctx.fillStyle = TH.crimson; ctx.globalAlpha = .1; ctx.fill(); ctx.globalAlpha = 1;

  ctx.beginPath();
  series.forEach((p, i) => { const x = X(p.d), y = Y(clamp(p.diff)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = TH.crimson; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke();

  /* 横轴。首尾两个层号就够, 但**检出层的标注会和它们抢位置** ——
     reveal 落在首端时, "1 层" 和 "1 层起可察" 叠在一起, 屏幕上读出来是
     "11 层起可察", 一个根本不存在的数。所以先判重叠, 撞了就不画那个端点。 */
  const near = (a, b) => Math.abs(a - b) <= span * 0.22;
  const hasRev = reveal !== null && reveal !== undefined;
  ctx.fillStyle = TH.mute;
  if (!hasRev || !near(reveal, d0)) {
    ctx.textAlign = 'left';
    ctx.fillText(d0 + ' 层', X(d0), h - 5);
  }
  if (!hasRev || !near(reveal, maxD)) {
    ctx.textAlign = 'right';
    ctx.fillText(maxD + ' 层', X(maxD), h - 5);
  }

  if (hasRev) {
    // 检出层: 一条竖线加一个词。之前只有一条没有标注的金线, 没人知道它是什么
    const x = X(reveal);
    ctx.strokeStyle = TH.ink; ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x + .5, 1); ctx.lineTo(x + .5, h - PADB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = TH.ink;
    ctx.textAlign = x > w * 0.6 ? 'right' : 'left';
    ctx.fillText(`${reveal} 层起可察`, x + (x > w * 0.6 ? -3 : 3), h - 5);
  }
}

/* ----- 存棋 ----- */
// 棋谱是唯一补不回来的东西, 算力随时能补跑, 所以每一手都立刻落盘。
function saveGame() {
  try {
    const key = 'xq.games';
    const all = JSON.parse(localStorage.getItem(key) || '[]');
    const rec = {
      id: S.gameId || (S.gameId = Date.now()),
      ts: Date.now(),
      mode: S.mode, mySide: S.mySide, level: S.level,
      moves: S.hist.map(h => h.uci),
    };
    const i = all.findIndex(g => g.id === rec.id);
    if (i >= 0) all[i] = rec; else all.push(rec);
    localStorage.setItem(key, JSON.stringify(all.slice(-200)));
  } catch (e) { /* 存不下就算了, 不打断对局 */ }
}

/* ----- 交互 ----- */

// 读屏播报。落子、被将、结束都往这里写一句。
function say(text) { const el = $('live'); if (el) el.textContent = text; }

/* ----- 确认 -----

   只用在**会把一个摆好的局面弄没**的动作上。判据和认输那条一致:
   可逆的事不弹框 (认输悔一步就回来了), 不可逆的才弹。

   ★ 为什么不做成"按钮自己变成'确定?'"那种就地两段式:
   要防的正是**连点** —— 手停不下来的那一下, 就地两段式照样会被第二次点击穿过去,
   等于没防。所以确认必须落在另一个位置, 而且默认落点 (背景 / Esc / 取消)
   一律是"不做"。整个对话框只有一个地方会执行, 那个地方要人主动移过去按。

   样式跟着 DESIGN.md 第一节: 0 圆角, 无阴影, 1px 边框, 纸色。 */
let confirmClose = null;

function askConfirm({ title, body, ok = '确定', danger = true }) {
  const el = $('modal');
  if (!el) return Promise.resolve(true);   // 没有这个节点就别把功能锁死
  if (confirmClose) confirmClose(false);
  return new Promise(res => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true; confirmClose = null;
      el.hidden = true; el.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      res(v);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    confirmClose = finish;
    el.hidden = false;
    el.innerHTML =
      `<div class="modalbox" role="alertdialog" aria-modal="true">` +
        `<b>${title}</b>` +
        (body ? `<p>${body}</p>` : '') +
        `<div class="mrow">` +
          `<button class="act sm" data-v="0">取消</button>` +
          `<button class="act sm ${danger ? 'danger' : 'primary'}" data-v="1">${ok}</button>` +
        `</div>` +
      `</div>`;
    el.onclick = e => {
      const b = e.target.closest('button[data-v]');
      if (b) return finish(b.dataset.v === '1');
      // 点背景 = 不做。误点最可能落在这里, 所以这里必须是安全的那一边。
      if (e.target === el) finish(false);
    };
    document.addEventListener('keydown', onKey, true);
    // 焦点给"取消": 弹出来之后敲回车的人不该因此丢掉局面
    const c = el.querySelector('button[data-v="0"]');
    if (c) c.focus();
  });
}

/* ================= 摆棋 / 读图 =================

   两个入口共用一个状态: 手工摆棋, 和"给一张照片让它认出来"。
   认出来的结果不直接开局 —— 它先落进摆棋态让人过一眼。

   为什么必须有这一步: 单枚子认对的概率再高, 一盘也有三十来枚。97% 的单枚准确率
   在 32 枚上就是 38% 的整盘正确率。而错一枚子, 引擎给的不是"差一点的建议",
   是**另一盘棋的**建议 —— 而且它会讲得同样自信。所以宁可让人点两下。

   模型标不确定的点、以及规则自检挑出来的点, 在盘上垫警示色; 点一下就消,
   那个动作的意思是"我看过了"。 */

// 手上拿的是什么: null = 只核对不落子, 0 = 拿掉, 其余 = 带符号的子力值
const HAND_CHECK = null, HAND_ERASE = 0;

function setupState() {
  return {
    pos: new Position(START_FEN),
    side: 1,
    unsure: new Set(),
    pick: HAND_CHECK,
    busy: false,
    note: '',
  };
}

function enterSetup(from) {
  if (S.setup) return;
  stopAnalysis();
  if (eng) eng.stop();
  moveToken++;
  const st = setupState();
  const base = from || displayPos();
  st.pos = base.clone ? base.clone() : new Position(base.fen());
  st.side = st.pos.side;
  // 进摆棋那一刻的盘面。取消要问不要问, 看的就是它和现在还一不一样。
  st.fromFen = st.pos.fen();
  S.setup = st;
  view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
  buildPalette();
  $('setupBar').hidden = false;
  ['analyzeBtn', 'undoBtn', 'reviewBtn', 'resignBtn', 'newBtn', 'setupBtn']
    .forEach(id => { $(id).disabled = true; });
  renderSetup();
  render();
}

function exitSetup() {
  if (!S.setup) return;
  S.setup = null;
  S.photo = null; showPhoto();
  $('setupBar').hidden = true;
  ['analyzeBtn', 'undoBtn', 'reviewBtn', 'resignBtn', 'newBtn', 'setupBtn']
    .forEach(id => { $(id).disabled = false; });
  render();
}

function setupClick(s) {
  const st = S.setup;
  if (!st || st.busy || s < 0) return;
  if (st.pick !== HAND_CHECK) st.pos.board[s] = st.pick;   // 落子 / 拿掉
  st.unsure.delete(s);                                      // 点过 = 核对过
  st.pos.side = st.side;
  renderSetup();
  render();
}

function buildPalette() {
  const el = $('palette');
  if (el.dataset.built) return;
  const btn = (label, val, red, wide) =>
    `<button data-v="${val}" class="${red ? 'r' : ''}${wide ? ' wd' : ''}">${label}</button>`;
  let h = btn(t('setup.check'), 'check', false, true);
  h += '<span class="gap"></span>';
  for (const t of [K, A, B, N, R, C, P]) h += btn(NAME_RED[t], t, true);
  h += '<span class="gap"></span>';
  for (const t of [K, A, B, N, R, C, P]) h += btn(NAME_BLACK[t], -t, false);
  h += '<span class="gap"></span>' + btn(t('setup.remove'), 'erase', false, true);
  el.innerHTML = h;
  el.dataset.built = '1';
  el.onclick = e => {
    const b = e.target.closest('button');
    if (!b || !S.setup) return;
    const v = b.dataset.v;
    S.setup.pick = v === 'check' ? HAND_CHECK : v === 'erase' ? HAND_ERASE : +v;
    renderSetup();
  };
}

function renderSetup() {
  const st = S.setup;
  if (!st) return;
  const cur = st.pick === HAND_CHECK ? 'check' : st.pick === HAND_ERASE ? 'erase' : String(st.pick);
  $('palette').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
  $('stmGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.s === st.side));
  /* 只在有硬依据时才说"这是推出来的" —— 被将的那一方必然轮它走。
     其余情况老实说"看不出来, 自己定", 不要假装知道。 */
  const hintEl = $('stmHint');
  if (hintEl) {
    const inChk = st.pos.inCheck(1) ? 1 : (st.pos.inCheck(-1) ? -1 : 0);
    hintEl.textContent = inChk
      ? t('setup.checkTurn', { s: t(inChk > 0 ? 'side.red' : 'side.black') })
      : t('setup.stmHint');
  }

  st.pos.side = st.side;
  const issues = positionIssues(st.pos);
  const hard = issues.filter(i => i.hard);
  $('setupOkBtn').disabled = !!hard.length || st.busy;

  let line;
  if (st.busy) {
    line = t('setup.selfReading');
  } else if (hard.length) {
    const head = hard.slice(0, 3).map(i =>
      i.msg + (i.sqs.length ? ' (' + i.sqs.map(sqToUci).join(' ') + ')' : '')).join(' · ');
    line = `<b>${t('setup.selfBad', { n: hard.length })}</b> · ` + head + (hard.length > 3 ? ' …' : '');
  } else if (st.unsure.size) {
    line = t('setup.selfUnsure', { n: st.unsure.size });
  } else {
    line = t('setup.selfPassed');
  }
  $('setupCheck').innerHTML = line + (st.note ? `<span style="opacity:.55"> · ${st.note}</span>` : '');
}

/* 摆完了。这里不是"接着下", 是**换一局**: 棋谱、评估、曲线、终局全部归零 ——
   载进来的局面和之前那一局没有任何关系, 留着旧棋谱会让复盘和曲线读的是别的棋。 */
function applySetup() {
  const st = S.setup;
  if (!st || positionIssues(st.pos).some(i => i.hard)) return;
  const fen = `${st.pos.fen().split(' ')[0]} ${st.side > 0 ? 'w' : 'b'} - - 0 1`;
  const unsureLeft = st.unsure.size;
  exitSetup();
  setTwoPlayer();
  /* ★ 先把分析关掉再 newGame。newGame 结尾会替你把分析拉起来, 而那一刻 S.pos
     还是**开局**局面 —— 结果是右栏在分析开局, 盘上摆的却是刚载入的残局,
     两边对不上而且没有任何提示。摆完再自己开一次。 */
  /* ★ newGame() 会把视角清回"跟着执子方走"。摆棋确认时必须把它保住 ——
     否则确认之前是按照片朝向画的 (黑在下), 一按确认就翻回红在下,
     等于把人截图里的棋盘给改了。2026-08-24 G 为此发火。 */
  const keepFlip = S.flipView;
  S.analysisOn = false;
  newGame();
  S.flipView = keepFlip;
  S.pos = new Position(fen);
  /* 摆完就直接开分析。人摆一个局面进来, 想要的下一件事必然是"那这里该走哪一步" ——
     还要他再找一次按钮是白加一步。要关随时按"分析"。 */
  S.analysisOn = true;
  // 这一局的起点就是刚摆好的这个局面, 不是开局。悔棋要退到这里。
  S.baseFen = fen;
  $('analyzeBtn').classList.add('primary');
  render();
  runAnalysis();
  log('局面已载入 · 已自动开始分析',
      unsureLeft ? `<span class="err">还有 ${unsureLeft} 个点没核对</span>` : '',
      '本局没有棋谱, 复盘要有棋谱才能跑');
}

// 载入的局面不该被引擎接手继续下 —— 和 ?moves= 那条路径一致
function setTwoPlayer() {
  S.mode = 1;
  $('modeGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === '1'));
  $('rowSide').style.display = 'none';
}

/* 图片先在本地缩到 1600px 再传。手机照片动辄五六 MB, 传上去慢, 而棋盘上
   要认的是碗口大的字, 1600px 早就够了。缩小是纯收益。 */
function imageToDataURL(file, max = 1600) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type || '')) return rej(new Error('这不是一张图片'));
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('读不了这个文件'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('这张图解不出来'));
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        if (k >= 1) return res(fr.result);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.9));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function readImage(file) {
  if (!S.setup) enterSetup();
  const st = S.setup;
  if (st.busy) return;
  let dataUrl;
  try { dataUrl = await imageToDataURL(file); }
  catch (e) { log(`<span class="err">${e.message}</span>`); return; }

  st.busy = true; st.note = ''; renderSetup(); renderTop();
  log(t('setup.readingLog'), t('setup.readingTime'));
  const t0 = performance.now();
  try {
    if (!window.XiangqiBrowserCV) throw new Error(t('setup.noRecognizer'));
    const j = await window.XiangqiBrowserCV.recognize(dataUrl);
    if (!j.ok) throw new Error(j.error || t('setup.noRecognizer'));
    st.pos = new Position(j.fen);
    /* 照片是从黑方那边拍的 (red_top) 就按黑在下画, 跟拍照的人看到的一样。
       核对靠的是逐点比对, 让人先在脑子里转 180 度是白送的出错机会。 */
    /* 用 photo_orientation (照片里红方在哪边), 不是 orientation (内部变换用的那个)。
       两者在 CV 那条路上会不一样 —— 模型输出的是矫正后的正视图, 内部方向跟拍摄
       朝向无关。用错会出现"照片里黑方朝着你, 画出来却红方在下"。 */
    S.flipView = ((j.photo_orientation || j.orientation) === 'red_top');
    S.photo = dataUrl;
    showPhoto();
    st.side = j.hint_side || st.side;
    st.pos.side = st.side;
    st.unsure = new Set(j.uncertain || []);
    st.pick = HAND_CHECK;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const ORI = { red_top: t('setup.oriTop'), red_left: t('setup.oriLeft'),
                  red_right: t('setup.oriRight') };
    st.note = `${j.model || ''} · ${t('setup.attempts', { n: j.attempts })} · ${secs}s` +
      (ORI[j.orientation] ? ' · ' + ORI[j.orientation] : '');
    log(t('setup.readDone'),
        j.clean ? t('setup.selfPassed') : `<span class="err">${t('setup.readFailed')}</span>`,
        st.unsure.size ? t('setup.reviewPoints', { n: st.unsure.size }) : t('setup.allConfident'),
        j.note || '');
  } catch (e) {
    log(`<span class="err">读图失败 ${String(e.message || e)}</span>`);
    st.note = '';
  } finally {
    st.busy = false;
    renderSetup(); render(); renderTop();
  }
}

/* 原图面板。只有读图进来的局面才有原图 —— 手工摆棋没有参照物可放。 */
function showPhoto() {
  const box = $('photoBox'), img = $('photoImg');
  if (!box) return;
  const row = $('boardRow');
  if (row) row.classList.toggle('labeling', !!S.label);
  if (S.photo) {
    img.src = S.photo; box.hidden = false;
    /* 折叠状态记在 localStorage: 核对的时候要看原图, 核完了它就是碍事的东西,
       而这个偏好因人而异, 不该每次重来。 */
    box.classList.toggle('folded', S.photoFolded);
    const b = $('photoToggle');
    if (b) b.textContent = t(S.photoFolded ? 'photo.expand' : 'photo.collapse');
  } else { box.hidden = true; img.removeAttribute('src'); }
}

/* ================= 标注模式 (?label=1) =================

   一批图一张张过: 自动识别打底 → 人在盘上把错的改掉 → 存成标准答案。

   ★ 它不是另一个工具, 就是确认盘本身多了一条翻页。
   用户核对识别结果, 和给测试集标 ground truth, 是同一个动作:
   看着原图, 把盘上错的点改过来。做成两个东西等于同一套 UI 写两遍,
   而且产品那边还会少掉"原图并排"这个最该有的参照。 */

async function labelLoad(i) {
  const L = S.label;
  if (!L || !L.items.length) return;
  L.i = (i + L.items.length) % L.items.length;
  const it = L.items[L.i];
  if (!S.setup) enterSetup();
  const st = S.setup;
  S.photo = 'api/labelimg/' + encodeURIComponent(it.img);
  showPhoto();
  labelBar();

  if (it.fen) {                       // 已经标过, 直接摆出来给人复核
    st.pos = new Position(it.fen + ' w - - 0 1');
    st.unsure = new Set();
    st.note = '已有标准答案';
    renderSetup(); render(); renderTop();
    log('标注', `${L.i + 1}/${L.items.length}`, it.img, '已有标准答案, 可以直接改');
    return;
  }
  await labelRecognize();
}

/* 让服务器直接读它本地那张图 —— 标注模式下图片本来就在服务器上,
   让浏览器下载一遍再原样传回去纯属绕路。 */
async function labelRecognize() {
  const L = S.label, st = S.setup;
  if (!L || !st || st.busy) return;
  const it = L.items[L.i];
  st.busy = true; renderSetup(); renderTop();
  log('正在识别', it.img);
  try {
    const r = await fetch('api/board', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelimg: it.img }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: `服务器返回 ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `服务器返回 ${r.status}`);
    st.pos = new Position(j.fen);
    st.unsure = new Set(j.uncertain || []);
    st.side = j.hint_side || st.side;
    st.pos.side = st.side;
    /* 用 photo_orientation (照片里红方在哪边), 不是 orientation (内部变换用的那个)。
       两者在 CV 那条路上会不一样 —— 模型输出的是矫正后的正视图, 内部方向跟拍摄
       朝向无关。用错会出现"照片里黑方朝着你, 画出来却红方在下"。 */
    S.flipView = ((j.photo_orientation || j.orientation) === 'red_top');
    st.note = `${j.attempts} 轮 · ${j.orientation}`;
    log('识别完成', j.clean ? '自检通过' : '<span class="err">自检没过</span>',
        st.unsure.size ? `${st.unsure.size} 个点要看` : '它每个点都有把握', j.note || '');
  } catch (e) {
    log(`<span class="err">识别失败 ${String(e.message || e)}</span>`,
        '可以自己摆, 或者按"重新识别"');
  } finally {
    st.busy = false; renderSetup(); render(); renderTop();
  }
}

function labelBar() {
  const L = S.label;
  if (!L) return;
  const it = L.items[L.i];
  const done = L.items.filter(x => x.fen).length;
  $('labNow').innerHTML = `${L.i + 1}/${L.items.length} · ${it.img}` +
    `<span style="opacity:.5"> · 已标 ${done}</span>`;
}

async function labelSave() {
  const L = S.label, st = S.setup;
  if (!L || !st) return;
  // 存之前也要过自检: 一个非法局面当标准答案, 后面所有准确率都是错的
  if (positionIssues(st.pos).some(i => i.hard)) {
    log('<span class="err">这个局面通不过自检, 不能当标准答案</span>');
    return;
  }
  const it = L.items[L.i];
  const fen = st.pos.fen().split(' ')[0];
  try {
    const r = await fetch('api/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ img: it.img, fen }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '存不进去');
    it.fen = fen;
    labelBar();
    log('已存', it.img, `测试集里现在有 ${j.count} 张`);
    if (L.i + 1 < L.items.length) labelLoad(L.i + 1);
  } catch (e) {
    log(`<span class="err">存不进去 ${String(e.message || e)}</span>`);
  }
}

async function labelBoot() {
  try {
    const r = await fetch('api/labelset');
    const j = await r.json();
    if (!j.ok) { log(`<span class="err">标注模式起不来 ${j.error || ''}</span>`); return; }
    if (!j.items.length) { log('<span class="err">待标目录里没有图</span>'); return; }
    S.label = { items: j.items, i: 0 };
    $('labelBar').hidden = false;
    labelLoad(0);
  } catch (e) {
    log(`<span class="err">标注模式起不来 ${String(e.message || e)}</span>`);
  }
}

function onBoardSquare(s) {
  if (S.setup) { setupClick(s); return; }
  if (S.cursor >= 0) { S.cursor = -1; render(); return; }
  if (S.over || S.pos.terminal() || S.thinking) return;
  if (S.mode === 0 && S.pos.side !== S.mySide) return;
  if (s < 0) { view.sel = -1; view.targets = []; render(); return; }

  const p = S.pos.board[s];
  if (view.sel >= 0 && view.targets.includes(s)) { doMove([view.sel, s]); return; }
  if (p && (p > 0) === (S.pos.side > 0)) {
    view.sel = s;
    view.targets = S.pos.legalMoves(S.pos.side).filter(m => m[0] === s).map(m => m[1]);
    const side = p > 0 ? 1 : -1;
    const nm = (side > 0 ? NAME_RED : NAME_BLACK)[Math.abs(p)];
    say(`选中 ${nm}${numStr(fileNum(colOf(s), side), side)}, ${view.targets.length} 个落点`);
  } else { view.sel = -1; view.targets = []; }
  render();
}

/* ★ 屏幕坐标 → 棋盘内部坐标。
   canvas 的内部坐标系宽度 (cssW) 和它在页面上被 CSS 拉伸到的实际宽度
   **不一定相等**: 格距是向下取整到设备像素的, 取整之后 cssW 通常比容器窄一点,
   而 `canvas{width:100%}` 又把它拉回容器宽度。差几个百分点看不出来, 但点击
   会按比例偏移, 越靠右下偏得越多 —— 2026-08-23 实测有一次 cssW=546 而实际
   显示 588, 差 7.7%, 点第三条纵线上的兵会选中隔壁那个子。
   所以这里必须除以拉伸比, 不能拿屏幕像素直接当棋盘坐标。 */
function boardPoint(ev) {
  const r = view.cv.getBoundingClientRect();
  const kx = r.width ? view.cssW / r.width : 1;
  const ky = r.height ? view.cssH / r.height : 1;
  return [(ev.clientX - r.left) * kx, (ev.clientY - r.top) * ky];
}

function onBoardClick(ev) {
  const [x, y] = boardPoint(ev);
  onBoardSquare(view.hit(x, y));
}

function browseTo(i) {
  S.cursor = i;
  view.lastMove = (i >= 0 && S.hist[i]) ? S.hist[i].mv : (S.hist.length ? S.hist[S.hist.length - 1].mv : null);
  view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
  render();
  if (S.analysisOn) runAnalysis();
}

function bindGroup(id, key, fn) {
  const g = $(id);
  g.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      g.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      fn(+b.dataset[key]);
    };
  });
}

function setTheme(key) {
  TH = THEMES[key] || THEMES.paper;
  // 换盘面主题时页面底色也跟着走一点, 不然冷的界面配暖的棋盘直接打架
  const r = document.documentElement.style;
  r.setProperty('--bg', TH.page.bg);
  r.setProperty('--paper', TH.page.paper);
  r.setProperty('--rule', TH.page.rule);
  r.setProperty('--rule-soft', TH.page.ruleSoft);
  document.querySelector('meta[name=theme-color]').setAttribute('content', TH.page.bg);
  try { localStorage.setItem('xq.theme', key); } catch (e) {}
  if (view) { view.arrowSig = ''; view.buildGrain(); render(); }
}

function boot() {
  let saved = 'paper';
  try { saved = localStorage.getItem('xq.theme') || 'paper'; } catch (e) {}
  const qt = new URLSearchParams(location.search).get('theme');
  if (qt && THEMES[qt]) saved = qt;
  if (!THEMES[saved]) saved = 'paper';
  TH = THEMES[saved];
  setTheme(saved);
  $('themeGrp').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', ['paper', 'wood', 'bamboo'][+b.dataset.t] === saved));

  view = new BoardView($('cv'));
  curve = new CurveView($('curve'));
  const relayout = () => { view.layout(); curve.layout(); render(); };
  window.addEventListener('resize', relayout);
  view.layout(); curve.layout();
  render();

  /* ★ 只听 window 的 resize 是不够的。
     棋盘的宽度是网格列算出来的, 而字体加载完、右栏内容填进去之后这一列还会再变 ——
     窗口尺寸没动, resize 不触发, 于是 canvas 的内部坐标系停在首次布局那个宽度上,
     被 CSS 拉伸着显示。画出来只是略糊, 但**点击会按比例偏移**, 越靠右下偏得越多。
     2026-08-23 实测: 首次布局按 546 算, 稳定后实际显示 588, 差 7.7%,
     点某一条纵线上的兵会选中隔壁那个子。
     这个 bug 只有真的用鼠标点才会暴露, 用 URL 参数灌局面截图那条路径永远碰不到。 */
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      if (!w || w === lastW) return;
      lastW = w;
      /* 必须推到下一帧再重排。ResizeObserver 的回调是在布局过程中调用的,
         在里面直接改 canvas 尺寸会让浏览器报
         "ResizeObserver loop completed with undelivered notifications"。 */
      requestAnimationFrame(relayout);
    }).observe(view.cv.parentElement);
  }

  // 点曲线直接跳到那一手
  $('curve').addEventListener('click', e => {
    const r = $('curve').getBoundingClientRect();
    const px = (e.clientX - r.left) * (r.width ? curve.w / r.width : 1);
    /* 先看有没有点在某个关键手的标记上。标记比它旁边的手更值得跳 ——
       点标记的人要的就是那一手, 差一两手就白点了。 */
    const m = curve.markAt(px);
    const ply = m ? m.ply : curve.plyAt(px);
    if (ply >= 0) browseTo(ply >= S.hist.length ? -1 : ply);
  });
  // 鼠标停在标记上给个说明, 不然一排点谁也不知道是什么
  $('curve').addEventListener('mousemove', e => {
    const r = $('curve').getBoundingClientRect();
    const px = (e.clientX - r.left) * (r.width ? curve.w / r.width : 1);
    const m = curve.markAt(px);
    $('curve').title = m ? `第 ${m.ply + 1} 手 ${m.zh} · ${m.grade}` : '';
    $('curve').style.cursor = m ? 'pointer' : 'crosshair';
  });
  // canvas 画字是即时取字体的, 字体晚到不会自动重画。等它到了再补一次。
  if (document.fonts && document.fonts.load) {
    document.fonts.load('40px XQKai', '车马炮').then(() => render()).catch(() => {});
  }

  $('cv').addEventListener('click', onBoardClick);
  // 悬停: 只在能动的子上给反馈, 不然满盘乱亮
  $('cv').addEventListener('mousemove', e => {
    if (S.over || S.pos.terminal() || S.thinking) return;
    const [hx, hy] = boardPoint(e);
    const sq2 = view.hit(hx, hy);
    const pos = displayPos();
    let h = -1;
    if (sq2 >= 0) {
      const pc = pos.board[sq2];
      const mine = pc && (pc > 0) === (pos.side > 0) &&
        !(S.mode === 0 && pos.side !== S.mySide);
      if (mine || (view.sel >= 0 && view.targets.includes(sq2))) h = sq2;
    }
    view.cv.style.cursor = h >= 0 ? 'pointer' : 'default';
    if (h !== view.hover) { view.hover = h; view.draw(pos); }
  });
  /* 键盘走棋 + 读屏播报。
     canvas 对读屏是一块黑箱, 只靠鼠标点的话用键盘的人完全用不了。
     光标复用 hover 那一层 —— 按视觉语言, 键盘光标和鼠标悬停是同一类状态,
     不该再造一种标记。 */
  $('cv').addEventListener('keydown', e => {
    const pos = displayPos();
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (step) {
      e.preventDefault(); e.stopPropagation();
      const cur = view.hover >= 0 ? view.hover : (view.sel >= 0 ? view.sel : sq(view.flip ? 0 : H - 1, 4));
      // 翻盘时方向键要跟着翻, 否则"上"在视觉上是往下
      const dr = view.flip ? -step[0] : step[0];
      const dc = view.flip ? -step[1] : step[1];
      const r = Math.max(0, Math.min(H - 1, rowOf(cur) + dr));
      const c = Math.max(0, Math.min(W - 1, colOf(cur) + dc));
      view.hover = sq(r, c);
      view.draw(pos);
      const pc = pos.board[view.hover];
      say(`${sqToUci(view.hover)}${pc ? ' ' + ((pc > 0 ? '红' : '黑') + (pc > 0 ? NAME_RED : NAME_BLACK)[Math.abs(pc)]) : ' 空'}`);
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      view.sel = -1; view.targets = []; view.draw(pos); return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      if (view.hover < 0) return;
      onBoardSquare(view.hover);
    }
  });
  $('cv').addEventListener('mouseleave', () => {
    if (view.hover !== -1) { view.hover = -1; view.draw(displayPos()); }
  });
  $('newBtn').onclick = newGameAsk;
  $('undoBtn').onclick = undo;
  $('resignBtn').onclick = resign;

  // ── 摆棋 / 读图 ──
  $('setupBtn').onclick = () => enterSetup();
  /* 取消 / 清盘 都会把摆好的东西弄没, 而摆一盘棋是几十次点击 + 一张照片的成本。
     只在"确实动过"的时候才问 —— 刚进摆棋就按取消不该被拦一道。 */
  $('setupCancelBtn').onclick = async () => {
    const st = S.setup;
    if (!st) return;
    if (st.pos.fen() !== st.fromFen) {
      const okd = await askConfirm({
        title: '不要这个局面了?',
        body: '摆棋期间改的全部丢掉, 盘面回到进摆棋之前那一刻。',
        ok: '丢掉',
      });
      if (!okd || !S.setup) return;
    }
    exitSetup();
  };
  $('setupOkBtn').onclick = applySetup;
  $('clearBoardBtn').onclick = async () => {
    if (!S.setup) return;
    const n = S.setup.pos.board.filter(Boolean).length;
    if (n) {
      const okd = await askConfirm({
        title: `清掉盘上的 ${n} 枚子?`,
        body: '清盘是空盘不是开局, 而且没有撤销。' +
              (S.photo ? ' 照片还在旁边, 可以对着重摆。' : ''),
        ok: '清盘',
      });
      if (!okd || !S.setup) return;
    }
    S.setup.pos = new Position('9/9/9/9/9/9/9/9/9/9 w - - 0 1');
    S.setup.unsure = new Set();
    renderSetup(); render();
  };
  bindGroup('stmGrp', 's', v => {
    if (!S.setup) return;
    S.setup.side = v; S.setup.pos.side = v;
    renderSetup(); renderTop();
  });
  bindGroup('flipGrp', 'f', v => { S.flipView = !!v; render(); });
  $('labPrev').onclick = () => S.label && labelLoad(S.label.i - 1);
  $('labNext').onclick = () => S.label && labelLoad(S.label.i + 1);
  $('labSave').onclick = labelSave;
  $('labRedo').onclick = labelRecognize;
  $('photoImg').onclick = () => { if (S.photo) window.open(S.photo, '_blank'); };
  try { S.photoFolded = localStorage.getItem('xq.photoFolded') === '1'; } catch (e) {}
  $('photoToggle').onclick = () => {
    S.photoFolded = !S.photoFolded;
    try { localStorage.setItem('xq.photoFolded', S.photoFolded ? '1' : '0'); } catch (e) {}
    showPhoto();
  };

  $('readImgBtn').onclick = () => $('imgIn').click();
  $('shotBtn').onclick = () => $('camIn').click();
  const pickFile = e => {
    const f = e.target.files && e.target.files[0];
    // value 清掉, 否则选同一个文件第二次不触发 change
    e.target.value = '';
    if (f) readImage(f);
  };
  $('imgIn').onchange = pickFile;
  $('camIn').onchange = pickFile;
  /* "拍一张"只在真有摄像头时露出来。桌面浏览器忽略 capture 属性, 那个按钮点下去
     和"读一张图"完全一样 —— 两个长得不同却做同一件事的按钮比少一个按钮更糟。
     enumerateDevices 不需要授权就能告诉你有没有 videoinput (拿不到 label 而已)。 */
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices()
      .then(ds => {
        const hasCam = ds.some(d => d.kind === 'videoinput');
        // 桌面上插着摄像头也不该走 capture, 那条路是给手机的
        const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        $('shotBtn').hidden = !(hasCam && mobile);
      })
      .catch(() => {});
  }
  /* 粘贴是截图这条路上最短的动作 (截图 → Ctrl+V), 所以全局挂,
     不要求先进摆棋态 —— 粘一张图本身就是"我要摆这个局面"的意思。 */
  document.addEventListener('paste', e => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        e.preventDefault();
        readImage(it.getAsFile());
        return;
      }
    }
  });
  const box = document.querySelector('.boardbox');
  ['dragover', 'drop'].forEach(t => box.addEventListener(t, e => {
    e.preventDefault();
    if (t === 'drop' && e.dataTransfer.files && e.dataTransfer.files[0])
      readImage(e.dataTransfer.files[0]);
  }));
  $('analyzeBtn').onclick = () => {
    S.analysisOn = !S.analysisOn;
    $('analyzeBtn').classList.toggle('primary', S.analysisOn);
    if (S.analysisOn) runAnalysis();
    else stopAnalysis();
  };
  $('reviewBtn').onclick = runReview;
  $('exitReviewBtn').onclick = () => {
    S.reviewing = false; $('revSec').hidden = true;
    $('exitReviewBtn').hidden = true; $('reviewBtn').hidden = false;
    $('anaSec').hidden = false;
  };

  bindGroup('lvlGrp', 'l', v => { S.level = v; renderTop(); });
  bindGroup('layerGrp', 'y', v => { view.layer = ['none', 'loose', 'control'][v]; render(); });
  bindGroup('themeGrp', 't', v => setTheme(['paper', 'wood', 'bamboo'][v]));
  /* ★ 换模式/换执子时, **如果还没走过一步就不要清盘**。
     从照片摆进来的局面 S.hist 是空的, 而原来这里无条件 newGame(), 于是
     "读图 → 想跟引擎从这个局面下" 会把刚摆好的局面打回开局。
     走过棋了才清 —— 那时候换模式确实等于换一局。 */
  const switchMode = fn => v => {
    const keep = S.hist.length === 0 && !S.setup ? S.pos.fen() : null;
    fn(v);
    if (keep === null) { newGame(); return; }
    S.flipView = S.flipView;          // 视角不动
    S.pos = new Position(keep);
    S.over = null; renderResult();
    view.lastMove = null; view.sel = -1; view.targets = [];
    render();
    if (S.mode === 0 && S.pos.side !== S.mySide) setTimeout(engineMove, 300);
    else if (S.analysisOn) runAnalysis();
  };
  bindGroup('modeGrp', 'm', switchMode(v => {
    S.mode = v; $('rowSide').style.display = v === 0 ? '' : 'none';
  }));
  bindGroup('sideGrp', 's', switchMode(v => { S.mySide = v; }));
  bindGroup('hintGrp', 'h', v => {
    S.hint = v;
    $('hintNote').textContent = t('hintNote.' + v);
    $('hintNote').setAttribute('data-i18n', 'hintNote.' + v);
    S.analysisOn = (v === 2);
    $('analyzeBtn').classList.toggle('primary', S.analysisOn);
    if (v === 2) runAnalysis(); else stopAnalysis();
  });

  $('sheet').onclick = e => {
    const m = e.target.closest('.m'); if (!m) return;
    S.cursor = +m.dataset.i;
    view.lastMove = S.hist[S.cursor] ? S.hist[S.cursor].mv : null;
    view.sel = -1; view.targets = []; view.arrows = []; view.arrowSig = ''; view.preview = null; S.hoverUci = null;
    render();
    if (S.analysisOn) runAnalysis();
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    /* 摆棋态下 A/Z/N 全部不接: 那三个键是对局的动作 (分析/悔棋/重开),
       在一个还没摆完的局面上执行它们只会把摆到一半的东西弄没。 */
    if (S.setup) { if (e.key === 'Escape') exitSetup(); return; }
    if (e.key === 'a' || e.key === 'A' || e.key === ' ') { e.preventDefault(); $('analyzeBtn').click(); }
    else if (e.key === 'z' || e.key === 'Z') undo();
    else if (e.key === 'n' || e.key === 'N') newGame();
    else if (e.key === 'ArrowLeft') { browseTo(Math.max(0, (S.cursor < 0 ? S.hist.length : S.cursor) - 1)); }
    else if (e.key === 'ArrowRight') {
      if (S.cursor < 0) return;
      browseTo(S.cursor + 1 >= S.hist.length ? -1 : S.cursor + 1);
    }
  });

  // ?moves=h3e3,b10c8&analyze=1 直接载入一个局面。分享分析链接用, 也是自动化测试的入口。
  const q = new URLSearchParams(location.search);
  const preload = (q.get('moves') || '').split(/[,\s]+/).filter(Boolean);
  const autoAnalyze = q.get('analyze') === '1';
  const autoReview = q.get('review') === '1';
  if (q.get('side') === '-1') {   // 我执黑, 引擎先走。也是人机流程的测试入口
    S.mySide = -1;
    $('sideGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.s === '-1'));
  }
  if (q.get('layer')) {
    const m = { none: 0, loose: 1, control: 2 };
    const v = m[q.get('layer')];
    if (v !== undefined) {
      view.layer = q.get('layer');
      $('layerGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.y === v));
    }
  }
  /* ?hint=0|1|2 预设提示档。录演示的时候每一幕要从确定的一档开始, 手点会漏拍;
     而且这一档同时决定 agent 能调哪几个工具, 所以它必须能写进链接里。 */
  if (q.get('hint') !== null) {
    const hv = Math.max(0, Math.min(2, +q.get('hint') || 0));
    S.hint = hv;
    $('hintGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.h === hv));
    $('hintNote').textContent = t('hintNote.' + hv);
    $('hintNote').setAttribute('data-i18n', 'hintNote.' + hv);
    if (hv === 2) S.analysisOn = true;
  }
  if (q.get('level')) {
    S.level = Math.max(0, Math.min(3, +q.get('level')));
    $('lvlGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.l === S.level));
  }
  /* ?fen=... 直接载入一个局面。照片识别、手工摆棋、别处贴过来的残局都走这条。

     ★ 和 ?moves= 是两件事, 不能合并: moves 从开局推, 载进来的是一整局;
     fen 是一个**孤立的局面**, 没有前面那些手 —— 复盘和形势曲线要棋谱才有意义,
     所以这条路径进来的局面注定只有局面分析, 那是它的性质, 不是缺陷。

     通不过自检的 FEN 不直接开局, 而是丢进摆棋态让人改 —— 一个非法局面塞给引擎,
     引擎不会说"这不合法", 它会一本正经地给出建议。 */
  const qfen = q.get('fen');
  if (qfen && !preload.length) {
    try {
      const p = new Position(decodeURIComponent(qfen));
      const bad = positionIssues(p).some(i => i.hard);
      if (bad) {
        enterSetup(p);
        S.setup.side = p.side;
        renderSetup();
        log('<span class="err">这个 FEN 通不过自检</span>', '已经放进摆棋等你改');
      } else {
        setTwoPlayer();
        S.pos = p;
        S.baseFen = p.fen();   // 悔棋要退到这里, 不是标准开局
        render();
        log('局面已载入', '本局没有棋谱, 复盘要有棋谱才能跑');
      }
    } catch (e) {
      log('<span class="err">FEN 读不了</span>', String(e.message || e));
    }
  }

  /* ?setup=1&unsure=e4,d1 直接进摆棋态并点亮几个待核对的点。
     和 ?sel= 一样是截图和自动化测试的入口 —— 读图那条路要真发一张图给模型,
     不适合每次改样式都跑一遍。 */
  if (q.get('label') === '1') labelBoot();
  if (q.get('setup') === '1' && !S.setup) enterSetup();
  const qu = q.get('unsure');
  if (qu && S.setup) {
    S.setup.unsure = new Set(
      qu.split(/[,\s]+/).filter(Boolean).map(uciToSq).filter(x => x >= 0 && x < NSQ));
    renderSetup(); render();
  }

  if (preload.length) {
    S.mode = 1;   // 载入的局面不该被引擎接手继续下
    $('modeGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === '1'));
    $('rowSide').style.display = 'none';
    for (const u of preload) {
      const mv = uciToMove(u);
      // 走不了的一步就在这里停住, 不要硬塞进棋谱: 塞了会留下一条裸 UCI,
      // 而且后面整局全部错位, 看起来像记谱坏了
      const ok = mv && S.pos.legalMoves(S.pos.side).some(m => m[0] === mv[0] && m[1] === mv[1]);
      if (!ok) { log(`着法 ${u} 不合法, 棋谱载入至此`); break; }
      const zh = moveToChinese(S.pos, mv), fenBefore = S.pos.fen(), side = S.pos.side;
      S.pos.apply(mv);
      S.hist.push({ uci: moveToUci(mv), mv, zh, fenBefore, side });
      view.lastMove = mv;
    }
    render();
    /* 载进来的棋谱可能本身就已经下完了。
       preload 是直接往 S.hist 里塞, 不走 doMove, 所以终局判定不会自己触发 ——
       结果是分享一局已经分出胜负的棋, 打开只看到一个静止的残局, 没有任何
       说明。和"看起来卡死了"是同一个毛病的另一条路径。 */
    const t0 = S.pos.terminal();
    if (t0) onGameOver(t0, S.pos.side);
  }

  /* ?sel=b1 预选一个子, 分享"这个子能去哪"用, 也是选中态的截图入口。
     ★ 这一段必须放在载入棋谱**之后**。原来它在前面, 于是合法着法是照**开局**
     算的, 载完棋谱也不重算 —— 盘上就会出现"可吃"的圈套在自己的子上
     (开局时那两个点是空的, 走完几手之后站上了自己人)。 */
  const qs = q.get('sel');
  if (qs && /^[a-i](10|[1-9])$/.test(qs)) {
    const sq2 = uciToSq(qs);
    if (S.pos.board[sq2]) {
      view.sel = sq2;
      view.targets = S.pos.legalMoves(S.pos.side).filter(m => m[0] === sq2).map(m => m[1]);
      render();
    }
  }

  eng = new Engine();
  /* 自检行是一次性写进去的, 切语言时得知道当时写的是哪一句才能重画。
     存 key 不存文字, 这样翻译换了也跟着换。 */
  window.__scState = { key: null, raw: null };
  const setSelfcheck = (key, raw) => {
    window.__scState = { key, raw };
    if (key === 'ready')
      $('selfcheck').textContent = `${t('sc.prefix')} · ${t('sc.ready')} · ${t(crossOriginIsolated ? 'sc.mt' : 'sc.st')}`;
    else if (key === 'failed')
      $('selfcheck').innerHTML = `<span class="err">${t('sc.prefix')} · ${t('sc.failed')} ` + raw + '</span>';
    else
      $('selfcheck').textContent = t('sc.prefix') + ' · ' + raw;
  };
  window.__setSelfcheck = setSelfcheck;

  /* ★ 引擎必须等到跨源隔离成立才能起。
     Emscripten 的 pthread 版 Pikafish 在 initMemory() 里无条件建 shared WebAssembly.Memory,
     那要 SharedArrayBuffer, 而 SharedArrayBuffer 要 crossOriginIsolated。

     静态托管 (GitHub Pages) 发不了 COOP/COEP, 补头的是 coi-serviceworker: 它在首次访问时
     注册 service worker 然后**把页面重载一次**, 第二次才隔离。所以首屏这一瞬是没有隔离的,
     这时候去 init 会抛 "SharedArrayBuffer transfer requires self.crossOriginIsolated",
     而且会白下一遍 51.6MB 权重 —— 重载之后还要再下一遍。
     什么都不做才是对的: 让重载发生。 */
  if (!crossOriginIsolated) {
    setSelfcheck('progress', t('sc.isolating'));
    /* The reload normally comes within a second. If it has not come after ten, the service
       worker was refused (some embedded browsers, private windows) and it never will: say so,
       instead of leaving "setting up" on screen forever. The rules half of the page (board,
       moves, setup, the rules-only agent tools) keeps working; only the engine is missing. */
    setTimeout(() => { if (!crossOriginIsolated && !eng.ready) setSelfcheck('failed', t('sc.noIsolation')); }, 10000);
  } else {
  const progressKey = {
    '载入引擎': 'eng.loading', '载入权重 50MB': 'eng.net',
    '校验权重': 'eng.verify', '权重来自本地缓存': 'eng.cached', '就绪': 'eng.ready'
  };
  eng.init(msg => setSelfcheck('progress', progressKey[msg] ? t(progressKey[msg]) : msg))
    .then(() => {
      /* 自检期间的 die 是预期内的 (坏权重 → 重新下载重试), 由 init 自己处理,
         不该弹错误框。就绪之后再死才是意外, 那时候必须让人看见。 */
      eng.onDeath = why => engineDied(why);
      setSelfcheck('ready');
      renderTop();
      if (autoAnalyze) {
        S.analysisOn = true;
        $('analyzeBtn').classList.add('primary');
        runAnalysis();
      }
      if (autoReview) runReview();
      /* 元信息档的面板 (含"我想走这一步"那个框) 平时是走完一手才画的;
         用 ?hint=1 直接进来时盘上还没有手, 得在这里补一次, 否则那个框不存在。 */
      if (S.hint === 1 && !S.analysisOn) hintMeta();
      if (S.mode === 0 && S.pos.side !== S.mySide) engineMove();
    })
    .catch(e => { setSelfcheck('failed', String(e)); });
  }

  /* 切界面语言时, 把自己动态写进去的那几处重画一遍。
     data-i18n 那批由 applyI18n() 负责, 这里管的是 JS 生成的部分。 */
  window.onLangChange = () => {
    try {
      if (S.setup) {
        delete $('palette').dataset.built;
        buildPalette();
        renderSetup();
      }
      renderTop();
      $('hintNote').textContent = t('hintNote.' + S.hint);
      render();
      renderLegend();
      renderLayerRead();
      if (window.__setSelfcheck && window.__scState && window.__scState.key)
        window.__setSelfcheck(window.__scState.key, window.__scState.raw);
      if (window.__xqAgent) { window.__xqAgent.readout(); window.__xqAgent.renderPanel(); }
    } catch (e) { console.warn('onLangChange', e); }
  };

  // 只读调试口, 给测试脚本用
  window.__xq = {
    get pos() { return S.pos; }, get hist() { return S.hist; }, get state() { return S; },
    Position, moveToChinese, uciToMove, moveToUci,
    analyze: (fen, o) => eng.analyze(fen || S.pos.fen(), o),
  };
}

// boot 里任何一步抛了都要看得见: 之前有一次 URL 参数整段没执行, 页面却完全正常,
// 因为异常发生在 render() 之后, 状态栏已经被正常内容覆盖过了。
function safeBoot() {
  try { boot(); }
  catch (e) {
    const el = document.getElementById('log');
    if (el) el.innerHTML = '<span class="err">启动出错 ' +
      String(e && (e.stack || e.message || e)).replace(/[<>&]/g, '').slice(0, 300) + '</span>';
    throw e;
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBoot);
else safeBoot();
