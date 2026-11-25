# 训练流程（GPU 机器）

> 本地只负责写代码和数据，训练在租的 4090 上跑。
> 数据：`training/data/processed/`（2474 训练 / 405 评测）

## 上卡当天：完整清单

### ① 选机器（10 分钟）

| 项 | 建议 |
|---|---|
| 显卡 | 4090 24G（够用、便宜）；A100 40G 更快但贵 |
| 镜像 | PyTorch 2.x + CUDA 12.1 |
| 磁盘 | 系统盘 50G + 数据盘 100G（模型 8G + 输出 10G） |
| 计费 | 按小时，跑完立刻关机 |

开机先验证：

```bash
nvidia-smi          # 显卡在不在
df -h               # 磁盘够不够
python -V           # 3.10+
```

### ② 传代码和数据（10 分钟）

```bash
# 本地执行：只传需要的，别传整个仓库
scp -r training/data/processed user@host:/data/project/training/data/
scp -r training/*.py training/requirements-training.txt user@host:/data/project/training/
scp -r eval scripts user@host:/data/project/
scp -r third_party/MNN/transformers/llm/export user@host:/data/project/mnn_export/
```

### ③ 装依赖（15 分钟）

```bash
pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121
pip install -r training/requirements-training.txt
```

### ④ 下基座（20 分钟）

```bash
pip install modelscope
modelscope download --model Qwen/Qwen3-4B-Instruct-2507 \
  --local_dir /data/models/Qwen3-4B-Instruct-2507
```

### ⑤ 冒烟（10 分钟）

```bash
cd /data/project
python training/train_lora.py \
  --base /data/models/Qwen3-4B-Instruct-2507 \
  --train training/data/processed/train.jsonl \
  --eval training/data/processed/eval.jsonl \
  --out /data/ckpt/smoke --max-samples 20 --epochs 1
```

看到 loss 下降、显存 14–18G，就往下走。

### ⑥ 正式训练（3–5 小时，挂后台）

```bash
tmux new -s train
python training/train_lora.py \
  --base /data/models/Qwen3-4B-Instruct-2507 \
  --out /data/ckpt/lora_r16_v1 --epochs 3
# Ctrl+B 然后 D 退出 tmux，训练继续
```

⚠️ **一定用 tmux/screen**，SSH 断开会杀掉前台进程。

### ⑦ 起服务（15 分钟）

```bash
# 不用合并，vLLM 直接挂 LoRA
vllm serve /data/models/Qwen3-4B-Instruct-2507 \
  --served-model-name qwen3-4b-instruct \
  --enable-lora --lora-modules lora_r16=/data/ckpt/lora_r16_v1 \
  --max-lora-rank 16 --max-model-len 8192 \
  --host 0.0.0.0 --port 8000
```

### ⑧ 评测 + 压测（40 分钟）

```bash
python eval/run_eval.py --eval training/data/processed/eval.jsonl --n 100 \
  --url-a http://127.0.0.1:8000/v1 --model-a qwen3-4b-instruct \
  --url-b http://127.0.0.1:8000/v1 --model-b lora_r16 \
  --judge-url http://127.0.0.1:8000/v1 --judge-model qwen3-4b-instruct \
  --out eval/report_v1.json

python eval/latency.py --url http://127.0.0.1:8000/v1 --model lora_r16 \
  --concurrency 1,4,8,16,32 --requests 40 --out eval/latency_report.json
```

### ⑨ 音色训练（40 分钟）

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS
# 下底模（约 3GB），然后
python GPT_SoVITS/prepare_datasets/1-get-text.py
python GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py
python GPT_SoVITS/s2_train.py --config configs/s2_yaya.json
python GPT_SoVITS/s1_train.py --config configs/s1_yaya.json
```

### ⑩ 关机器前：先把产物下回来 ⚠️

```bash
# 本地执行
scp -r user@host:/data/ckpt/lora_r16_v1 ./training/ckpt/
scp user@host:/data/project/eval/report_v1.json ./eval/
scp user@host:/data/project/eval/latency_report.json ./eval/
scp -r user@host:/data/models/sovits_yaya ./training/voice/model/
```

**漏拿产物等于白跑**。清单：

- [ ] `lora_r16_v1/`（adapter，约 50MB）
- [ ] `report_v1.json`（win-rate）
- [ ] `latency_report.json`（压测）
- [ ] 音色模型目录
- [ ] 训练日志（`trainer_state.json` 里的 loss 曲线）

---

## 0. 准备

```bash
# 基座（HF 原始权重，不是 MNN 导出的）
modelscope download --model Qwen/Qwen3-4B-Instruct-2507 --local_dir /data/models/Qwen3-4B-Instruct-2507

# 依赖
pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121
pip install -r training/requirements-training.txt

# 数据（从本地传，或 git clone 整个仓库）
scp -r training/data/processed user@gpu:/data/project/training/data/
```

## 1. 冒烟（10 分钟，验证环境）

```bash
python training/train_lora.py \
  --base /data/models/Qwen3-4B-Instruct-2507 \
  --train training/data/processed/train.jsonl \
  --eval  training/data/processed/eval.jsonl \
  --out /data/ckpt/smoke \
  --max-samples 20 --epochs 1
```

跑通再进下一步。显存应该在 14–18G。

## 2. 正式训练

```bash
python training/train_lora.py \
  --base /data/models/Qwen3-4B-Instruct-2507 \
  --train training/data/processed/train.jsonl \
  --eval  training/data/processed/eval.jsonl \
  --out /data/ckpt/lora_r16_v1 \
  --epochs 3 --bs 1 --grad-accum 8 --lr 2e-4 --r 16 --alpha 32
```

4090 24G 上大约 **3–5 小时**（2484 条 × 3 epoch）。

产物：`/data/ckpt/lora_r16_v1/`（adapter，几十 MB）

## 3. 合并

```bash
python training/merge_lora.py \
  --base /data/models/Qwen3-4B-Instruct-2507 \
  --lora /data/ckpt/lora_r16_v1 \
  --out  /data/models/qwen3-4b-roleplay
```

产物：约 8GB fp16，给 vLLM 和 MNN 导出用。

## 4. 起服务验证

```bash
vllm serve /data/models/qwen3-4b-roleplay \
  --served-model-name qwen3-4b-roleplay \
  --max-model-len 8192 --gpu-memory-utilization 0.85
```

然后本地把网关指向它：

```powershell
$env:INFERENCE_MODE="cloud"
$env:INFERENCE_BASE_URL="http://<gpu-ip>:8000/v1"
```

## 5. 评估（待补）

`eval/run_eval.py` 还没写，计划：
- base vs lora 的 win-rate（100 条，带置信区间）
- 角色一致性打分
- 退化检查（50 道通用题）

## 显存与时间参考

| 项 | 值 |
|---|---|
| 基座 | Qwen3-4B-Instruct-2507（4bit 加载） |
| 显存占用 | 14–18 GB |
| 单步耗时 | 约 1.2–1.8 s（bs1 × accum8） |
| 总时长 | 3–5 小时（2484 条 × 3 epoch） |
| adapter 大小 | 约 40–60 MB |

## 已知限制

1. **数据 90% 是单轮**（Muice），模型多轮承接会弱一些。先用 3 个代词/省略用例测，不行再补多轮数据。
2. **Muice 是 CC-BY-NC-4.0**：只能非商业使用，发布模型时 model card 必须写明。
3. 训练数据里的 system 是「沐雪」，推理时用「娅娅」也能生效（指令跟随），但风格会偏沐雪。
