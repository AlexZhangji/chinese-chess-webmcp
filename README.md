[English](README.md) | [简体中文](README.zh-CN.md)

# Chinese Chess WebMCP: How to Win Grandpa's Respect

*Go deeper, not just wider: turn a park-game photo into an exact board, deep engine analysis, and your best shot at earning Grandpa's respect.*

![A real park photo beside the verified reconstructed board](media/cover.png)

Chinese Chess WebMCP is a bilingual Chinese chess app with a real engine in the browser, dedicated photo-to-board recognition, and native WebMCP tools that let an AI work with exact game state instead of guessing from pixels.

## Demo

The demo follows one real park position through the complete workflow: photo, dedicated board recognition, human-verifiable setup, ranked engine moves, and an explanation adapted to the player's question.

[Watch the corrected 56-second demo](media/demo/chinese-chess-webmcp-demo.mp4)

[Watch the latest demo on YouTube](https://youtu.be/d60A0dA97Pw)

[Open the browser preview](https://alexzhangji.github.io/chinese-chess-webmcp/?lang=en)

The GitHub Pages build is the complete app. The board recognizer, perspective correction, engine, and WebMCP layer all run in the browser. No recognition server or API key is required.

## Agent quick start

1. Open the [live app](https://alexzhangji.github.io/chinese-chess-webmcp/?lang=en) in a WebMCP-compatible browser.
2. Call `get_position` first. Its response describes the exact board and the tools currently available to you.
3. Use `tools_available` as the live capability boundary. Hint settings, setup mode, and engine readiness intentionally change that list.
4. To try photo recognition, open the [included park-game photo](https://alexzhangji.github.io/chinese-chess-webmcp/media/samples/park-game.png), then ask the human to drop, paste, or open it in the app. The human confirms the reconstructed board and side to move before analysis.
5. When `analyze_position` is available, use its structured candidates and continuation to answer the person's actual question. You can also use `show_on_board` to make the explanation visible on the board.

### Where an agent finds the data

| Need | Source |
| --- | --- |
| Current board, FEN, turn, history, and capability boundary | Call `get_position`. |
| Legal moves | Call `get_legal_moves`. |
| Ranked moves, scores, continuation, and threats | Call `analyze_position` when listed in `tools_available`. |
| Sample photos and verified screenshots | `media/samples/`; URLs are also returned by `get_position`. |
| Photo-recognition weights | `cvmodel/hf-space/onnx/`. |
| Browser engine and NNUE weight | `engine/`. |
| Exact sample ground truth | `tests/photo_recognition_e2e.py`. |

There is no hidden application database or recognition backend. Live game state is owned by the page, and the callable view of that state comes from WebMCP.

## What runs where

| Capability | Runtime | Network behavior |
| --- | --- | --- |
| Photo recognition | Browser: RTMPose ONNX, full-board ONNX classifier, ONNX Runtime Web, and OpenCV.js | The photo stays in the browser. |
| Position validation | Browser: the same `rules.js` used by setup mode and WebMCP | No network request. |
| Deep analysis | Browser: Pikafish WebAssembly with its NNUE network | Engine search is local. |
| Agent access | Browser: native `document.modelContext.registerTool` registration | The compatible host calls page tools directly. |
| Cloud opening data | Optional `chessdb.cn` lookup when analysis or book data is enabled | Sends the position FEN, never the photo. |

## Why WebMCP fits

Many agent integrations solve a breadth problem: search more rows, more pages, or more records. This project explores the complementary depth problem.

A screenshot does not reliably give an agent every piece, legal move, engine score, principal variation, or threat. This page owns that deeper state. Its dedicated recognizer turns a real photo into a checked board, Pikafish searches the position inside the browser, and WebMCP exposes the exact results in structured form.

That lets the AI do more than repeat one best move. It can coach patiently, compare alternatives, explain the best move for one selected piece, validate a candidate move, or draw a plan directly on the board. The page supplies exact state and computation. The AI adapts them to the person.

## Photo-to-board pipeline

The photo path does not use a visual language model and does not send the image to a model provider.

1. The user opens or pastes a Chinese chess photo in the page.
2. A dedicated RTMPose ONNX model finds the four board corners through ONNX Runtime Web.
3. OpenCV.js rectifies the perspective into a straight 10 by 9 board.
4. A dedicated full-board ONNX classifier labels all 90 intersections and returns per-point confidence, also inside the browser.
5. The same Xiangqi rules implementation checks piece counts, palaces, reachable advisors and elephants, pawn constraints, and facing kings.
6. The original photo stays beside the reconstructed board for human verification. Uncertain or invalid points are highlighted instead of silently accepted.
7. After the human confirms whose turn it is, the same position is available to the engine and to WebMCP.

If a correction fallback is added later, its role is intentionally narrow: it should receive the ONNX result and only inspect low-confidence or rule-conflicting points. It must not regenerate the entire board from scratch, and the corrected result must pass the same rules check.

The included park sample is pinned by an end-to-end regression test to this verified FEN:

```text
3akab2/3n3r1/1c1Rb1n1c/4p1p1p/2p6/r3P1P2/2P5P/N1C1C1N2/9/1RBAKAB2 w - - 0 1
```

For that position, the verified analysis selects `炮七平六` (`c3d3`) at about `+3.4`. A depth-17 reference run scored it `+3.36`; live time-based searches can vary slightly while preserving the same move.

## Real WebMCP behavior

On a compatible host, the page registers real tools with `document.modelContext.registerTool`. The registry is dynamic: it mirrors what the human is allowed to see or do at that moment, and each execution checks the same boundary again.

The visible tool panel is a development fallback for ordinary browsers. It exercises the same contracts, but it does not pretend that every browser has native WebMCP.

| Tool | Capability |
| --- | --- |
| `get_position` | Exact board, FEN, side to move, move list, evaluation, and current tool boundary. |
| `get_legal_moves` | All legal moves in UCI and Chinese notation, with captures and checks. |
| `make_move` | Play a requested move and receive the engine reply when active. |
| `show_on_board` | Draw numbered arrows and a short caption on the real board. |
| `set_position` | Enter setup mode from a FEN and run the page's position checks. |
| `place_pieces` | Correct selected intersections and rerun validation. |
| `load_game` | Load a move list from the standard starting position. |
| `new_game`, `undo`, `resign` | Control a game within the same UI permissions as the human. |
| `is_critical_moment`, `check_my_move` | Offer gated coaching without automatically revealing the best move. |
| `analyze_position` | Return candidates, scores, principal variation, book verdict, and threat. |
| `review_game` | Grade a loaded or completed game with discoverable search depth. |

Engine-backed tools remain absent until the engine is ready. Hint settings intentionally gate advice, so an agent can coach around a position without giving away more than the person requested.

## Run locally

The ONNX models and browser runtimes are included. Photo recognition is CPU-only, stays on the device, and requires no API key or Python package installation.

Windows PowerShell:

```powershell
py -3 serve.py 8794
```

macOS or Linux:

```bash
python3 serve.py 8794
```

Open `http://127.0.0.1:8794/?lang=en`. Do not open `index.html` through `file://`.

The included server provides:

- COOP and COEP headers required by the multi-threaded Pikafish WebAssembly build.
- An optional Python `/api/board` reference path for recognition regression testing and batch labeling. The product upload flow does not depend on it.

## Browser and deployment requirements

- A current browser with WebAssembly. The included isolation helper enables the engine's threaded build on static hosts that support service workers.
- Native WebMCP support for direct agent tool calls. Ordinary browsers can use the visible compatibility panel for contract testing.

GitHub Pages hosts the complete static application. `browser-cv.js` runs the same two ONNX weights and mirrors the reference Python/OpenCV preprocessing in ONNX Runtime Web and OpenCV.js. The uploaded image never leaves the browser.

## Tests

Run the JavaScript checks:

```bash
node tests/t.js
node tests/globals.js
```

The browser upload path has also been exercised in headless Chrome against the real park photo. For exact parity testing against the optional Python reference implementation:

```powershell
py -3.10 -m venv cvmodel\.venv
cvmodel\.venv\Scripts\python.exe -m pip install -r requirements.txt
cvmodel\.venv\Scripts\python.exe tests\photo_recognition_e2e.py
```

The photo regression uses the real sample under `media/samples/park-game.png` and fails unless the complete recognized FEN matches exactly.

## Language and notation

Open `?lang=en` for English or `?lang=zh` for Chinese. Chess pieces and Chinese move notation remain Chinese because they are the subject of the app. Tool responses include UCI coordinates where useful.

## Project layout

- `index.html`, `app.js`, `rules.js`, `webmcp.js`, `i18n.js`: app and WebMCP implementation.
- `browser-cv.js`: production browser recognition pipeline, orientation selection, confidence handling, and rules check.
- `cvmodel/`: the two ONNX weights plus the optional Python reference implementation.
- `vendor/`: pinned ONNX Runtime Web and OpenCV.js browser runtimes.
- `tools/board_cv.py`: optional Python recognition adapter used by regression and labeling tools.
- `engine/`: Pikafish WebAssembly runtime and included NNUE network.
- `tests/`: rules, WebMCP contract, and real-photo end-to-end regression tests.
- `media/`: verified sample assets and demo video.

## License and notices

Application code is GPL-3.0. Pikafish source and the browser build follow their upstream notices. The board-recognition source repository does not state a license. See [`LICENSE`](LICENSE), [`THIRD_PARTY.md`](THIRD_PARTY.md), and the notices under `engine/` before redistribution.
