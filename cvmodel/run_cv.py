#!/usr/bin/env python3
"""Run the dedicated Xiangqi board detector and classifier.

This is intentionally local ONNX inference. It does not call a VLM or send the
photo over the network.
"""
from __future__ import annotations

import os
import sys

import cv2
import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SPACE = os.path.join(HERE, 'hf-space')
sys.path.insert(0, SPACE)

from core.chessboard_detector import ChessboardDetector  # noqa: E402


POSE_MODEL = os.path.join(SPACE, 'onnx', 'pose', '4_v6-0301.onnx')
CLASSIFIER_MODEL = os.path.join(
    SPACE, 'onnx', 'layout_recognition', 'nano_v3-0319.onnx')

_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        _detector = ChessboardDetector(
            pose_model_path=POSE_MODEL,
            full_classifier_model_path=CLASSIFIER_MODEL,
        )
    return _detector


def _fen_row(row):
    out = []
    empty = 0
    for cell in row:
        if cell == '.':
            empty += 1
            continue
        if empty:
            out.append(str(empty))
            empty = 0
        out.append(cell)
    if empty:
        out.append(str(empty))
    return ''.join(out)


def _predict(detector, image_rgb, keypoints):
    _board, labels, scores = detector.extract_chessboard_and_classifier_layout(
        image_rgb=image_rgb, keypoints=keypoints)
    if isinstance(labels, str):
        labels = [list(row) for row in labels.splitlines() if row]
    return labels, [[float(v) for v in row] for row in scores]


def read_twoview(path):
    """Return the 10x9 classification plus confidence and corner metadata."""
    image_bgr = cv2.imread(path)
    if image_bgr is None:
        return None
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    detector = _get_detector()
    keypoints, keypoint_scores = detector.pred_keypoints(image_bgr)
    if keypoints is None or len(keypoints) != 4 or min(keypoint_scores) < 0.05:
        return None

    labels, scores = _predict(detector, image_rgb, keypoints)

    # A second, color-normalized view catches otherwise high-confidence cases
    # where a piece glyph is right but its red/black class changes.
    lab = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)
    l_chan = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8)).apply(l_chan)
    normalized_rgb = cv2.cvtColor(
        cv2.merge((l_chan, a_chan, b_chan)), cv2.COLOR_LAB2RGB)
    labels_normalized, _ = _predict(detector, normalized_rgb, keypoints)

    disagree = [
        r * 9 + c
        for r in range(10)
        for c in range(9)
        if labels[r][c] != labels_normalized[r][c]
    ]
    unknown = [
        r * 9 + c
        for r in range(10)
        for c in range(9)
        if labels[r][c] == 'x'
    ]
    return {
        'fen': '/'.join(_fen_row(row) for row in labels),
        'scores': scores,
        'unknown': unknown,
        'disagree': disagree,
        'keypoints': [[float(x), float(y)] for x, y in keypoints],
        'keypoint_scores': [float(v) for v in keypoint_scores],
    }
