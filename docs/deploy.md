# 部署说明

## 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | ≥ 20 |
| Python | ≥ 3.10（推理服务） |
| 数据库 | SQLite（内置，无需安装） |
| 可选 GPU | 跑 4B 模型时需要，纯演示可只用 MOCK |

## 一、最小启动（不需要 GPU）

```bash
# 1. 依赖
npm install

# 2. 环境变量
cp .env.example .env

# 3. 数据库
npx prisma generate
npx prisma db push

# 4. 演示数据（含账号与 AI 好友）
npm run seed

# 5. 启动前端
npm run dev          # http://localhost:3000
```

此时 AI 好友还不能回复，需要下面任选一种推理后端。

## 二、推理网关

### 方式 A：MOCK（只验证链路，不跑模型）

```bash
cd services/ai_gateway
pip install -r requirements.txt
MOCK_AI=1 python app.py        # :9200
```

网关返回预设回复，用于联调前端流式效果。

### 方式 B：端侧 MNN（离线，CPU 可跑）

```bash
# 需要先准备 int4 量化的 MNN 模型目录
cd services/device
pip install -r requirements.txt
MNN_MODEL_DIR=<模型目录> \
MNN_STREAM_EXE=<mnn_stream 可执行文件> \
python -m uvicorn server:app --host 127.0.0.1 --port 9000
```

预期速度：4B int4 在桌面 CPU 上约 11 tok/s。

### 方式 C：云端 vLLM（需要 GPU）

```bash
# 合并 LoRA 后得到完整模型目录
python merge_lora.py --base <基座> --lora <adapter> --out <merged>

# 起 vLLM
vllm serve <merged> --served-model-name qwen3-4b-roleplay --port 8000
```

预期速度：A10 上约 30–50 tok/s。

## 三、网关对接

编辑 `services/ai_gateway/.env`：

```bash
# 端侧
INFERENCE_MODE=device
DEVICE_BASE_URL=http://127.0.0.1:9000/v1
DEVICE_MODEL=qwen3-4b-roleplay

# 或云端
INFERENCE_MODE=cloud
CLOUD_BASE_URL=http://127.0.0.1:8000/v1
CLOUD_MODEL=qwen3-4b-roleplay

# 或自动路由
INFERENCE_MODE=auto
```

启动：

```bash
python app.py      # :9200
```

## 四、Socket 服务

```bash
cd mini-services/chat-service
npm install
npm run dev        # :3003
```

前端 `.env` 里的地址要与之一致。

## 五、语音合成（可选）

### edge-tts（默认，需联网）

无需部署，装好依赖即可。

### GPT-SoVITS（自训练音色）

```bash
# GPU 机器上
cd GPT-SoVITS
python api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

本地语音服务指向它：

```bash
TTS_ENGINE=sovits
SOVITS_API=http://<GPU机器>:9880
```

若 GPU 机器在远程且未开放端口，用 SSH 隧道：

```bash
ssh -L 9880:127.0.0.1:9880 <user>@<gpu-host>
```

## 六、验收检查

| 检查 | 期望 |
| --- | --- |
| `GET /api/auth/me` | 未登录返回 401 |
| 登录 `alice_demo / 123456` | 返回 token |
| 好友列表 | 有「沐雪」 |
| 发「在吗」 | 打字机效果出短回复 |
| `curl :9200/healthz` | `{"ok": true}` |
| `curl :9000/healthz` | `backend: mnn_stream` |

## 七、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| AI 不回 | 网关未启动 | 检查 `:9200` |
| 回复很久才出现 | 模型在 CPU 上推理 | 换 cloud 或减少 `max_tokens` |
| 中文乱码 | 终端编码 | 内容本身正确，仅显示问题 |
| Prisma 报数据库不存在 | 未执行 `db push` | 重跑 `npx prisma db push` |
| Socket 连不上 | chat-service 未启动 | 检查 `:3003` |
| 语音 400 | 参考音频不在 3–10 秒 | 换一段合格音频 |
