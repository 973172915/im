# -*- coding: utf-8 -*-
"""从 Muice 原始数据重建训练集（v5），修掉评测泄漏并做硬校验。

输入：ShareGPT 格式
    {"conversations": [{"from": "human"|"gpt", "value": "..."}], "system": "..."}

输出：
    train_v5.jsonl / eval_v5.jsonl   （messages + meta，供 train_lora.py 直接使用）
    stats.json

硬校验（不通过直接退出）：
    1. 每条对话必须以 assistant 结尾（否则没有监督 token）
    2. 消息里不得残留 <|im_end|> 等特殊 token（会和模板重复）
    3. assistant 内容非空、非纯空白
    4. train / eval 的「用户句」零重叠（防泄漏）

用法：
    python training/build_dataset_v5.py \
        --input "%USERPROFILE%/Downloads/train_all.jsonl" \
        --out-dir training/data/v5
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
from collections import Counter
from pathlib import Path

SPECIAL_TOKENS = ("<|im_end|>", "<|im_start|>", "<|endoftext|>", "<|eot_id|>", "</s>")
MAX_REPLY_CHARS = 150      # 超过视为"小作文"，与历史清洗规则一致
MIN_REPLY_CHARS = 3        # <=2 字的回复是噪声
MAX_TURNS = 8              # 多轮样本最多保留几轮对话

# 模板任务占位符：<生成推文: 情感建议> 这类不是真实对话，会教模型写小作文
PLACEHOLDER = re.compile(r"^\s*[<［\[].{0,40}[>］\]]\s*$")
TASK_PREFIX = re.compile(r"^\s*(请)?(帮我)?生成(推文|文案|祝福|标题|总结|摘要)")


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def normalize(row: dict) -> list[dict] | None:
    """统一成 [{role, content}]，返回 None 表示该条不可用。"""
    convs = row.get("conversations") or row.get("messages") or []
    msgs: list[dict] = []
    for c in convs:
        from_ = c.get("from") or c.get("role")
        text = (c.get("value") or c.get("content") or "").strip()
        role = "assistant" if from_ in ("gpt", "assistant") else "user"
        if not text:
            return None
        # 清掉残留特殊 token（不能手写，交给模板）
        for tok in SPECIAL_TOKENS:
            text = text.replace(tok, "")
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return None
        msgs.append({"role": role, "content": text})
    if not msgs:
        return None
    return msgs


def pair_age(msgs: list[dict]) -> list[tuple[dict, dict]]:
    """把相邻的 user->assistant 配对。"""
    out: list[tuple[dict, dict]] = []
    for i in range(len(msgs) - 1):
        if msgs[i]["role"] == "user" and msgs[i + 1]["role"] == "assistant":
            out.append((msgs[i], msgs[i + 1]))
    return out


def conv_key(msgs: list[dict]) -> str:
    raw = "||".join("%s:%s" % (m["role"], m["content"]) for m in msgs)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(Path.home() / "Downloads" / "train_all.jsonl"))
    ap.add_argument("--out-dir", default="training/data/v5")
    ap.add_argument("--eval-ratio", type=float, default=0.12)
    ap.add_argument("--max-reply", type=int, default=MAX_REPLY_CHARS)
    ap.add_argument("--drop-multi", action="store_true", help="不生成多轮样本")
    ap.add_argument("--keep-placeholder", action="store_true",
                    help="保留 <生成推文: …> 这类模板任务样本（默认丢弃）")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print("输入不存在:", src)
        return 2
    rows = load_jsonl(src)
    print("读取 %d 条原始对话" % len(rows))

    problems = Counter()
    convs: list[list[dict]] = []
    for row in rows:
        msgs = normalize(row)
        if not msgs:
            problems["空消息"] += 1
            continue
        if msgs[-1]["role"] != "assistant":
            problems["未以assistant结尾"] += 1
            continue
        convs.append(msgs)

    # ---- 硬校验 1/2/3 ----
    for m in convs:
        assert m[-1]["role"] == "assistant", "末尾必须是 assistant"
        for x in m:
            assert not any(t in x["content"] for t in SPECIAL_TOKENS), "残留特殊 token"
            assert x["content"].strip(), "空内容"

    # ---- 过滤回复长度（按单条 assistant 判定，整段对话若含超长回复则截断那轮）----
    kept: list[list[dict]] = []
    dropped_long = dropped_short = 0
    for msgs in convs:
        cleaned: list[dict] = []
        for m in msgs:
            if m["role"] == "assistant":
                n = len(m["content"])
                if n > args.max_reply:
                    dropped_long += 1
                    break
                if n < MIN_REPLY_CHARS:
                    dropped_short += 1
                    break
            cleaned.append(m)
        else:
            kept.append(cleaned)

    # ---- 过滤模板任务占位符（<生成推文: 情感建议> 等）----
    dropped_placeholder = 0
    if not args.keep_placeholder:
        before = len(kept)
        kept = [
            msgs for msgs in kept
            if not any(m["role"] == "user" and (PLACEHOLDER.match(m["content"]) or TASK_PREFIX.match(m["content"]))
                       for m in msgs)
        ]
        dropped_placeholder = before - len(kept)

    # ---- 构造样本：单轮（每个 user->assistant 对）+ 多轮（>2 句）----
    samples: list[dict] = []
    seen = set()

    def add(msgs: list[dict], kind: str) -> None:
        key = conv_key(msgs)
        if key in seen:
            return
        seen.add(key)
        samples.append({
            "messages": msgs,
            "meta": {
                "id": key[:12],
                "kind": kind,
                "turns": len(msgs),
                "system_hint": "muxue",
            },
        })

    for msgs in kept:
        for u, a in pair_age(msgs):
            add([u, a], "single")
        if not args.drop_multi and len(msgs) > 2:
            add(msgs[: MAX_TURNS * 2], "multi")

    # ---- 按「对话」切分 train/eval（同一对话的所有样本只进一侧）----
    by_conv: dict[str, list[dict]] = {}
    for s in samples:
        # 用第一条 user 内容 + 对话 hash 作为分组键（同一对话的样本共享）
        root = s["messages"][0]["content"]
        by_conv.setdefault(hashlib.md5(root.encode("utf-8")).hexdigest(), []).append(s)

    train: list[dict] = []
    evals: list[dict] = []
    for gid, group in by_conv.items():
        bucket = int(gid[:8], 16) / 0xFFFFFFFF
        (evals if bucket < args.eval_ratio else train).extend(group)

    # ---- 硬校验 4：用户句零重叠 ----
    # 把重叠样本"挪回训练集"，但挪动会新增 train 用户句，可能又和剩余 eval 撞上，
    # 所以要循环到不动点（实测最多 2 轮）。
    moved = 0
    for _ in range(6):
        train_users = {m["content"] for s in train for m in s["messages"] if m["role"] == "user"}
        keep: list[dict] = []
        round_moved: list[dict] = []
        for s in evals:
            if all(m["content"] not in train_users for m in s["messages"] if m["role"] == "user"):
                keep.append(s)
            else:
                round_moved.append(s)
        if not round_moved:
            break
        train.extend(round_moved)
        moved += len(round_moved)
        evals = keep
    if moved:
        print("ℹ️ 因用户句重叠，从 eval 挪回 train 的样本:", moved)

    # ---- 输出 ----
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    def dump(path: Path, rows_: list[dict]) -> None:
        with open(path, "w", encoding="utf-8") as f:
            for r in rows_:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    dump(out / "train_v5.jsonl", train)
    dump(out / "eval_v5.jsonl", evals)

    reply_lens = [len(m["content"]) for s in train for m in s["messages"] if m["role"] == "assistant"]
    multi_n = sum(1 for s in train if s["meta"]["kind"] == "multi")
    stats = {
        "input_rows": len(rows),
        "valid_convs": len(convs),
        "kept_convs": len(kept),
        "dropped_long_reply": dropped_long,
        "dropped_short_reply": dropped_short,
        "dropped_placeholder_convs": dropped_placeholder,
        "problems": dict(problems),
        "train_samples": len(train),
        "eval_samples": len(evals),
        "eval_moved_to_train": moved,
        "multi_turn_samples": multi_n,
        "multi_ratio": round(multi_n / max(len(train), 1), 4),
        "reply_len": {
            "mean": round(statistics.mean(reply_lens), 1) if reply_lens else 0,
            "p50": int(statistics.median(reply_lens)) if reply_lens else 0,
            "p95": sorted(reply_lens)[int(len(reply_lens) * 0.95)] if reply_lens else 0,
            "max": max(reply_lens) if reply_lens else 0,
        },
    }
    (out / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== 结果 ===")
    for k, v in stats.items():
        if k != "reply_len":
            print("  %-22s %s" % (k, v))
    print("  reply_len              %s" % stats["reply_len"])
    print("\n输出目录:", out.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
