# -*- coding: utf-8 -*-
"""把 LoRA adapter 合并进基座，输出 fp16 完整模型（给 vLLM / MNN 导出用）。

用法：
    python training/merge_lora.py \
        --base /data/models/Qwen3-4B-Instruct-2507 \
        --lora /data/ckpt/lora_r16_v1 \
        --out  /data/models/qwen3-4b-roleplay
"""
from __future__ import annotations

import argparse

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--lora", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    print("loading base:", args.base)
    base = AutoModelForCausalLM.from_pretrained(
        args.base, torch_dtype=torch.bfloat16, device_map="cpu", trust_remote_code=True,
    )
    print("applying lora:", args.lora)
    model = PeftModel.from_pretrained(base, args.lora)
    model = model.merge_and_unload()
    model.save_pretrained(args.out, safe_serialization=True)

    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    tok.save_pretrained(args.out)
    print("merged ->", args.out)


if __name__ == "__main__":
    main()
