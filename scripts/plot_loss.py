# -*- coding: utf-8 -*-
"""把 train_lora.py 输出的 loss.jsonl 画成曲线图。

用法：
    python scripts/plot_loss.py logs/v4.jsonl -o docs/images/loss_v4.png
    python scripts/plot_loss.py logs/v4.jsonl -o loss.png --baseline 2.68 --title "LoRA r=16 e=3"
    python scripts/plot_loss.py logs/a.jsonl logs/b.jsonl -o cmp.png --labels r8 r32

说明：
    - 横轴 step，纵轴 loss；train loss 做指数平滑（原始点淡淡画在底层）
    - eval_loss 用大点标注
    - --baseline 画一条水平虚线（基座在同一 eval 集上的 loss），便于判断"提升了多少"
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def load(path: str) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    train: list[tuple[int, float]] = []
    evals: list[tuple[int, float]] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        step = int(row.get("step", 0))
        if "loss" in row:
            train.append((step, float(row["loss"])))
        if "eval_loss" in row:
            evals.append((step, float(row["eval_loss"])))
    return train, evals


def smooth(values: list[float], alpha: float = 0.15) -> list[float]:
    out: list[float] = []
    last = values[0] if values else 0.0
    for v in values:
        last = alpha * v + (1 - alpha) * last
        out.append(last)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl", nargs="+", help="一个或多个 loss jsonl")
    ap.add_argument("-o", "--out", default="loss.png")
    ap.add_argument("--labels", nargs="*", default=None, help="每条曲线的名字")
    ap.add_argument("--baseline", type=float, default=None, help="基座 loss（水平虚线）")
    ap.add_argument("--title", default="Training loss")
    args = ap.parse_args()

    labels = args.labels or [Path(p).stem for p in args.jsonl]
    if len(labels) < len(args.jsonl):
        labels += [Path(p).stem for p in args.jsonl[len(labels):]]

    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=140)

    for path, label in zip(args.jsonl, labels):
        train, evals = load(path)
        if train:
            xs = [s for s, _ in train]
            ys = [v for _, v in train]
            ax.plot(xs, ys, color="#94a3b8", linewidth=0.6, alpha=0.45)  # 原始点
            ax.plot(xs, smooth(ys), color="#0ea5e9", linewidth=1.8, label="%s train" % label)
        if evals:
            ex = [s for s, _ in evals]
            ey = [v for _, v in evals]
            ax.scatter(ex, ey, s=46, zorder=5, color="#ef4444", edgecolor="white", linewidth=0.8)
            ax.plot(ex, ey, color="#ef4444", linewidth=1.0, linestyle="--", label="%s eval" % label)
            x_max = max(ex) if ex else 1
            for x, y in zip(ex, ey):
                # 靠右的点把标注放到左侧，避免被画布裁掉
                right_edge = x > x_max * 0.92
                ax.annotate(
                    "%.3f" % y,
                    (x, y),
                    textcoords="offset points",
                    xytext=(-6, 8) if right_edge else (5, 8),
                    ha="right" if right_edge else "left",
                    fontsize=8,
                    color="#b91c1c",
                )

    if args.baseline is not None:
        ax.axhline(args.baseline, color="#64748b", linestyle=":", linewidth=1.2,
                   label="base %.3f" % args.baseline)

    ax.set_xlabel("step")
    ax.set_ylabel("loss")
    ax.set_title(args.title)
    ax.grid(alpha=0.25, linestyle="--", linewidth=0.5)
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(args.out)
    print("saved:", args.out)


if __name__ == "__main__":
    main()
