/* 界面语言。棋本身不翻译 —— 棋子 (车马炮)、记谱 (炮二平五)、楚河汉界一律保持原样,
   翻的只有围着棋盘的那层界面文字。

   用法:
     - 静态标签: <span data-i18n="acts.analyze">分析</span>
     - 带 HTML 的:  <p data-i18n-html="ana.dek">...</p>
     - 属性:        <canvas data-i18n-aria-label="board.aria">
     - 整块二选一:  <div data-lang="zh">…</div><div data-lang="en">…</div>
     - JS 里:       t('sc.ready')  /  t('ana.depth', {n: 12})

   切语言时 applyI18n() 重扫一遍 DOM, 然后调 window.onLangChange(), 让 app.js
   把自己那些动态写进去的文字 (状态行、分析面板、读数行) 重画一次。 */
(function () {
  const DICT = {
    zh: {
      'lang.other': 'EN',
      'lang.title': '切换到英文界面',

      'head.mode.vsEngine': '人机', 'head.mode.twoPlayer': '双人同机',
      'head.side.red': '我执红', 'head.side.black': '我执黑',
      'head.setup': '摆棋', 'head.review': '复盘',
      'status.init': '初始化', 'status.reading': '正在读图',

      'board.aria': '象棋棋盘。方向键移动光标, 回车选子或落子, Esc 取消。',
      'photo.alt': '读进来的原图',
      'photo.collapse': '收起', 'photo.expand': '展开',
      'photo.cap': '原图 · 点图放大',
      'curve.now': '形势',

      'acts.analyze': '分析', 'acts.undo': '悔棋', 'acts.review': '复盘',
      'acts.exitReview': '退出复盘', 'acts.resign': '认输',
      'acts.new': '重开', 'acts.setup': '摆棋',

      'setup.1': '1 · 读图', 'setup.shot': '拍一张', 'setup.read': '读一张图',
      'setup.readHint': '也可以 Ctrl+V 粘贴截图, 或把图片拖到棋盘上',
      'setup.sample': '打开示例照片',
      'setup.2': '2 · 改子',
      'setup.editHint': '拿一个子点在盘上落下去 · 拿"核对"只消红点不改子 · 拿"拿掉"清子',
      'setup.3': '3 · 轮谁走', 'setup.redFirst': '红先', 'setup.blackFirst': '黑先',
      'setup.stmHint': '照片里看不出该谁走, 自己定一下',
      'setup.4': '4 · 完成', 'setup.ok': '确认并开始分析',
      'setup.clear': '清盘', 'setup.cancel': '取消',
      'setup.label': '标注', 'setup.prev': '上一张', 'setup.next': '下一张',
      'setup.save': '存为标准答案', 'setup.redo': '重新识别',
      'setup.check': '核对', 'setup.remove': '拿掉',
      'setup.checkTurn': '{s}方正被将, 所以只能是{s}先',
      'setup.selfReading': '正在读图', 'setup.selfPassed': '自检通过',
      'setup.selfBad': '自检 {n} 处不合规',
      'setup.selfUnsure': '自检通过 · 还有 {n} 个点标着红, 点掉表示核对过',
      'setup.readingLog': '正在读图', 'setup.readingTime': '通常只需几秒',
      'setup.readDone': '读图完成', 'setup.readFailed': '自检没过, 见下面那行',
      'setup.reviewPoints': '{n} 个点要你看一眼', 'setup.allConfident': '每个点它都有把握',
      'setup.attempts': '{n} 次',
      'setup.oriTop': '图是拍反的, 已转正',
      'setup.oriLeft': '棋盘是横着的 (红方在左), 已转正',
      'setup.oriRight': '棋盘是横着的 (红方在右), 已转正',
      'setup.noRecognizer': '浏览器 ONNX 读图组件没有载入',

      'view.level': '难度', 'lvl.0': '入门', 'lvl.1': '业余', 'lvl.2': '较强', 'lvl.3': '全力',
      'view.layer': '盘面', 'layer.0': '无', 'layer.1': '无根', 'layer.2': '控制',
      'view.flip': '视角', 'flip.0': '红在下', 'flip.1': '黑在下',
      'view.theme': '主题', 'theme.0': '纸', 'theme.1': '木', 'theme.2': '竹',

      'sec.review': '复盘', 'sec.reviewThis': '本局',
      'sec.ana': '局面分析', 'sec.sheet': '棋谱', 'sec.game': '对局设置',
      'ana.off': '未开', 'ana.waiting': '等对方', 'ana.thinking': '思考中',
      'ana.meta': '元信息', 'ana.broken': '引擎故障',
      'ana.depth': '{n} 层',
      'ana.kicker': '引擎首选', 'ana.titleOff': '未开启',
      'ana.dek': '按"分析"或空格键开启。对局中默认关闭。',
      'ana.press': '按"分析"或空格开始。', 'ana.noMoves': '无可走之着。',
      'ana.best': '引擎首选', 'ana.calculating': '正在计算',
      'ana.only': '只有这一步, 次选差 {n} 兵', 'ana.secondGap': '次选差 {n} 兵',
      'ana.alternatives': '另有 {n} 步相差不到 {gap} 兵',
      'ana.move': '着法', 'ana.score': '评分', 'ana.gap': '差距', 'ana.cloud': '云库',
      'ana.after': '之后', 'ana.methodLine': '评分为行棋方视角, 单位兵。点一行看它之后的变化。',
      'ann.capture': '吃{s}', 'ann.check': '将军', 'ann.defend': '补根', 'ann.loose': '遗 {n} 无根',
      'loose.loose': '无根', 'loose.attacked': '受攻',
      'loose.more': '另有 {n} 枚 · ', 'loose.before': '落子之前先看这几枚',
      'ana.method': 'Pikafish 于本机浏览器运行, 无分析后端。开启分析时会把当前局面 (FEN) 发给 chessdb 公共云库查询',

      'row.mode': '模式', 'row.side': '执子', 'row.hint': '提示',
      'hint.0': '关', 'hint.1': '元信息', 'hint.2': '全开',
      'hintNote.0': '对局中不予任何提示。',
      'hintNote.1': '可问这里是否关键, 也可判断你点名的一步, 但不透露最佳着。',
      'hintNote.2': '对局中亦显示完整候选, 等同练习模式。',

      'sc.prefix': '自检', 'sc.ready': '引擎就绪',
      'sc.mt': '多线程', 'sc.st': '单线程',
      'sc.failed': '引擎装载失败', 'sc.stopped': '引擎已停止',
      'sc.isolating': '正在建立跨源隔离, 页面会自动重载一次',
      'sc.noIsolation': '这个浏览器不让 service worker 建立跨源隔离, 引擎起不来; 走子、摆棋和规则类 agent 工具照常',

      'eng.loading': '载入引擎', 'eng.net': '载入权重 50MB', 'eng.verify': '校验权重',
      'eng.cached': '权重来自本地缓存', 'eng.ready': '就绪',

      'grade.妙手': '妙手', 'grade.好棋': '好棋', 'grade.正着': '正着',
      'grade.缓手': '缓手', 'grade.漏着': '漏着', 'grade.败着': '败着',

      'agent.on': '浏览器已开 WebMCP', 'agent.off': '浏览器未开 WebMCP',
      'agent.can': 'agent 能调 {n} 项', 'agent.cannot': '不能调',
      'agent.none': '没有工具可调',
      'st.win': '{s}方胜', 'st.thinking': '引擎运算中', 'st.toMove': '{s}方走',
      'st.check': '将军',
      'curve.nodata': '尚无数据', 'curve.at': '第 {k} / {n} 手', 'curve.stale': '第 {k} 手 · 之后未测',
      'curve.mate': '{n} 步内, 无解', 'curve.mateBy': '{s}方绝杀', 'curve.ahead': '{s}方占先',
      'curve.delta': '{s}这一手', 'unit.pawn': '兵',
      'legend.hint': '朱红是红方走的, 墨是黑方走的',
      'legend.preview': '变化预览', 'legend.choice': '第 {n} 选',
      'legend.enginePick': '引擎首选', 'legend.threat': '对方威胁',
      'band.均势': '均势', 'band.略优': '略优', 'band.优势': '优势', 'band.大优': '大优', 'band.胜势': '胜势',
      'panel.count': '{n} 项 · {mode}', 'panel.native': 'WebMCP 原生', 'panel.shim': '本页模拟',
      'lvl.book': '云库正着',
      'meta.narrow': '着法极窄', 'meta.narrowNote': '此处可行之着不多, 落子前须算清。',
      'meta.loose': '着法宽松, 前几着相差有限。',
      'meta.askLabel': '我想走这一步:', 'meta.askPlaceholder': '炮二平五 或 h3e3',
      'meta.askBtn': '问', 'meta.askThinking': '算一下…',
      'meta.askIllegal': '这一步在当前局面里走不了', 'meta.askLoss': '比最好的那步差 {n} 个胜势点',
      'verdict.正着': '正着 (就是首选)', 'verdict.可走': '可走', 'verdict.偏软': '偏软', 'verdict.有问题': '有问题',
      'taken.none': '尚无得失', 'side.red': '红', 'side.black': '黑',
      'sheet.empty': '尚未走子', 'sheet.count': '{n} 手',
      'read.control': '朱红=红方控得多, 墨=黑方', 'read.loose': '无根 {n}', 'read.press': '受攻 {n}',
      'foot.about': '说明与快捷键', 'foot.agent': 'Agent 工具', 'foot.call': '调用'
    },

    en: {
      'lang.other': '中',
      'lang.title': 'Switch the interface to Chinese',

      'head.mode.vsEngine': 'vs engine', 'head.mode.twoPlayer': 'two players',
      'head.side.red': 'I play Red', 'head.side.black': 'I play Black',
      'head.setup': 'set up', 'head.review': 'review',
      'status.init': 'starting', 'status.reading': 'reading the photo',

      'board.aria': 'Xiangqi board. Arrow keys move the cursor, Enter picks up or drops a piece, Esc cancels.',
      'photo.alt': 'the photo that was read',
      'photo.collapse': 'hide', 'photo.expand': 'show',
      'photo.cap': 'source photo · click to enlarge',
      'curve.now': 'balance',

      'acts.analyze': 'Analyse', 'acts.undo': 'Undo', 'acts.review': 'Review',
      'acts.exitReview': 'Leave review', 'acts.resign': 'Resign',
      'acts.new': 'New game', 'acts.setup': 'Set up',

      'setup.1': '1 · from a photo', 'setup.shot': 'Take a photo', 'setup.read': 'Open an image',
      'setup.readHint': 'You can also paste a screenshot with Ctrl+V, or drop an image on the board',
      'setup.sample': 'Open the included sample',
      'setup.2': '2 · fix pieces',
      'setup.editHint': 'Pick a piece and click a point to place it · pick "check" to clear a red dot without changing the piece · pick "remove" to empty a point',
      'setup.3': '3 · side to move', 'setup.redFirst': 'Red moves', 'setup.blackFirst': 'Black moves',
      'setup.stmHint': 'A photo cannot show whose turn it is. Set it yourself.',
      'setup.4': '4 · done', 'setup.ok': 'Confirm and analyse',
      'setup.clear': 'Clear board', 'setup.cancel': 'Cancel',
      'setup.label': 'Label', 'setup.prev': 'Previous', 'setup.next': 'Next',
      'setup.save': 'Save as ground truth', 'setup.redo': 'Read again',
      'setup.check': 'Check', 'setup.remove': 'Remove',
      'setup.checkTurn': '{s} is in check, so {s} must move',
      'setup.selfReading': 'Reading photo', 'setup.selfPassed': 'Position check passed',
      'setup.selfBad': 'Position check found {n} problems',
      'setup.selfUnsure': 'Position check passed · review {n} highlighted points',
      'setup.readingLog': 'Reading photo', 'setup.readingTime': 'Usually takes a few seconds',
      'setup.readDone': 'Photo recognized', 'setup.readFailed': 'Position check failed; review the line below',
      'setup.reviewPoints': 'Review {n} points', 'setup.allConfident': 'All 90 points are confident',
      'setup.attempts': '{n} attempt(s)',
      'setup.oriTop': 'Photo rotated 180° and corrected',
      'setup.oriLeft': 'Photo rotated from Red on the left and corrected',
      'setup.oriRight': 'Photo rotated from Red on the right and corrected',
      'setup.noRecognizer': 'The browser ONNX photo recognizer did not load',

      'view.level': 'Level', 'lvl.0': 'Novice', 'lvl.1': 'Club', 'lvl.2': 'Strong', 'lvl.3': 'Full',
      'view.layer': 'Overlay', 'layer.0': 'None', 'layer.1': 'Loose pieces', 'layer.2': 'Control',
      'view.flip': 'View', 'flip.0': 'Red at bottom', 'flip.1': 'Black at bottom',
      'view.theme': 'Theme', 'theme.0': 'Paper', 'theme.1': 'Wood', 'theme.2': 'Bamboo',

      'sec.review': 'Review', 'sec.reviewThis': 'this game',
      'sec.ana': 'Position analysis', 'sec.sheet': 'Moves', 'sec.game': 'Game',
      'ana.off': 'off', 'ana.waiting': 'opponent', 'ana.thinking': 'thinking',
      'ana.meta': 'meta only', 'ana.broken': 'engine error',
      'ana.depth': 'depth {n}',
      'ana.kicker': "Engine's choice", 'ana.titleOff': 'Not running',
      'ana.dek': 'Press "Analyse" or the space bar. Off by default while a game is on.',
      'ana.press': 'Press "Analyse" or the space bar.', 'ana.noMoves': 'No legal moves.',
      'ana.best': "Engine's choice", 'ana.calculating': 'Calculating',
      'ana.only': 'Only this move holds; the next is {n} pawns worse',
      'ana.secondGap': 'The next move is {n} pawns worse',
      'ana.alternatives': '{n} other move(s) within {gap} pawns',
      'ana.move': 'Move', 'ana.score': 'Score', 'ana.gap': 'Gap', 'ana.cloud': 'Book',
      'ana.after': 'Then', 'ana.methodLine': 'Scores are from the side-to-move perspective, in pawns. Select a row to inspect its continuation.',
      'ann.capture': 'takes {s}', 'ann.check': 'check', 'ann.defend': 'defends', 'ann.loose': 'leaves {n} loose',
      'loose.loose': 'Loose', 'loose.attacked': 'Attacked',
      'loose.more': '{n} more · ', 'loose.before': 'Check these pieces before moving',
      'ana.method': 'Pikafish runs inside this browser; there is no analysis backend. While analysis is on, the current position (FEN) is sent to the public chessdb cloud book.',

      'row.mode': 'Mode', 'row.side': 'Side', 'row.hint': 'Hints',
      'hint.0': 'Off', 'hint.1': 'Meta', 'hint.2': 'Full',
      'hintNote.0': 'No hints of any kind while a game is on.',
      'hintNote.1': 'Ask whether the moment is critical, or judge a move you name, without revealing the best move.',
      'hintNote.2': 'Full candidate list and scores during play, same as practice mode.',

      'sc.prefix': 'Self-check', 'sc.ready': 'engine ready',
      'sc.mt': 'multi-threaded', 'sc.st': 'single-threaded',
      'sc.failed': 'engine failed to load', 'sc.stopped': 'engine stopped',
      'sc.isolating': 'setting up cross-origin isolation; the page will reload once',
      'sc.noIsolation': 'this browser did not let the service worker set up cross-origin isolation, so the engine cannot start; moves, setup and the rules-only agent tools still work',

      'eng.loading': 'loading engine', 'eng.net': 'loading the 50MB network', 'eng.verify': 'checking the network',
      'eng.cached': 'network came from the local cache', 'eng.ready': 'ready',

      'grade.妙手': 'Brilliant', 'grade.好棋': 'Good', 'grade.正着': 'Book',
      'grade.缓手': 'Inaccuracy', 'grade.漏着': 'Mistake', 'grade.败着': 'Blunder',

      'agent.on': 'WebMCP is on in this browser', 'agent.off': 'WebMCP is off in this browser',
      'agent.can': 'the agent can call {n}', 'agent.cannot': 'it cannot call',
      'agent.none': 'no tools available',
      'st.win': '{s} wins', 'st.thinking': 'engine thinking', 'st.toMove': '{s} to move',
      'st.check': 'check',
      'curve.nodata': 'no data yet', 'curve.at': 'move {k} / {n}', 'curve.stale': 'move {k} · nothing measured after it',
      'curve.mate': 'mate in {n}, forced', 'curve.mateBy': '{s} mates', 'curve.ahead': '{s} is ahead',
      'curve.delta': "{s}'s move", 'unit.pawn': 'pawns',
      'legend.hint': 'vermilion is a Red move, ink is a Black move',
      'legend.preview': 'Variation preview', 'legend.choice': 'Choice {n}',
      'legend.enginePick': "Engine's choice", 'legend.threat': "Opponent's threat",
      'band.均势': 'even', 'band.略优': 'slightly better', 'band.优势': 'better', 'band.大优': 'much better', 'band.胜势': 'winning',
      'panel.count': '{n} tools · {mode}', 'panel.native': 'native WebMCP', 'panel.shim': 'shimmed on this page',
      'lvl.book': 'book move',
      'meta.narrow': 'Narrow choice', 'meta.narrowNote': 'Few moves work here; calculate before you move.',
      'meta.loose': 'Relaxed: the top moves are close.',
      'meta.askLabel': 'I want to play:', 'meta.askPlaceholder': '炮二平五 or h3e3',
      'meta.askBtn': 'Ask', 'meta.askThinking': 'checking…',
      'meta.askIllegal': 'That move is not legal in this position', 'meta.askLoss': '{n} win-chance points behind the best move',
      'verdict.正着': 'Best move', 'verdict.可走': 'Playable', 'verdict.偏软': 'Soft', 'verdict.有问题': 'Problem',
      'taken.none': 'nothing captured yet', 'side.red': 'Red', 'side.black': 'Black',
      'sheet.empty': 'No moves yet', 'sheet.count': '{n} plies',
      'read.control': 'vermilion = Red controls more, ink = Black', 'read.loose': '{n} loose', 'read.press': '{n} under attack',
      'foot.about': 'About and shortcuts', 'foot.agent': 'Agent tools', 'foot.call': 'Call'
    }
  };

  const KEY = 'xq_lang';
  let LANG;
  /* ?lang=en / ?lang=zh 优先: 给分享链接和测试用, 它不写 localStorage,
     所以不会把这台机器上的选择改掉。 */
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'zh' || q === 'en') {
    LANG = q;
  } else {
    try { LANG = localStorage.getItem(KEY); } catch (e) { LANG = null; }
    if (LANG !== 'zh' && LANG !== 'en') {
      LANG = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    }
  }

  function t(key, vars) {
    let s = (DICT[LANG] && DICT[LANG][key]);
    if (s == null) s = DICT.zh[key];
    if (s == null) return key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    /* data-i18n-aria-label -> aria-label, data-i18n-alt -> alt, ... */
    root.querySelectorAll('*').forEach(el => {
      for (const a of el.attributes) {
        if (a.name.startsWith('data-i18n-') &&
            a.name !== 'data-i18n-html' && !a.name.startsWith('data-i18n-attr')) {
          const target = a.name.slice('data-i18n-'.length);
          if (target === 'aria-label' || target === 'alt' || target === 'title' ||
              target === 'placeholder') el.setAttribute(target, t(a.value));
        }
      }
    });
    root.querySelectorAll('[data-lang]').forEach(el => {
      el.hidden = el.getAttribute('data-lang') !== LANG;
    });
  }

  function setLang(l) {
    if (l !== 'zh' && l !== 'en') return;
    LANG = l;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    document.documentElement.lang = (l === 'zh' ? 'zh-Hans' : 'en');
    applyI18n();
    const btn = document.getElementById('langBtn');
    if (btn) { btn.textContent = t('lang.other'); btn.title = t('lang.title'); }
    if (typeof window.onLangChange === 'function') window.onLangChange(l);
  }

  /* 形势词是"红"/"黑" + 档位合成的 (红大优 / 黑胜势 / 均势)。内部值保持中文
     (有 startsWith('红') 这种判断挂在上面), 只在显示的时候翻。 */
  function band(word) {
    if (word === '均势') return t('band.均势');
    const side = word[0] === '红' ? t('side.red') : t('side.black');
    const rest = word.slice(1);
    const s2 = t('band.' + rest);
    if (s2 === 'band.' + rest) return word;
    return LANG === 'en' ? (side + ' ' + s2) : (side + s2);
  }

  window.t = t;
  window.band = band;
  window.applyI18n = applyI18n;
  window.setLang = setLang;
  Object.defineProperty(window, 'LANG', { get: () => LANG });

  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.lang = (LANG === 'zh' ? 'zh-Hans' : 'en');
    applyI18n();
    const btn = document.getElementById('langBtn');
    if (btn) {
      btn.textContent = t('lang.other');
      btn.title = t('lang.title');
      btn.addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh'));
    }
  });
})();
