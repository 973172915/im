'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SendHorizontal,
  ArrowLeft,
  Users,
  UserRoundPlus,
  Loader2,
  MessageCircle,
} from 'lucide-react'
import { IMAvatar } from '@/components/im/im-avatar'
import { conversationDisplayName } from '@/components/im/sidebar'
import { formatDayDivider, formatMessageTime } from '@/lib/im-utils'
import { api } from '@/lib/api'
import { useIMStore } from '@/store/im-store'
import { cn } from '@/lib/utils'
import type { Socket } from 'socket.io-client'

interface ChatWindowProps {
  socketRef: React.RefObject<Socket | null>
  onBack: () => void
  onInviteMembers: (conversationId: string) => void
}

export function ChatWindow({ socketRef, onBack, onInviteMembers }: ChatWindowProps) {
  const me = useIMStore((s) => s.me)
  const activeConversationId = useIMStore((s) => s.activeConversationId)
  const conversations = useIMStore((s) => s.conversations)
  const messagesMap = useIMStore((s) => s.messages)
  const hasMoreMap = useIMStore((s) => s.hasMore)
  const loadingMap = useIMStore((s) => s.loadingMessages)
  const onlineUserIds = useIMStore((s) => s.onlineUserIds)
  const typingMap = useIMStore((s) => s.typing)
  const streamingMap = useIMStore((s) => s.streaming)
  const sending = useIMStore((s) => s.sending)

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastTypingSentAt = useRef(0)
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const atBottomRef = useRef(true)
  const openedOnceRef = useRef<Set<string>>(new Set())

  const conv = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )
  const messages = activeConversationId ? messagesMap[activeConversationId] : undefined
  const hasMore = activeConversationId ? hasMoreMap[activeConversationId] ?? false : false
  const loading = activeConversationId ? loadingMap[activeConversationId] ?? false : false
  const typingUsers = activeConversationId ? typingMap[activeConversationId] ?? [] : []
  const streaming = activeConversationId ? streamingMap[activeConversationId] : undefined

  const other = conv?.type === 'single' ? conv.members.find((m) => m.id !== me?.id) : null
  const displayName = conv ? conversationDisplayName(conv, me?.id) : ''

  // 切换会话时加载消息
  useEffect(() => {
    if (!activeConversationId || !conv) return
    const store = useIMStore.getState()

    if (messagesMap[activeConversationId]) {
      // 已加载过，滚到底部
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView())
      return
    }

    store.setLoadingMessages(activeConversationId, true)
    api
      .getMessages(activeConversationId)
      .then(({ messages, hasMore }) => {
        store.setMessages(activeConversationId, messages, hasMore)
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView())
      })
      .catch(() => {
        /* 打开失败保持空白 */
      })
      .finally(() => {
        store.setLoadingMessages(activeConversationId, false)
        openedOnceRef.current.add(activeConversationId)
      })

    // 标记已读
    if (conv.unreadCount > 0) {
      void api.markRead(activeConversationId)
      store.clearUnread(activeConversationId)
    }
  }, [activeConversationId, conv?.id, conv?.unreadCount])

  // 新消息到达 → 若在底部自动滚动
  const messageCount = messages?.length ?? 0
  useEffect(() => {
    if (atBottomRef.current) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }))
    }
  }, [messageCount, activeConversationId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottomRef.current = distanceToBottom < 120

    // 顶部触底加载更多
    if (el.scrollTop < 60 && activeConversationId && hasMore && !loading && messages && messages.length > 0) {
      const store = useIMStore.getState()
      const oldestId = messages[0]?.id
      const prevHeight = el.scrollHeight
      store.setLoadingMessages(activeConversationId, true)
      api
        .getMessages(activeConversationId, oldestId)
        .then(({ messages: older, hasMore }) => {
          store.prependMessages(activeConversationId, older, hasMore)
          // 保持滚动位置
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight
            }
          })
        })
        .catch(() => null)
        .finally(() => store.setLoadingMessages(activeConversationId, false))
    }
  }, [activeConversationId, hasMore, loading, messages])

  // typing 事件
  function emitTyping(isTyping: boolean) {
    if (!activeConversationId) return
    socketRef.current?.emit('typing', { conversationId: activeConversationId, isTyping })
  }

  function handleDraftChange(value: string) {
    setDraft(value)
    const now = Date.now()
    if (value.trim() && now - lastTypingSentAt.current > 2000) {
      lastTypingSentAt.current = now
      emitTyping(true)
    }
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current)
    typingStopTimer.current = setTimeout(() => emitTyping(false), 2500)
  }

  async function handleSend() {
    const content = draft.trim()
    if (!content || !activeConversationId || sending) return
    useIMStore.getState().setSending(true)
    try {
      const { message } = await api.sendMessage(activeConversationId, content)
      const store = useIMStore.getState()
      store.appendMessage(message)
      // 更新会话列表
      const current = store.conversations.find((c) => c.id === activeConversationId)
      if (current) {
        store.upsertConversation({
          ...current,
          lastMessage: {
            id: message.id,
            content: message.content,
            senderId: message.senderId,
            senderNickname: message.senderNickname,
            createdAt: message.createdAt,
          },
        })
      }
      setDraft('')
      emitTyping(false)
      atBottomRef.current = true
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }))
    } catch {
      // 错误由 toast 处理层抛出，这里静默
    } finally {
      useIMStore.getState().setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (!conv || !activeConversationId) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center bg-stone-100/50">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-stone-200/70">
          <MessageCircle className="h-9 w-9 text-stone-400" />
        </div>
        <p className="mt-4 text-sm text-stone-500">选择一个会话，开始聊天</p>
      </section>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-stone-100/50">
      {/* 头部 */}
      <header className="flex items-center gap-3 border-b bg-white/80 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" className="h-9 w-9 md:hidden" onClick={onBack} aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <IMAvatar
          nickname={displayName}
          color={conv.type === 'single' ? other?.avatarColor ?? conv.avatarColor : conv.avatarColor}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-stone-900">
            {displayName}
            {conv.type === 'group' && (
              <span className="ml-2 text-xs font-normal text-stone-400">（{conv.members.length}人）</span>
            )}
          </h2>
          {conv.type === 'single' ? (
            typingUsers.length > 0 ? (
              <p className="text-xs font-medium text-emerald-600">正在输入…</p>
            ) : (
              <p className={cn('text-xs', onlineUserIds.has(other?.id ?? '') ? 'text-emerald-500' : 'text-stone-400')}>
                {onlineUserIds.has(other?.id ?? '') ? '在线' : '离线'}
              </p>
            )
          ) : typingUsers.length > 0 ? (
            <p className="text-xs font-medium text-emerald-600">
              {typingUsers.map((t) => t.nickname).join('、')} 正在输入…
            </p>
          ) : (
            <p className="truncate text-xs text-stone-400">
              {conv.members.map((m) => m.nickname).join('、')}
            </p>
          )}
        </div>
        {conv.type === 'group' && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-stone-200 text-stone-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600"
            onClick={() => onInviteMembers(conv.id)}
          >
            <UserRoundPlus className="mr-1 h-3.5 w-3.5" /> 邀请
          </Button>
        )}
      </header>

      {/* 消息列表 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="im-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {loading && messages && messages.length > 0 && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-stone-400" />
          </div>
        )}
        {loading && !messages ? (
          <div className="space-y-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className={cn('flex gap-2', i % 3 === 0 && 'flex-row-reverse')}>
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-10 w-40 rounded-2xl" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {hasMore && !loading && (
              <p className="pb-3 text-center text-xs text-stone-400">向上滚动查看更早消息</p>
            )}
            <MessageList
              messages={messages ?? []}
              myId={me?.id ?? ''}
              convType={conv.type}
            />
            {/* AI 好友流式输出 */}
            {streaming && (
              <div className="mt-3 flex items-start gap-2">
                <div className="w-9 shrink-0">
                  <IMAvatar
                    nickname={streaming.nickname}
                    color={streaming.avatarColor}
                    size="sm"
                  />
                </div>
                <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-stone-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-stone-800 shadow-sm">
                  {streaming.text}
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-stone-400 align-middle" />
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* typing 指示（输入框上方） */}
      {typingUsers.length > 0 && (
        <div className="px-5 pb-1 text-xs text-emerald-600">
          <span className="animate-pulse">
            {conv.type === 'single'
              ? '对方正在输入…'
              : `${typingUsers.map((t) => t.nickname).join('、')} 正在输入…`}
          </span>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`发消息给 ${displayName}…（Enter 发送，Shift+Enter 换行）`}
            className="max-h-36 min-h-[44px] flex-1 resize-none rounded-xl border-stone-200 bg-stone-50 focus-visible:ring-emerald-400"
            rows={1}
          />
          <Button
            onClick={() => void handleSend()}
            disabled={!draft.trim() || sending}
            className="h-11 rounded-xl bg-emerald-500 px-4 hover:bg-emerald-600"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SendHorizontal className="h-4 w-4" />
            )}
            <span className="ml-1 hidden sm:inline">发送</span>
          </Button>
        </div>
      </div>
    </section>
  )
}

interface DecoratedMessage {
  msg: { id: number; senderId: string; senderNickname: string; senderAvatarColor: string; content: string; createdAt: string }
  mine: boolean
  day: string
  showDay: boolean
  showSender: boolean
  grouped: boolean
  showTime: boolean
}

/** 纯函数：计算每条消息的展示元数据（日期分割/分组/时间显示） */
function decorateMessages(
  messages: DecoratedMessage['msg'][],
  myId: string,
  convType: 'single' | 'group'
): DecoratedMessage[] {
  let prevDay = ''
  let prevSenderId = ''

  return messages.map((msg, idx) => {
    const day = formatDayDivider(msg.createdAt)
    const showDay = day !== prevDay
    const mine = msg.senderId === myId
    const nextMsg = messages[idx + 1]
    const grouped =
      !showDay && msg.senderId === prevSenderId && nextMsg && nextMsg.senderId === msg.senderId
    const showSender = !mine && convType === 'group' && msg.senderId !== prevSenderId
    const showTime =
      !nextMsg ||
      formatDayDivider(nextMsg.createdAt) !== day ||
      nextMsg.senderId !== msg.senderId ||
      showDay

    prevDay = day
    prevSenderId = msg.senderId

    return { msg, mine, day, showDay, showSender, grouped, showTime }
  })
}

function MessageList({
  messages,
  myId,
  convType,
}: {
  messages: DecoratedMessage['msg'][]
  myId: string
  convType: 'single' | 'group'
}) {
  const decorated = decorateMessages(messages, myId, convType)

  return (
    <div className="space-y-1">
      {messages.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm text-stone-400">还没有消息，打个招呼吧 👋</p>
        </div>
      )}
      {decorated.map(({ msg, mine, day, showDay, showSender, grouped, showTime }) => (
        <div key={msg.id}>
          {showDay && (
            <div className="flex justify-center py-3">
              <span className="rounded-full bg-stone-200/70 px-3 py-0.5 text-[11px] text-stone-500">
                {day}
              </span>
            </div>
          )}
          <div
            className={cn(
              'flex items-end gap-2',
              mine ? 'flex-row-reverse' : 'flex-row',
              grouped ? 'mt-0.5' : 'mt-3'
            )}
          >
            <div className="w-9 shrink-0">
              {!grouped && (
                <IMAvatar nickname={msg.senderNickname} color={msg.senderAvatarColor} size="sm" />
              )}
            </div>
            <div className={cn('flex max-w-[75%] flex-col', mine ? 'items-end' : 'items-start')}>
              {showSender && (
                <span className="mb-0.5 px-1 text-[11px] text-stone-400">{msg.senderNickname}</span>
              )}
              <div
                className={cn(
                  'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm',
                  mine
                    ? 'rounded-br-md bg-emerald-500 text-white'
                    : 'rounded-bl-md border border-stone-200 bg-white text-stone-800'
                )}
              >
                {msg.content}
              </div>
              {showTime && (
                <span className="mt-0.5 px-1 text-[10px] text-stone-400">
                  {formatMessageTime(msg.createdAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
