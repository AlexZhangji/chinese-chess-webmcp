# 引擎

`pikafish.js` / `pikafish.wasm` 是 **Pikafish** 编译出来的 WebAssembly。
Pikafish 是目前最强的开源中国象棋引擎, 官方**不提供** WASM 构建 (release 里只有
原生二进制), 所以这一份是我们自己编的。

- 上游源码: https://github.com/official-pikafish/Pikafish
- 授权: **GNU General Public License v3**, 全文见本目录 `COPYING.txt`

## 我们改了什么 (GPLv3 要求说明)

**这个二进制不是上游源码的未修改构建。** 我们打了三处补丁, 完整 patch 在
`../pikafish-wasm/pikafish-wasm.patch`, 构建脚本在
`../pikafish-wasm/build_browser.sh`, 理由写在 `../pikafish-wasm/README.md`:

1. `src/uci.h` / `src/uci.cpp` — 把 `UCIEngine::loop()` 拆成 `loop()` 和
   `execute(const std::string&)`。原来一百行 UCI 命令分发焊死在
   `do { getline(std::cin, cmd); ... } while` 里, 而浏览器没有阻塞式 stdin,
   进去就再也出不来。拆开之后两种宿主共用同一份分发逻辑, 原生行为未改变
   (拿打完补丁的源码重编原生二进制, `bench` 与补丁前同为 2,329,099 节点)。
2. `src/main.cpp` — 增加 `__EMSCRIPTEN__` 专用入口, 导出 `pikafish_command`,
   `main()` 初始化完即返回而不进 `loop()`。
3. `wasm/pikafish_shim.js` — Emscripten `--pre-js`, 提供
   `postMessage` / `addMessageListener`。

构建方式本身不改源码, 靠两个命令行变量绕开上游 Makefile 的两处问题
(`clangmajorversion=22`, `RTLIB=compiler-rt`), 原因见构建脚本顶部注释。

★ **`-sMEMORY64=0` 必须同时加在编译侧和链接侧。** 这套 emsdk (6.0.8) 默认会编出
memory64 模块, node 收但浏览器不收 (Chrome 133 才默认支持), 表现是
`CompileError: WebAssembly.instantiate(): invalid memory limits flags 0x7`。
只加链接侧会被 wasm-ld 拒绝, 因为 `.o` 本身就是 wasm64 的。

## 权重

`pikafish.nnue` 取自 https://github.com/official-pikafish/Networks
的 `master-net` release, **51.6MB**。

⚠️ **权重是另一份许可, 写明未经许可不得商业使用** (和程序的 GPLv3 不同)。
自己用没问题; 一旦想开放收费, 得换回 Fairy-Stockfish 那条路 ——
它的象棋 NNUE 是 CC0。

权重文件不进 git (见 `.gitignore` 的 `engine/*.nnue`), 重新获取:

```bash
curl -L -o pikafish.nnue \
  https://github.com/official-pikafish/Networks/releases/download/master-net/pikafish.nnue
```

## 坐标: 这里的行号是 0-9

Pikafish 的 UCI 着法行号从 **0** 开始 (红方底线是 0), 而我们全站和 `rules.js`
用的是 **1-10**。同一手炮二平五, 我们写 `h3e3`, 引擎写 `h2e2`。
转换焊在 `app.js` 顶部的 `toEng` / `fromEng`, 除了 `Engine` 这个类以外
全站只认 1-10。**转错了不会报错**, 引擎照样返回一个合法着法, 只是完全不是那一手。

## 旧引擎

`stockfish.js` / `stockfish.wasm` / `stockfish.worker.js` 是之前用的
**Fairy-Stockfish** (`fairy-stockfish-nnue.wasm@1.1.11`, 未经修改, 同为 GPLv3,
上游 https://github.com/fairy-stockfish/Fairy-Stockfish)。
现在没有被页面引用, 留着是因为它是唯一一条"权重可商用"的退路
(象棋 NNUE 为 CC0, 11MB)。
