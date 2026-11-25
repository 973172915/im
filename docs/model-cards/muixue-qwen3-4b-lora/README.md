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

## 数据

| 项 | 值 |
| --- | --- |
| 来源 | [Moemu/Muice-Dataset](https://huggingface.co/datasets/Moemu/Muice-Dataset) |
| 许可 | **CC-BY-NC-4.0（非商业）** |
| 规模 | 2474 条训练 / 405 条验证 |
| 特点 | 单角色、单 system prompt、约 9.4% 多轮 |

## 训练

| 项 | 值 |
| --- | --- |
| 基座 | Qwen3-4B-Instruct-2507 |
| 方法 | QLoRA 4bit（nf4 + double quant） |
| LoRA | r=8, alpha=16, dropout=0.05 |
| 学习率 | 1e-4，cosine |
| epoch | 2 |
| 硬件 | 单卡 A10（24GB），678 步，48 分 35 秒 |

```
train_loss 2.415
eval_loss  2.553
gap        0.14（无过拟合）
```

## 关键修复：模型不停机

微调后模型会无限重复同一句话。原因：Qwen3 的 chat template 没有 `{% generation %}`，
按 token 位置切分时 `<|im_end|>` 落在 assistant 区间之外，模型从未学过何时停止。

解法：用字符偏移定位 assistant 区间，并**把 `<|im_end|>` 纳入监督**。详见配套项目的 `training/train_lora.py`。

## 效果

| 指标 | 基座 | 微调后 |
| --- | --- | --- |
| 平均回复长度 | 165 字 | **25 字** |
| 超 80 字占比 | 100% | 显著下降 |
| 人设一致性 | 客服腔 | 短句、口语、会拒绝越界 |

## 使用

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = "Qwen/Qwen3-4B-Instruct-2507"
tok = AutoTokenizer.from_pretrained(base)
model = AutoModelForCausalLM.from_pretrained(base, torch_dtype="bfloat16", device_map="auto")
model = PeftModel.from_pretrained(model, ".", dtype="bfloat16")

messages = [
    {"role": "system", "content": "你是一个名为沐雪的可爱AI女孩子"},
    {"role": "user", "content": "在吗"},
]
inputs = tok.apply_chat_template(messages, return_tensors="pt", add_generation_prompt=True).to(model.device)
print(tok.decode(model.generate(inputs, max_new_tokens=64, temperature=0.7)[0][inputs.shape[1]:], skip_special_tokens=True))
```

> 输出约为「在哦，有什么事吗？」

## 提示词建议

实测**越短的提示越好**：

| prompt | 结果 |
| --- | --- |
| 空 | 丢人设，自称"我是 Qwen" |
| 长规则（100+ 字） | 基座也能模仿短句，微调价值被掩盖 |
| **`你是一个名为沐雪的可爱AI女孩子`** | 最佳，能体现微调差异 |

## 许可与署名

- 训练数据：Moemu/Muice-Dataset（CC-BY-NC-4.0）
- 基座：Qwen3-4B-Instruct-2507（Apache-2.0）
- 本 LoRA：**CC-BY-NC-4.0，禁止商用**，使用需保留署名并注明为微调产物
