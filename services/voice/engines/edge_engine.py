# -*- coding: utf-8 -*-
"""edge-tts 引擎（在线，当前默认）。"""
from __future__ import annotations

import os
from typing import AsyncIterator

import edge_tts

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")


class EdgeEngine:
    name = "edge"
    media_type = "audio/mpeg"
    ext = ".mp3"

    def __init__(self) -> None:
        self.voice = DEFAULT_VOICE

    async def stream(self, text: str, voice: str | None = None) -> AsyncIterator[bytes]:
        v = voice or self.voice
        async for chunk in edge_tts.Communicate(text, v).stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                yield chunk["data"]
