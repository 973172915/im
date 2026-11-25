# -*- coding: utf-8 -*-
"""GPT-SoVITS 引擎：把请求转成 GPT-SoVITS 的 HTTP API（api_v2.py，默认 9880）。

环境变量：
    TTS_ENGINE=sovits
    SOVITS_API=http://127.0.0.1:9880      # GPU 机器上的 GPT-SoVITS 服务
    SOVITS_VOICE=yaya                     # 默认音色（对应 voices.json）
    SOVITS_REF_DIR=<路径>                 # ref_audio_path 的相对根目录
    TTS_FALLBACK_EDGE=1                   # 连不上时退回 edge-tts
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import AsyncIterator

import httpx

BASE_DIR = Path(__file__).resolve().parents[1]       # services/voice
PROJECT_ROOT = BASE_DIR.parents[1]                  # 项目根
VOICES_FILE = BASE_DIR / "voices.json"

DEFAULT_API = os.environ.get("SOVITS_API", "http://127.0.0.1:9880").rstrip("/")
REF_DIR = Path(os.environ.get("SOVITS_REF_DIR") or PROJECT_ROOT)


def _load_voices() -> dict:
    if not VOICES_FILE.exists():
        return {}
    return json.loads(VOICES_FILE.read_text(encoding="utf-8"))


class SovitsEngine:
    name = "sovits"
    media_type = "audio/wav"
    ext = ".wav"

    def __init__(self) -> None:
        cfg = _load_voices()
        self.api = DEFAULT_API
        self.default_voice = os.environ.get("SOVITS_VOICE") or cfg.get("default_voice", "yaya")
        self.voices = cfg.get("voices", {})
        self.fallback = os.environ.get("TTS_FALLBACK_EDGE", "1") == "1"

    # ---------- 内部 ----------
    def _profile(self, voice: str | None) -> dict:
        key = voice or self.default_voice
        p = self.voices.get(key)
        if not p:
            raise RuntimeError("voices.json 里没有音色: %s" % key)
        return p

    def _payload(self, text: str, voice: str | None) -> dict:
        p = self._profile(voice)
        ref = Path(p["ref_audio_path"])
        if not ref.is_absolute():
            ref = REF_DIR / ref
        if not ref.exists():
            # GPU 机器上路径通常不同，这里只警告不阻断
            print("[sovits] 警告：参考音频不存在 %s" % ref, flush=True)
        return {
            "text": text,
            "text_lang": p.get("text_lang", "zh"),
            "ref_audio_path": str(ref),
            "prompt_text": p.get("prompt_text", ""),
            "prompt_lang": p.get("prompt_lang", "zh"),
            "text_split_method": p.get("text_split_method", "cut5"),
            "speed_factor": p.get("speed_factor", 1.0),
            "top_k": p.get("top_k", 5),
            "top_p": p.get("top_p", 1.0),
            "temperature": p.get("temperature", 1.0),
            "repetition_penalty": p.get("repetition_penalty", 1.35),
            "batch_size": 1,
            "media_type": "wav",
            # CPU 推理下整段返回更稳定（流式会拿不到 WAV 头）
            "streaming_mode": False,
        }

    # ---------- 对外 ----------
    async def stream(self, text: str, voice: str | None = None) -> AsyncIterator[bytes]:
        try:
            payload = self._payload(text, voice)
        except RuntimeError as e:
            print("[sovits] 配置错误: %s" % e, flush=True)
            if self.fallback:
                from .edge_engine import EdgeEngine
                async for chunk in EdgeEngine().stream(text):
                    yield chunk
                return
            raise

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", self.api + "/tts", json=payload) as r:
                    if r.status_code != 200:
                        body = (await r.aread())[:200]
                        raise RuntimeError("GPT-SoVITS 返回 %d: %s" % (r.status_code, body))
                    async for chunk in r.aiter_raw():
                        if chunk:
                            yield chunk
        except Exception as e:  # noqa: BLE001
            print("[sovits] 调用失败: %s" % e, flush=True)
            if not self.fallback:
                raise
            from .edge_engine import EdgeEngine
            print("[sovits] 回退到 edge-tts", flush=True)
            async for chunk in EdgeEngine().stream(text):
                yield chunk

    async def health(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(self.api + "/docs")
                return {"api": self.api, "ok": r.status_code < 500}
        except Exception as e:  # noqa: BLE001
            return {"api": self.api, "ok": False, "error": str(e)}
