# -*- coding: utf-8 -*-
"""把 Muice 数据集转换成项目的训练格式。

来源：ModelScope / Moemuu/Muice-Dataset（CC-BY-NC-4.0，仅限非商业使用）
原始格式：{"system": "...", "conversation": [{"human": "...", "assistant": "..."}]}

过滤：指令类样本、长度越界、用户消息过长、空回复。
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

SRC = Path(r"F:\ai应用开发项目\tools\tmp\muice_train.jsonl")
OUT = Path(__file__).resolve().parents[0] / "data" / "external" / "muice.jsonl"

BANNED = ["作为一个AI", "作为AI", "以下是", "希望对你有帮助"]
MIN_A, MAX_A = 4, 150
MAX_H = 100
MAX_TURNS = 8


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in SRC.read_text(encoding="utf-8").splitlines() if line.strip()]

    kept, drop = [], Counter()
    seen = set()

    for r in rows:
        system = (r.get("system") or "").strip()
        conv = r.get("conversation") or []
        if not system or not conv:
            drop["结构缺失"] += 1
            continue
        if len(conv) > MAX_TURNS:
            drop["轮数过多"] += 1
            continue

        ok = True
        msgs = [{"role": "system", "content": system}]
        for turn in conv:
            human = (turn.get("human") or "").strip()
            assistant = (turn.get("assistant") or "").strip()
            if not human or not assistant:
                drop["空消息"] += 1
                ok = False
                break
            if "<" in human or ">" in human:
                drop["指令类"] += 1
                ok = False
                break
            if len(human) > MAX_H:
                drop["用户消息过长"] += 1
                ok = False
                break
            if not (MIN_A <= len(assistant) <= MAX_A):
                drop["回复长度越界"] += 1
                ok = False
                break
            if any(b in assistant for b in BANNED):
                drop["套话"] += 1
                ok = False
                break
            msgs.append({"role": "user", "content": human})
            msgs.append({"role": "assistant", "content": assistant})

        if not ok:
            continue
        body = "\n".join(m["content"] for m in msgs)
        if body in seen:
            drop["完全重复"] += 1
            continue
        seen.add(body)

        kept.append({
            "messages": msgs,
            "meta": {
                "id": "muice_%04d" % len(kept),
                "character": "muice",
                "scene": "roleplay",
                "source": "muice",
                "license": "CC-BY-NC-4.0",
                "turns": len(conv),
            },
        })

    with open(OUT, "w", encoding="utf-8") as f:
        for item in kept:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    turns = [k["meta"]["turns"] for k in kept]
    print("原始 %d -> 保留 %d (%.1f%%)" % (len(rows), len(kept), 100 * len(kept) / max(1, len(rows))))
    print("过滤原因:", dict(drop))
    print("平均轮次 %.2f, 多轮(>=2)占比 %.1f%%" % (
        sum(turns) / len(turns), 100 * sum(1 for t in turns if t >= 2) / len(turns)))
    print("输出:", OUT)


if __name__ == "__main__":
    main()
