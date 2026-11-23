'use client'

import { create } from 'zustand'
import type {
  SessionUser,
  ConversationSummary,
  ChatMessage,
  FriendInfo,
  FriendRequest,
  TypingUser,
} from '@/lib/im-types'

interface IMState {
  // 认证
  me: SessionUser | null
  authChecked: boolean
  token: string | null

  // 数据
  conversations: ConversationSummary[]
  activeConversationId: string | null
  messages: Record<string, ChatMessage[]>
  hasMore: Record<string, boolean>
  loadingMessages: Record<string, boolean>
  friends: FriendInfo[]
  friendRequests: FriendRequest[]

  // 实时状态
  connected: boolean
  onlineUserIds: Set<string>
  typing: Record<string, TypingUser[]> // conversationId -> typing users
  sending: boolean

  // 操作
  setMe: (me: SessionUser | null) => void
  setAuthChecked: (v: boolean) => void
  setToken: (t: string | null) => void
  setConnected: (v: boolean) => void
  setConversations: (convs: ConversationSummary[]) => void
  upsertConversation: (conv: ConversationSummary) => void
  setActiveConversation: (id: string | null) => void
  setMessages: (conversationId: string, messages: ChatMessage[], hasMore: boolean) => void
  prependMessages: (conversationId: string, messages: ChatMessage[], hasMore: boolean) => void
  appendMessage: (message: ChatMessage) => void
  setLoadingMessages: (conversationId: string, v: boolean) => void
  setFriends: (friends: FriendInfo[]) => void
  setFriendRequests: (requests: FriendRequest[]) => void
  removeFriendRequest: (id: string) => void
  setOnlineUserIds: (ids: string[]) => void
  setUserOnline: (userId: string, online: boolean) => void
  setTyping: (conversationId: string, userId: string, nickname: string, isTyping: boolean) => void
  setSending: (v: boolean) => void
  clearUnread: (conversationId: string) => void
  reset: () => void
}

export const useIMStore = create<IMState>((set) => ({
  me: null,
  authChecked: false,
  token: null,

  conversations: [],
  activeConversationId: null,
  messages: {},
  hasMore: {},
  loadingMessages: {},
  friends: [],
  friendRequests: [],

  connected: false,
  onlineUserIds: new Set<string>(),
  typing: {},
  sending: false,

  setMe: (me) => set({ me }),
  setAuthChecked: (v) => set({ authChecked: v }),
  setToken: (t) => set({ token: t }),
  setConnected: (v) => set({ connected: v }),
  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (conv) =>
    set((state) => {
      const others = state.conversations.filter((c) => c.id !== conv.id)
      return { conversations: [conv, ...others] }
    }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setMessages: (conversationId, messages, hasMore) =>
    set((state) => ({
      messages: { ...state.messages, [conversationId]: messages },
      hasMore: { ...state.hasMore, [conversationId]: hasMore },
    })),
  prependMessages: (conversationId, older, hasMore) =>
    set((state) => {
      const existing = state.messages[conversationId] ?? []
      const existingIds = new Set(existing.map((m) => m.id))
      const deduped = older.filter((m) => !existingIds.has(m.id))
      return {
        messages: { ...state.messages, [conversationId]: [...deduped, ...existing] },
        hasMore: { ...state.hasMore, [conversationId]: hasMore },
      }
    }),
  appendMessage: (message) =>
    set((state) => {
      const list = state.messages[message.conversationId]
      // 消息列表未加载（用户没打开过该会话）则跳过，等打开时拉取
      if (!list) return state
      if (list.some((m) => m.id === message.id)) return state
      return {
        messages: { ...state.messages, [message.conversationId]: [...list, message] },
      }
    }),
  setLoadingMessages: (conversationId, v) =>
    set((state) => ({ loadingMessages: { ...state.loadingMessages, [conversationId]: v } })),
  setFriends: (friends) => set({ friends }),
  setFriendRequests: (requests) => set({ friendRequests: requests }),
  removeFriendRequest: (id) =>
    set((state) => ({ friendRequests: state.friendRequests.filter((r) => r.id !== id) })),
  setOnlineUserIds: (ids) => set({ onlineUserIds: new Set(ids) }),
  setUserOnline: (userId, online) =>
    set((state) => {
      const next = new Set(state.onlineUserIds)
      if (online) next.add(userId)
      else next.delete(userId)
      return { onlineUserIds: next }
    }),
  setTyping: (conversationId, userId, nickname, isTyping) =>
    set((state) => {
      const list = state.typing[conversationId] ?? []
      let next: TypingUser[]
      if (isTyping) {
        next = list.some((t) => t.userId === userId)
          ? list.map((t) => (t.userId === userId ? { ...t, at: Date.now() } : t))
          : [...list, { userId, nickname, at: Date.now() }]
      } else {
        next = list.filter((t) => t.userId !== userId)
      }
      return { typing: { ...state.typing, [conversationId]: next } }
    }),
  setSending: (v) => set({ sending: v }),
  clearUnread: (conversationId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: 0 } : c
      ),
    })),
  reset: () =>
    set({
      me: null,
      token: null,
      conversations: [],
      activeConversationId: null,
      messages: {},
      hasMore: {},
      loadingMessages: {},
      friends: [],
      friendRequests: [],
      connected: false,
      onlineUserIds: new Set<string>(),
      typing: {},
      sending: false,
    }),
}))
