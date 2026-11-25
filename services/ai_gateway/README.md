# AI 推理服务

无状态的推理服务：调用方（Next.js）把「人设 + 对话历史」发过来，这里负责
选端/云、流式返回。**不存任何数据**。

## 启动

```bash
# 端侧（MNN，默认）
python services/ai_gateway/app.py            # 监听 9200

# 或指定端口/模式
PORT=9200 INFERENCE_MODE=auto \
DEVICE_BASE_URL=http://127.0.0.1:9000/v1 \
CLOUD_BASE_URL=http://gpu:8000/v1 \
python services/ai_gateway/app.py
```

## 接口

### POST /v1/reply

```json
{
  "messages": [{"role": "user", "content": "在吗"}],
  "persona": "你是一个名为沐雪的可爱AI女孩子",
  "session_id": "c_123",
  "max_tokens": 256,
  "temperature": 0.7,
  "privacy": false
}
```

SSE 返回：

```
data: {"type":"route","decision":"device","reasons":["默认端侧（12 token）"]}
data: {"type":"delta","text":"在呀"}
data: {"type":"done","usage":{"tokens":5,"ms":380},"decision":"device"}
```

错误：

```
data: {"type":"error","message":"RuntimeError: 推理服务返回 500: ..."}
```

### GET /healthz

```json
{"ok":true,"mode":"auto","device":{"url":"...","model":"..."},"cloud":{...}}
```

## 路由规则

| 模式 | 行为 |
|---|---|
| `device` | 全部走端侧 |
| `cloud` | 全部走云端 |
| `auto` | 隐私 → 端侧；上下文 > `CONTEXT_TOKEN_LIMIT` 且云端可用 → 云端；其余端侧 |

## 部署位置

```
Next.js ──HTTP/SSE──▶ ai-gateway ──▶ vLLM / MNN
                         │
                         └── 无状态，可水平扩展
```
