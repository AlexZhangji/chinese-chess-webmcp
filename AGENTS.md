# Agent guide

## What this project is

Chinese Chess WebMCP is a bilingual browser app that exposes exact Chinese chess state and actions through native WebMCP tools. Its dedicated ONNX photo recognizer, position validation, and Pikafish engine all run in the browser. The photo path does not use a visual language model.

Live app: https://alexzhangji.github.io/chinese-chess-webmcp/?lang=en

## First interaction

1. Call `get_position` first.
2. Treat `tools_available` as the current capability boundary. Do not assume every registered tool is currently allowed.
3. Respect the human's hint level and do not play a move unless requested.
4. Use `show_on_board` when a visual arrow makes an explanation clearer.

## Photo sample

Bundled image: `media/samples/park-game.png`

Verified FEN:

```text
3akab2/3n3r1/1c1Rb1n1c/4p1p1p/2p6/r3P1P2/2P5P/N1C1C1N2/9/1RBAKAB2 w - - 0 1
```

Ask the human to open, paste, or drop the image into the page. The browser recognizer reconstructs the board and highlights uncertain points. The human must confirm the board and side to move before engine analysis. Do not infer whose turn it is from a still photo.

## Local verification

Run `py -3 serve.py 8794`, then open `http://127.0.0.1:8794/?lang=en`.

Use `node tests/t.js` and `node tests/globals.js` for the fast JavaScript checks. The reference photo regression is `py -3 tests/photo_recognition_e2e.py` and requires the local Python recognition dependencies.
