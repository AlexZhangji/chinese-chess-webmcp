#!/bin/bash
# Pikafish -> WebAssembly, shaped like fairy-stockfish-nnue.wasm.
# Verified working 2026-08-23 on this VPS (emsdk 6.0.8, node 24).
#
# ---------------------------------------------------------------------------
# Makefile workarounds (no file edits needed -- both are command-line overrides)
#
#   clangmajorversion=22   src/Makefile:733 runs `$(CXX) -dumpversion` to detect
#                          clang. em++ answers with the EMSCRIPTEN version
#                          (6.0.8), not the underlying clang (22.x), so the
#                          `< 16` test at :734 passes and it appends
#                          -fexperimental-new-pass-manager, removed in clang 17.
#                          -> "clang++: error: unknown argument"
#
#   RTLIB=compiler-rt      src/Makefile:562-563 appends -latomic on any
#                          non-Darwin non-Windows host; the emscripten sysroot
#                          has no libatomic.
#                          -> "wasm-ld: error: unable to find library -latomic"
#                          RTLIB is referenced at exactly one place (:562), so
#                          setting it suppresses -latomic and nothing else.
#
# Root cause of both: the Makefile's COMP=gcc branch carries `ifneq
# ($(arch),wasm32)` guards that its COMP=clang branch never got. (-m64 leaks in
# from :574 too, but em++ silently accepts it.)
#
# ---------------------------------------------------------------------------
# Source changes (GPLv3 -- these are ours, see the report):
#   src/uci.h, src/uci.cpp  split UCIEngine::loop() into loop() + execute()
#   src/main.cpp            __EMSCRIPTEN__ entry point exporting pikafish_command
#   wasm/pikafish_shim.js   --pre-js providing postMessage/addMessageListener
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
cd "$ROOT/pikafish/src"

[ -f pikafish.nnue ] || curl -skL --max-time 380 -o pikafish.nnue \
  "https://github.com/official-pikafish/Networks/releases/download/master-net/pikafish.nnue"

# PTHREAD_POOL_SIZE must cover the largest "setoption name Threads" the host
# will ask for. Emscripten can spawn workers past the pool, but only by
# returning to the event loop -- and pthread_create here is called from a
# postMessage() handler, so an undersized pool deadlocks instead of growing.
# -sMEMORY64=0 is NOT optional. This emsdk (6.0.8) emits a memory64 module by
# default for this flag combination -- the memory import comes out with limits
# flags 0x7 (has_max | shared | memory64). node 24 accepts that; browsers before
# Chrome 133 reject it outright with
#   CompileError: WebAssembly.instantiate(): invalid memory limits flags 0x7
# which is what the site hit on Chrome 132. A xiangqi engine has no use for a
# >4GB address space anyway, and memory64 costs speed on every pointer.
LD="-sMEMORY64=0 \
    -sMODULARIZE=1 -sEXPORT_NAME=Pikafish \
    -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,callMain \
    -sEXPORTED_FUNCTIONS=_main,_pikafish_command,_malloc,_free \
    -sPTHREAD_POOL_SIZE=12 \
    -sEXIT_RUNTIME=0 \
    --pre-js $ROOT/pikafish/wasm/pikafish_shim.js"

# MEMORY64=0 has to be on the COMPILE side too, not just the link. This emsdk
# compiles wasm64 objects by default here, and wasm-ld then refuses to mix them
# with a wasm32 link ("must specify -mwasm64 to process wasm64 object files").
# So objects from an earlier build must be thrown away, not reused.
make -j2 objclean >/dev/null 2>&1 || true
rm -f pikafish.js pikafish.wasm
make -j2 build \
  ARCH=wasm32 COMP=clang COMPCXX=em++ \
  clangmajorversion=22 RTLIB=compiler-rt \
  EXTRACXXFLAGS="-sMEMORY64=0" \
  EXTRALDFLAGS="$LD"

ls -la pikafish.js pikafish.wasm
