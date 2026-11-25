# -*- coding: utf-8 -*-
"""TTS 服务：统一入口。

    POST /api/tts {text, voice}      整段返回（audio/mpeg 或 audio/wav）
    GET  /api/tts?text=&voice=       流式返回（给 <audio src> 边下边播）

引擎由环境变量 TTS_ENGINE 决定：edge（默认，在线）或 sovits（GPT-SoVITS，需 GPU）。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from engines import engine_name, get_engine

BASE_DIR = Path(__file__).parent
CACHE_DIR = BASE_DIR / "cache"
CACHE_DIR.mkdir(exist_ok=True)

ENGINE = get_engine()
_SEM = asyncio.Semaphore(int(os.environ.get("TTS_CONCURRENCY", "2")))
MAX_LEN = 500

app = FastAPI(title="IM TTS")


class TtsBody(BaseModel):
    text: str
    voice: str | None = None


def _clean(text: str) -> str:
    t = (text or "").strip()
    if not t:
        raise HTTPException(400, "text 不能为空")
    return t[:MAX_LEN]


def _cache_path(text: str, voice: str | None) -> Path:
    key = hashlib.sha1(
        ("%s\x00%s\x00%s" % (ENGINE.name, voice or "", text)).encode("utf-8")
    ).hexdigest()[:20]
    return CACHE_DIR / (key + ENGINE.ext)


async def _stream_to_cache(text: str, voice: str | None, out: Path) -> AsyncIterator[bytes]:
    """边合成边吐出，同时落缓存；中途失败则丢弃缓存。"""
    tmp = out.with_name(out.stem + "." + str(os.getpid()) + ".tmp")
    await _SEM.acquire()
    ok = False
    try:
        with open(tmp, "wb") as f:
            async for chunk in ENGINE.stream(text, voice):
                if not chunk:
                    continue
                f.write(chunk)
                yield chunk
        ok = True
    finally:
        _SEM.release()
        try:
            if ok:
                tmp.replace(out)
            elif tmp.exists():
                tmp.unlink()
        except OSError:
            pass


@app.get("/healthz")
async def healthz():
    info = {"ok": True, "engine": ENGINE.name, "media_type": ENGINE.media_type,
            "cache_files": len(list(CACHE_DIR.glob("*" + ENGINE.ext)))}
    if engine_name() == "sovits":
        info["sovits"] = await ENGINE.health()
    return info


@app.get("/api/voices")
async def voices():
    if engine_name() == "sovits":
        import json
        cfg = json.loads((BASE_DIR / "voices.json").read_text(encoding="utf-8"))
        return [{"id": k, "name": k} for k in cfg.get("voices", {})]
    return [{"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（默认）"}]


@app.post("/api/tts")
async def tts(body: TtsBody):
    text = _clean(body.text)
    out = _cache_path(text, body.voice)
    if not out.exists():
        async with _SEM:
            tmp = out.with_name(out.stem + ".post.tmp")
            try:
                with open(tmp, "wb") as f:
                    async for chunk in ENGINE.stream(text, body.voice):
                        f.write(chunk)
                tmp.replace(out)
            except Exception as e:  # noqa: BLE001
                if tmp.exists():
                    tmp.unlink()
                raise HTTPException(502, "合成失败: %s" % e) from e
    return FileResponse(out, media_type=ENGINE.media_type, filename=out.name)


@app.get("/api/tts")
async def tts_stream(text: str = Query(default=""), voice: str | None = None):
    t = _clean(text)
    out = _cache_path(t, voice)
    if out.exists():
        return FileResponse(out, media_type=ENGINE.media_type)
    return StreamingResponse(_stream_to_cache(t, voice, out), media_type=ENGINE.media_type,
                             headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "9100")))
