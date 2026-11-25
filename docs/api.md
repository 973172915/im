# API 文档

## 服务总览

| 服务 | 端口 | 协议 | 说明 |
| --- | --- | --- | --- |
| Next.js | 3000 | HTTP / SSE | 业务接口（认证、好友、会话、消息、记忆、语音代理） |
| chat-service | 3003 | WebSocket | 实时消息推送（Socket.io） |
| ai-gateway | 9200 | HTTP / SSE | 统一推理入口，端云路由 |
| device | 9000 | HTTP / SSE | 端侧 MNN 推理（OpenAI 兼容） |
| voice | 9100 | HTTP | 语音合成 |
| embed | 9300 | HTTP | 文本向量 |
| GPT-SoVITS | 9880 | HTTP | 音色推理（外部服务） |

## 通用约定

**Base URL**：`http://localhost:3000`

**鉴权**（二选一）：

```
Cookie: im_session=<token>        # 登录后自动下发（httpOnly）
Authorization: Bearer <token>     # 或显式头
```

**响应**：JSON（UTF-8）。时间统一 ISO 8601（`2026-11-25T22:00:00.000Z`）。

**错误**：

```json
{ "error": "未登录" }
```

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数错误 |
| 401 | 未登录 / token 失效 |
| 403 | 无权访问该资源 |
| 404 | 资源不存在 |
| 409 | 冲突（用户名已存在） |
| 500 | 服务器错误 |

---

## 一、认证

### POST /api/auth/register

注册。**新用户自动获得 AI 好友「沐雪」**。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| username | string | ✅ | 3–20 位字母/数字/下划线 |
| password | string | ✅ | 6–64 位 |
| nickname | string | ❌ | 默认同 username |

```json
// 响应
{
  "user": { "id": "...", "username": "alice", "nickname": "灵儿", "bio": "", "avatarColor": "#10b981" },
  "token": "2f2a4d19..."
}
```

### POST /api/auth/login

```json
// 请求
{ "username": "alice_demo", "password": "123456" }
// 响应：同注册
```

### POST /api/auth/logout

清除会话，返回 `{ "ok": true }`。

### GET /api/auth/me

当前用户，未登录返回 401。

```json
{ "user": { "id": "...", "username": "alice_demo", "nickname": "灵儿" } }
```

### GET /api/auth/verify?token=xxx

校验 token 是否有效（供 Socket 握手前检查）。

```json
{ "valid": true, "user": { ... } }
```

---

## 二、好友

### GET /api/friends

```json
{
  "friends": [
    { "id": "...", "username": "ai_muxue", "nickname": "沐雪", "avatarColor": "#8b5cf6",
      "bio": "住在雪里的 AI 女孩子", "conversationId": "..." }
  ]
}
```

### GET /api/friends/requests

收到的待处理请求。

```json
{ "requests": [ { "id": "...", "createdAt": "...", "requester": { "id": "...", "nickname": "小智" } } ] }
```

### POST /api/friends/requests

按用户名发起好友请求。

```json
{ "username": "bob_demo" }
```

互发的请求自动成为好友。

### PUT /api/friends/requests/:id

```json
{ "action": "accept" }   // 或 "reject"
// 响应
{ "ok": true, "action": "accepted" }
```

### GET /api/users/search?q=关键词

按用户名/昵称搜索。

```json
{
  "users": [
    { "id": "...", "username": "bob", "nickname": "小智",
      "isFriend": false, "hasOutgoingRequest": false, "hasIncomingRequest": false }
  ]
}
```

---

## 三、会话与消息

### GET /api/conversations

```json
{
  "conversations": [
    {
      "id": "...", "type": "single", "name": null, "avatarColor": "#8b5cf6",
      "members": [ { "id": "...", "username": "alice_demo", "nickname": "灵儿" } ],
      "lastMessage": { "id": 58, "content": "在哦", "senderId": "...", "createdAt": "..." },
      "unreadCount": 2,
      "updatedAt": "..."
    }
  ]
}
```

### POST /api/conversations

创建会话（单聊已存在则返回已有的）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| type | `single` \| `group` | ✅ | |
| memberIds | string[] | ✅ | 其他成员 id |
| name | string | 群聊必填 | |

```json
{ "conversation": { "id": "...", "type": "single", "members": [...] } }
```

### POST /api/conversations/:id/members

拉人进群。

```json
{ "memberIds": ["...", "..."] }
```

### GET /api/conversations/:id/messages

分页拉历史（按 id 倒序取，返回正序）。

| 查询参数 | 默认 | 说明 |
| --- | --- | --- |
| before | 0 | 取 id < before 的消息（向上翻页） |
| limit | 30 | 最大 100 |

```json
{
  "messages": [
    { "id": 59, "conversationId": "...", "senderId": "...", "senderNickname": "灵儿",
      "senderAvatarColor": "#10b981", "senderKind": "human", "content": "在吗", "createdAt": "..." }
  ],
  "hasMore": true
}
```

> `senderKind` 为 `ai` 时，前端展示「朗读」按钮。

### POST /api/conversations/:id/messages

发送消息。写库后立即广播 `message:new`；**若会话内有 AI 成员，异步触发生成**。

```json
{ "content": "在吗" }
```

```json
// 响应
{ "message": { "id": 61, "content": "在吗", "senderId": "...", "createdAt": "..." } }
```

限制：content 不能为空，最长 2000 字。

### POST /api/conversations/:id/read

标记已读（无请求体），`lastReadAt = now`。

```json
{ "ok": true }
```

---

## 四、AI 能力

### GET /api/memory

查看当前用户的长期记忆（含召回统计）。

```json
{
  "count": 2,
  "items": [
    { "id": "...", "scope": "user", "kind": "fact",
      "content": "最近经常加班或熬夜，比较累",
      "keywords": "加班 熬夜 通宵 累 工作 上班",
      "confidence": 0.9, "expiresAt": "2026-12-09T...", "createdAt": "...",
      "lastUsedAt": "...", "usedCount": 3 }
  ]
}
```

### DELETE /api/memory

清空当前用户记忆。

```json
{ "deleted": 2 }
```

### GET /api/tts?text=...&voice=...

语音合成代理（服务端转发到 `voice:9100`，需登录）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| text | ✅ | 最长 300 字 |
| voice | ❌ | 音色 id，默认 `dafeiyu` |

响应：`audio/wav` 或 `audio/mpeg`（取决于 TTS 引擎）。

---

## 五、实时事件（Socket.io）

连接：`io("http://localhost:3003")`，连接后发送 `user:online` 携带 token。

| 方向 | 事件 | 载荷 |
| --- | --- | --- |
| C→S | `user:online` | `{ token }` |
| C→S | `typing` | `{ conversationId, isTyping }` |
| C→S | `presence:query` | `{ userIds }` |
| S→C | `presence:snapshot` | `{ onlineUserIds }` |
| S→C | `presence:update` | `{ userId, online }` |
| S→C | `typing:update` | `{ conversationId, userId, nickname, isTyping }` |
| S→C | `message:new` | `{ message }` |
| S→C | `message:delta` | `{ conversationId, agentId, nickname, avatarColor, text }` |
| S→C | `message:done` | `{ conversationId, agentId }` |
| S→C | `conversation:new` | `{ conversationId }` |
| S→C | `auth:error` | — |

---

## 六、推理服务

### ai-gateway（9200）

**POST /v1/reply** —— SSE 流式回复。

```json
{
  "messages": [ { "role": "user", "content": "在吗" } ],
  "persona": "你是一个名为沐雪的可爱AI女孩子",
  "session_id": "conv-id",
  "max_tokens": 256,
  "temperature": 0.7,
  "privacy": false
}
```

响应（`text/event-stream`）：

```
data: {"type":"route","decision":"device","reasons":["强制端侧"]}

data: {"type":"delta","text":"在"}

data: {"type":"delta","text":"哦"}

data: {"type":"done","decision":"device","tokens":12}
```

| 事件 | 说明 |
| --- | --- |
| `route` | 本次路由决策（device / cloud）及原因 |
| `delta` | 增量文本 |
| `done` | 结束，含 token 数 |
| `error` | 出错原因 |

**GET /v1/models**：可用模型列表。**GET /healthz**：健康检查。

### device（9000）

OpenAI 兼容：**POST /v1/chat/completions**（`stream: true` 时 SSE）。

```json
{ "model": "qwen3-4b-roleplay", "messages": [{"role":"user","content":"在吗"}], "max_tokens": 64 }
```

**GET /v1/models**、**GET /healthz**（返回 `model_dir`、`backend`）。

### voice（9100）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/tts` | `{ text, voice? }` → 整段音频 |
| GET | `/api/tts?text=&voice=` | 流式返回（边合成边下） |
| GET | `/api/voices` | 可用音色 |
| GET | `/healthz` | `{ ok, engine, media_type, sovits }` |

### embed（9300）

**POST /embed** → 向量。

```json
{ "texts": ["想养只猫"] }
// {"vectors": [[0.012, -0.034, ...]]}   512 维，已 L2 归一化
```

**GET /healthz** → `{ ok, model, dim }`。

---

## 七、调用示例

```bash
BASE=http://localhost:3000

# 1. 登录
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice_demo","password":"123456"}' | jq -r .token)

# 2. 找和沐雪的会话
CONV=$(curl -s $BASE/api/conversations -H "Authorization: Bearer $TOKEN" \
  | jq -r '.conversations[] | select(.members[].nickname=="沐雪") | .id' | head -1)

# 3. 发消息（AI 异步回复，通过 Socket 推送）
curl -s -X POST $BASE/api/conversations/$CONV/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"在吗"}'

# 4. 合成语音
curl -s "$BASE/api/tts?text=%E5%9C%A8%E5%93%A6" -H "Authorization: Bearer $TOKEN" -o reply.wav
```

## 八、说明

- 接口无版本前缀（`/api/...`），业务迭代以仓库 git 历史为准
- Python 服务自带 Swagger：`http://localhost:<port>/docs`
- 记忆与检索的实现细节见 [`docs/memory.md`](memory.md) 与 [`docs/context.md`](context.md)
