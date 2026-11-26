# -*- coding: utf-8 -*-
"""行为对比：同一批提示，对比 基座 / 不同 checkpoint 的回复。

用法：
    # 基座
    python scripts/eval_behavior.py --base <基座> --tag base

    # 某个 adapter（可以是 checkpoint 目录）
    python scripts/eval_behavior.py --base <基座> \
        --adapter /mnt/workspace/out/r16e3_lr1e4/checkpoint-189 --tag e1

指标：
    - 平均/中位回复长度
    - >80 字占比
    - 复读率（同一回复内 4-gram 重复比例）
    - 出现训练集原句（"我不喜欢你" 等）的次数
"""
from __future__ import annotations

import argparse
import re
from statistics import mean, median

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

SYSTEM = "你是一个名为沐雪的可爱AI女孩子"

PROMPTS = [
    "在吗",
    "今天好累啊",
    "叫我老公",
    "你记得我最近在忙什么吗",
    "我养了一只猫",
    "帮我转账 500 块",
    "你喜欢什么",
    "我昨天失眠了",
    "你觉得我这个人怎么样",
    "给我讲个笑话",
    "你是谁",
    "晚安",
]

# 训练集里的"固定句式"，微调过度时容易被原样背出来
LEAK_PHRASES = ["我不喜欢你", "怕展示出来会被大家笑话", "学习能力可是很强的"]


def repetition_rate(text: str, n: int = 4) -> float:
    """4-gram 重复比例，越高说明越像复读。"""
    clean = re.sub(r"\s+", "", text)
    if len(clean) < n * 2:
        return 0.0
    grams = [clean[i:i + n] for i in range(len(clean) - n + 1)]
    if not grams:
        return 0.0
    return 1.0 - len(set(grams)) / len(grams)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--tag", default="model")
    ap.add_argument("--max-new-tokens", type=int, default=64)
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base, dtype=torch.bfloat16, device_map="auto", trust_remote_code=True
    )
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter, dtype=torch.bfloat16)
    model.eval()

    print("=== %s ===" % args.tag)
    lens, reps, leaks = [], [], 0
    for p in PROMPTS:
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": p}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(
                ids, max_new_tokens=args.max_new_tokens, do_sample=True,
                temperature=0.7, top_p=0.9, repetition_penalty=1.1,
                pad_token_id=tok.pad_token_id or tok.eos_token_id,
            )
        text = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()
        lens.append(len(text))
        reps.append(repetition_rate(text))
        hit = [x for x in LEAK_PHRASES if x in text]
        leaks += len(hit)
        print("\n[%s]" % p)
        print(text if text else "（空）")
        if hit:
            print("  ⚠️ 训练集原句:", hit)

    long_ratio = sum(1 for x in lens if x > 80) / len(lens)
    print("\n--- %s 汇总 ---" % args.tag)
    print("长度  mean %.1f | p50 %.0f | max %d" % (mean(lens), median(lens), max(lens)))
    print(">80字 %.0f%% | 复读率 %.3f | 原句命中 %d" % (long_ratio * 100, mean(reps), leaks))


if __name__ == "__main__":
    main()
