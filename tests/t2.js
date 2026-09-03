const X = require('../rules.js');
const p = new X.Position();
const byPiece = {};
for (const m of p.legalMoves(1)) {
  const t = Math.abs(p.board[m[0]]);
  const key = X.NAME_RED[t] + '@' + X.sqToUci(m[0]);
  (byPiece[key] = byPiece[key] || []).push(X.sqToUci(m[1]));
}
for (const k of Object.keys(byPiece)) console.log(k.padEnd(10), byPiece[k].length, byPiece[k].join(' '));
console.log('total', p.legalMoves(1).length);
