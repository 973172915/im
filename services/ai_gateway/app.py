# -*- coding: utf-8 -*-
"""AI 推理服务（无状态）。

职责：收到「人设 + 对话历史」→ 选端/云 → 流式返回 token。
不存会话、不存用户——存储归调用方（Next.js / Prisma）。

    POST /v1/reply    SSE：route / delta / done / error
    GET  /healthz
    GET  /v1/models

环境变量：
    INFERENCE_MODE   device | cloud | auto（auto = 按隐私/上下文/难度路由）
    DEVICE_BASE_URL  端侧 OpenAI 兼容地址（默认 http://127.0.0.1:9000/v1）
    DEVICE_MODEL     端侧模型名
    CLOUD_BASE_URL   云端地址（vLLM）
    CLOUD_MODEL      云端模型名
    CONTEXT_TOKEN_LIMIT  超过这个 token 数走云端（默认 1200）
    CORS_ORIGINS     允许的来源，逗号分隔，默认 *
"""
from __future__ import annotations

import json
import os
import time
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

INFERENCE_MODE = os.environ.get("INFERENCE_MODE", "device").strip().lower()
DEVICE_BASE_URL = os.environ.get("DEVICE_BASE_URL", "http://127.0.0.1:9000/v1").rstrip("/")
DEVICE_MODEL = os.environ.get("DEVICE_MODEL", "qwen3-0.6b-device")
CLOUD_BASE_URL = os.environ.get("CLOUD_BASE_URL", "").rstrip("/")
CLOUD_MODEL = os.environ.get("CLOUD_MODEL", "qwen3-4b-roleplay")
CONTEXT_TOKEN_LIMIT = int(os.environ.get("CONTEXT_TOKEN_LIMIT", "1200"))
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
MOCK_AI = os.environ.get("MOCK_AI", "0") == "1"

MOCK_REPLIES = [
    "在呀～刚在发呆呢，你今天怎么样？",
    "诶？这个我不太懂，不过可以陪你说说。",
    "好呀，那就这样定了～",
    "别急嘛，慢慢来，我等你。",
    "嗯嗯，我在听呢，你接着说。",
]

app = FastAPI(title="IM AI Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReplyBody(BaseModel):
    messages: list[dict]
    persona: str | None = None
    session_id: str | None = None
    max_tokens: int = 256
    temperature: float = 0.7
    privacy: bool = False


# ---------------- 路由 ----------------
def estimate_tokens(text: str) -> int:
    """粗估：中文 1 字≈1 token，英文 4 字符≈1 token。"""
    zh = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = max(0, len(text) - zh)
    return zh + (other + 3) // 4


def has_cloud() -> bool:
    return bool(CLOUD_BASE_URL)


def decide(body: ReplyBody) -> tuple[str, list[str]]:
    """返回 (decision, reasons)。decision ∈ {device, cloud}"""
    history = body.messages
    tokens = sum(estimate_tokens(m.get("content", "")) for m in history)
    reasons: list[str] = []

    if INFERENCE_MODE == "cloud":
        return "cloud", ["强制云端"]
    if INFERENCE_MODE == "device":
        return "device", ["强制端侧"]

    # auto：隐私 > 上下文长度 > 默认端侧
    if body.privacy:
        reasons.append("隐私模式")
        return "device", reasons
    if tokens > CONTEXT_TOKEN_LIMIT:
        if has_cloud():
            reasons.append("上下文 %d token 超过 %d" % (tokens, CONTEXT_TOKEN_LIMIT))
            return "cloud", reasons
        reasons.append("上下文过长但云端不可用，退回端侧")
        return "device", reasons
    reasons.append("默认端侧（%d token）" % tokens)
    return "device", reasons


# ---------------- 推理 ----------------
async def stream_chat(base_url: str, model: str, messages: list[dict],
                      max_tokens: int, temperature: float) -> AsyncIterator[str]:
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", base_url + "/chat/completions", json=payload) as r:
            if r.status_code != 200:
                body = (await r.aread())[:200].decode("utf-8", "ignore")
                raise RuntimeError("推理服务返回 %d: %s" % (r.status_code, body))
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta") or {}
                text = delta.get("content")
                if text:
                    yield text


def build_messages(body: ReplyBody) -> list[dict]:
    msgs: list[dict] = []
    if body.persona:
        msgs.append({"role": "system", "content": body.persona})
    for m in body.messages[-20:]:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    return msgs


def sse(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "mode": INFERENCE_MODE,
        "device": {"url": DEVICE_BASE_URL, "model": DEVICE_MODEL},
        "cloud": {"url": CLOUD_BASE_URL, "model": CLOUD_MODEL} if has_cloud() else None,
    }


@app.get("/v1/models")
async def models():
    out = [{"id": DEVICE_MODEL, "owned_by": "device"}]
    if has_cloud():
        out.append({"id": CLOUD_MODEL, "owned_by": "cloud"})
    return {"object": "list", "data": out}


@app.post("/v1/reply")
async def reply(body: ReplyBody, request: Request):
    messages = build_messages(body)
    if not messages or messages[-1]["role"] != "user":
        # 没有用户消息也允许（调用方可能只传了 system）
        pass
    decision, reasons = decide(body)
    base_url, model = ((CLOUD_BASE_URL, CLOUD_MODEL) if decision == "cloud"
                       else (DEVICE_BASE_URL, DEVICE_MODEL))
    if not base_url:
        raise RuntimeError("云端未配置：CLOUD_BASE_URL")

    async def gen():
        t0 = time.time()
        yield sse({"type": "route", "decision": decision, "reasons": reasons})
        tokens = 0

        # ---- 演示模式：不连模型，逐字吐一段预置回复 ----
        if MOCK_AI:
            import asyncio

            text = MOCK_REPLIES[len(body.messages) % len(MOCK_REPLIES)]
            for ch in text:
                if await request.is_disconnected():
                    return
                tokens += 1
                yield sse({"type": "delta", "text": ch})
                await asyncio.sleep(0.04)
            yield sse({"type": "done",
                       "usage": {"tokens": tokens, "ms": round((time.time() - t0) * 1000, 1)},
                       "decision": "mock"})
            return

        try:
            async for piece in stream_chat(base_url, model, messages,
                                           body.max_tokens, body.temperature):
                if await request.is_disconnected():
                    return
                tokens += 1
                yield sse({"type": "delta", "text": piece})
        except Exception as e:  # noqa: BLE001
            yield sse({"type": "error", "message": "%s: %s" % (type(e).__name__, e)})
            return
        yield sse({"type": "done",
                   "usage": {"tokens": tokens, "ms": round((time.time() - t0) * 1000, 1)},
                   "decision": decision})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9200")))
