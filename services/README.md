# services

推理相关的四个独立服务，与前端同仓，但各自独立部署（都是无状态或弱状态）。

| 服务 | 端口 | 语言 | 职责 |
| --- | --- | --- | --- |
| `ai_gateway` | 9200 | Python / FastAPI | 统一推理入口，SSE 流式，端云路由与降级 |
| `device` | 9000 | Python / MNN | 端侧 4B int4 推理（Windows 用 `mnn_stream.exe` 子进程） |
| `voice` | 9100 | Python / FastAPI | 语音合成，引擎可切 edge-tts / GPT-SoVITS，带文件缓存 |
| `embed` | 9300 | Python / FastAPI | 文本向量（bge-small-zh-v1.5），供记忆语义召回 |

## 调用关系

```
Next.js (:3000)
   │  SSE
   ▼
ai_gateway (:9200)
   ├── device (:9000)   ← MNN 4B int4
   └── cloud  (:8000)   ← vLLM（可选）

Next.js (:3000)
   ├── voice (:9100) ──► GPT-SoVITS (:9880)  ← 自训练音色
   └── embed (:9300)                        ← 记忆召回
```

## 设计约定

- 所有服务**无业务数据库**，用户/消息存储在 Next.js 的 SQLite
- 服务失败不阻塞主流程：网关降级、语音回退 edge-tts、向量缺席时回退词法检索
- 每个服务都有 `/healthz`，启停脚本据此判断就绪

## 本地启动

在仓库根目录：

```powershell
.\scripts\dev\start-all.cmd     # 全部
.\scripts\dev\start-all.cmd -SkipVoice   # 跳过语音与向量服务
```

Python 环境不在仓库内（体积大），通过参数指定：

```powershell
.\scripts\dev\start-all.ps1 -MainPy "D:\venv\Scripts\python.exe" -VoicePy "D:\venv2\Scripts\python.exe"
```

## 依赖

各服务目录下均有 `requirements.txt`：

```bash
pip install -r services/ai_gateway/requirements.txt
```
