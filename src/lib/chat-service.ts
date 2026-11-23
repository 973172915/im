import { io, Socket } from 'socket.io-client'

const CHAT_SERVICE_URL = 'http://localhost:3003'
const INTERNAL_SECRET = 'im-internal-secret'

export interface BroadcastPayload {
  room?: string
  userIds?: string[]
  event: string
  payload: unknown
}

const globalForChat = globalThis as unknown as {
  internalChatSocket: Socket | undefined
}

function getInternalSocket(): Socket {
  if (!globalForChat.internalChatSocket) {
    const sock = io(CHAT_SERVICE_URL, {
      path: '/',
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionAttempts: Infinity,
      auth: { internal: true, secret: INTERNAL_SECRET },
    })
    sock.on('connect', () => console.log('[chat-service] internal bridge connected'))
    sock.on('disconnect', () => console.log('[chat-service] internal bridge disconnected'))
    sock.on('connect_error', (err) => console.error('[chat-service] bridge connect error:', err.message))
    globalForChat.internalChatSocket = sock
  }
  return globalForChat.internalChatSocket
}

function destroyInternalSocket() {
  const sock = globalForChat.internalChatSocket
  if (sock) {
    sock.removeAllListeners()
    sock.disconnect()
    globalForChat.internalChatSocket = undefined
  }
}

function waitForConnect(sock: Socket, timeoutMs = 3000): Promise<void> {
  if (sock.connected) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sock.off('connect', onConnect)
      resolve()
    }, timeoutMs)
    const onConnect = () => {
      clearTimeout(timer)
      resolve()
    }
    sock.once('connect', onConnect)
  })
}

/** 带 ack 的 emit；服务端 2 秒内未确认则返回 false */
function emitWithAck(sock: Socket, event: string, payload: unknown, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      sock.timeout(timeoutMs).emit(event, payload, (err: unknown) => {
        resolve(!err)
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * 通过 chat-service 广播事件。
 * ack 未确认（僵尸连接/热重载竞态）时自动重建桥接并重试一次。
 */
export async function broadcastToChatService(payload: BroadcastPayload): Promise<void> {
  try {
    let sock = getInternalSocket()
    await waitForConnect(sock, 1500)
    if (await emitWithAck(sock, 'internal:broadcast', payload)) return

    console.warn('[chat-service] broadcast ack timeout, rebuilding bridge and retrying')
    destroyInternalSocket()
    sock = getInternalSocket()
    await waitForConnect(sock, 4000)
    if (!(await emitWithAck(sock, 'internal:broadcast', payload))) {
      console.error('[chat-service] broadcast retry failed')
    }
  } catch (e) {
    console.error('[chat-service] broadcast failed:', e)
  }
}

/** 通知在线用户重新同步其会话房间（新会话/新成员加入后调用） */
export async function refreshChatRooms(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  try {
    let sock = getInternalSocket()
    await waitForConnect(sock, 1500)
    if (await emitWithAck(sock, 'internal:refresh-rooms', { userIds })) return

    console.warn('[chat-service] refresh-rooms ack timeout, rebuilding bridge and retrying')
    destroyInternalSocket()
    sock = getInternalSocket()
    await waitForConnect(sock, 4000)
    if (!(await emitWithAck(sock, 'internal:refresh-rooms', { userIds }))) {
      console.error('[chat-service] refresh-rooms retry failed')
    }
  } catch (e) {
    console.error('[chat-service] refresh-rooms failed:', e)
  }
}
