# 灵犀 IM · 带 AI 好友的实时聊天应用

> 一个可跑通的 IM 产品：前端 Next.js，后端自建推理网关，**AI 好友不是调 API，而是我自己微调的 4B 模型**，可选配自己训练的 GPT-SoVITS 音色。

**核心卖点**：从对话数据 → LoRA 微调 → 端侧/云端推理 → IM 产品接入，全链路自己实现。

---

## 功能

### IM 基础能力

| 模块 | 能力 |
| --- | --- |
| 账号 | 注册 / 登录，scrypt 加盐哈希，HTTP-only Cookie 会话 |
| 好友 | 搜索、申请、接受/拒绝、双向自动成为好友 |
| 会话 | 单聊、群聊（建群 / 邀请） |
| 实时 | Socket.io 消息即达、正在输入、在线状态 |
| 消息 | 未读计数、自动已读、历史分页、日期分隔、连续消息分组 |
| 可靠性 | 发送重试、断线重连补偿、消息幂等 |

### AI 好友（本项目重点）

| 能力 | 说明 |
| --- | --- |
| 流式回复 | SSE 逐字推送，前端打字机效果 |
| 角色扮演 | 微调后的 4B 模型，固定人设「沐雪」 |
| 双后端 | 端侧 MNN int4（离线）/ 云端 vLLM（快） |
| 智能路由 | 闲聊走端侧、知识型问题走云端 |
| 长期记忆 | 跨会话记住用户事实，关键词召回 + 时间衰减（[设计](docs/memory.md)） |
| 语音合成 | 自训练 GPT-SoVITS 音色（本地 CPU 可跑），可回退 edge-tts |

---

## 架构

```
┌─────────────────────────────────────────────┐
│  浏览器（Next.js 16 + React 19）              │
│  ├─ 聊天界面 / 好友列表 / 群聊               │
│  └─ Socket.io 客户端（实时消息 + 正在输入）   │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Next.js 服务端                              │
│  ├─ API 路由（Auth / 会话 / 消息）           │
│  ├─ Prisma + SQLite（用户、消息、会话）       │
│  └─ AI 好友编排（ai-agent.ts）               │
└───────────────┬─────────────────────────────┘
                │  SSE / JSON
┌───────────────▼─────────────────────────────┐
│  ai-gateway（FastAPI :9200）                 │
│  ├─ 无状态推理网关                            │
│  ├─ 路由：auto / device / cloud              │
│  └─ 统一 OpenAI 兼容协议                     │
└───────┬───────────────────────┬─────────────┘
        │                       │
┌───────▼────────┐    ┌─────────▼───────────┐
│ device :9000   │    │ cloud vLLM :8000     │
│ MNN 4B int4    │    │ 4B + LoRA（bf16）    │
│ 本地 CPU 推理  │    │ GPU 推理             │
└────────────────┘    └─────────────────────┘
```

---

## 自训练模型

| 模型 | 用途 | 数据 | 下载 |
| --- | --- | --- | --- |
| **沐雪 Qwen3-4B LoRA** | AI 好友对话 | 2474 条对话（CC-BY-NC） | [lora_v4_slim.tar.gz](https://github.com/973172915/im/releases/download/v1/lora_v4_slim.tar.gz) |
| **大肥鱼 GPT-SoVITS v2** | 语音合成音色 | 145 条语音 / 18.5 分钟（CC-BY-NC） | [voice_model_dafeiyu.tar.gz](https://github.com/973172915/im/releases/download/v1/voice_model_dafeiyu.tar.gz) |

> 两个模型均为非商业用途；权重放在 Release 里（Git 不适合托管大文件）。
> ModelScope 镜像页：`<MODEL_REPO_LORA>` / `<MODEL_REPO_VOICE>`（待补充）

### 对话模型要点

- 基座：Qwen3-4B-Instruct-2507，QLoRA 4bit（nf4 + double quant）
- 超参：r=8，alpha=16，lr=1e-4，2 epoch，cosine
- **关键修复**：`<|im_end|>` 必须计入 loss，否则模型不会停止（会无限重复）
- 效果：平均回复从 165 字降到 25 字，短句 + 人设稳定

### 音色模型要点

- 底模：GPT-SoVITS v2final
- 训练：SoVITS 10 epoch + GPT 10 epoch，单卡 A10 约 4 分钟
- 数据：145 条中文语音，统一 32kHz 单声道
- 输出：32kHz 合成音频，参考音频 3–10 秒

> 两个模型均为非商业用途（CC-BY-NC-4.0），音色数据来自 B 站 UP 主「尹紫鹭幻想社」。

---

## 快速开始

### 1. 安装依赖

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma db push
```

### 2. 初始化演示数据

```bash
npm run seed        # 创建演示账号与 AI 好友
```

### 3. 一键启动（推荐）

```powershell
.\scripts\dev\start-all.cmd     # 启动全部服务（等效于下面的 ps1，且不受执行策略限制）
.\scripts\dev\stop-all.cmd      # 停止全部服务

# 也可直接跑 ps1（若提示禁止运行脚本，先 Set-ExecutionPolicy -Scope CurrentUser RemoteSigned）
.\scripts\dev\start-all.ps1
```

脚本会依次拉起 6 个服务并打印状态：

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 9880 | GPT-SoVITS | 音色合成（CPU 加载约 4 分钟，最先启动） |
| 9100 | TTS 服务 | 封装音色引擎，失败回退 edge-tts |
| 9000 | device | MNN 4B int4 端侧推理 |
| 9200 | ai-gateway | 无状态推理网关 |
| 3003 | chat-service | Socket.io |
| 3000 | Next.js | 前端 |

日志在 `logs/`，PID 记录在 `.dev-pids.json`。也可 `-SkipVoice` 跳过语音。

### 4. 手动启动单个服务

```bash
npm run dev                          # 仅前端
cd services/ai_gateway && python app.py     # 仅网关（MOCK_AI=1 可无模型）
```

### 5. 接入真实模型（可选）

```bash
# 端侧：MNN 4B int4
MNN_MODEL_DIR=<模型目录> python -m uvicorn server:app --port 9000

# 云端：vLLM
vllm serve <模型目录> --port 8000

# 网关切到对应模式
INFERENCE_MODE=device   # 或 cloud / auto
DEVICE_BASE_URL=http://127.0.0.1:9000/v1
CLOUD_BASE_URL=http://127.0.0.1:8000/v1
```

---

## 演示账号

| 用户名 | 密码 | 昵称 |
| --- | --- | --- |
| `alice_demo` | `123456` | 灵儿 |
| `bob_demo` | `123456` | 小智 |

登录后好友列表里有 AI 好友「沐雪」，直接发消息即可。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 16、React 19、Tailwind CSS |
| 实时 | Socket.io |
| 数据 | Prisma + SQLite |
| 认证 | scrypt + HTTP-only Cookie |
| 推理网关 | FastAPI + SSE |
| 端侧推理 | MNN（int4 量化） |
| 云端推理 | vLLM |
| 微调 | transformers + PEFT（QLoRA） |
| 语音 | GPT-SoVITS / edge-tts |

---

## 目录结构

```
lingxi-im/
├── src/
│   ├── app/                 # Next.js 页面与 API 路由
│   ├── components/im/       # 聊天界面组件
│   ├── hooks/               # Socket.io 与状态钩子
│   ├── lib/
│   │   ├── ai-agent.ts      # AI 好友编排（流式）
│   │   ├── auth.ts          # 会话与密码
│   │   └── db.ts            # Prisma 客户端
│   └── store/               # 前端状态
├── prisma/schema.prisma     # 数据模型
├── mini-services/
│   └── chat-service/        # Socket.io 服务
├── services/                # 推理与语音服务（子模块）
├── scripts/                 # 种子数据与工具
└── docs/                    # 设计文档
```

---

## 已知限制

- AI 好友是小模型（4B），事实类问题会答错——这正是引入端云路由的原因
- 端侧推理约 11 tok/s，长回复较慢
- 语音合成在 CPU 上约 8–20 秒/句（GPU 可实时），已做文件缓存，重复文本秒出
- 演示数据为公开角色语料，模型不可商用

---

## 许可与致谢

- 代码：MIT
- 对话训练数据：[Muice](https://github.com/Muice-Project)（CC-BY-NC）
- 音色训练数据：`YinZilu/da-fei-yu-girl-voice-zh`（CC-BY-NC-4.0，尹紫鹭幻想社）
- 基座模型：Qwen3-4B-Instruct-2507（Apache-2.0）
- 语音框架：GPT-SoVITS（MIT）
