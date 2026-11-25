import { createServer } from 'http'
import { Server, Socket } from 'socket.io'

const PORT = 3003
const NEXT_APP = 'http://localhost:3000'
const INTERNAL_SECRET = 'im-internal-secret'

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
})

// userId -> Set<socketId> （支持同一账号多端登录）
const onlineUsers = new Map<string, Set<string>>()
// socketId -> userId
const socketUser = new Map<string, string>()

interface VerifiedUser {
  valid: boolean
  userId?: string
  nickname?: string
  username?: string
}

/** 调 Next.js API 验证 token */
async function verifyToken(token: string): Promise<VerifiedUser> {
  try {
    const res = await fetch(`${NEXT_APP}/api/auth/verify?token=${encodeURIComponent(token)}`)
    if (!res.ok) return { valid: false }
    return await res.json()
  } catch {
    return { valid: false }
  }
}

interface UserOverview {
  conversationIds: string[]
  relatedUserIds: string[]
}

/** 获取用户会话概览（会话房间 + 相关用户），失败自动重试 */
async function getUserOverview(userId: string): Promise<UserOverview> {
  const empty: UserOverview = { conversationIds: [], relatedUserIds: [] }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${NEXT_APP}/api/internal/users/${userId}/overview`)
      if (!res.ok) return empty
      return await res.json()
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
    }
  }
  return empty
}

function socketsOf(userId: string): Socket[] {
  const ids = onlineUsers.get(userId)
  if (!ids) return []
  return Array.from(ids)
    .map((sid) => io.sockets.sockets.get(sid))
    .filter((s): s is Socket => Boolean(s))
}

/** 向指定用户集合的所有 socket 发事件 */
function emitToUsers(userIds: string[], event: string, payload: unknown) {
  const seen = new Set<string>()
  for (const uid of userIds) {
    if (seen.has(uid)) continue
    seen.add(uid)
    for (const sock of socketsOf(uid)) {
      sock.emit(event, payload)
    }
  }
}

/** 内部指令：广播事件（按房间或按用户） */
function handleBroadcast(data: {
  room?: string
  userIds?: string[]
  event: string
  payload: unknown
}) {
  if (!data?.event) return
  if (data.room) {
    io.to(data.room).emit(data.event, data.payload)
  }
  if (Array.isArray(data.userIds)) {
    emitToUsers(data.userIds, data.event, data.payload)
  }
}

/** 内部指令：通知在线用户重新同步会话房间 */
function handleRefreshRooms(data: { userIds?: string[] }) {
  const userIds = data?.userIds ?? []
  for (const uid of userIds) {
    for (const sock of socketsOf(uid)) {
      void syncUserRooms(sock, uid)
    }
  }
}

/** 同步用户会话房间 */
async function syncUserRooms(socket: Socket, userId: string) {
  const overview = await getUserOverview(userId)
  for (const convId of overview.conversationIds) {
    await socket.join(`conv:${convId}`)
  }
  socket.emit('rooms:synced', { conversationIds: overview.conversationIds })
  return overview
}

io.on('connection', (socket) => {
  const auth = (socket.handshake.auth ?? {}) as { internal?: boolean; secret?: string }

  // ---- 内部桥接 socket（Next.js API 服务）----
  if (auth.internal === true) {
    if (auth.secret !== INTERNAL_SECRET) {
      socket.disconnect(true)
      return
    }
    console.log('[chat] internal bridge connected:', socket.id)
    socket.on('internal:broadcast', (data: unknown, callback?: (res: unknown) => void) => {
      try {
        handleBroadcast(data as Parameters<typeof handleBroadcast>[0])
        if (typeof callback === 'function') callback({ ok: true })
      } catch (e) {
        if (typeof callback === 'function') callback({ ok: false, error: String(e) })
      }
    })
    socket.on('internal:refresh-rooms', (data: unknown, callback?: (res: unknown) => void) => {
      try {
        handleRefreshRooms(data as Parameters<typeof handleRefreshRooms>[0])
        if (typeof callback === 'function') callback({ ok: true })
      } catch (e) {
        if (typeof callback === 'function') callback({ ok: false, error: String(e) })
      }
    })
    socket.on('disconnect', () => console.log('[chat] internal bridge disconnected'))
    return
  }

  // ---- 普通用户 socket ----
  // 未认证的 socket 定时清理（30 秒内未认证断开）
  const authTimer = setTimeout(() => {
    if (!socketUser.has(socket.id)) socket.disconnect(true)
  }, 30000)

  socket.on('user:online', async (data: { token?: string }) => {
    const token = data?.token
    if (!token) {
      socket.emit('auth:error', { message: 'missing token' })
      return
    }
    const verified = await verifyToken(token)
    if (!verified.valid || !verified.userId) {
      socket.emit('auth:error', { message: 'invalid token' })
      return
    }
    clearTimeout(authTimer)

    const userId = verified.userId
    socket.data.userId = userId
    socket.data.nickname = verified.nickname
    socketUser.set(socket.id, userId)

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set())
    onlineUsers.get(userId)!.add(socket.id)

    const overview = await syncUserRooms(socket, userId)

    // 广播上线状态给相关用户
    emitToUsers(overview.relatedUserIds, 'presence:update', { userId, online: true })

    // 回报当前相关用户中谁在线（供刚上线的客户端渲染）
    const onlineRelated = overview.relatedUserIds.filter((uid) => onlineUsers.has(uid))
    socket.emit('presence:snapshot', { onlineUserIds: onlineRelated })

    console.log(
      `[chat] ${verified.nickname}(${verified.username}) online, sockets=${onlineUsers.get(userId)!.size}`
    )
  })

  // 主动查询指定用户的在线状态（解决错过广播的竞态）
  socket.on('presence:query', (data: { userIds?: string[] }) => {
    const userId = socketUser.get(socket.id)
    if (!userId || !Array.isArray(data?.userIds)) return
    const online = data.userIds.filter((uid) => uid !== userId && onlineUsers.has(uid))
    socket.emit('presence:snapshot', { onlineUserIds: online })
  })

  // 正在输入
  socket.on('typing', (data: { conversationId?: string; isTyping?: boolean }) => {
    const userId = socketUser.get(socket.id)
    if (!userId || !data?.conversationId) return
    socket.to(`conv:${data.conversationId}`).emit('typing:update', {
      conversationId: data.conversationId,
      userId,
      nickname: socket.data.nickname ?? '',
      isTyping: Boolean(data.isTyping),
    })
  })

  socket.on('disconnect', () => {
    clearTimeout(authTimer)
    const userId = socketUser.get(socket.id)
    if (!userId) return
    socketUser.delete(socket.id)

    const set = onlineUsers.get(userId)
    if (set) {
      set.delete(socket.id)
      if (set.size === 0) {
        onlineUsers.delete(userId)
        console.log(`[chat] user ${userId} offline`)
        // 广播下线状态（异步，不阻塞断开）
        void getUserOverview(userId).then((overview) => {
          if (overview.relatedUserIds.length === 0) return
          emitToUsers(overview.relatedUserIds, 'presence:update', { userId, online: false })
        })
      }
    }
  })

  socket.on('error', (error: unknown) => {
    console.error(`[chat] socket error (${socket.id}):`, error)
  })
})

httpServer.listen(PORT, () => {
  console.log(`[chat] Socket.io service running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[chat] SIGTERM, shutting down...')
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('[chat] SIGINT, shutting down...')
  httpServer.close(() => process.exit(0))
})
