#!/usr/bin/env node
/* 局面自检的命令行入口, 给 serve.py 的识别端点用。

   为什么走 node 而不是在 Python 里重写一遍: 那套约束 (仕 5 个点 / 相 7 个点 /
   兵过河前不能换列 / 双王照面) 是这个功能的**判据本身**, 两份实现迟早会分叉,
   而分叉的那一天前端说合法后端说不合法, 没人知道该信谁。
   起一个 node 进程五十毫秒, 比一份影子实现便宜。

   stdin  {"fen": "..."}
   stdout {"issues":[{code,msg,sqs,hard}], "hint": 1|-1|null, "fen": "规范化后的"}   */

const { Position, positionIssues, sideToMoveHint, sqToUci } = require('../rules.js');

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const { fen } = JSON.parse(raw);
    const pos = new Position(fen);
    const issues = positionIssues(pos).map(i => ({ ...i, at: i.sqs.map(sqToUci) }));
    process.stdout.write(JSON.stringify({ issues, hint: sideToMoveHint(pos), fen: pos.fen() }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && (e.message || e)) }));
    process.exitCode = 1;
  }
});
