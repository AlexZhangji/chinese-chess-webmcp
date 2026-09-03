const X = require('../rules.js');
function perft(p, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of p.legalMoves(p.side)) { const c = p.clone(); c.apply(m); n += perft(c, d - 1); }
  return n;
}
const p = new X.Position();
for (let d = 1; d <= 4; d++) console.log('perft', d, '=', perft(p, d));
