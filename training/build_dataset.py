# -*- coding: utf-8 -*-
"""构建微调数据集：校验 → 过滤 → 去重 → 切分 → 统计。

用法：
    python training/build_dataset.py --seeds training/data/seeds.jsonl \
        --out training/data/processed

输出：
    processed/train.jsonl   训练集（messages 里已补 system）
    processed/eval.jsonl    评测集（按会话切分，不是按消息）
    processed/stats.json    统计
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

BANNED = [
    "作为一个AI", "作为AI", "作为人工智能", "很抱歉，我不能", "以下是", "首先，", "其次，",
    "总结一下", "希望对你有帮助", "如果你还有其他问题",
]
MIN_ASSISTANT = 4      # 允许「在。」这种角色化短回复，但不能整段都短
MAX_ASSISTANT = 150
MAX_TURNS = 14


def norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def is_chinese_ratio_ok(text: str, ratio: float = 0.5) -> bool:
    if not text:
        return False
    zh = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return zh / max(1, len(text)) >= ratio


def has_repetition(text: str, n: int = 6, times: int = 3) -> bool:
    grams = [text[i:i + n] for i in range(max(0, len(text) - n + 1))]
    return any(v >= times for v in Counter(grams).values())


def validate(item: dict, chars: dict[str, dict]) -> list[str]:
    errs: list[str] = []
    if not item.get("id"):
        errs.append("缺少 id")
    if item.get("character") not in chars:
        errs.append("角色不存在: %s" % item.get("character"))
    msgs = item.get("messages") or []
    if len(msgs) < 2:
        errs.append("消息太少")
        return errs
    if len(msgs) > MAX_TURNS:
        errs.append("消息太多: %d" % len(msgs))
    for i, m in enumerate(msgs):
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role not in ("user", "assistant"):
            errs.append("第 %d 条 role 非法: %s" % (i, role))
        if not content:
            errs.append("第 %d 条内容为空" % i)
            continue
        if role == "user" and i % 2 != 0:
            errs.append("第 %d 条应为 user" % i)
        if role == "assistant":
            ch = chars.get(item.get("character"), {})
            lo, hi = ch.get("len_range", [MIN_ASSISTANT, MAX_ASSISTANT])
            if not (lo <= len(content) <= hi):
                errs.append("第 %d 条 assistant 长度 %d 不在角色区间 [%d,%d]" % (i, len(content), lo, hi))
            if any(b in content for b in BANNED):
                errs.append("第 %d 条含套话: %s" % (i, [b for b in BANNED if b in content][0]))
            if not is_chinese_ratio_ok(content):
                errs.append("第 %d 条中文占比过低" % i)
            if has_repetition(content):
                errs.append("第 %d 条有重复片段" % i)
    # 整段不能都是「嗯」「在」这类极短回复
    assistants = [m["content"] for m in msgs if m.get("role") == "assistant"]
    if assistants and max(len(a) for a in assistants) < 12:
        errs.append("整段缺少像样的回复（最长 %d 字）" % max(len(a) for a in assistants))
    return errs


def signature(item: dict) -> str:
    body = "\n".join(norm(m["content"]) for m in item["messages"])
    return hashlib.sha1(body.encode("utf-8")).hexdigest()


def ngrams(text: str, n: int = 3) -> set[str]:
    t = norm(text)
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def near_dup(a: set[str], b: set[str], threshold: float = 0.85) -> bool:
    if not a or not b:
        return False
    return len(a & b) / len(a | b) >= threshold


def to_training(item: dict, chars: dict[str, dict]) -> dict:
    ch = chars[item["character"]]
    msgs = [{"role": "system", "content": ch["system_prompt"]}]
    msgs += [{"role": m["role"], "content": m["content"].strip()} for m in item["messages"]]
    return {
        "messages": msgs,
        "meta": {
            "id": item["id"],
            "character": item["character"],
            "scene": item.get("scene", "misc"),
            "source": item.get("source", "human"),
            "quality": item.get("quality", "gold"),
            "turns": (len(msgs) - 1) // 2,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="training/data/seeds.jsonl")
    ap.add_argument("--characters", default="training/data/characters.json")
    ap.add_argument("--out", default="training/data/processed")
    ap.add_argument("--eval-ratio", type=float, default=0.15)
    ap.add_argument("--extra", nargs="*", default=[],
                    help="额外数据（已是最终 messages 格式），如 external/muice.jsonl")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    seeds_path = Path(args.seeds)
    if not seeds_path.is_absolute():
        seeds_path = root / seeds_path
    chars_path = Path(args.characters)
    if not chars_path.is_absolute():
        chars_path = root / chars_path
    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = root / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    chars = {c["id"]: c for c in json.loads(chars_path.read_text(encoding="utf-8"))["characters"]}
    items = [json.loads(line) for line in seeds_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    kept, rejected = [], []
    seen_ids, seen_sig = set(), set()
    sigs: list[tuple[str, set[str]]] = []

    for item in items:
        errs = validate(item, chars)
        if errs:
            rejected.append((item.get("id"), errs))
            continue
        if item["id"] in seen_ids:
            rejected.append((item["id"], ["重复 id"]))
            continue
        sig = signature(item)
        if sig in seen_sig:
            rejected.append((item["id"], ["完全重复会话"]))
            continue
        body = "".join(norm(m["content"]) for m in item["messages"])
        grams = ngrams(body)
        if any(near_dup(grams, g) for g in sigs):
            rejected.append((item["id"], ["近似重复会话"]))
            continue
        seen_ids.add(item["id"])
        seen_sig.add(sig)
        sigs.append(grams)
        kept.append(item)

    # 外部数据：已经是最终 messages 格式，只做轻量校验 + 去重
    extra_rows: list[dict] = []
    for p in args.extra:
        pp = Path(p)
        if not pp.is_absolute():
            pp = root / pp
        if not pp.exists():
            print("跳过不存在的文件:", pp)
            continue
        before = len(extra_rows)
        for line in pp.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            d = json.loads(line)
            msgs = d.get("messages") or []
            if len(msgs) < 3:
                continue
            if any(not (m.get("content") or "").strip() for m in msgs):
                continue
            if any(not (MIN_ASSISTANT <= len(m["content"]) <= MAX_ASSISTANT)
                   for m in msgs if m.get("role") == "assistant"):
                continue
            if any(b in m["content"] for m in msgs if m.get("role") == "assistant" for b in BANNED):
                continue
            body = hashlib.sha1("\n".join(norm(m["content"]) for m in msgs).encode("utf-8")).hexdigest()
            if body in seen_sig:
                continue
            seen_sig.add(body)
            extra_rows.append(d)
        print("载入 %s: +%d" % (pp.name, len(extra_rows) - before))

    # 按会话切分
    rows_all = [to_training(item, chars) for item in kept] + extra_rows
    train, evals = [], []
    for r in rows_all:
        h = int(hashlib.sha1(str(r["meta"].get("id")).encode()).hexdigest(), 16) % 100
        if h < args.eval_ratio * 100:
            evals.append(r)
        else:
            train.append(r)

    for name, rows in (("train.jsonl", train), ("eval.jsonl", evals)):
        with open(out_dir / name, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    turns = [r["meta"]["turns"] for r in train + evals]
    alen = [len(m["content"]) for r in train + evals for m in r["messages"] if m["role"] == "assistant"]
    stats = {
        "seeds": len(items),
        "kept": len(kept),
        "rejected": len(rejected),
        "external": len(extra_rows),
        "total": len(rows_all),
        "train": len(train),
        "eval": len(evals),
        "avg_turns": round(sum(turns) / max(1, len(turns)), 2),
        "avg_assistant_len": round(sum(alen) / max(1, len(alen)), 1),
        "by_source": dict(Counter(r["meta"].get("source", "unknown") for r in train + evals)),
        "by_character": dict(Counter(r["meta"]["character"] for r in train + evals)),
        "by_scene": dict(Counter(r["meta"]["scene"] for r in train + evals)),
        "rejection_reasons": dict(Counter(e.split(":")[0] for _, errs in rejected for e in errs)),
    }
    (out_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print("种子: %d  保留: %d  剔除: %d  外部: %d" % (
        stats["seeds"], stats["kept"], stats["rejected"], stats["external"]))
    print("train: %d  eval: %d  合计: %d" % (stats["train"], stats["eval"], stats["total"]))
    print("平均轮次: %.2f  平均回复长度: %.1f 字" % (stats["avg_turns"], stats["avg_assistant_len"]))
    print("来源分布:", stats["by_source"])
    print("角色分布:", stats["by_character"])
    print("场景分布:", stats["by_scene"])
    if rejected:
        print("\n剔除明细（前 10 条）:")
        for rid, errs in rejected[:10]:
            print("  %s -> %s" % (rid, "; ".join(errs)))
    print("\n输出目录:", out_dir)


if __name__ == "__main__":
    main()
