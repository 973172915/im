'use client'

import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { useIMStore } from '@/store/im-store'
import { api } from '@/lib/api'
import type { ChatMessage } from '@/lib/im-types'

/**
 * 建立 socket 连接并挂载所有实时事件处理。
 * 仅在已登录（me 存在）时连接。
 */
export function useSocket() {
  const me = useIMStore((s) => s.me)
  const token = useIMStore((s) => s.token)
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!me || !token) return

    // Never use PORT in the URL, always use XTransformPort
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      useIMStore.getState().setConnected(true)
      socket.emit('user:online', { token })
    })

    socket.on('disconnect', () => {
      useIMStore.getState().setConnected(false)
    })

    socket.on('auth:error', () => {
      useIMStore.getState().setConnected(false)
    })

    // 在线状态快照
    socket.on('presence:snapshot', (data: { onlineUserIds: string[] }) => {
      useIMStore.getState().setOnlineUserIds(data.onlineUserIds)
    })

    socket.on('presence:update', (data: { userId: string; online: boolean }) => {
      useIMStore.getState().setUserOnline(data.userId, data.online)
    })

    // 新消息
    socket.on('message:new', (data: { message: ChatMessage }) => {
      const store = useIMStore.getState()
      const message = data.message
      const activeConversationId = store.activeConversationId
      store.appendMessage(message)

      // 更新会话最后一条消息并按时间排序提前（一次 set 完成，避免旧引用覆盖）
      const updated = store.conversations
        .map((c) =>
          c.id === message.conversationId
            ? {
                ...c,
                lastMessage: {
                  id: message.id,
                  content: message.content,
                  senderId: message.senderId,
                  senderNickname: message.senderNickname,
                  createdAt: message.createdAt,
                },
                unreadCount:
                  message.senderId !== me.id && activeConversationId !== message.conversationId
                    ? c.unreadCount + 1
                    : c.unreadCount,
              }
            : c
        )
        .sort((a, b) => {
          const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : new Date(a.updatedAt).getTime()
          const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : new Date(b.updatedAt).getTime()
          return tb - ta
        })
      store.setConversations(updated)

      // 正在当前会话 → 自动已读
      if (activeConversationId === message.conversationId && message.senderId !== me.id) {
        void api.markRead(message.conversationId)
        useIMStore.getState().clearUnread(message.conversationId)
      }

      // 清除发送者的 typing 状态
      useIMStore.getState().setTyping(message.conversationId, message.senderId, message.senderNickname, false)
    })

    // AI 好友流式输出
    socket.on(
      'message:delta',
      (data: {
        conversationId: string
        agentId: string
        nickname: string
        avatarColor: string
        text: string
      }) => {
        if (!data?.conversationId || !data.text) return
        useIMStore.getState().appendStreaming(
          data.conversationId,
          { id: data.agentId, nickname: data.nickname, avatarColor: data.avatarColor || '#8b5cf6' },
          data.text
        )
      }
    )

    socket.on('message:done', (data: { conversationId: string }) => {
      if (!data?.conversationId) return
      // 给一个极短延迟，等 message:new 先落地，避免闪烁
      setTimeout(() => useIMStore.getState().clearStreaming(data.conversationId), 120)
    })

    // 正在输入
    socket.on(
      'typing:update',
      (data: { conversationId: string; userId: string; nickname: string; isTyping: boolean }) => {
        if (data.userId === me.id) return
        useIMStore.getState().setTyping(data.conversationId, data.userId, data.nickname, data.isTyping)
      }
    )

    // 好友请求 / 好友接受 / 新会话 → 刷新数据
    socket.on('friend:request', () => {
      void refreshFriendRequests()
      void refreshConversations()
    })

    socket.on('friend:accepted', () => {
      void refreshFriends()
      void refreshConversations()
      void refreshFriendRequests()
    })

    socket.on('conversation:new', () => {
      void refreshConversations()
      void refreshFriends()
    })

    socket.on('rooms:synced', () => {
      // 房间同步完成（无需处理，数据刷新由其它事件触发）
    })

    async function refreshConversations() {
      try {
        const { conversations } = await api.getConversations()
        useIMStore.getState().setConversations(conversations)
      } catch {
        /* ignore */
      }
    }

    async function refreshFriends() {
      try {
        const { friends } = await api.getFriends()
        useIMStore.getState().setFriends(friends)
      } catch {
        /* ignore */
      }
    }

    async function refreshFriendRequests() {
      try {
        const { requests } = await api.getFriendRequests()
        useIMStore.getState().setFriendRequests(requests)
      } catch {
        /* ignore */
      }
    }

    return () => {
      socket.disconnect()
      socketRef.current = null
      useIMStore.getState().setConnected(false)
    }
  }, [me, token])

  return socketRef
}

/** 数据或连接变化时主动同步一次在线状态（避免错过广播） */
export function usePresenceSync(socketRef: React.RefObject<Socket | null>) {
  const me = useIMStore((s) => s.me)
  const friends = useIMStore((s) => s.friends)
  const conversations = useIMStore((s) => s.conversations)
  const connected = useIMStore((s) => s.connected)

  useEffect(() => {
    if (!connected || !me) return
    const socket = socketRef.current
    if (!socket) return
    const ids = new Set<string>()
    for (const f of friends) ids.add(f.id)
    for (const c of conversations) {
      for (const m of c.members) {
        if (m.id !== me.id) ids.add(m.id)
      }
    }
    if (ids.size > 0) {
      socket.emit('presence:query', { userIds: Array.from(ids) })
    }
  }, [connected, me, friends, conversations, socketRef])
}
