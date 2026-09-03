#!/usr/bin/env python3
"""End-to-end regression for the real park-game sample and dedicated ONNX path."""
import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import board_cv  # noqa: E402


EXPECTED = (
    '3akab2/3n3r1/1c1Rb1n1c/4p1p1p/2p6/'
    'r3P1P2/2P5P/N1C1C1N2/9/1RBAKAB2 w - - 0 1'
)


def main():
    image = os.path.join(ROOT, 'media', 'samples', 'park-game.png')
    result = board_cv.extract(image)
    assert result.get('ok'), result
    assert result.get('engine') == 'cv', result
    assert result.get('model') == 'chinese-chess-recognition (onnx)', result
    assert result.get('fen') == EXPECTED, result
    assert result.get('clean') is True, result
    assert result.get('issues') == [], result
    assert result.get('uncertain') == [], result
    print('photo recognition e2e passed')


if __name__ == '__main__':
    main()
