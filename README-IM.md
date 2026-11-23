# 灵犀 IM

心有灵犀，一触即达 —— 基于 Next.js 16 + Socket.io + Prisma(SQLite) 的实时即时通讯应用。

## 功能一览

- **账号体系**：用户名密码注册 / 登录，scrypt 加盐哈希，HTTP-only Cookie 会话（7 天有效）
- **好友系统**：搜索用户（用户名 / 昵称）、发送好友请求、接受 / 拒绝、互相申请自动成为好友
- **单聊 & 群聊**：一对一私聊、多人群聊（创建群、邀请好友进群）
- **实时通信**：消息即时送达、"正在输入…"提示、好友在线 / 离线状态
- **消息体验**：未读红点计数、自动已读、历史消息分页加载（向上滚动）、日期分隔线、连续消息分组
- **响应式界面**：桌面双栏布局，移动端单栏 + 返回导航

## 演示账号

| 用户名 | 密码 | 昵称 |
| --- | --- | --- |
| `alice_demo` | `123456` | 灵儿 |
| `bob_demo` | `123456` | 小智 |

> 体验实时聊天：在两个浏览器窗口分别登录两个账号（或注册新账号互加好友）。

## 技术架构

```
浏览器 (Next.js 前端, :3000)
  │  REST API（认证/好友/会话/消息持久化）
  │  WebSocket io('/?XTransformPort=3003')（实时事件）
  ▼
Caddy 网关 (:81)  ──按 XTransformPort 转发──►  chat-service (:3003, Socket.io)
                                                  ▲
Next.js API 路由 ────内部桥接 socket（广播消息）────┘
```

- **消息可靠性**：消息通过 REST 写入 SQLite 后，由 API 服务经内部桥接 socket 广播（房间 + 成员直发双保险，带 ack 确认与自动重连）
- **在线状态**：上线 / 下线广播 + 客户端主动查询（presence:query）双机制，避免错过广播
- **多端登录**：同一账号多个标签页可同时在线

## 目录结构

```
mini-services/chat-service/   Socket.io 实时服务（端口 3003）
prisma/schema.prisma          数据模型：User / Session / Friendship / Conversation / Message
src/app/api/                  REST API（auth / users / friends / conversations）
src/components/im/            前端组件（登录页、侧栏、聊天窗、对话框）
src/hooks/use-im-socket.ts    socket 连接与实时事件处理
src/store/im-store.ts         Zustand 全局状态
src/lib/                      API 客户端、会话查询、桥接通信等工具
scripts/seed-demo.ts          演示数据重置脚本
```

## 本地开发

```bash
# 1. 启动 Next.js（端口 3000）
bun run dev

# 2. 启动实时服务（端口 3003，独立目录）
cd mini-services/chat-service && bun run dev

# 3. （可选）重置演示数据
bun run scripts/seed-demo.ts
```

> 注意：chat-service 使用 `bun --watch`（进程级重启）。开发中修改该服务代码后，浏览器端最长约 20 秒（pingTimeout）自动重连，或刷新页面立即恢复。
