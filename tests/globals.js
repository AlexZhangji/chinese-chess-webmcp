/* 三个脚本共用一个全局作用域, 重名的顶层 const/let/class 会让页面整个死掉。

   为什么需要这条测试:
   `rules.js` / `levels.js` / `app.js` 在 index.html 里是三个普通 <script>,
   顶层的 `const` 全部落在同一个词法环境。任意两个文件声明同名, 浏览器直接
   `Identifier 'x' has already been declared`, **整个 app.js 一行都不执行** ——
   页面只剩一块空白, 而 `node tests/t.js` 一条都不会挂, 因为 node 那边是
   require, 每个文件有自己的模块作用域, 根本看不到这个冲突。

   2026-08-23 一天之内踩了两次 (posKey, mateScore), 两次都是浏览器打开才发现的。
   所以把它变成一条能自动跑的检查, 而不是靠记性。

   用法: node tests/globals.js
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 顺序和 index.html 里的 <script> 顺序一致
const FILES = ['rules.js', 'levels.js', 'app.js', 'webmcp.js'];

/* 只找**顶层**声明: 行首没有缩进的 const / let / var / function / class。
   这是个粗糙的判据, 但对这个代码库成立 (顶层声明一律顶格写),
   而且宁可多报也不要漏报 —— 漏报的代价是一个白屏。 */
const DECL = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/;

const seen = new Map();     // 名字 -> 第一次出现的文件
const dupes = [];

for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    const m = DECL.exec(line);
    if (!m) return;
    const name = m[1] || m[2] || m[3];
    if (seen.has(name)) {
      dupes.push(`${name}  —  ${seen.get(name)} 和 ${f}:${i + 1}`);
    } else {
      seen.set(name, `${f}:${i + 1}`);
    }
  });
}

if (dupes.length) {
  console.error('顶层名字在多个脚本里重复声明, 浏览器会直接拒绝执行:\n');
  for (const d of dupes) console.error('  ' + d);
  console.error('\n三个文件共用一个全局作用域。删掉其中一份, 或者改名。');
  process.exit(1);
}

console.log(`${FILES.length} 个脚本, ${seen.size} 个顶层名字, 无重复`);
