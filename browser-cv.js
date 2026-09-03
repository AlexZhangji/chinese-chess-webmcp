/* Browser-side Xiangqi photo recognition.

   This is a direct port of cvmodel/run_cv.py and its OpenCV preprocessing:
   RTMPose board corners -> perspective rectification -> 90-point classifier.
   Both ONNX models and every image operation run locally in the browser. */
(function () {
  'use strict';

  const ROOT = 'cvmodel/hf-space/onnx/';
  const POSE_MODEL = ROOT + 'pose/4_v6-0301.onnx';
  const CLASSIFIER_MODEL = ROOT + 'layout_recognition/nano_v3-0319.onnx';
  const LABELS = ['.', 'x', 'K', 'A', 'B', 'N', 'R', 'C', 'P',
                  'k', 'a', 'b', 'n', 'r', 'c', 'p'];
  const MEAN = [123.675, 116.28, 103.53];
  const STD = [58.395, 57.12, 57.375];
  const LOW_CONF = 0.5;

  let runtimePromise = null;
  let sessionsPromise = null;

  function deleteAll(...items) {
    for (const item of items) if (item && typeof item.delete === 'function') item.delete();
  }

  async function getCv() {
    let module = window.cv;
    if (!module) throw new Error('OpenCV.js did not load');
    if (typeof module.then === 'function') module = await module;
    if (module.Mat) return module;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV.js initialization timed out')), 30000);
      module.onRuntimeInitialized = () => { clearTimeout(timer); resolve(); };
    });
    return module;
  }

  async function getRuntime() {
    if (!runtimePromise) runtimePromise = (async () => {
      if (!window.ort) throw new Error('ONNX Runtime Web did not load');
      ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime/', document.baseURI).href;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const cv = await getCv();
      return { cv, ort: window.ort };
    })();
    return runtimePromise;
  }

  async function getSessions() {
    if (!sessionsPromise) sessionsPromise = (async () => {
      const { ort } = await getRuntime();
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [pose, classifier] = await Promise.all([
        ort.InferenceSession.create(POSE_MODEL, opts),
        ort.InferenceSession.create(CLASSIFIER_MODEL, opts),
      ]);
      return { pose, classifier };
    })();
    return sessionsPromise;
  }

  function normalizedTensor(mat, width, height) {
    if (mat.cols !== width || mat.rows !== height || mat.channels() !== 3) {
      throw new Error(`Unexpected image tensor shape ${mat.cols}x${mat.rows}x${mat.channels()}`);
    }
    const pixels = mat.data;
    const plane = width * height;
    const data = new Float32Array(plane * 3);
    for (let i = 0, p = 0; i < plane; i++, p += 3) {
      data[i] = (pixels[p] - MEAN[0]) / STD[0];
      data[plane + i] = (pixels[p + 1] - MEAN[1]) / STD[1];
      data[plane * 2 + i] = (pixels[p + 2] - MEAN[2]) / STD[2];
    }
    return new ort.Tensor('float32', data, [1, 3, height, width]);
  }

  function affinePoints(rows, cols) {
    // Preserve the upstream implementation exactly. It assigns shape[:2] to
    // width,height, so rows drive x and cols drive y.
    const center = [rows / 2, cols / 2];
    const paddedW = rows * 1.25;
    const paddedH = cols * 1.25;
    const scale = Math.max(paddedW, paddedH);
    const src = [
      center[0], center[1],
      center[0] - scale / 2, center[1],
      center[0] - scale / 2, center[1] + scale / 2,
    ];
    const dst = [128, 128, 0, 128, 0, 256];
    return { src, dst };
  }

  function applyAffine(point, matrix) {
    const m = matrix.data64F.length ? matrix.data64F : matrix.data32F;
    return [m[0] * point[0] + m[1] * point[1] + m[2],
            m[3] * point[0] + m[4] * point[1] + m[5]];
  }

  async function predictCorners(rgb, cv, pose) {
    const { src, dst } = affinePoints(rgb.rows, rgb.cols);
    const srcTri = cv.matFromArray(3, 1, cv.CV_32FC2, src);
    const dstTri = cv.matFromArray(3, 1, cv.CV_32FC2, dst);
    const warp = cv.getAffineTransform(srcTri, dstTri);
    const inv = cv.getAffineTransform(dstTri, srcTri);
    const input = new cv.Mat();
    try {
      cv.warpAffine(rgb, input, warp, new cv.Size(256, 256), cv.INTER_LINEAR,
                    cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      const tensor = normalizedTensor(input, 256, 256);
      const out = await pose.run({ [pose.inputNames[0]]: tensor });
      const simccX = out.simcc_x || out[pose.outputNames[0]];
      const simccY = out.simcc_y || out[pose.outputNames[1]];
      const xs = simccX.data, ys = simccY.data;
      const xBins = simccX.dims[2], yBins = simccY.dims[2];
      const count = simccX.dims[1];
      const keypoints = [], scores = [];
      for (let k = 0; k < count; k++) {
        let xi = 0, yi = 0, xv = -Infinity, yv = -Infinity;
        for (let i = 0; i < xBins; i++) {
          const v = xs[k * xBins + i];
          if (v > xv) { xv = v; xi = i; }
        }
        for (let i = 0; i < yBins; i++) {
          const v = ys[k * yBins + i];
          if (v > yv) { yv = v; yi = i; }
        }
        keypoints.push(applyAffine([xi / 2, yi / 2], inv));
        scores.push(xv * yv);
      }
      return { keypoints, scores };
    } finally {
      deleteAll(srcTri, dstTri, warp, inv, input);
    }
  }

  function rectify(rgb, keypoints, cv) {
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, keypoints.flat());
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2,
      [50, 50, 400, 50, 50, 450, 400, 450]);
    const matrix = cv.getPerspectiveTransform(src, dst);
    const board = new cv.Mat();
    try {
      cv.warpPerspective(rgb, board, matrix, new cv.Size(450, 500), cv.INTER_LINEAR,
                         cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      return board.clone();
    } finally {
      deleteAll(src, dst, matrix, board);
    }
  }

  async function classify(rgb, keypoints, cv, classifier) {
    const board = rectify(rgb, keypoints, cv);
    const cropped = board.roi(new cv.Rect(25, 25, 400, 450));
    const resized = new cv.Mat();
    try {
      cv.resize(cropped, resized, new cv.Size(280, 315), 0, 0, cv.INTER_LINEAR);
      const tensor = normalizedTensor(resized, 280, 315);
      const out = await classifier.run({ [classifier.inputNames[0]]: tensor });
      const result = out.output || out[classifier.outputNames[0]];
      const logits = result.data;
      const labels = [], scores = [];
      for (let point = 0; point < 90; point++) {
        let best = 0, value = -Infinity;
        for (let cls = 0; cls < 16; cls++) {
          const v = logits[point * 16 + cls];
          if (v > value) { value = v; best = cls; }
        }
        labels.push(LABELS[best]);
        scores.push(value);
      }
      return { labels, scores };
    } finally {
      deleteAll(board, cropped, resized);
    }
  }

  function normalizedView(rgb, cv) {
    const lab = new cv.Mat();
    const channels = new cv.MatVector();
    const merged = new cv.Mat();
    const output = new cv.Mat();
    let clahe = null;
    try {
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      cv.split(lab, channels);
      clahe = new cv.CLAHE(1.5, new cv.Size(8, 8));
      const equalized = new cv.Mat();
      clahe.apply(channels.get(0), equalized);
      const rebuilt = new cv.MatVector();
      rebuilt.push_back(equalized);
      rebuilt.push_back(channels.get(1));
      rebuilt.push_back(channels.get(2));
      cv.merge(rebuilt, merged);
      cv.cvtColor(merged, output, cv.COLOR_Lab2RGB);
      deleteAll(equalized, rebuilt);
      return output.clone();
    } finally {
      deleteAll(lab, channels, merged, output, clahe);
    }
  }

  function cellsToFen(cells) {
    const rows = [];
    for (let r = 0; r < 10; r++) {
      let row = '', empty = 0;
      for (const ch of cells.slice(r * 9, r * 9 + 9)) {
        if (ch === '.') { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += ch;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function bestOrientation(rawCells) {
    const candidates = [
      { orientation: 'red_bottom', cells: rawCells.slice() },
      { orientation: 'red_top', cells: rawCells.slice().reverse() },
    ];
    for (const candidate of candidates) {
      candidate.fen = cellsToFen(candidate.cells);
      candidate.pos = new Position(candidate.fen + ' w - - 0 1');
      candidate.issues = positionIssues(candidate.pos);
      candidate.hard = candidate.issues.filter(issue => issue.hard).length;
    }
    return candidates[0].hard <= candidates[1].hard ? candidates[0] : candidates[1];
  }

  async function imageFromDataUrl(dataUrl) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = dataUrl;
    });
    return img;
  }

  async function recognize(dataUrl) {
    const started = performance.now();
    const [{ cv }, { pose, classifier }, image] = await Promise.all([
      getRuntime(), getSessions(), imageFromDataUrl(dataUrl),
    ]);
    const rgba = cv.imread(image);
    const rgb = new cv.Mat();
    let normalized = null;
    try {
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      const corners = await predictCorners(rgb, cv, pose);
      if (corners.keypoints.length !== 4 || Math.min(...corners.scores) < 0.05) {
        throw new Error('Board corners were not found');
      }
      const primary = await classify(rgb, corners.keypoints, cv, classifier);
      normalized = normalizedView(rgb, cv);
      const secondary = await classify(normalized, corners.keypoints, cv, classifier);
      const disagreement = [];
      for (let i = 0; i < 90; i++) if (primary.labels[i] !== secondary.labels[i]) disagreement.push(i);

      const best = bestOrientation(primary.labels);
      const rotateIndex = i => best.orientation === 'red_top' ? 89 - i : i;
      const uncertain = new Set(disagreement.map(rotateIndex));
      primary.labels.forEach((label, i) => { if (label === 'x') uncertain.add(rotateIndex(i)); });
      primary.scores.forEach((score, i) => { if (score < LOW_CONF) uncertain.add(rotateIndex(i)); });
      best.issues.forEach(issue => (issue.sqs || []).forEach(sq => uncertain.add(sq)));

      const blackY = (corners.keypoints[0][1] + corners.keypoints[1][1]) / 2;
      const redY = (corners.keypoints[2][1] + corners.keypoints[3][1]) / 2;
      let photoOrientation = redY < blackY ? 'red_top' : 'red_bottom';
      if (best.orientation === 'red_top') {
        photoOrientation = photoOrientation === 'red_top' ? 'red_bottom' : 'red_top';
      }
      return {
        ok: true,
        engine: 'browser-cv',
        fen: best.fen + ' w - - 0 1',
        orientation: best.orientation,
        photo_orientation: photoOrientation,
        clean: best.hard === 0,
        issues: best.issues,
        shape_problems: [],
        uncertain: [...uncertain].sort((a, b) => a - b),
        hint_side: sideToMoveHint(best.pos),
        note: '',
        attempts: 1,
        model: 'chinese-chess-recognition (ONNX, in browser)',
        ms: Math.round(performance.now() - started),
        cost: 0,
        keypoints: corners.keypoints,
        keypoint_scores: corners.scores,
      };
    } finally {
      deleteAll(rgba, rgb, normalized);
    }
  }

  window.XiangqiBrowserCV = { recognize, ready: getSessions };
})();
