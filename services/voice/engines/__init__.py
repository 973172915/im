# -*- coding: utf-8 -*-
"""TTS 引擎：统一接口，方便在 edge-tts 和 GPT-SoVITS 之间切换。

每个引擎提供：
    media_type  返回的 MIME 类型（audio/mpeg 或 audio/wav）
    ext         缓存文件后缀
    stream(text, voice)  -> 异步产出音频字节流
"""
from __future__ import annotations

import os

from .edge_engine import EdgeEngine
from .sovits import SovitsEngine

_ENGINES = {"edge": EdgeEngine, "sovits": SovitsEngine}


def get_engine(name: str | None = None):
    key = (name or os.environ.get("TTS_ENGINE", "edge")).strip().lower()
    cls = _ENGINES.get(key)
    if cls is None:
        raise ValueError("未知 TTS 引擎: %s（可选: %s）" % (key, ", ".join(_ENGINES)))
    return cls()


def engine_name() -> str:
    return (os.environ.get("TTS_ENGINE", "edge") or "edge").strip().lower()
