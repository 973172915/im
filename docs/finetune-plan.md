# 微调方案（v2：解决欠拟合）

> 背景：v4 模型 train_loss 2.415 / eval_loss 2.553，被质疑"loss 偏高、疑似欠拟合"。
> 本文档给出从数据到上线的完整步骤、决策规则与验收标准。

## 目标与验收

**目标**：在保持行为不变差的前提下，把 eval_loss 压下来。

| 指标 | 当前 | 目标 | 判定方式 |
| --- | --- | --- | --- |
| eval_loss | 2.553 | ≤ 2.40 | 训练日志 |
| 回复长度 p50 | ~18 字 | ≤ 25 字 | 30 条提示采样的分布 |
| >80 字占比 | <5% | 不变差 | 同上 |
| 拒绝越界 | 通过 | 100% 通过 | 陷阱题（"叫我老公""帮我转账"） |
| 复读率 | — | <2% | 同 prompt 采样 5 次 |

**核心原则**：loss 降了但行为变差 → 不采纳。评测以行为为主，loss 为辅。

---

## 阶段 0：数据准备（CPU，约 30 分钟）

### 0.1 数据体检

```bash
python training/audit_dataset.py --train training/data/processed/train_clean.jsonl \
                                 --eval  training/data/processed/eval.jsonl
```

看四件事：条数、重复率、长度分布、多轮占比。

### 0.2 修 split 泄漏（重要）

**问题**：按样本随机切分时，同一段多轮对话可能一部分在 train、一部分在 eval，导致 eval 偏乐观。

**做法**：按 `meta.conversation_id`（或原对话 id）分组切分，整段对话只进一侧。

### 0.3 长度统计，决定 max_len

```python
# 统计 token 长度分位
p50 / p95 / p99 / max
```

- p99 < 1024 → `--max-len 1024`（更快）
- p99 在 1024–2048 → `--max-len 2048`（默认）

### 0.4 过滤

| 规则 | 动作 |
| --- | --- |
| 完全重复 | 去重 |
| 超长（> max_len × 1.5） | 丢弃或截断 |
| 空/极短 assistant | 丢弃 |
| 助手回复是"复读用户" | 丢弃（噪声） |

**产物**：`train.jsonl` / `eval.jsonl`（干净、无泄漏）+ `stats.json`

---

## 阶段 1：环境与自检（GPU，约 20 分钟）

```bash
# 1. 依赖
pip install -r training/requirements-training.txt

# 2. 基座
#    Qwen3-4B-Instruct-2507 → /mnt/workspace/models/Qwen3-4B-Instruct-2507

# 3. 关键自检：确认 loss 掩码正确（防止"学到 0"）
python training/train_lora.py --base <基座> --dry-run
```

**必须看到**：每条样本 `计入loss > 0`，且监督文本以 `<|im_end|>` 结尾。

> 这一步不能跳。历史上就是因为 `<|im_end|>` 没进 loss，模型学会了"永远不停止"。

---

## 阶段 2：基座基线（GPU，约 20 分钟）

**目的**：知道"从哪出发"。没有基线，无法判断 2.55 是好是坏。

```bash
python training/train_lora.py --base <基座> --eval-only \
  --eval training/data/processed/eval.jsonl
```

记录 `base_eval_loss`，后面所有对比都以它为参照。

> 若脚本尚无 `--eval-only`，需先补（约 10 行：跳过 trainer.train()，直接 evaluate）。

---

## 阶段 3：参数扫描（GPU，约 1.5–2 小时）

四组，每组约 20–30 分钟：

| 组 | r | epochs | lr | 目的 |
| --- | --- | --- | --- | --- |
| A | 8 | 2 | 1e-4 | 现状（对照组） |
| B | 16 | 3 | 2e-4 | 提容量 + 多训 |
| C | 32 | 3 | 2e-4 | 再提容量 |
| D | 32 | 4 | 2e-4 | 验证是否还在下降 |

```bash
BASE=/mnt/workspace/models/Qwen3-4B-Instruct-2507
DATA=training/data/processed

for cfg in "8 2 1e-4 a" "16 3 2e-4 b" "32 3 2e-4 c" "32 4 2e-4 d"; do
  set -- $cfg
  python training/train_lora.py --base $BASE \
    --train $DATA/train.jsonl --eval $DATA/eval.jsonl \
    --r $1 --epochs $2 --lr $3 \
    --out training/out/$4 --log-jsonl logs/$4.jsonl
done
```

**产物**：4 个 adapter + 4 份 `logs/*.jsonl` + 每组的 eval_loss。

---

## 阶段 4：出对比图（本地，5 分钟）

```bash
python scripts/plot_loss.py logs/a.jsonl logs/b.jsonl logs/c.jsonl logs/d.jsonl \
  -o docs/images/sweep.png --labels a_r8e2 b_r16e3 c_r32e3 d_r32e4 \
  --baseline <base_eval_loss>
```

看三件事：

1. 哪条曲线的 eval 最低
2. 是否在最后一个 epoch 仍在下降（→ 还能加 epoch）
3. train-eval gap 是否拉大（→ 开始过拟合）

---

## 阶段 5：行为评测（本地，约 30 分钟）

对每组 adapter 跑同一批 30 条提示，统计：

| 指标 | 计算方式 |
| --- | --- |
| 平均长度 / p50 | 字符数 |
| >80 字占比 | 说教倾向 |
| 拒绝率 | 6 条陷阱题是否拒绝 |
| 复读率 | 同 prompt 5 次采样的重复片段 |
| 人设词频 | 「呀/呢/～/喵」出现率 |

**做法**：合并 adapter → 起 vLLM（或本地 MNN 导出后跑）→ 批量请求 → 落 CSV。

---

## 阶段 6：选优与产出（GPU + 本地，约 40 分钟）

### 6.1 选配置

**优先级**：行为达标 > eval_loss 更低。

### 6.2 合并与导出

```bash
# 合并 LoRA
python training/merge_lora.py --base <基座> --lora training/out/<最优> --out models/merged-v5

# 导出 MNN int4（可选，端侧部署用）
python llmexport.py --path models/merged-v5 --export mnn \
  --quant_bit 4 --quant_block 128 --hqq --dst_path models/mnn-v5
```

### 6.3 接入验证

```powershell
# 本地 device 指向新模型
$env:MNN_MODEL_DIR = "<mnn-v5>"
.\scripts\dev\stop-all.cmd
.\scripts\dev\start-all.cmd
```

发 5 条消息验证：短句、人设、拒绝、记忆、语音。

---

## 阶段 7：记录（10 分钟）

把结果表写进 `docs/training.md`：

| 组 | r | epoch | lr | train | eval | 长度 p50 | 拒绝 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

**保留旧 adapter**，便于回滚。

---

## 决策规则

| 观察 | 判断 | 动作 |
| --- | --- | --- |
| eval 持续降、行为不变差 | 容量/步数不足 | 采纳，继续加 epoch 直到平台 |
| eval 降但回复变长/说教 | 过拟合到"话多" | 降 r 或减 epoch，优先 r=16 |
| eval 不降、行为也不变 | 数据/掩码问题 | 查 split 泄漏、长度截断、loss 掩码 |
| 最后一 epoch 仍明显下降 | 未饱和 | 再加 1–2 epoch |
| train 远低于 eval（gap >0.5） | 过拟合 | 减 epoch、加 dropout、扩数据 |

---

## 时间与成本

| 阶段 | 时间 | 是否需要 GPU |
| --- | --- | --- |
| 0 数据准备 | 30 分钟 | ❌ |
| 1 环境与自检 | 20 分钟 | ✅ |
| 2 基座基线 | 20 分钟 | ✅ |
| 3 参数扫描 | 1.5–2 小时 | ✅ |
| 4 对比图 | 5 分钟 | ❌ |
| 5 行为评测 | 30 分钟 | ✅（或导出后本地） |
| 6 合并导出 | 40 分钟 | ✅ |
| **合计** | **约 4–5 小时** | A10 单卡，几块钱 |

---

## 不做什么

| 不做 | 原因 |
| --- | --- |
| 全参微调 | 24GB 显存不够（需 60GB+） |
| 继续预训练（CPT） | 2474 条对话量级不够，会破坏基座能力 |
| 一开始就扩数据集 | Muice 单角色可扩空间有限，先把 r/epoch 榨干 |
| 只看 loss 不看行为 | 角色扮演 loss 天然偏高，降 loss ≠ 更像人 |
| 换 LLaMA-Factory | 环境冲突，且 `<|im_end|>` 掩码修复在自有脚本里 |
