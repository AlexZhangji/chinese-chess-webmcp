/* ================= WebMCP: the agent sees what the human sees =================

   This file is the only thing that knows WebMCP exists. It registers tools on
   `document.modelContext` (the WebMCP proposal, https://github.com/webmachinelearning/webmcp)
   and re-registers them whenever the page's state changes.

   The one design rule, and the reason this app fits WebMCP at all:

     ★ The set of registered tools mirrors what is on the screen.
       Whatever the interface currently shows the human is what the agent may call.
       Nothing more.

   The app already has a three-position "提示" (hint) control for play against the engine:
     关     (off)   the engine tells you nothing during the game
     元信息 (meta)  it only says whether this moment is critical, never which move
     全开   (full)  the analysis panel is open: candidates, scores, threat
   Those positions become tool sets. With hints off there is no `analyze_position` tool for
   the agent to call: "the coach may not read the engine" is enforced by absence, not by a
   sentence in a prompt. The human moves the control; the agent's capabilities move with it.
   A static tool manifest cannot express that; the spec's own "Alternatives Considered"
   gives exactly this as the reason for a dynamic API.

   Everything else the agent can do (read the board, move a piece, set up a position from a
   FEN produced by the app or supplied by the human, load a game, ask for a review) it can
   do at every hint level, because none of it consults the engine on the human's behalf.

   Wiring: app.js calls `agentSync()` at the end of every `render()`; a slow interval covers
   the few state changes that do not redraw. Nothing else in app.js knows about this file.
   Globals used from the other three scripts are all read-only here except through the
   app's own entry points (doMove / undo / newGame / enterSetup / runAnalysis / runReview).
*/
(function () {
  'use strict';

  /* ---------- a spec-shaped shim for browsers without WebMCP ----------
     Chrome 146+ (chrome://flags/#enable-webmcp-testing) and ChatGPT's built-in browser
     provide `document.modelContext` natively. Everywhere else this shim keeps the same
     surface (registerTool with an AbortSignal, getTools, executeTool, `toolchange`) so the
     in-page tool panel, the tests and the readout still work. Agents cannot see the shim;
     it exists so the page tells the truth about its own boundary in any browser. */
  const NATIVE = !!((document.modelContext && document.modelContext.registerTool) ||
                    (navigator.modelContext && navigator.modelContext.registerTool));
  if (!NATIVE) {
    const reg = new Map();
    class ShimModelContext extends EventTarget {
      async registerTool(tool, opts = {}) {
        if (!tool || !tool.name || typeof tool.execute !== 'function') throw new TypeError('bad tool');
        if (reg.has(tool.name)) throw new DOMException(`Tool "${tool.name}" is already registered`, 'InvalidStateError');
        const rec = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
                      annotations: tool.annotations, execute: tool.execute, origin: location.origin };
        reg.set(tool.name, rec);
        if (opts.signal) {
          if (opts.signal.aborted) { reg.delete(tool.name); return; }
          opts.signal.addEventListener('abort', () => {
            if (reg.get(tool.name) === rec) { reg.delete(tool.name); this.dispatchEvent(new Event('toolchange')); }
          }, { once: true });
        }
        this.dispatchEvent(new Event('toolchange'));
      }
      async getTools() {
        return [...reg.values()].map(t => ({ name: t.name, description: t.description,
          inputSchema: t.inputSchema, annotations: t.annotations, origin: t.origin, window }));
      }
      async executeTool(tool, input = {}, opts = {}) {
        const t = reg.get(typeof tool === 'string' ? tool : tool.name);
        if (!t) throw new Error(`Tool ${tool && tool.name || tool} not found`);
        const r = await t.execute(typeof input === 'string' ? JSON.parse(input) : input,
                                  { signal: opts.signal || new AbortController().signal });
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
    }
    Object.defineProperty(document, 'modelContext', { value: new ShimModelContext(), configurable: true });
  }
  const MC = () => (document.modelContext && document.modelContext.registerTool)
    ? document.modelContext : navigator.modelContext;

  /* ---------- helpers ---------- */
  const SIDE = s => (s > 0 ? 'red' : 'black');
  const FEN_LETTER = { [K]: 'k', [A]: 'a', [B]: 'b', [N]: 'n', [R]: 'r', [C]: 'c', [P]: 'p' };
  const pieceName = p => (p > 0 ? NAME_RED : NAME_BLACK)[Math.abs(p)];
  const pieceLabel = p => (p > 0 ? '红' : '黑') + pieceName(p);
  const pieceLetter = p => { const l = FEN_LETTER[Math.abs(p)]; return p > 0 ? l.toUpperCase() : l; };
  const PIECE_WORDS = {
    K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
    k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒',
  };
  const isUci = s => /^[a-i](10|[1-9])[a-i](10|[1-9])$/.test(s);
  const isSq = s => /^[a-i](10|[1-9])$/.test(s);
  const err = (error, extra) => ({ ok: false, error, ...(extra || {}) });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (cond, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (cond()) return true; await wait(80); }
    return cond();
  };
  const normalizeZh = s => String(s || '').replace(/[\s　]+/g, '')
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48))
    .replace(/後/g, '后').replace(/傌/g, '马').replace(/俥/g, '车').replace(/砲/g, '炮')
    .replace(/將/g, '将').replace(/帥/g, '帅').replace(/車/g, '车').replace(/馬/g, '马')
    .replace(/進/g, '进').replace(/兵卒/g, '兵');

  function agentLog(name, detail) {
    log(`agent · ${name}`, detail || '');
    say(`agent ${name}`);
    /* Same line, but next to the tool list instead of at the foot of the page: a human
       watching should be able to see that the agent really called something. */
    const el = $('agentLast');
    if (el) el.innerHTML = `<b>${name}</b>` + (detail ? ' · ' + String(detail).replace(/[<>]/g, '') : '');
  }

  /* Parse a move the agent sent. UCI ("h3e3", files a-i, ranks 1-10 with red at the bottom)
     or the Chinese notation the sheet itself prints ("炮二平五"). Chinese is resolved by
     generating every legal move and matching its notation, so the matcher can never be
     out of step with the sheet. */
  function parseMove(pos, text) {
    const raw = String(text || '').trim();
    const legal = pos.legalMoves(pos.side);
    if (isUci(raw.toLowerCase())) {
      const mv = uciToMove(raw.toLowerCase());
      const ok = mv && legal.some(m => m[0] === mv[0] && m[1] === mv[1]);
      return ok ? { mv } : { error: `${raw} is not a legal move for ${SIDE(pos.side)} in this position` };
    }
    const want = normalizeZh(raw);
    const hits = legal.filter(m => normalizeZh(moveToChinese(pos, m)) === want);
    if (hits.length === 1) return { mv: hits[0] };
    if (hits.length > 1) return { error: `"${raw}" matches ${hits.length} moves; use UCI` };
    return { error: `"${raw}" is neither UCI (e.g. h3e3) nor a legal move in Chinese notation (e.g. 炮二平五) for ${SIDE(pos.side)}` };
  }

  function moveInfo(pos, m) {
    const after = new Position(pos.fen()); after.apply(m);
    const cap = pos.board[m[1]];
    return {
      uci: moveToUci(m), zh: moveToChinese(pos, m),
      captures: cap ? pieceLabel(cap) : null,
      gives_check: after.inCheck(after.side),
    };
  }

  function pieces(pos) {
    const out = [];
    for (let s = 0; s < NSQ; s++) {
      const p = pos.board[s];
      if (p) out.push({ square: sqToUci(s), piece: pieceLabel(p), letter: pieceLetter(p) });
    }
    return out;
  }

  function boardText(pos) {
    /* rank 10 (black's back rank) first, red at the bottom, the same way the board is drawn
       for a red player. '.' is an empty point. */
    const rows = [];
    for (let r = 0; r < H; r++) {
      let line = String(10 - r).padStart(2, ' ') + ' ';
      for (let c = 0; c < W; c++) { const p = pos.board[sq(r, c)]; line += (p ? pieceLetter(p) : '.') + ' '; }
      rows.push(line.trimEnd());
    }
    rows.push('   a b c d e f g h i');
    return rows.join('\n');
  }

  function issuesOf(pos) {
    return positionIssues(pos).map(i => ({ code: i.code, message: i.msg, hard: i.hard,
                                          squares: i.sqs.map(sqToUci) }));
  }

  function hintName() { return ['off', 'meta', 'full'][S.hint] || 'off'; }
  function hintMeaning() {
    return S.hint === 0 ? 'the engine says nothing to the human during play, so it says nothing to you either'
      : S.hint === 1 ? 'the engine says whether the moment is critical and judges a move the human names; never which move is best'
      : 'the analysis panel is open: candidates, scores and the opponent threat are visible';
  }
  const liveGame = () => !S.setup && !S.over;
  const humanTurn = () => S.mode === 1 || S.pos.side === S.mySide;

  /* ---------- which tools exist right now ----------
     Returns the names to register plus, for the ones that are absent, a sentence saying why.
     `get_position` reports both lists so an agent can plan around its own boundary. */
  function desired() {
    const names = ['get_position'];
    const absent = {};
    if (S.setup) {
      names.push('set_position', 'place_pieces');
      absent.make_move = 'the board is in setup mode; the human must press 确认 (Confirm) first';
      absent.analyze_position = 'no game yet; the position has not been confirmed by the human';
      return { names, absent };
    }
    names.push('get_legal_moves', 'show_on_board', 'set_position', 'load_game', 'new_game');
    if (!S.over) names.push('make_move'); else absent.make_move = 'the game is over';
    if (S.hist.length) names.push('undo');
    if (S.mode === 0 && S.hist.length && !S.over) names.push('resign');

    /* The four engine tools also need the engine. While it is still loading (or if it could
       not start in this browser: no cross-origin isolation, no SharedArrayBuffer) they are not
       registered, and the reason says so. A tool whose only possible answer is "engine not
       ready" is not a tool. The rules-only tools above do not depend on the engine at all. */
    const engineUp = typeof eng !== 'undefined' && eng && eng.ready;
    const engineWhy = typeof eng !== 'undefined' && eng && eng.dead
      ? 'the engine has stopped in this browser; the rules-only tools still work'
      : !window.crossOriginIsolated
      ? 'this browser has not set up cross-origin isolation, so the engine (which needs SharedArrayBuffer) cannot start; the rules-only tools still work'
      : 'the engine is still loading in this browser; try again in a few seconds';
    const critical = S.hint >= 1 || S.analysisOn;
    if (critical && engineUp) names.push('is_critical_moment', 'check_my_move');
    else absent.check_my_move = !critical
      ? 'hint level is 关 (off): at this level nobody, human or agent, can have a move judged. Only the human can change that, with the 提示 control'
      : engineWhy;
    if (!(critical && engineUp)) absent.is_critical_moment = !critical
      ? 'hint level is 关 (off): the engine does not tell either of us whether this moment is critical. Only the human can change that, with the 提示 control'
      : engineWhy;
    if (S.analysisOn && engineUp) names.push('analyze_position');
    else absent.analyze_position = !S.analysisOn
      ? 'the analysis panel is closed. The human can open it (分析 button, or hint level 全开); you cannot'
      : engineWhy;
    const reviewable = S.hist.length >= 2 && (S.over || S.mode === 1 || S.analysisOn);
    if (reviewable && engineUp) names.push('review_game');
    else absent.review_game = S.hist.length < 2 ? 'nothing to review yet'
      : !reviewable ? 'a review reveals every best move; during a human-vs-engine game it opens only when the game ends or the analysis panel is open'
      : engineWhy;
    return { names, absent };
  }

  /* ---------- the tools ---------- */
  const T = {};

  T.get_position = {
    description: 'Call this first. Read the xiangqi (Chinese chess) board exactly as the human sees it: pieces, side to move, move list in Chinese notation, game status, the on-screen evaluation, loose pieces, the current tool boundary, and a short agent quick start with the bundled photo sample.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const pos = displayPos();
      const { names, absent } = desired();
      const ply = S.setup ? 0 : (S.cursor < 0 ? S.hist.length : S.cursor);
      const out = {
        ok: true,
        project: {
          name: 'Chinese Chess WebMCP',
          purpose: 'Expose exact board state, legal moves, browser photo recognition, board actions, and deep engine analysis as capabilities an AI can use without guessing from pixels.',
          repository: 'https://github.com/AlexZhangji/chinese-chess-webmcp',
          agent_guide: 'https://github.com/AlexZhangji/chinese-chess-webmcp/blob/main/AGENTS.md',
        },
        agent_quick_start: [
          'Call get_position first, then use only the names in tools_available.',
          'For a photo, ask the human to open, paste, or drop it into the page. The dedicated browser recognizer reconstructs the board; the human confirms the board and side to move.',
          'Use analyze_position for ranked engine candidates when it is available, and show_on_board when a visible explanation would help.',
        ],
        samples: {
          park_photo: new URL('media/samples/park-game.png', document.baseURI).href,
          tv_match_photo: new URL('media/samples/tv-match.png', document.baseURI).href,
          verified_analysis_screenshot: new URL('media/samples/product-en-analysis.png', document.baseURI).href,
          demo_video: new URL('media/demo/chinese-chess-webmcp-demo.mp4', document.baseURI).href,
          verified_fen: '3akab2/3n3r1/1c1Rb1n1c/4p1p1p/2p6/r3P1P2/2P5P/N1C1C1N2/9/1RBAKAB2 w - - 0 1',
          note: 'The sample image is for the page photo-upload workflow. A file input still requires the human to open, paste, or drop the file.',
        },
        fen: pos.fen(),
        board: boardText(pos),
        pieces: pieces(pos),
        side_to_move: SIDE(pos.side),
        in_check: !S.setup && pos.inCheck(pos.side),
        human_plays: S.mode === 1 ? 'both' : SIDE(S.mySide),
        mode: S.mode === 0 ? 'human_vs_engine' : 'two_players_or_loaded_game',
        engine_level: LEVELS[S.level].name,
        hint_level: { value: hintName(), meaning: hintMeaning() },
        analysis_panel_open: !!S.analysisOn,
        move_count: S.hist.length,
        moves: S.hist.map((h, i) => ({ n: i + 1, side: SIDE(h.side), uci: h.uci, zh: h.zh })),
        last_move: S.hist.length ? S.hist[S.hist.length - 1].zh : null,
        game_over: S.over ? { winner: S.over.winner === undefined ? null : SIDE(S.over.winner), reason: S.over.why || S.over.name || S.over.t } : null,
        tools_available: names,
        tools_unavailable: absent,
      };
      agentLog('get_position', S.setup ? 'setup mode' : `${SIDE(pos.side)} to move`);
      if (S.setup) {
        const iss = issuesOf(S.setup.pos);
        out.setup = {
          message: 'setup mode: the position is being edited and has NOT been confirmed. The human must press 确认并开始分析 (Confirm and analyse). You cannot confirm it.',
          side_to_move: SIDE(S.setup.side),
          issues: iss, hard_issue_count: iss.filter(i => i.hard).length,
          unchecked_squares: [...S.setup.unsure].map(sqToUci),
        };
        return out;
      }
      if (S.cursor >= 0) out.browsing = { message: `the human is looking back at the position before move ${S.cursor + 1}; the live game is further along`, live_move_count: S.hist.length };
      const ev = S.evals[ply], adv = S.advs[ply], mate = S.mates[ply];
      if (ev !== undefined || mate) {
        out.evaluation = {
          note: 'this number is on the screen (the evaluation band under the board); it is the engine\'s view of the position, red-positive, not advice about a move',
          pawns_red_view: ev === undefined ? null : +(ev / 100).toFixed(2),
          phase: adv === undefined ? null : phaseText(adv),
          mate: mate ? { winner: SIDE(mate.winner), in_moves: mate.n } : null,
        };
      }
      if (view && view.layer === 'loose') {
        out.loose_pieces = looseSquares(pos).map(x => ({
          square: sqToUci(x.sq), piece: pieceLabel(pos.board[x.sq]),
          kind: x.kind === 'loose' ? 'hanging' : 'under_pressure',
          attacked_by: x.att.map(a => sqToUci(a.sq)), defended_by: x.def.map(a => sqToUci(a.sq)),
        }));
      }
      const verdictCount = S.repeat || 0;
      if (verdictCount >= 3) out.repetition = { count: verdictCount, note: 'perpetual check loses in xiangqi; three-fold repetition is not an automatic draw' };
      return out;
    },
  };

  T.get_legal_moves = {
    description: 'List every legal move for the side to move, in UCI and Chinese notation, with captures and checks. Rules-only; the engine is not consulted, so this says nothing about which move is good.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const pos = displayPos();
      const ms = pos.legalMoves(pos.side).map(m => moveInfo(pos, m));
      agentLog('get_legal_moves', `${ms.length} moves`);
      return { ok: true, side_to_move: SIDE(pos.side), count: ms.length, moves: ms };
    },
  };

  T.make_move = {
    description: 'Play a move on the board for the human side (UCI like "h3e3", or Chinese notation like "炮二平五"). In human-vs-engine mode the engine answers immediately and its reply is included. This is the human\'s game: only move when the human asked you to, and say which move you played.',
    inputSchema: {
      type: 'object', required: ['move'], additionalProperties: false,
      properties: { move: { type: 'string', description: 'UCI (files a-i, ranks 1-10, red at the bottom) or Chinese notation exactly as the move list prints it' } },
    },
    async execute({ move }) {
      if (S.setup) return err('board is in setup mode');
      if (S.over) return err('the game is over', { game_over: S.over.why || S.over.name });
      if (S.cursor >= 0) return err(`the human is browsing the move list (looking at move ${S.cursor + 1}); ask them to return to the live position`);
      if (S.thinking) { await until(() => !S.thinking, 8000); }
      if (S.thinking) return err('the engine is still thinking');
      if (S.mode === 0 && S.pos.side !== S.mySide) return err(`it is ${SIDE(S.pos.side)}'s turn and the human plays ${SIDE(S.mySide)}`);
      const p = parseMove(S.pos, move);
      if (p.error) return err(p.error, { legal_moves_hint: 'call get_legal_moves' });
      const info = moveInfo(S.pos, p.mv);
      const before = S.hist.length;
      const engineReplies = S.mode === 0;
      agentLog('make_move', info.zh);
      doMove(p.mv);
      const out = { ok: true, played: { uci: info.uci, zh: info.zh, captures: info.captures, gives_check: info.gives_check } };
      if (S.over) { out.game_over = { reason: S.over.why || S.over.name }; return out; }
      if (engineReplies) {
        await until(() => S.hist.length >= before + 2 || !!S.over, 9000);
        const r = S.hist[before + 1];
        out.engine_reply = r ? { uci: r.uci, zh: r.zh } : null;
        if (!r) out.note = 'engine reply not yet in; call get_position again';
      }
      out.fen = S.pos.fen();
      out.side_to_move = SIDE(S.pos.side);
      out.in_check = S.pos.inCheck(S.pos.side);
      if (S.over) out.game_over = { reason: S.over.why || S.over.name };
      const ev = S.evals[S.hist.length];
      if (ev !== undefined) out.evaluation_pawns_red_view = +(ev / 100).toFixed(2);
      return out;
    },
  };

  T.show_on_board = {
    description: 'Draw one or more arrows on the board so the human can see what you are talking about (a move, a plan, a threat). Arrows are numbered in order and colored by the side of the piece that moves. This only draws; it does not move anything. Call with clear=true to remove your arrows.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        arrows: { type: 'array', maxItems: 6, description: 'in order; each is a from-square and a to-square in UCI, e.g. {"from":"h3","to":"e3"}',
          items: { type: 'object', required: ['from', 'to'], additionalProperties: false,
            properties: { from: { type: 'string' }, to: { type: 'string' } } } },
        label: { type: 'string', maxLength: 24, description: 'short caption shown under the board, e.g. "我的建议" or "对方的威胁"' },
        clear: { type: 'boolean' },
      },
    },
    async execute({ arrows, label, clear }) {
      if (S.setup) return err('board is in setup mode');
      const pos = displayPos();
      if (clear || !arrows || !arrows.length) {
        view.preview = null; view.arrowSig = '';
        if (S.legend) { S.legend = { ...S.legend }; delete S.legend.preview; delete S.legend.previewTitle; }
        renderLegend(); view.draw(pos);
        return { ok: true, cleared: true };
      }
      const line = [];
      const p = new Position(pos.fen());
      for (const a of arrows) {
        const f = String(a.from || '').toLowerCase(), t = String(a.to || '').toLowerCase();
        if (!isSq(f) || !isSq(t)) return err(`bad square in ${JSON.stringify(a)}`);
        const from = uciToSq(f), to = uciToSq(t);
        const pc = p.board[from];
        if (!pc) return err(`no piece on ${f} at that point of the line`);
        line.push({ from, to, side: pc > 0 ? 1 : -1, zh: `${f}${t}` });
        // label the arrow with real notation when the move is legal in the running line
        const legal = p.legalMoves(pc > 0 ? 1 : -1).find(m => m[0] === from && m[1] === to);
        if (legal) { line[line.length - 1].zh = moveToChinese(p, legal); p.side = pc > 0 ? 1 : -1; p.apply(legal); }
        else { p.board[to] = pc; p.board[from] = 0; }
      }
      view.preview = line;
      S.legend = { ...(S.legend || {}), preview: line, previewTitle: label || 'agent 所指' };
      renderLegend();
      view.arrowSig = 'agent:' + line.map(m => `${m.from}-${m.to}`).join(',');
      view.draw(pos);
      agentLog('show_on_board', line.map(m => m.zh).join(' '));
      return { ok: true, drawn: line.map(m => ({ move: m.zh, side: SIDE(m.side) })), label: label || 'agent 所指' };
    },
  };

  T.set_position = {
    description: 'Put a position on the board from a FEN, including a FEN returned by the app\'s dedicated photo recognizer. The board enters setup mode and runs its rules self-check (piece counts, advisors and elephants on reachable points, pawns not behind their river, kings inside the palace, and kings not facing). Invalid points come back listed so you can fix only those squares with place_pieces. The human must press Confirm to start analysing. Side to move cannot be inferred from a still photo, so ask the human if it is unknown.',
    inputSchema: {
      type: 'object', required: ['fen'], additionalProperties: false,
      properties: {
        fen: { type: 'string', description: 'xiangqi FEN, rank 10 (black back rank) first, uppercase = red. Example start: rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w' },
        side_to_move: { type: 'string', enum: ['red', 'black'] },
      },
    },
    async execute({ fen, side_to_move }) {
      let pos;
      try { pos = new Position(String(fen).trim().split(/\s+/)[0] + ' ' + (side_to_move === 'black' ? 'b' : 'w') + ' - - 0 1'); }
      catch (e) { return err('FEN could not be parsed: ' + (e.message || e)); }
      if (!pos.board.some(Boolean)) return err('FEN has no pieces');
      if (!S.setup) enterSetup(pos);
      const st = S.setup;
      st.pos = pos; st.side = side_to_move ? (side_to_move === 'black' ? -1 : 1) : (sideToMoveHint(pos) || st.side);
      st.pos.side = st.side;
      const iss = issuesOf(pos);
      st.unsure = new Set(iss.flatMap(i => i.squares.map(uciToSq)));
      st.pick = HAND_CHECK;
      renderSetup(); render();
      agentLog('set_position', iss.some(i => i.hard) ? `${iss.filter(i => i.hard).length} 处不合规` : '自检通过');
      return {
        ok: true, fen: st.pos.fen(), board: boardText(st.pos), side_to_move: SIDE(st.side),
        issues: iss, hard_issue_count: iss.filter(i => i.hard).length,
        needs_human_confirmation: true,
        next: iss.some(i => i.hard) ? 'fix the listed squares with place_pieces, then ask the human to confirm' : 'ask the human to check the board and press 确认并开始分析 (Confirm and analyse)',
      };
    },
  };

  T.place_pieces = {
    description: 'In setup mode, change specific points only (put a piece, or clear one). Use it to fix the squares the self-check flagged instead of resending the whole FEN. Returns the updated self-check.',
    inputSchema: {
      type: 'object', required: ['changes'], additionalProperties: false,
      properties: { changes: { type: 'array', minItems: 1, maxItems: 32,
        items: { type: 'object', required: ['square', 'piece'], additionalProperties: false,
          properties: {
            square: { type: 'string', description: 'e.g. e1' },
            piece: { type: 'string', description: 'FEN letter: K A B N R C P for red, k a b n r c p for black, "" (empty string) to clear' },
          } } } },
    },
    async execute({ changes }) {
      if (!S.setup) return err('not in setup mode; call set_position first');
      /* An agent that gets the argument name wrong should be told the shape, not handed
         "changes is not iterable" from the for-of below. Cost: three lines. */
      if (!Array.isArray(changes) || !changes.length)
        return err('"changes" must be a non-empty array of {square, piece}, e.g. ' +
                   '{"changes":[{"square":"h10","piece":""},{"square":"c5","piece":"p"}]}');
      const st = S.setup;
      const LET = { K: K, A: A, B: B, N: N, R: R, C: C, P: P };
      for (const ch of changes) {
        const s = String(ch.square || '').toLowerCase();
        if (!isSq(s)) return err(`bad square ${ch.square}`);
        const raw = String(ch.piece == null ? '' : ch.piece).trim();
        let v = 0;
        if (raw) {
          let letter = null;
          if (/^[KABNRCPkabnrcp]$/.test(raw)) letter = raw;
          else {
            /* Chinese: eight of the fourteen pieces name their side by the character alone
               (帅仕相兵 / 将士象卒); 马车炮 need a 红/黑 prefix. */
            const side = raw[0] === '红' ? 1 : raw[0] === '黑' ? -1 : 0;
            const word = raw.replace(/^[红黑]/, '');
            const hit = Object.entries(PIECE_WORDS).filter(([, w]) => w === word);
            if (hit.length === 1) letter = hit[0][0];
            else if (hit.length === 2 && side) letter = hit.find(([l]) => (l === l.toUpperCase()) === (side > 0))[0];
          }
          if (!letter) return err(`unknown piece "${raw}"; use FEN letters (K A B N R C P / k a b n r c p), or 红马/黑车 style names, or empty string`);
          v = LET[letter.toUpperCase()] * (letter === letter.toUpperCase() ? 1 : -1);
        }
        const sqi = uciToSq(s);
        st.pos.board[sqi] = v;
        st.unsure.delete(sqi);
      }
      st.pos.side = st.side;
      renderSetup(); render();
      const iss = issuesOf(st.pos);
      agentLog('place_pieces', `${changes.length} 处`);
      return { ok: true, fen: st.pos.fen(), board: boardText(st.pos), issues: iss,
               hard_issue_count: iss.filter(i => i.hard).length, needs_human_confirmation: true };
    },
  };

  T.load_game = {
    description: 'Load a whole game (a move list from a book, a website, a video) so it can be stepped through and reviewed. Moves may be UCI or Chinese notation, separated by spaces or commas; they are played from the standard start position and loading stops at the first illegal move, telling you where. If a game is in progress the human is asked to allow the replacement.',
    inputSchema: {
      type: 'object', required: ['moves'], additionalProperties: false,
      properties: { moves: { type: 'string', description: 'e.g. "炮二平五 马8进7 马二进三 车9平8" or "h3e3 b10c8 h1g3 i10h10"' } },
    },
    async execute({ moves }) {
      if (S.setup) return err('board is in setup mode');
      const toks = String(moves || '').split(/[\s,，;；]+/).filter(Boolean);
      if (!toks.length) return err('no moves given');
      // dry run first: nothing on screen changes if the list is garbage
      const p = new Position(START_FEN);
      const played = [];
      let stopped = null;
      for (let i = 0; i < toks.length; i++) {
        const r = parseMove(p, toks[i]);
        if (r.error) { stopped = { index: i, token: toks[i], reason: r.error }; break; }
        played.push({ mv: r.mv, zh: moveToChinese(p, r.mv), uci: moveToUci(r.mv), side: p.side, fenBefore: p.fen() });
        p.apply(r.mv);
      }
      if (!played.length) return err('the first move is already illegal', { stopped_at: stopped });
      if (S.hist.length && !S.over) {
        const okd = await askConfirm({ title: 'Agent 要载入一局棋', body: `当前对局会被替换 (${S.hist.length} 手)。载入 ${played.length} 手${stopped ? ', 第 ' + (stopped.index + 1) + ' 手起不合法, 到那里为止' : ''}。`, ok: '允许' });
        if (!okd) return err('the human declined to replace the current game');
      }
      S.analysisOn = false; $('analyzeBtn').classList.remove('primary');
      setTwoPlayer();
      newGame();
      for (const h of played) {
        S.pos.apply(h.mv);
        S.hist.push({ uci: h.uci, mv: h.mv, zh: h.zh, fenBefore: h.fenBefore, side: h.side });
        view.lastMove = h.mv;
      }
      render();
      const t0 = S.pos.terminal();
      if (t0) onGameOver(t0, S.pos.side);
      agentLog('load_game', `${played.length} 手`);
      return { ok: true, loaded: played.length, moves: played.map((h, i) => ({ n: i + 1, side: SIDE(h.side), zh: h.zh, uci: h.uci })),
               stopped_at: stopped, fen: S.pos.fen(), side_to_move: SIDE(S.pos.side), game_over: S.over ? (S.over.why || S.over.name) : null,
               next: 'review_game is now available' };
    },
  };

  T.new_game = {
    description: 'Start a new human-vs-engine game, optionally choosing the engine level and which side the human plays. If a game is in progress the human is asked to allow it.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        level: { type: 'string', enum: ['入门', '业余', '较强', '全力'], description: 'engine strength: 入门 beginner, 业余 amateur, 较强 strong, 全力 full strength' },
        human_plays: { type: 'string', enum: ['red', 'black'] },
      },
    },
    async execute({ level, human_plays }) {
      if (S.setup) return err('board is in setup mode');
      if (S.hist.length && !S.over) {
        const okd = await askConfirm({ title: 'Agent 要重开一局', body: `当前对局 (${S.hist.length} 手) 会被丢掉。`, ok: '允许' });
        if (!okd) return err('the human declined');
      }
      if (level) {
        const i = LEVELS.findIndex(l => l.name === level);
        if (i >= 0) { S.level = i; $('lvlGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.l === i)); }
      }
      S.mode = 0;
      $('modeGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === '0'));
      $('rowSide').style.display = '';
      if (human_plays) {
        S.mySide = human_plays === 'black' ? -1 : 1;
        $('sideGrp').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.s === S.mySide));
      }
      newGame();
      agentLog('new_game', `${LEVELS[S.level].name} · 人执${S.mySide > 0 ? '红' : '黑'}`);
      if (S.mySide < 0) await until(() => S.hist.length >= 1, 9000);
      return { ok: true, engine_level: LEVELS[S.level].name, human_plays: SIDE(S.mySide), fen: S.pos.fen(),
               side_to_move: SIDE(S.pos.side), engine_opened_with: S.hist.length ? S.hist[0].zh : null };
    },
  };

  T.undo = {
    description: 'Take back the last move (in human-vs-engine mode, the last pair of moves). The human is asked if this would empty a game that started from a set-up position.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (S.setup) return err('board is in setup mode');
      if (!S.hist.length) return err('nothing to undo');
      const n = S.hist.length;
      await undo();
      agentLog('undo', `${n} → ${S.hist.length} 手`);
      return { ok: true, move_count: S.hist.length, fen: S.pos.fen(), side_to_move: SIDE(S.pos.side),
               last_move: S.hist.length ? S.hist[S.hist.length - 1].zh : null };
    },
  };

  T.resign = {
    description: 'Resign the current game on the human\'s behalf. The human is asked to allow it in the page before anything happens.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (S.setup || S.over || !S.hist.length || S.mode !== 0) return err('no live human-vs-engine game to resign');
      const okd = await askConfirm({ title: 'Agent 提议认输', body: '这一局按认输记。悔棋一步就能回来。', ok: '认输' });
      if (!okd) return err('the human declined to resign');
      resign();
      agentLog('resign');
      return { ok: true, game_over: S.over ? (S.over.why || S.over.name) : null };
    },
  };

  T.is_critical_moment = {
    description: 'Ask the engine ONLY whether the current moment is critical (a narrow choice where the best move is much better than the second) or relaxed. It never says which move. This is the "元信息" (meta) hint level made callable; it exists because the human set the hint control to at least 元信息.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (S.setup) return err('board is in setup mode');
      if (!(S.hint >= 1 || S.analysisOn)) return err('hint level is 关');
      if (!eng || !eng.ready) return err('engine not ready');
      const pos = displayPos();
      if (pos.terminal()) return err('game is over in this position');
      if (S.mode === 0 && S.cursor < 0 && pos.side !== S.mySide) return err('it is the engine\'s turn; the hint is for the human\'s moves');
      const fen = pos.fen();
      const res = await eng.analyze(fen, { ms: 700, multipv: 2 });
      if (res.failed) return err('engine failed: ' + res.failed);
      const [a, b] = res.candidates;
      if (!a || !b) return { ok: true, critical: true, text: '只此一手', gap_pawns: null, moves_available: res.candidates.length };
      const gap = (cpOf(a) - cpOf(b)) / 100;
      const critical = gap >= 0.9;
      if (displayPos().fen() === fen) {
        $('anaBody').innerHTML = critical
          ? '<div class="callout hot"><b>着法极窄</b> 此处可行之着不多, 落子前须算清。</div>'
          : '<div class="callout">着法宽松, 前几着相差有限。</div>';
        $('anaMode').textContent = '元信息';
      }
      agentLog('is_critical_moment', critical ? '着法极窄' : '着法宽松');
      return { ok: true, critical, gap_pawns: +gap.toFixed(2),
               text: critical ? '着法极窄: the best move is far better than the second; calculate before moving' : '着法宽松: the top moves are close; several are fine',
               note: 'deliberately no move is named' };
    },
  };

  /* 「我这步行不行」。元信息这一档的另一半: 不说该走哪, 但你说出一步它能判。

     ★ 它和页面上那个输入框调的是 app.js 里同一个 checkMove()。人能得到的判断,
     agent 得到的是同一份。这一档没有任何一方比另一方多知道一点。
     首选是什么不在返回值里, 也没有任何字段能反推出来。 */
  T.check_my_move = {
    description: 'Judge a move the human is considering: is it the engine\'s first choice, playable, soft, or a problem, and how many win-chance points behind the best move it is. It never reveals what the best move is. This is the "元信息" (meta) hint level made callable, and it answers exactly what the box in the analysis panel answers for the human.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', required: ['move'], additionalProperties: false,
      properties: { move: { type: 'string', description: 'UCI like h3e3, or Chinese notation like 炮二平五' } },
    },
    async execute({ move }) {
      if (S.setup) return err('board is in setup mode');
      if (!(S.hint >= 1 || S.analysisOn)) return err('hint level is 关');
      if (!eng || !eng.ready) return err('engine not ready');
      const pos = displayPos();
      if (pos.terminal()) return err('game is over in this position');
      if (S.mode === 0 && S.cursor < 0 && pos.side !== S.mySide) return err('it is the engine\'s turn; this judges the human\'s moves');
      const parsed = parseMove(pos, move);
      if (parsed.error) return err(parsed.error);
      const r = await checkMove(pos, parsed.mv);
      if (r.failed) return err('engine failed: ' + r.failed);
      if (r.gone) return err('the position changed while the engine was thinking; call again');
      const info = moveInfo(pos, parsed.mv);
      agentLog('check_my_move', `${info.zh} · ${r.verdict}`);
      return { ok: true, move: { uci: info.uci, zh: info.zh },
               verdict: r.verdict,
               verdict_en: { '正着': 'best move', '可走': 'playable', '偏软': 'soft', '有问题': 'problem' }[r.verdict],
               points_behind_best: +r.probLoss.toFixed(1),
               scale: 'win-chance points, same scale the review uses: 3 = soft, 8 = mistake, 16 = blunder',
               note: 'the best move is deliberately not named at this hint level' };
    },
  };

  T.analyze_position = {
    description: 'Read the open analysis panel: the engine\'s candidate moves with scores, the principal variation in Chinese notation, the cloud book verdict, and the opponent\'s threat. Available only while the analysis panel is open (the human opened it, or set hints to 全开). Scores are in pawns from the side to move\'s point of view; "mate" is moves to mate.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (S.setup) return err('board is in setup mode');
      if (!S.analysisOn) return err('the analysis panel is closed');
      if (!eng || !eng.ready) return err('engine not ready');
      const pos = displayPos();
      if (pos.terminal()) return err('game is over in this position');
      if (S.mode === 0 && S.cursor < 0 && pos.side !== S.mySide) return err('it is the engine\'s turn; analysis is shown only for the human\'s moves');
      const fen = pos.fen();
      if (!(S.lastAnalysis && S.lastAnalysisFen === fen)) {
        await runAnalysis();
        await until(() => S.lastAnalysis && S.lastAnalysisFen === fen, 12000);
      }
      if (!(S.lastAnalysis && S.lastAnalysisFen === fen)) return err('analysis did not complete (position changed?)');
      const res = S.lastAnalysis;
      const cloud = S.cloud && S.cloud.fen === fen ? S.cloud.data : null;
      const cands = res.candidates.map((c, i) => {
        const cv = cloud && cloud.get(c.uci);
        return {
          rank: i + 1, uci: c.uci, zh: moveToChinese(pos, uciToMove(c.uci)),
          score_pawns: c.mate != null ? null : +(c.score / 100).toFixed(2),
          mate_in: c.mate != null ? c.mate : null,
          line_zh: pvToChinese(pos, c.pv, 6),
          cloud_book: cv ? (cv.rank >= 2 ? '正着 (book-approved)' : cv.rank === 1 ? '可走 (playable)' : null) : null,
        };
      });
      const gap = cands.length > 1 && cands[0].score_pawns != null && cands[1].score_pawns != null ? +(cands[0].score_pawns - cands[1].score_pawns).toFixed(2) : null;
      const th = S.threat && S.threat.fen === fen ? { zh: S.threat.zh, note: 'what the opponent would play if this side passed' } : null;
      agentLog('analyze_position', cands[0] ? cands[0].zh : '');
      return { ok: true, side_to_move: SIDE(pos.side), depth: res.maxDepth, best: cands[0] || null, candidates: cands,
               gap_between_best_two_pawns: gap, opponent_threat: th };
    },
  };

  T.review_game = {
    description: 'Run (or read) the game review: every move graded (妙手 brilliant / 好棋 good / 正着 best / 缓手 inaccuracy / 漏着 mistake / 败着 blunder), the loss in win-chance points, the engine\'s best move where it differed, and for each error the search depth at which it becomes visible ("discoverable depth": low = an oversight anyone could see, high = only deep calculation finds it). Takes 10-60 seconds on first call. Explain the result to the human in words; use show_on_board to point at moves.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (S.setup) return err('board is in setup mode');
      if (S.hist.length < 2) return err('nothing to review');
      if (!(S.over || S.mode === 1 || S.analysisOn)) return err('review is not available during a human-vs-engine game with hints off');
      if (!eng || !eng.ready) return err('engine not ready');
      const stale = !S.review || S.review.plies.length !== S.hist.length;
      if (stale && !S.reviewing) { agentLog('review_game', '复盘中'); await runReview(); }
      else if (S.reviewing) await until(() => !S.reviewing, 120000);
      if (!S.review) return err('review did not run');
      const ps = S.review.plies;
      const mineSide = S.mode === 1 ? null : S.mySide;
      const mine = ps.filter(p => mineSide === null ? true : p.side === mineSide);
      const counts = { 妙手: 0, 好棋: 0, 正着: 0, 缓手: 0, 漏着: 0, 败着: 0 };
      for (const p of mine) { const g = GRADE(p); if (g) counts[g]++; }
      const avg = mine.length ? mine.reduce((a, p) => a + (p.probLoss || 0), 0) / mine.length : 0;
      const clean = mine.filter(p => (p.probLoss || 0) < G_BAD.缓手).length;
      const worst = mine.reduce((a, p) => (p.probLoss || 0) > ((a && a.probLoss) || 0) ? p : a, null);
      const movesOut = ps.map(p => {
        const g = GRADE(p);
        const o = { n: p.i + 1, side: SIDE(p.side), zh: p.zh, uci: p.uci, grade: g,
                    loss_points: +(p.probLoss || 0).toFixed(1) };
        if (p.best && !p.wasTop) o.engine_best = p.best;
        if (p.deep) o.discoverable_depth = p.revealDepth === null ? 'not found within the review budget' : p.revealDepth;
        return o;
      });
      agentLog('review_game', `均亏 ${avg.toFixed(1)} · 无明显损失 ${(mine.length ? clean / mine.length * 100 : 0).toFixed(0)}%`);
      return {
        ok: true,
        graded_side: mineSide === null ? 'both' : SIDE(mineSide),
        summary: {
          moves_graded: mine.length,
          average_loss_points_per_move: +avg.toFixed(1),
          share_without_clear_loss: mine.length ? +(clean / mine.length * 100).toFixed(0) : 0,
          counts,
          worst_move: worst && worst.probLoss ? { n: worst.i + 1, zh: worst.zh, loss_points: +worst.probLoss.toFixed(1), engine_best: worst.best || null, discoverable_depth: worst.revealDepth } : null,
          grading_rule: '缓手 ≥3, 漏着 ≥8, 败着 ≥16 win-chance points lost; 好棋 = best move and the second choice was ≥8 points worse; 妙手 = a 好棋 that a shallow (depth 5-6) search does not find',
          caveat: 'win-chance points come from an uncalibrated logistic of the engine score; they compare moves within one position, they are not a probability of winning',
        },
        moves: movesOut,
      };
    },
  };

  /* ---------- registration ---------- */
  const live = new Map();      // name -> AbortController

  /* The spec unregisters by aborting the signal given at registration. ChatGPT's built-in
     browser documents itself as "a subset of the WebMCP APIs" without saying which subset, so
     when a host also offers unregisterTool(name) we call that too. Both are idempotent. */
  function unregister(mc, name, ac) {
    ac.abort();
    if (typeof mc.unregisterTool === 'function') {
      try { const r = mc.unregisterTool(name); if (r && r.catch) r.catch(() => {}); } catch (e) { /* already gone */ }
    }
  }
  let lastSig = '';
  let syncing = false;

  let dirty = false;
  async function sync() {
    // `view` / `eng` are top-level `let`s in app.js: global lexical bindings, not window properties
    if (typeof S === 'undefined' || typeof view === 'undefined' || !view) return;
    const sig = desired().names.join(',');
    if (sig === lastSig && !dirty) { readout(); return; }
    if (syncing) { dirty = true; return; }   // a sync is in flight; it loops until the state is stable
    syncing = true;
    try {
      const mc = MC();
      for (;;) {
        dirty = false;
        const { names } = desired();
        lastSig = names.join(',');
        for (const [name, ac] of [...live]) if (!names.includes(name)) { unregister(mc, name, ac); live.delete(name); }
        for (const name of names) {
          if (live.has(name)) continue;
          const def = T[name];
          const ac = new AbortController();
          live.set(name, ac);
          const tool = { name, description: def.description, inputSchema: def.inputSchema,
            annotations: def.annotations || { readOnlyHint: false },
            execute: async (input, opts) => {
              /* Backstop for a host that kept a registration we asked it to drop: the
                 boundary is still the boundary. In a spec-conformant browser this branch
                 is unreachable, because the tool would not exist. */
              const now = desired();
              if (!now.names.includes(name))
                return err(`${name} is not available right now: ${now.absent[name] || 'not on screen'}`, { tools_available: now.names });
              try { return await def.execute(input || {}, opts || {}); }
              catch (e) { console.error('agent tool', name, e); return err(String(e && e.message || e)); }
            } };
          try { await mc.registerTool(tool, { signal: ac.signal }); }
          catch (e) {
            /* "already registered": the host ignored an earlier abort. Drop it its way, retry once. */
            if (e && e.name === 'InvalidStateError' && typeof mc.unregisterTool === 'function') {
              try { await mc.unregisterTool(name); await mc.registerTool(tool, { signal: ac.signal }); continue; }
              catch (e2) { e = e2; }
            }
            console.warn('registerTool failed', name, e); live.delete(name);
          }
        }
        if (!dirty && desired().names.join(',') === lastSig) break;
      }
    } finally { syncing = false; }
    readout();
    renderPanel();
  }

  /* One line under the hint control: what the agent can and cannot call right now.
     The boundary is a fact about the page; saying it out loud is the interface. */
  const ZH = { get_position: '看盘', get_legal_moves: '着法', make_move: '走子', show_on_board: '画箭头',
               set_position: '摆局', place_pieces: '改点', load_game: '载入棋谱', new_game: '重开', undo: '悔棋',
               resign: '认输', is_critical_moment: '关键时刻', check_my_move: '这步如何',
               analyze_position: '引擎分析', review_game: '复盘' };
  const EN = { get_position: 'read board', get_legal_moves: 'legal moves', make_move: 'move', show_on_board: 'draw arrows',
               set_position: 'set position', place_pieces: 'fix pieces', load_game: 'load a game', new_game: 'new game',
               undo: 'undo', resign: 'resign', is_critical_moment: 'critical?', check_my_move: 'check my move', analyze_position: 'engine analysis',
               review_game: 'review' };
  /* 工具名给人看的短标签。棋本身不翻, 但工具是界面的一部分, 跟着界面语言走。 */
  const label = n => (window.LANG === 'en' ? (EN[n] || n) : (ZH[n] || n));
  let acPrev = null;
  function readout() {
    const { names, absent } = desired();
    const el = $('agentRead');
    if (el) {
      const no = Object.keys(absent).filter(n => ['is_critical_moment', 'check_my_move', 'analyze_position', 'review_game'].includes(n));
      const T_ = (k, v) => (typeof window.t === 'function' ? window.t(k, v) : k);
      el.innerHTML = (NATIVE ? '' : `<i>${T_('agent.off')} · </i>`) +
        T_('agent.can', { n: `<b>${names.length}</b>` }) + ': ' + names.map(label).join(' · ') +
        (no.length ? `<span class="no"> | ${T_('agent.cannot')}: ${no.map(label).join(' · ')}</span>` : '');
    }
    /* The card next to the hint control. One chip per tool, struck through when it is not
       registered right now, and briefly marked when it has just appeared: the list changing
       is the thing worth watching, and it has to be watchable in the same screenful as the
       control that changes it. */
    const chips = $('agentChips');
    if (!chips) return;
    const en = window.LANG === 'en';
    const host = $('agentHost');
    if (host) {
      host.className = NATIVE ? 'live' : 'shim';
      host.textContent = NATIVE
        ? (en ? `WebMCP live · ${names.length} registered` : `WebMCP 已接入 · 此刻注册 ${names.length} 项`)
        : (en ? `page shim · ${names.length} registered` : `本页模拟 · 此刻注册 ${names.length} 项`);
    }
    chips.innerHTML =
      names.map(n => `<span class="ac-chip${acPrev && acPrev.indexOf(n) < 0 ? ' new' : ''}">${n}</span>`).join('') +
      Object.keys(absent).map(n => `<span class="ac-chip off" title="${String(absent[n]).replace(/["<>]/g, '')}">${n}</span>`).join('');
    acPrev = names.slice();
  }

  /* Footer panel: the live tool list, and a way to call one by hand.
     For a reader without a WebMCP-capable browser this is the only place the boundary is
     visible in full; for a demo it is where the list can be watched changing. */
  function renderPanel() {
    const el = $('agentTools');
    if (!el) return;
    const { names, absent } = desired();
    el.innerHTML = names.map(n => `<div class="tl"><b>${n}</b><span>${T[n].description.replace(/[<>]/g, '')}</span></div>`).join('') +
      Object.entries(absent).map(([n, why]) => `<div class="tl off"><b>${n}</b><span>${window.LANG === 'en' ? 'unavailable' : '不可调'}: ${why.replace(/[<>]/g, '')}</span></div>`).join('');
    const sel = $('agentCallName');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = names.map(n => `<option>${n}</option>`).join('');
      if (names.includes(cur)) sel.value = cur;
    }
    const c = $('agentCount');
    if (c) c.textContent = (typeof window.t === 'function')
      ? window.t('panel.count', { n: names.length, mode: window.t(NATIVE ? 'panel.native' : 'panel.shim') })
      : `${names.length} 项`;
  }

  function bindPanel() {
    const btn = $('agentCallBtn');
    if (!btn) return;
    btn.onclick = async () => {
      const name = $('agentCallName').value;
      let input = {};
      try { input = JSON.parse($('agentCallInput').value || '{}'); }
      catch (e) { $('agentCallOut').textContent = 'input is not JSON'; return; }
      const mc = MC();
      $('agentCallOut').textContent = '…';
      try {
        let r;
        if (typeof mc.getTools === 'function' && typeof mc.executeTool === 'function') {
          const tools = await mc.getTools();
          const t = tools.find(x => x.name === name);
          if (!t) { $('agentCallOut').textContent = `${name} is not registered right now`; return; }
          r = await mc.executeTool(t, input);
        } else {
          /* A host without the in-page getTools/executeTool half of the API (ChatGPT's browser
             documents only the registration half): call the same execute the agent would get. */
          if (!live.has(name)) { $('agentCallOut').textContent = `${name} is not registered right now`; return; }
          r = await T[name].execute(input, { signal: new AbortController().signal });
        }
        $('agentCallOut').textContent = typeof r === 'string' ? (() => { try { return JSON.stringify(JSON.parse(r), null, 1); } catch (e) { return r; } })() : JSON.stringify(r, null, 1);
      } catch (e) { $('agentCallOut').textContent = 'error: ' + (e.message || e); }
    };
    const mc = MC();
    if (mc && mc.addEventListener) mc.addEventListener('toolchange', renderPanel);
  }

  window.agentSync = sync;
  window.__xqAgent = { native: NATIVE, desired, tools: T, live, readout, renderPanel };
  document.addEventListener('DOMContentLoaded', bindPanel);
  if (document.readyState !== 'loading') bindPanel();
  setInterval(sync, 400);
})();
