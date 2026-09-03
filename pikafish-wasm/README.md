# Pikafish 的浏览器构建

2026-08-23 做的探路, 当天晚上接进了站里: `engine/pikafish.js` / `pikafish.wasm`
就是这份配方的产物, 页面现在跑的就是它 (Fairy-Stockfish 只剩退路, 没有被加载)。
这个目录放的是"怎么把 Pikafish 编成浏览器能跑的东西": 配方、三处源码补丁
(GPLv3 要求说清楚改了什么)、和一个 `--pre-js` 垫片。下面是当时的探路笔记。

## 为什么要它

Pikafish 是中国象棋这个棋种上公认最强的开源引擎。我们用 Fairy-Stockfish 是因为
它有官方 WASM 包, 而 Pikafish 官方没有 —— 最新 release 只有原生二进制。

两者不是一回事: 搜索实现不同, 网络架构不同, 网络大小差五倍。同一批人训的网
(Fairy 的象棋 NNUE 确实是 Pikafish 团队训的) 不等于同一个引擎。

## 最重要的一条: 这不是移植, 是"跑一下编译"

Pikafish 上游的 `src/Makefile` **已经内建 `wasm32` 和 `wasm32-relaxed-simd`
两个官方 target**。来源是 Stockfish 的 commit `455f6fdf` (2026-06-10), 把 Lichess
维护多年的 Emscripten 补丁正式收进主干, 包括 `nnue/simd.h` 里的 WASM 原生
intrinsic。所以"NNUE 的 AVX2 内联汇编要自己往 WASM SIMD 上搬"这个担心是过时的,
别人两个月前就解决了。

编译本身**不需要 GPU, 不需要 WSL2**。纯 C++ 编译。本 VPS (3.9GB, 2 核) 上
emsdk 装 4 分钟, 首次构建约 20 分钟 (绝大部分是 emscripten 预热自己的 sysroot
缓存), 之后每次重新链接 23-40 秒。

## 构建卡住的两处 (都在 Makefile, 不在代码)

Pikafish 收了源码改动但**没收 CI job**, 所以这条路没人跑过, 两个 bug 露在外面。
两个都不用改文件, 命令行变量覆盖即可 (`build_browser.sh` 里已经写死):

| 位置 | 症状 | 覆盖 |
|---|---|---|
| `src/Makefile:733` | `em++ -dumpversion` 返回 Emscripten 版本 `6.0.8` 而不是底层 clang 的 `22.x`, 于是 `:734` 判定 `6 < 16` 成立, 加上了 clang 17 就删掉的 `-fexperimental-new-pass-manager` | `clangmajorversion=22` |
| `src/Makefile:562` | 非 Darwin / 非 Windows 一律加 `-latomic`, emscripten sysroot 里没有 libatomic | `RTLIB=compiler-rt` |

根因是同一个: `COMP=gcc` 分支处处写了 `ifneq ($(arch),wasm32)` 守卫,
`COMP=clang` 分支一个都没加。

## 源码补丁 (`pikafish-wasm.patch`)

**GPLv3 要求说清楚改了什么。** 三处, 75 行新增 1 行删除
(`git diff --stat` 看着有 150 行是因为一整块代码从 `do{}` 里挪出来降了一级缩进):

1. **`src/uci.cpp` / `src/uci.h`** — 把 `UCIEngine::loop()` 拆成 `loop()` 和
   新增的 `execute(const std::string&)`。原来一百行命令分发焊死在
   `do { getline(std::cin, cmd); ... } while (token != "quit")` 内部, 外部拿不到。
   **浏览器没有阻塞式 stdin**, `loop()` 一进去就再也不出来, 会把页面唯一的线程钉死。
   拆开之后两种宿主共用完全相同的分发逻辑, native 行为一字未变。

2. **`src/main.cpp`** — 加一个 `__EMSCRIPTEN__` 专用入口
   (`pikafish_command(const char*)` → `execute()`), `main()` 初始化完就返回, 不调 `loop()`。
   能这么干是因为这套代码里 UCI 本来就是异步的: `go` 把局面交给线程池就返回,
   结果通过回调走 stdout。引擎对象故意 leak —— 模块活得比 `main()` 长,
   静态析构期拆引擎会和还在跑的搜索线程打架。

3. **`wasm/pikafish_shim.js`** — `--pre-js`, 补上 `postMessage` /
   `addMessageListener` / `removeMessageListener`, 把 `Module.print` 接到 listener
   分发上。**必须是 `--pre-js` 不是 `--post-js`**: `print` 要在 runtime 捕获它之前装好。

## 验证

- **同一 FEN、`go depth 18`、单线程, patched WASM 与未打补丁的原生构建逐字段一致**:
  depth 18/37, score cp 112, **nodes 285,244 相同**, 23 手主变一字不差,
  bestmove 相同。固定深度单线程时搜索是确定的, 节点数一致 = 搜索树一模一样。
- **补丁对 native 是空操作**: 用打完补丁的源码重编原生二进制, `bench` 得
  2,329,099 节点, 和补丁前同一个数。
- **速度**: 单线程 nps 约为原生的 77% (上游自报 78%)。
- 我自己复核过一遍 (不是只看 agent 的报告): 用本站 `app.js` 那套写法
  (`FS.writeFile` 灌权重 → `addMessageListener` → `postMessage`) 驱动,
  起始局面 `go depth 14` 搜出 `bestmove h2e2` (炮二平五), WDL 正常。

**没在真浏览器里验过** —— 这台机禁本地 Chrome 长跑, 测试都在 node 上
(emscripten pthread 走 worker_threads, 和浏览器同一套 SharedArrayBuffer 语义,
但不是同一个运行时)。首次接进页面时要盯一下 COOP/COEP 下 pthread 起不起得来。

## 真要接进来的话, 三个坑

1. ★ **Pikafish 的坐标行号是 0-9, Fairy-Stockfish 是 1-10。**
   同一手棋 Fairy 写 `h3e3`, Pikafish 写 `h2e2` (和 chessdb 云库同一个偏移)。
   不转换的话满盘着法整体错位一行, 而且**不会报错**, 只会安静地全错。
2. **`setoption name UCI_Variant value xiangqi` 要删掉。** 那是 Fairy 的多棋种
   选项, Pikafish 只下象棋, 没这个 option。`MultiPV` / `UCI_ShowWDL` / `Hash` /
   `Threads` / `EvalFile` 都在, 名字一样。
3. **`PTHREAD_POOL_SIZE=12` 是硬上限不是建议值。** emscripten 线程池耗尽后要靠
   回到事件循环才能长新 worker, 而 `pthread_create` 发生在 `postMessage` 的同步
   处理函数里 —— 池子不够不会自动扩容, 会死锁。`Threads` 必须留在 12 以内。

## 真正的决策点是体积, 不是技术

| | 现在 (Fairy-Stockfish) | Pikafish |
|---|---|---|
| wasm | 1.6 MB | **0.77 MB** |
| 权重 | 11 MB | **51.6 MB** |
| 首次下载 | ~13 MB | **~52 MB** |

引擎本体反而更小, 四倍的下载量全在权重上。

许可: Pikafish 程序是 GPLv3 (改动见上, 补丁在本目录);
**它自己的权重是另一份许可, 写明未经许可不得商业使用** —— 自己玩没问题,
一旦想开放收费就只有 Fairy 那条路。
