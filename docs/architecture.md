# 架构设计

## 1. 分层

```
浏览器 ──HTTP──> Next.js API ──Prisma──> SQLite
   │                    │
   └──WebSocket──> chat-service (Socket.io) :3003
                        ▲
                        │ 广播
                   ai-agent.ts
                        │ SSE
                   ai-gateway :9200
                    ├── device :9000（MNN int4）
                    └── cloud  :8000（vLLM）
```

| 层 | 职责 | 是否持久化 |
| --- | --- | --- |
| Next.js | 页面、API、AI 编排 | 是（SQLite） |
| chat-service | Socket.io 连接管理与广播 | 否（无状态） |
| ai-gateway | 推理协议转换、路由 | 否（无状态） |
| device / cloud | 模型推理 | 否 |

**设计原则**：只有 Next.js 碰数据库，其余服务都是无状态的，可以随时重启/横向扩容。

## 2. 数据模型

```
User          id, username, passwordHash, nickname, kind(student|ai), persona, model
FriendRequest fromUserId, toUserId, status
Friendship    userId, friendId
Conversation  id, type(single|group), name, updatedAt
Member        conversationId, userId, lastReadAt
Message       id, conversationId, senderId, content, clientMsgId, createdAt
```

`User.kind = 'ai'` 的好友会被 `ai-agent` 接管：用户发消息后，异步触发生成并回复。

## 3. 一条消息的完整链路

```
1. 用户发送
   POST /api/conversations/:id/messages { content, clientMsgId }
   → 写 Message 表
   → Socket 广播 message:new 给会话内所有人
   → 若会话里有 kind=ai 的成员，异步触发 ai-agent

2. AI 生成（流式）
   ai-agent: 读最近 N 条消息 → POST ai-gateway /v1/reply (SSE)
   gateway: 决定 device / cloud → 转发并透传 token 流

3. 前端渲染
   socket.on('message:delta') → 追加到当前气泡（打字机效果）
   socket.on('message:done')  → 收起"正在输入"

4. 落库
   ai-agent 在流结束后写一次 Message（完整内容）
   再广播 message:new（正式消息）
```

为什么要"先 delta 后 new"：delta 只更新 UI 的临时气泡，落库后才成为正式消息，避免半截消息污染历史。

## 4. 端云路由

gateway 的 `decide()` 按模式决定后端：

| 模式 | 行为 |
| --- | --- |
| `device` | 全部走本地 MNN，离线可用，约 11 tok/s |
| `cloud` | 全部走 vLLM，约 30–50 tok/s |
| `auto` | 按规则分流：寒暄/情绪 → device；知识/算术 → cloud |

路由存在的理由：4B 小模型的强项是"像人"，弱项是事实与计算。
把两类请求分开，能同时拿到"有性格"和"答得准"。

失败降级：cloud 不可用时自动回落 device（反之亦然），保证始终有回复。

## 5. 可靠性

| 场景 | 处理 |
| --- | --- |
| 网络抖动导致发送失败 | 前端保留草稿 + 重试按钮 |
| 重复提交 | `clientMsgId` 幂等去重 |
| 断线期间漏消息 | 重连后按 `lastReadAt` 拉取增量 |
| AI 服务不可用 | 网关降级 + 前端提示 |
| 流中断 | 已生成的 partial 内容仍落库，标注未完成 |

## 6. 认证

- 密码：`scrypt(password, salt)`，不存明文
- 会话：登录后签发 token，写入 HTTP-only Cookie（7 天）
- Socket：握手时带 token，服务端校验后才允许订阅会话
- API：每次请求校验 Cookie 或 `Authorization: Bearer`

## 7. 为什么不用现成的 IM 方案

| 方案 | 不选的原因 |
| --- | --- |
| 直接调 OpenAI/DeepSeek API | 体现不出"训练和部署"能力 |
| 用 Supabase/Firebase | 存储层不可控，也不练 Prisma 建模 |
| 用第三方 IM SDK | 同上，且消息模型无法自定义 AI 行为 |

自建的代价是代码量大，好处是**每一层都能讲清楚**。
