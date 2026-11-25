# -*- coding: utf-8 -*-
"""端侧推理服务：把 MNN 的 Qwen3-0.6B 包装成 OpenAI 兼容接口。

实现要点：
- MNN 的 `response(prompt, True)` 会把 token 打到 stdout，无法直接拿到增量；
  改用「后台线程生成 + 轮询 context.generate_str」拿到逐 token 文本。
- `set_config({"use_template": False})` 让 response 直接吃渲染好的 chat prompt，
  避免模板被套两次。
- 单模型实例，用 threading.Lock 串行化，不承诺并发。
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import MNN.llm as llm
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from stream_client import MnnStreamClient

MODEL_DIR = os.environ.get("MNN_MODEL_DIR", r"F:\mnn-test\Qwen3-0.6B-MNN")
MODEL_ID = os.environ.get("MODEL_ID", "qwen3-0.6b-device")
STREAM_EXE = os.environ.get("MNN_STREAM_EXE", "")
CFG = os.path.join(MODEL_DIR, "config.json")

app = FastAPI(title="MNN Device Inference")

_m = None
_stream_client: MnnStreamClient | None = None
_lock = threading.Lock()


@app.on_event("startup")
def load_model() -> None:
    global _m, _stream_client
    t0 = time.time()
    if STREAM_EXE and Path(STREAM_EXE).exists():
        _stream_client = MnnStreamClient(STREAM_EXE, CFG)
        _stream_client.start()
        print("[device] backend=mnn_stream (%s) ready in %.2fs" % (STREAM_EXE, time.time() - t0), flush=True)
        return
    _m = llm.create(CFG)
    _m.load()
    _m.set_config({"use_template": False, "max_new_tokens": 16})
    _m.response("预热", False)
    _m.reset()
    print("[device] backend=pymnn loaded in %.2fs: %s" % (time.time() - t0, MODEL_DIR), flush=True)


@app.get("/healthz")
async def healthz():
    backend = "mnn_stream" if _stream_client else "pymnn"
    return {"ok": True, "model": MODEL_ID, "model_dir": MODEL_DIR, "backend": backend}


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]}


def _render(messages: list[dict[str, Any]]) -> str:
    return _m.apply_chat_template(messages)


def _chunks(text: str, size: int = 4) -> list[str]:
    """按标点/长度切块，用于把整段回复分片下发。"""
    out, buf = [], ""
    for ch in text:
        buf += ch
        if len(buf) >= size or ch in "，。！？…；\n":
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


async def _stream_tokens(messages: list[dict[str, Any]], max_tokens: int):
    """逐 token 流式：优先走 C++ 常驻进程（线程安全），否则退回 pymnn 整段生成。"""
    if _stream_client is not None:
        async for piece in _stream_client.generate(messages, max_tokens):
            yield piece
        return

    prompt = _render(messages)

    def work() -> str:
        with _lock:
            _m.reset()
            _m.set_config({"max_new_tokens": max_tokens})
            return _m.response(prompt, False) or ""

    text = await asyncio.to_thread(work)
    for piece in _chunks(text):
        await asyncio.sleep(0.008)
        yield piece


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    if not messages:
        raise HTTPException(400, "messages required")
    stream = bool(body.get("stream"))
    max_tokens = int(body.get("max_tokens") or 256)
    cid = "chatcmpl-" + uuid.uuid4().hex[:12]
    created = int(time.time())

    if not stream:
        text = "".join([chunk async for chunk in _stream_tokens(messages, max_tokens)])
        return JSONResponse({
            "id": cid, "object": "chat.completion", "created": created, "model": MODEL_ID,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": max(1, len(text) // 2)},
        })

    async def sse():
        try:
            async for delta in _stream_tokens(messages, max_tokens):
                payload = {"id": cid, "object": "chat.completion.chunk", "created": created,
                           "model": MODEL_ID,
                           "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}]}
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
        except Exception as e:  # noqa: BLE001
            err = {"id": cid, "object": "chat.completion.chunk", "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
                   "error": str(e)}
            yield "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "9000")))
