'use client'

import type {
  ConversationSummary,
  ChatMessage,
  FriendInfo,
  FriendRequest,
  SearchUser,
  SessionUser,
} from '@/lib/im-types'

const TOKEN_KEY = 'im_token'

/** 将会话 token 持久化到 localStorage（第三方 Cookie 受限时的主认证手段） */
export function setAuthToken(token: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** 所有请求自动携带 Authorization 头，兼容 iframe 内嵌等 Cookie 受限场景 */
function authHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options?.headers ?? {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `请求失败 (${res.status})`)
  }
  return data as T
}

export const api = {
  register: (body: { username: string; password: string; nickname?: string }) =>
    request<{ user: SessionUser; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  login: (body: { username: string; password: string }) =>
    request<{ user: SessionUser; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: SessionUser }>('/api/auth/me'),

  searchUsers: (q: string) =>
    request<{ users: SearchUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`),

  getFriends: () => request<{ friends: FriendInfo[] }>('/api/friends'),

  getFriendRequests: () => request<{ requests: FriendRequest[] }>('/api/friends/requests'),

  sendFriendRequest: (username: string) =>
    request<{ ok: boolean; autoAccepted?: boolean; conversationId?: string }>(
      '/api/friends/requests',
      { method: 'POST', body: JSON.stringify({ username }) }
    ),

  respondFriendRequest: (id: string, action: 'accept' | 'reject') =>
    request<{ ok: boolean; action: string; conversationId?: string }>(
      `/api/friends/requests/${id}`,
      { method: 'PUT', body: JSON.stringify({ action }) }
    ),

  getConversations: () =>
    request<{ conversations: ConversationSummary[] }>('/api/conversations'),

  createConversation: (body: { type: 'single'; userId: string } | { type: 'group'; name: string; memberIds: string[] }) =>
    request<{ conversation: ConversationSummary }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  inviteMembers: (conversationId: string, memberIds: string[]) =>
    request<{ ok: boolean; addedCount: number }>(`/api/conversations/${conversationId}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),

  getMessages: (conversationId: string, before?: number) =>
    request<{ messages: ChatMessage[]; hasMore: boolean }>(
      `/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`
    ),

  sendMessage: (conversationId: string, content: string) =>
    request<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  markRead: (conversationId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${conversationId}/read`, { method: 'POST' }),
}
