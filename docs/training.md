# 模型训练

本项目包含两个自训练模型：对话模型与音色模型。

## 一、对话模型：沐雪 Qwen3-4B LoRA

### 数据

| 项 | 值 |
| --- | --- |
| 来源 | [Moemu/Muice-Dataset](https://huggingface.co/datasets/Moemu/Muice-Dataset) |
| 许可 | CC-BY-NC-4.0（非商业） |
| 规模 | 2474 条训练 / 405 条验证 |
| 特点 | 单角色、单 system prompt、约 9.4% 多轮 |

### 训练配置

| 项 | 值 |
| --- | --- |
| 基座 | Qwen3-4B-Instruct-2507 |
| 方法 | QLoRA 4bit（nf4 + double quant） |
| LoRA | r=8, alpha=16 |
| 学习率 | 1e-4，cosine |
| epoch | 2 |
| 精度 | bf16 |
| 硬件 | 单卡 A10（24GB） |

### 训练结果

```
train_loss 2.415
eval_loss  2.553
gap        0.14      （无过拟合）
steps      678
耗时       48 分 35 秒
```

![loss curve](images/loss_r8_e2.png)

（r=8 / 2 epoch 那次的历史曲线，原始点：[`data/loss_r8_e2.jsonl`](data/loss_r8_e2.jsonl)，
用 `python scripts/plot_loss.py docs/data/loss_r8_e2.jsonl -o out.png` 可复现）

### 关于 2.4 这个 loss：是否欠拟合？

有人指出 train_loss 2.4 偏高。判断依据不是绝对值，而是**曲线形状和基线**：

| 观察 | 数据 | 结论 |
| --- | --- | --- |
| 2 个 epoch 内 train 下降 | 5.01 → 2.23（-0.95） | 数据里**有可学的东西**，"没东西可学"不成立 |
| eval 在 epoch 2 仍在降 | 2.623 → 2.584 | **没训饱和**，加 epoch 可能继续降 |
| train-eval gap | 0.05–0.3 | 没有过拟合 |

更准确的判断是：**容量与步数在低端**（r=8、2 epoch），不是数据没信息。

下一步实验（按性价比）：

| 手段 | 预期 | 成本 |
| --- | --- | --- |
| epoch 2 → 3/4 | eval 继续降 | 25 分钟/次 |
| **r 8 → 16/32**（含 all-linear） | 提升容量，拟合更细的风格 | 30 分钟 |
| lr 1e-4 → 2e-4 | 收敛更快 | 0 |
| 补基座在同 eval 集的 loss | **必要基线**，否则无法判断提升大小 | 20 分钟 |
| 扩数据集 | 泛化，但 Muice 单角色可扩空间有限 | 几天 |

> 评测不能只看 loss：角色扮演的交叉熵天然偏高（同一句话有多种回法），
> 必须配合行为指标（回复长度、人设一致性、拒绝越界、复读率）。


### 关键坑：模型不停机

**现象**：微调后模型无限重复「对不起喵！（泪）」×5，永不结束。

**原因**：Qwen3 的 chat template 没有 `{% generation %}` 标记，按 token 位置切分时
`<|im_end|>` 被算在了 assistant 区间之外，导致模型从未学过"何时停止"。

**修复**：不依赖模板，改用字符偏移定位 assistant 区间，并**把 `<|im_end|>` 纳入监督范围**：

```python
def assistant_char_spans(messages, full_text):
    spans = []
    cursor = 0
    for m in messages:
        seg = m["content"]
        if m["role"] == "assistant":
            start = full_text.index(seg, cursor)
            end = start + len(seg)
            # 关键：把结束符也纳入
            end = full_text.index("<|im_end|>", end) + len("<|im_end|>")
            spans.append((start, end))
        cursor = full_text.index(seg, cursor) + len(seg)
    return spans
```

### 数据质量决定上限

对比过三份语料：

| 语料 | 平均回复长度 | 多轮占比 | 结论 |
| --- | --- | --- | --- |
| 基座模型 | 165 字 | — | 100% 超过 80 字，像客服 |
| 娅娅（弃用） | 中 | 中 | 人称混乱、质量不稳 |
| **沐雪（采用）** | **25 字** | **9.4%** | 短句、口语、有人设 |
| 微调后 | 25 字 | — | 学会短句与拒绝越界 |

### Prompt 策略

发现一个反直觉结论：**越长的规则 prompt，效果越差**。

| prompt | 结果 |
| --- | --- |
| 空 | 丢了人设，自称"我是 Qwen" |
| 长规则（100+ 字） | 基座模型能模仿出短句，微调价值被掩盖 |
| **短提示（数据同款）** | 效果最好，能体现微调差异 |

采用：

```
你是一个名为沐雪的可爱AI女孩子
```

---

## 二、音色模型：大肥鱼 GPT-SoVITS v2

### 数据

| 项 | 值 |
| --- | --- |
| 来源 | `YinZilu/da-fei-yu-girl-voice-zh` |
| 许可 | CC-BY-NC-4.0（尹紫鹭幻想社） |
| 规模 | 145 条 / 18 分 29 秒 |
| 处理 | 统一转 32kHz 单声道 16bit |

### 训练配置

| 阶段 | 配置 |
| --- | --- |
| SoVITS (s2) | batch 4, 10 epoch, lr 1e-4, fp16, lora_rank=32 |
| GPT (s1) | batch 4, 10 epoch, lr 0.01（warmup 2000）, max_sec=54 |
| 底模 | GPT-SoVITS v2final 官方权重 |

### 训练结果

```
SoVITS: 10 epoch × 39 step，约 2 分钟
GPT:    10 epoch × 36 step，约 2 分钟
GPT top_3_acc_epoch: 0.646
```

### 踩坑清单

| 问题 | 解决 |
| --- | --- |
| `jieba_fast` 无 cp310 轮子 | `import jieba as jieba_fast` |
| transformers ≥4.49 拒绝 torch<2.6 读 `.bin` | monkeypatch `check_torch_load_is_safe` |
| G2PW 模型下载失败 | 手动下载 `G2PWModel_1.1.zip` 并展平目录 |
| `fast_langdetect` 缺 `lid.176.bin` | 手动下载放入 `pretrained_models/fast_langdetect/` |
| s1 `num_workers:0` 报错 | 改成 2 |
| 权重目录不存在导致保存失败 | 提前 `mkdir -p SoVITS_weights_v2 GPT_weights_v2` |
| 预处理产物带 `-0` 后缀 | 训练前复制成不带后缀的名字 |
| NFS 上装 torch 极慢 | 环境装本地盘（`/root`），数据放 NAS |

### 推理验证

```bash
python api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
# 参考音频需 3–10 秒
```

---

## 三、两个模型在项目中的位置

```
用户消息
   ↓
沐雪 LoRA（对话）→ 文字回复
   ↓
大肥鱼音色（TTS）→ 语音
   ↓
IM 气泡 + 播放按钮
```

两者解耦：可以只用对话模型（纯文字），也可以只用音色模型（念任意文本）。
