---
license: cc-by-nc-4.0
language:
  - zh
tags:
  - qwen3
  - lora
  - qlora
  - roleplay
  - chatbot
pretty_name: 沐雪 Qwen3-4B LoRA（中文陪伴型对话）
---

# 沐雪 Qwen3-4B LoRA

在 Qwen3-4B-Instruct-2507 上用 QLoRA 微调的中文陪伴型角色 LoRA，配套项目：[灵犀 IM](https://github.com/973172915/im)。

当前权重为 **v5**（数据重建 + 1 epoch）。

## 数据

| 项 | 值 |
| --- | --- |
| 来源 | [Moemu/Muice-Dataset](https://huggingface.co/datasets/Moemu/Muice-Dataset) |
| 许可 | **CC-BY-NC-4.0（非商业）** |
| 规模 | 3020 条训练 / 381 条验证（按对话切分，用户句零重叠） |
| 清洗 | 去除 >150 字长回复、≤2 字噪声、`<生成推文: …>` 类模板任务 333 段 |

## 训练

| 项 | 值 |
| --- | --- |
| 基座 | Qwen3-4B-Instruct-2507 |
| 方法 | QLoRA 4bit（nf4 + double quant），target 覆盖 q/k/v/o + gate/up/down |
| LoRA | r=16, alpha=32, dropout=0.05 |
| 学习率 | 1e-4，cosine，warmup 3% |
| epoch | **1**（189 步，batch 4×4，max_len 1024） |
| 硬件 | 单卡 A10（24GB） |

## 效果（同一评测集 381 条）

| 版本 | eval_loss | 平均回复长度 | >80 字占比 |
| --- | --- | --- | --- |
| 基座 | **6.50** | 98 字 | 100% |
| **本模型（1 epoch）** | **2.72** | **18 字** | **0%** |
| 2 epoch | 2.77 | — | — |
| 3 epoch | 2.95 | 30 字 | 8% |

**loss 下降 58%，且收益在第 1 轮就完成**；继续训练 eval_loss 反弹、行为退化（说教、出戏）。

行为对照示例：

```
[叫我老公]
  基座：哎呀，这么突然叫老公，让我有点害羞呢~ 既然你都这么说了…
  本模型：不给，谁让你叫呢？（恼）

[今天好累啊]
  基座：呜...听到你说累，我好心疼呢！*轻轻拍了拍你的肩膀*（98 字）
  本模型：辛苦了，想睡一下嘛？（12 字）
```

## 关键修复：模型不停机

微调后模型会无限重复同一句话。原因：Qwen3 的 chat template 没有 `{% generation %}`，
按 token 位置切分时 `<|im_end|>` 落在 assistant 区间之外，模型从未学过何时停止。

解法：用字符偏移定位 assistant 区间，并**把 `<|im_end|>` 纳入监督**。详见配套项目的 `training/train_lora.py`。

## 使用

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = "Qwen/Qwen3-4B-Instruct-2507"
tok = AutoTokenizer.from_pretrained(base)
model = AutoModelForCausalLM.from_pretrained(base, dtype="bfloat16", device_map="auto")
model = PeftModel.from_pretrained(model, ".", dtype="bfloat16")

messages = [
    {"role": "system", "content": "你是一个名为沐雪的可爱AI女孩子"},
    {"role": "user", "content": "在吗"},
]
inputs = tok.apply_chat_template(messages, return_tensors="pt", add_generation_prompt=True)
inputs = inputs["input_ids"] if hasattr(inputs, "keys") else inputs
out = model.generate(inputs.to(model.device), max_new_tokens=64, temperature=0.7)
print(tok.decode(out[0][inputs.shape[1]:], skip_special_tokens=True))
```

> 输出约为「在，有什么事嘛？」

## 提示词建议

实测**越短的提示越好**：

| prompt | 结果 |
| --- | --- |
| 空 | 丢人设，自称"我是 Qwen" |
| 长规则（100+ 字） | 基座也能模仿短句，微调价值被掩盖 |
| **`你是一个名为沐雪的可爱AI女孩子`** | 最佳，能体现微调差异 |

## 已知限制

- 记忆类问题会编造（"你应该是在学习吧？"），项目里靠外部记忆注入解决
- 称呼偶尔不稳定（姐姐/妹妹混用）
- 单角色数据集，**不适合直接扩展到其他角色**

## 许可与署名

- 训练数据：Moemu/Muice-Dataset（CC-BY-NC-4.0）
- 基座：Qwen3-4B-Instruct-2507（Apache-2.0）
- 本 LoRA：**CC-BY-NC-4.0，禁止商用**，使用需保留署名并注明为微调产物
