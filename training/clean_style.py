# -*- coding: utf-8 -*-
"""清洗数据里的「舞台动作」和符号：只保留纯对话文本。

Muice 是语 C 风格，(（恼）（泪）（即答）) 这类括号动作占 12%，会被模型学成模板。
本脚本删掉它们，并丢掉清洗后过短/改动过大的样本。

用法：
    python training/clean_style.py \
        --in training/data/processed/train.jsonl \
        --out training/data/processed/train_clean.jsonl
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# 括号动作：中英文括号、方括号、书名号里的短内容（≤20 字）
PAREN = re.compile(r"[（(【\[〔][^）)】\]〕\n]{1,20}[）)】\]〕]")
# emoji / 特殊符号
EMOJI = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]")
# 连发符号，如 ~⭐~ 或 ～～～
SYMBOL_RUN = re.compile(r"([~～\-—*#☆★])(?:[\s]*\1){2,}")
# 装饰性符号串
DECOR = re.compile(r"[⭐☆★✦✧✩✪~～]{2,}")


def clean_text(text: str) -> str:
    """只去掉括号动作，保留语气（emoji、～、喵 是角色声音的一部分）。"""
    t = PAREN.sub("", text)
    t = SYMBOL_RUN.sub("", t)          # 只合并 3 个以上的连续装饰符
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-len", type=int, default=6)
    ap.add_argument("--max-drop-ratio", type=float, default=0.5,
                    help="单条消息被删掉超过这个比例就丢弃整段对话")
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.inp).read_text(encoding="utf-8").splitlines() if l.strip()]
    kept, dropped = [], {"过短": 0, "删减过多": 0, "为空": 0}
    before = after = 0
    n_msg = 0

    for r in rows:
        changed = False
        msgs = []
        bad = False
        for m in r["messages"]:
            content = m["content"]
            if m["role"] == "assistant":
                n_msg += 1
                before += len(content)
                c = clean_text(content)
                after += len(c)
                if not c:
                    dropped["为空"] += 1
                    bad = True
                    break
                if len(c) < args.min_len:
                    dropped["过短"] += 1
                    bad = True
                    break
                removed = 1 - len(c) / max(1, len(content))
                if removed > args.max_drop_ratio:
                    dropped["删减过多"] += 1
                    bad = True
                    break
                if c != content:
                    changed = True
                msgs.append({"role": "assistant", "content": c})
            else:
                msgs.append({"role": m["role"], "content": content})
        if bad:
            continue
        out = dict(r)
        out["messages"] = msgs
        out["meta"] = dict(r.get("meta", {}))
        out["meta"]["cleaned"] = changed
        kept.append(out)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print("原始 %d 条 -> 保留 %d 条（丢 %d）" % (len(rows), len(kept), len(rows) - len(kept)))
    print("丢弃原因:", dropped)
    print("assistant 平均长度: %.1f -> %.1f 字" % (before / max(1, n_msg), after / max(1, n_msg)))
    print("输出:", args.out)


if __name__ == "__main__":
    main()
