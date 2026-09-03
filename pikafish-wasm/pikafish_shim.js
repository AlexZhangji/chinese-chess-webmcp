// Emscripten --pre-js shim: gives the Pikafish module the same message-passing
// surface that fairy-stockfish-nnue.wasm exposes, so an existing host can drive
// it without changing its engine wrapper:
//
//     const sf = await Pikafish({ wasmBinary, locateFile });
//     sf.FS.writeFile('/pikafish.nnue', bytes);
//     sf.addMessageListener(line => ...);
//     sf.postMessage('uci');
//
// Runs as --pre-js (not --post-js) because it has to install Module.print
// before the runtime captures it. Module.ccall is referenced only from inside
// postMessage(), which is not called until after the runtime is up.
(function () {
  var listeners = [];

  // Chain rather than clobber: a host may legitimately pass its own print.
  var chained = (typeof Module !== 'undefined' && Module['print']) || null;

  function dispatch(line) {
    if (chained) {
      try { chained(line); } catch (e) { /* a bad host listener must not kill the engine */ }
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](line); } catch (e) { /* ditto */ }
    }
  }

  Module['print'] = dispatch;
  // Engine diagnostics (and emscripten's own warnings) also carry UCI-relevant
  // text in some builds; surface them the same way rather than swallowing them.
  Module['printErr'] = dispatch;

  Module['addMessageListener'] = function (fn) {
    listeners.push(fn);
  };

  Module['removeMessageListener'] = function (fn) {
    var i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };

  // One UCI command per call. Synchronous by design: every UCI command in this
  // engine either completes immediately or hands work to the thread pool, so
  // this returns without blocking the caller's event loop.
  Module['postMessage'] = function (cmd) {
    Module['ccall']('pikafish_command', null, ['string'], [String(cmd)]);
  };

  // Alias used by some hosts.
  Module['uci'] = Module['postMessage'];
})();
