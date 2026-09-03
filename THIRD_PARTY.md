# Third-party components

| component | where | license | notes |
|---|---|---|---|
| Pikafish (engine source) | `engine/pikafish.js`, `engine/pikafish.wasm`, patches in `pikafish-wasm/` | GPL-3.0 | our own Emscripten build; three source patches are in `pikafish-wasm/pikafish-wasm.patch` as GPL requires. Upstream: https://github.com/official-pikafish/Pikafish |
| Pikafish NNUE network | `engine/pikafish.nnue` (51.6 MB) | **non-commercial** | from https://github.com/official-pikafish/Networks (`master-net`). Terms: legal use only; *no commercial use without permission*; derived weights inherit the same terms. This project is a non-commercial demonstration. |
| Fairy-Stockfish (old engine) | not shipped here | GPL-3.0 / network CC0 | the commercially-clean fallback path (`fairy-stockfish-nnue.wasm` 1.1.11, xiangqi NNUE is CC0); the page does not load it |
| coi-serviceworker v0.1.7 | `coi-serviceworker.js` | MIT | Guido Zuidhof and contributors, https://github.com/gzuidhof/coi-serviceworker |
| LXGW WenKai (subset, 24 glyphs) | `assets/fonts/kai.woff2` | SIL OFL 1.1 | https://github.com/lxgw/LxgwWenKai |
| Noto Serif SC (subset) | `assets/fonts/notoserifsc-*.woff2` | SIL OFL 1.1 | |
| Space Grotesk, Geist Mono, Cinzel (latin subsets) | `assets/fonts/*.woff2` | SIL OFL 1.1 | |
| chessdb.cn cloud book | runtime HTTPS call | public API | when the analysis panel is open the current FEN is sent to `https://www.chessdb.cn/chessdb.php` (`learn=0`). Nothing else leaves the browser. |
| ONNX Runtime Web 1.29.0 | `vendor/onnxruntime/` | MIT | browser ONNX inference, https://github.com/microsoft/onnxruntime |
| OpenCV.js 5.0.0 | `vendor/opencv/` | Apache-2.0 | browser image rectification and preprocessing, https://opencv.org/ |
| Chinese chess board recognition models and inference code | `cvmodel/` | upstream repository does not state a license | RTMPose board-corner model and full-board classifier from https://github.com/TheOne1006/chinese-chess-recognition and https://huggingface.co/spaces/yolo12138/Chinese_Chess_Recognition. Production inference runs inside the browser; uploaded photos are not sent to a model provider. |
