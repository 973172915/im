# -*- coding: utf-8 -*-
"""Qwen3-4B LoRA 训练脚本（兼容 transformers 4.x / 5.x）。

关键：不依赖 chat template 的 {% generation %} 标记，用字符偏移切出 assistant 段来算 loss。
（Qwen3 模板没有该标记，return_assistant_tokens_mask 会返回全 0）

用法：
    python training/train_lora.py --base <模型> --dry-run          # 验证模板
    python training/train_lora.py --base <模型> --max-samples 20 --epochs 1
    python training/train_lora.py --base <模型> --out /path/ckpt --epochs 2
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch
import transformers
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)


class JsonlLogger(TrainerCallback):
    """把每个 logging 点和 eval 点追加到 jsonl，供离线画曲线。

    一行一条：
        {"step": 10, "epoch": 0.15, "loss": 2.71, "lr": 9.9e-05, "grad_norm": 1.9}
        {"step": 100, "epoch": 1.0, "eval_loss": 2.55}
    """

    def __init__(self, path: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("", encoding="utf-8")

    def _write(self, row: dict) -> None:
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def on_log(self, args, state, control, logs=None, **kwargs):  # noqa: ANN001
        if not logs:
            return
        row = {"step": state.global_step, "epoch": round(state.epoch or 0.0, 3)}
        for key, cast in (("loss", float), ("eval_loss", float),
                          ("learning_rate", float), ("grad_norm", float)):
            if key in logs and logs[key] is not None:
                row["lr" if key == "learning_rate" else key] = round(cast(logs[key]), 6)
        if len(row) > 2:
            self._write(row)


TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj",
                  "gate_proj", "up_proj", "down_proj"]
TF_MAJOR = int(transformers.__version__.split(".")[0])


def load_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def build_encoder(tok, max_len: int):
    """返回 encode(example) -> {input_ids, attention_mask, labels}。

    labels 只在 assistant 内容上保留 token id，其余为 -100。
    """
    fast = bool(getattr(tok, "is_fast", False))

    def assistant_char_spans(msgs: list[dict], full: str) -> list[tuple[int, int]]:
        """定位每条 assistant 的字符区间，结尾包含本轮的结束符（<|im_end|>）。

        不依赖「前缀渲染 == 全文前缀」的假设，直接在全文里找结束符。
        """
        spans = []
        for i, m in enumerate(msgs):
            if m.get("role") != "assistant":
                continue
            prefix = tok.apply_chat_template(msgs[:i], tokenize=False,
                                             add_generation_prompt=True)
            start = len(prefix)
            content_end = start + len(m["content"])
            end = content_end
            for marker in ("<|im_end|>", "<|eot_id|>", "<|end_of_text|>", "</s>"):
                j = full.find(marker, content_end)
                # 只接受紧跟正文的结束符，避免误匹配到很后面
                if j != -1 and j - content_end <= 16:
                    end = j + len(marker)
                    break
            spans.append((start, end))
        return spans

    def encode(example: dict) -> dict:
        msgs = example["messages"]
        full = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
        spans = assistant_char_spans(msgs, full)

        if fast:
            enc = tok(full, truncation=True, max_length=max_len,
                      add_special_tokens=False, return_offsets_mapping=True)
            ids = list(enc["input_ids"])
            offsets = list(enc["offset_mapping"])
            labels = [-100] * len(ids)
            for s, e in spans:
                for j, (a, b) in enumerate(offsets):
                    if b > s and a < e:
                        labels[j] = ids[j]
        else:
            ids = tok(full, truncation=True, max_length=max_len,
                      add_special_tokens=False)["input_ids"]
            labels = [-100] * len(ids)
            for s, e in spans:
                pre = tok(full[:s], add_special_tokens=False)["input_ids"]
                body = tok(full[s:e], add_special_tokens=False)["input_ids"]
                for j in range(len(pre), min(len(ids), len(pre) + len(body))):
                    labels[j] = ids[j]

        return {"input_ids": ids, "attention_mask": [1] * len(ids), "labels": labels}

    return encode


class Collator:
    def __init__(self, pad_id: int):
        self.pad_id = pad_id

    def __call__(self, features: list[dict]) -> dict:
        max_len = max(len(f["input_ids"]) for f in features)
        out = {"input_ids": [], "attention_mask": [], "labels": []}
        for f in features:
            pad = max_len - len(f["input_ids"])
            out["input_ids"].append(f["input_ids"] + [self.pad_id] * pad)
            out["attention_mask"].append(f["attention_mask"] + [0] * pad)
            out["labels"].append(f["labels"] + [-100] * pad)
        return {k: torch.tensor(v, dtype=torch.long) for k, v in out.items()}


def make_training_args(args) -> TrainingArguments:
    """按 transformers 版本过滤参数：v5 删掉了 warmup_ratio 等旧参数。"""
    kw = dict(
        output_dir=args.out,
        per_device_train_batch_size=args.bs,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        report_to=[],
        remove_unused_columns=False,
        dataloader_pin_memory=False,
    )
    kw["optim"] = "paged_adamw_8bit" if getattr(args, "use_4bit", False) else "adamw_torch"
    if args.eval:
        kw["eval_strategy"] = "epoch"
        kw["evaluation_strategy"] = "epoch"

    fields = set(getattr(TrainingArguments, "__dataclass_fields__", {}).keys())
    if "warmup_ratio" in fields:
        kw["warmup_ratio"] = 0.03
    elif "warmup_steps" in fields:
        kw["warmup_steps"] = 0          # v5 没有 ratio，直接不预热

    filtered = {k: v for k, v in kw.items() if k in fields}
    dropped = sorted(set(kw) - set(filtered))
    if dropped:
        print("提示：当前 transformers 不支持这些参数，已忽略: %s" % ", ".join(dropped))
    return TrainingArguments(**filtered)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--train", default="training/data/processed/train.jsonl")
    ap.add_argument("--eval", default="training/data/processed/eval.jsonl")
    ap.add_argument("--out", default="training/out/lora_r16")
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--bs", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--r", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--no-4bit", action="store_true")
    ap.add_argument("--log-jsonl", default="", help="把 loss 逐步写入该 jsonl，供 plot_loss.py 画图")
    ap.add_argument("--eval-only", action="store_true",
                    help="只算 eval loss 不训练（LoRA 零初始化，等价于基座基线）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    print("transformers %s / torch %s / cuda %s" % (
        transformers.__version__, torch.__version__, torch.cuda.is_available()))

    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    print("tokenizer is_fast =", getattr(tok, "is_fast", False))

    encode = build_encoder(tok, args.max_len)

    # ---------------- dry run ----------------
    if args.dry_run:
        rows = load_jsonl(args.train)[:5]
        lens = []
        for row in rows:
            enc = encode(row)
            n_loss = sum(1 for x in enc["labels"] if x != -100)
            sup = [t for t in enc["labels"] if t != -100]
            text = tok.decode(sup, skip_special_tokens=False) if sup else ""
            lens.append(len(enc["input_ids"]))
            print("\n  %s  tokens=%d  计入loss=%d" % (
                row["meta"].get("id", "?"), len(enc["input_ids"]), n_loss))
            print("  监督文本: %r" % text[:80])
            if n_loss == 0:
                raise SystemExit("❌ 没有监督 token，训练会学到 0，请检查模板！")
        print("\ntoken 长度: %s" % lens)
        print("最长 %d / 上限 %d %s" % (
            max(lens), args.max_len, "✅ 不截断" if max(lens) <= args.max_len else "⚠️ 会截断"))
        return

    # ---------------- 训练 ----------------
    args.use_4bit = not args.no_4bit
    if args.use_4bit:
        try:
            import bitsandbytes  # noqa: F401
        except Exception as e:  # noqa: BLE001
            print("bitsandbytes 不可用（%s），改用 bf16 LoRA" % e)
            args.use_4bit = False

    print("加载模型（%s）…" % ("4bit QLoRA" if args.use_4bit else "bf16 LoRA"))
    dtype_kw = {"dtype": torch.bfloat16} if TF_MAJOR >= 5 else {"torch_dtype": torch.bfloat16}
    load_kw = dict(device_map="auto", trust_remote_code=True, **dtype_kw)
    if args.use_4bit:
        from transformers import BitsAndBytesConfig
        load_kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
        )
    model = AutoModelForCausalLM.from_pretrained(args.base, **load_kw)
    if args.use_4bit:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False

    lora = LoraConfig(r=args.r, lora_alpha=args.alpha, lora_dropout=0.05,
                      bias="none", task_type="CAUSAL_LM", target_modules=TARGET_MODULES)
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def make_ds(path: str):
        rows = load_jsonl(path)
        if args.max_samples:
            rows = rows[: args.max_samples]
        return Dataset.from_list(rows).map(encode, remove_columns=["messages", "meta"])

    train_ds = None if args.eval_only else make_ds(args.train)
    eval_ds = make_ds(args.eval) if Path(args.eval).exists() else None
    print("train=%d eval=%s" % (len(train_ds), len(eval_ds) if eval_ds else 0))

    targs = make_training_args(args)
    callbacks = [JsonlLogger(args.log_jsonl)] if args.log_jsonl else []
    if args.log_jsonl:
        print("loss 逐步写入:", args.log_jsonl)
    trainer = Trainer(model=model, args=targs, train_dataset=train_ds,
                      eval_dataset=eval_ds, data_collator=Collator(tok.pad_token_id),
                      callbacks=callbacks)

    if args.eval_only:
        # LoRA 的 B 矩阵零初始化，此时模型输出等于基座 —— 可直接当基座基线
        if eval_ds is None:
            raise SystemExit("--eval-only 需要 --eval 数据集")
        metrics = trainer.evaluate()
        loss = metrics.get("eval_loss")
        print("\n=== 基线 ===")
        print("eval_loss %.4f  (%d 条样本)" % (loss, len(eval_ds)))
        if args.log_jsonl:
            JsonlLogger(args.log_jsonl)._write(
                {"step": 0, "epoch": 0.0, "eval_loss": round(float(loss), 4)}
            )
        return

    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    print("saved adapter to", args.out)


if __name__ == "__main__":
    main()
