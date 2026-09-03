# Public-release audit

This repository was prepared as a clean public release from a separate working copy. No previous Git history was imported; the public repository begins with one initial commit.

Checked for exclusion:

- MiniMax API keys, cloned-voice IDs, raw narration audio, and private account material.
- Local absolute paths, private hostnames, private browser captures, and temporary recording workspaces.
- Git history and the original repository's `.git` directory.
- HyperFrames working files, intermediate renders, raw narration, and temporary captures.

Included intentionally:

- The application source, WebMCP implementation, rules, WASM engine runtime, build notices, tests, and local server.
- The browser-native ONNX photo-recognition pipeline, its two public model files, and pinned browser runtimes. No API key or recognition backend is required.
- The Pikafish NNUE network required by the hosted engine demo, together with its upstream notices.
- The real park-game input and its verified product result under `media/samples/`.
- The reviewed cover under `media/cover.png`; it uses the verified park position and the real engine ranking shown in the corrected demo.
- One reviewed 56-second demo under `media/demo/`; it contains the final mixed narration but no cloned-voice ID, API credential, or local path metadata.

The release contains no previous repository history, API credentials, cloned-voice identifier, personal filesystem paths, private service configuration, or runtime call to a visual language model.
