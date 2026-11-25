# -*- coding: utf-8 -*-
"""文本向量服务（bge-small-zh-v1.5，CPU）。

    POST /embed {"texts": ["...", "..."]}  →  {"vectors": [[...], ...]}
    GET  /healthz

为什么独立成服务：
    Next.js 侧没有原生 torch/onnx 运行时，装 onnxruntime-node 体积大且难调试；
    项目里已有 Python 服务（网关、语音），加一个向量服务最一致。
"""
from __future__ import annotations

import os
from pathlib import Path

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer

MODEL_DIR = os.environ.get("EMBED_MODEL_DIR", r"F:\models\bge-small-zh-v1.5")
PORT = int(os.environ.get("PORT", "9300"))
MAX_LEN = int(os.environ.get("EMBED_MAX_LEN", "256"))

torch.set_num_threads(int(os.environ.get("EMBED_THREADS", "6")))

if not Path(MODEL_DIR).exists():
    raise SystemExit("模型目录不存在: %s" % MODEL_DIR)

_tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
_model = AutoModel.from_pretrained(MODEL_DIR, attn_implementation="eager").eval()

app = FastAPI(title="IM Embedding")


class EmbedBody(BaseModel):
    texts: list[str]


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_DIR, "dim": int(_model.config.hidden_size)}


@app.post("/embed")
def embed(body: EmbedBody):
    texts = [(t or "").strip() for t in body.texts]
    texts = [t[:MAX_LEN * 4] for t in texts if t]
    if not texts:
        return {"vectors": []}

    with torch.no_grad():
        inputs = _tokenizer(
            texts, padding=True, truncation=True, max_length=MAX_LEN, return_tensors="pt"
        )
        out = _model(**inputs)
        # bge 用 CLS 池化 + L2 归一化
        cls = out.last_hidden_state[:, 0]
        if torch.isnan(cls).any():
            print("[embed] NaN detected, texts=%r" % texts[:2], flush=True)
            cls = torch.nan_to_num(cls)
        vecs = torch.nn.functional.normalize(cls, p=2, dim=1)

    return {"vectors": vecs.tolist()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
