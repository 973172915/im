---
license: cc-by-nc-4.0
language:
  - zh
tags:
  - mnn
  - mnn-llm
  - qwen3
  - int4
  - edge
  - on-device
pretty_name: 沐雪 Qwen3-4B MNN int4（端侧）
---

# 沐雪 Qwen3-4B MNN int4

Qwen3-4B-Instruct-2507 + 沐雪 LoRA 合并后，用 **MNN `llmexport`** 导出的 **int4** 端侧模型，
可在**纯 CPU** 上离线推理。配套项目：[灵犀 IM](https://github.com/973172915/im)。

## 模型信息

| 项 | 值 |
| --- | --- |
| 基座 | Qwen3-4B-Instruct-2507 + 沐雪 LoRA（见 `muixue-qwen3-4b-lora`） |
| 导出工具 | MNN `transformers/llm/export/llmexport.py` |
| 量化 | int4，`--quant_block 128 --hqq` |
| 文件大小 | 权重约 **2.0 GB**（bf16 原模型 7.6 GB） |
| 上下文 | 32k（Qwen3 原生） |

## 文件

| 文件 | 说明 |
| --- | --- |
| `llm.mnn` | 计算图（约 1.5 MB） |
| `llm.mnn.weight` | int4 权重（约 2.0 GB） |
| `llm_config.json` | chat template 与推理参数 |
| `config.json` | 模型结构配置 |
| `tokenizer.mtok` | MNN 词表（3.9 MB） |
| `export_args.json` | 导出参数快照，便于复现 |

## 导出方式（复现）

```bash
# 1. 合并 LoRA 得到 bf16 全量模型
python merge_lora.py --base Qwen3-4B-Instruct-2507 --lora ./lora --out ./merged

# 2. 用 MNN 导出 int4
python llmexport.py \
  --path ./merged \
  --export mnn \
  --quant_bit 4 \
  --quant_block 128 \
  --hqq \
  --dst_path ./qwen3-4b-roleplay-mnn
```

## 使用

### 方式一：MNN-Chat / MNN 官方 demo

把本仓库目录作为模型路径传给 MNN-Chat（或 [MNN LLM demo](https://github.com/alibaba/MNN/tree/master/apps/Android/MnnLlmChat)）即可，
无需额外转换。

### 方式二：MNN Python API

```python
import MNN.llm as llm

model = llm.create("llm.mnn", "llm_config.json")
model.load()

for token in model.generate("你是一个名为沐雪的可爱AI女孩子\n用户：在吗\n沐雪：", max_new_tokens=64):
    print(token, end="", flush=True)
```

### 方式三：OpenAI 兼容服务

配套项目里的 `services/device` 用 `mnn_stream` 子进程包装成 `/v1/chat/completions`（支持 SSE）：

```bash
cd services/device
$env:MNN_MODEL_DIR = "<本仓库目录>"
python -m uvicorn server:app --port 9000
```

## 性能

| 硬件 | 速度 | 内存 |
| --- | --- | --- |
| Ryzen 5 5600（6C/12T，纯 CPU） | 约 **11 tok/s** | 约 4 GB |
| A10 + vLLM（bf16，对比） | 约 30–50 tok/s | 约 9 GB |

端侧的价值是**离线可用、零请求成本、数据不出本机**，不是绝对速度。
适合"闲聊/陪伴"这类短回复场景（25 字回复约 2–3 秒）。

## 已知限制

- 4B 模型的事实类问答不可靠（数学、时效信息），生产环境建议配合云端路由
- 纯 CPU 推理，长上下文（>4k token）时 prefill 明显变慢
- **禁止商用**

## 许可与署名

| 资产 | 许可 |
| --- | --- |
| 基座 Qwen3-4B-Instruct-2507 | Apache-2.0 |
| 微调数据 Moemu/Muice-Dataset | CC-BY-NC-4.0 |
| **本模型（含 LoRA 权重）** | **CC-BY-NC-4.0** |

使用需保留署名，并注明为微调 + 量化产物。
