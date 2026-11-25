# -*- coding: utf-8 -*-
"""数据集体检：格式、长度分布、重复、风格标记、训练/评测泄漏。

用法：
    python training/audit_dataset.py --train training/data/processed/train.jsonl \
                                     --eval  training/data/processed/eval.jsonl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

BANNED = ["作为一个AI", "作为AI", "作为人工智能", "以下是", "希望对你有帮助", "总结一下"]
PAREN = re.compile(r"[（(【\[〔][^）)】\]〕\n]{1,20}[）)】\]〕]")
META = re.compile(r"^(你可以|你应该|建议你|可以这样|你可以说|回复[:：])")
EMOJI = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]")


def norm(t: str) -> str:
    return re.sub(r"\s+", "", t or "")


def sig(msgs: list[dict]) -> str:
    body = "|".join(norm(m["content"]) for m in msgs if m["role"] in ("user", "assistant"))
    return hashlib.sha1(body.encode()).hexdigest()


def load(path: Path) -> list[dict]:
    rows = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            print("  !! 第 %d 行 JSON 错误: %s" % (i, e))
    return rows


def pct(n: int, d: int) -> str:
    return "%.1f%%" % (100 * n / max(1, d))


def audit(name: str, rows: list[dict]) -> dict:
    print("\n" + "=" * 66)
    print("%s：%d 条" % (name, len(rows)))
    print("=" * 66)

    bad_schema = 0
    assistant_lens: list[int] = []
    user_lens: list[int] = []
    turns: list[int] = []
    no_system = 0
    ends_user = 0
    paren = emoji = meta = banned = non_zh = 0
    n_asst = 0

    for r in rows:
        msgs = r.get("messages") or []
        if not msgs or msgs[0].get("role") != "system":
            no_system += 1
        roles = [m.get("role") for m in msgs]
        if roles and roles[-1] != "assistant":
            ends_user += 1
        if not any(x == "assistant" for x in roles):
            bad_schema += 1
            continue
        turns.append(sum(1 for x in roles if x == "assistant"))
        for m in msgs:
            c = (m.get("content") or "").strip()
            if not c:
                bad_schema += 1
            if m.get("role") == "user":
                user_lens.append(len(c))
            elif m.get("role") == "assistant":
                n_asst += 1
                assistant_lens.append(len(c))
                if PAREN.search(c):
                    paren += 1
                if EMOJI.search(c):
                    emoji += 1
                if META.match(c):
                    meta += 1
                if any(b in c for b in BANNED):
                    banned += 1
                if len(re.findall(r"[\u4e00-\u9fff]", c)) / max(1, len(c)) < 0.5:
                    non_zh += 1

    assistant_lens.sort()
    user_lens.sort()

    def q(v, p):
        return v[min(len(v) - 1, int(p * len(v)))] if v else 0

    print("格式")
    print("  缺 system      : %d" % no_system)
    print("  末条不是 assistant: %d" % ends_user)
    print("  结构异常        : %d" % bad_schema)

    print("\n轮次")
    print("  平均 assistant 轮数: %.2f" % (sum(turns) / max(1, len(turns))))
    print("  多轮(>=2)占比     : %s" % pct(sum(1 for t in turns if t >= 2), len(turns)))

    print("\nassistant 回复长度（字）")
    print("  p10/p50/p90/p99 : %d / %d / %d / %d" % (
        q(assistant_lens, 0.10), q(assistant_lens, 0.50), q(assistant_lens, 0.90), q(assistant_lens, 0.99)))
    print("  平均 %.1f，最长 %d" % (sum(assistant_lens) / max(1, n_asst), assistant_lens[-1] if assistant_lens else 0))
    print("  <=5 字          : %s" % pct(sum(1 for x in assistant_lens if x <= 5), n_asst))
    print("  >=80 字         : %s" % pct(sum(1 for x in assistant_lens if x >= 80), n_asst))

    print("\n风格标记（占总 assistant 条数）")
    print("  含括号动作      : %s" % pct(paren, n_asst))
    print("  含 emoji        : %s" % pct(emoji, n_asst))
    print("  元话语(教你怎么说): %s" % pct(meta, n_asst))
    print("  套话            : %s" % pct(banned, n_asst))
    print("  中文占比<50%%    : %s" % pct(non_zh, n_asst))

    return {
        "rows": len(rows),
        "assistant_turns": n_asst,
        "paren_pct": 100 * paren / max(1, n_asst),
        "emoji_pct": 100 * emoji / max(1, n_asst),
        "meta_pct": 100 * meta / max(1, n_asst),
        "avg_len": sum(assistant_lens) / max(1, n_asst),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="training/data/processed/train.jsonl")
    ap.add_argument("--eval", default="training/data/processed/eval.jsonl")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    tp = Path(args.train) if Path(args.train).is_absolute() else root / args.train
    ep = Path(args.eval) if Path(args.eval).is_absolute() else root / args.eval

    train = load(tp)
    evals = load(ep) if ep.exists() else []

    audit("训练集", train)
    if evals:
        audit("评测集", evals)

    # ---- 重复 ----
    print("\n" + "=" * 66)
    print("重复与泄漏")
    print("=" * 66)
    tsig = [sig(r["messages"]) for r in train]
    ts = Counter(tsig)
    dup = sum(v - 1 for v in ts.values() if v > 1)
    print("训练集完全重复会话: %d 条（%.1f%%）" % (dup, 100 * dup / max(1, len(tsig))))

    if evals:
        eset = set(sig(r["messages"]) for r in evals)
        leak = len(set(tsig) & eset)
        print("训练/评测重叠会话: %d 条 %s" % (leak, "❌ 有泄漏" if leak else "✅ 无泄漏"))

    # ---- 抽样 ----
    print("\n" + "=" * 66)
    print("随机抽样（5 条）")
    print("=" * 66)
    step = max(1, len(train) // 5)
    for r in train[::step][:5]:
        msgs = r["messages"]
        print("\n[%s]" % r.get("meta", {}).get("id", "?"))
        for m in msgs:
            if m["role"] == "system":
                print("  sys : %s" % m["content"][:50])
            elif m["role"] == "user":
                print("  user: %s" % m["content"][:60])
            else:
                flag = ""
                if PAREN.search(m["content"]):
                    flag += " [括号]"
                if META.match(m["content"]):
                    flag += " [元话语]"
                if len(m["content"]) > 80:
                    flag += " [过长]"
                print("  asst: %s%s" % (m["content"][:60], flag))


if __name__ == "__main__":
    main()
