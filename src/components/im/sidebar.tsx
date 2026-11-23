'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Search,
  MessageCircle,
  UserPlus,
  Users,
  Bell,
  LogOut,
  WifiOff,
  ScrollText,
} from 'lucide-react'
import { IMAvatar } from '@/components/im/im-avatar'
import { formatListTime } from '@/lib/im-utils'
import { api, setAuthToken } from '@/lib/api'
import { useIMStore } from '@/store/im-store'
import { cn } from '@/lib/utils'
import type { ConversationSummary } from '@/lib/im-types'

interface SidebarProps {
  onOpenAddFriend: () => void
  onOpenFriendRequests: () => void
  onOpenNewGroup: () => void
  onOpenChat: (conversationId: string, friendUserId?: string) => void
}

export function Sidebar({ onOpenAddFriend, onOpenFriendRequests, onOpenNewGroup, onOpenChat }: SidebarProps) {
  const me = useIMStore((s) => s.me)
  const conversations = useIMStore((s) => s.conversations)
  const friends = useIMStore((s) => s.friends)
  const friendRequests = useIMStore((s) => s.friendRequests)
  const onlineUserIds = useIMStore((s) => s.onlineUserIds)
  const connected = useIMStore((s) => s.connected)
  const activeConversationId = useIMStore((s) => s.activeConversationId)
  const reset = useIMStore((s) => s.reset)
  const typing = useIMStore((s) => s.typing)

  const [keyword, setKeyword] = useState('')

  const filteredConversations = useMemo(() => {
    if (!keyword.trim()) return conversations
    const kw = keyword.trim().toLowerCase()
    return conversations.filter((c) => {
      const name = conversationDisplayName(c, me?.id).toLowerCase()
      return name.includes(kw)
    })
  }, [conversations, keyword, me?.id])

  const filteredFriends = useMemo(() => {
    if (!keyword.trim()) return friends
    const kw = keyword.trim().toLowerCase()
    return friends.filter(
      (f) => f.nickname.toLowerCase().includes(kw) || f.username.toLowerCase().includes(kw)
    )
  }, [friends, keyword])

  function handleLogout() {
    // 经 api 客户端携带 Authorization 头，确保 Cookie 受限场景也能正确销毁会话
    void api
      .logout()
      .catch(() => null)
      .finally(() => {
        setAuthToken(null)
        reset()
      })
  }

  return (
    <aside className="flex h-full w-full flex-col border-r bg-stone-50/80 md:w-80">
      {/* 顶栏：个人信息 + 操作 */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <IMAvatar nickname={me?.nickname ?? '?'} color={me?.avatarColor ?? '#10b981'} size="md" online={connected} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-stone-900">{me?.nickname}</p>
          <p className="truncate text-xs text-stone-400">
            {connected ? `@${me?.username}` : (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <WifiOff className="h-3 w-3" /> 连接中断，重连中…
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="relative h-9 w-9 text-stone-500 hover:text-emerald-600"
            onClick={onOpenAddFriend}
            title="添加好友"
          >
            <UserPlus className="h-4.5 w-4.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="relative h-9 w-9 text-stone-500 hover:text-emerald-600"
            onClick={onOpenFriendRequests}
            title="好友请求"
          >
            <Bell className="h-4.5 w-4.5" />
            {friendRequests.length > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {friendRequests.length}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-stone-500 hover:text-emerald-600"
            onClick={onOpenNewGroup}
            title="发起群聊"
          >
            <Users className="h-4.5 w-4.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-stone-500 hover:text-red-500"
            onClick={handleLogout}
            title="退出登录"
          >
            <LogOut className="h-4.5 w-4.5" />
          </Button>
        </div>
      </div>

      {/* 搜索 */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索聊天或好友"
            className="h-9 rounded-full border-stone-200 bg-white pl-9 text-sm"
          />
        </div>
      </div>

      {/* 面板切换 */}
      <Tabs defaultValue="chats" className="flex min-h-0 flex-1 flex-col px-3">
        <TabsList className="grid h-9 w-full grid-cols-2 bg-stone-200/50">
          <TabsTrigger value="chats" className="text-xs">
            <MessageCircle className="mr-1 h-3.5 w-3.5" /> 聊天
          </TabsTrigger>
          <TabsTrigger value="friends" className="text-xs">
            <Users className="mr-1 h-3.5 w-3.5" /> 好友
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chats" className="mt-0 min-h-0 flex-1">
          <div className="h-full overflow-y-auto pb-4 pr-1 im-scrollbar">
            {filteredConversations.length === 0 ? (
              <EmptyHint
                icon={<MessageCircle className="h-8 w-8 text-stone-300" />}
                title="还没有聊天"
                desc="添加好友，开始你们的第一次对话吧"
                action={
                  <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-600 hover:bg-emerald-50" onClick={onOpenAddFriend}>
                    <UserPlus className="mr-1 h-3.5 w-3.5" /> 添加好友
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-0.5">
                {filteredConversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conv={conv}
                    myId={me?.id ?? ''}
                    active={conv.id === activeConversationId}
                    online={
                      conv.type === 'single'
                        ? onlineUserIds.has(conv.members.find((m) => m.id !== me?.id)?.id ?? '')
                        : null
                    }
                    typingUsers={(typing[conv.id] ?? []).map((t) => t.nickname)}
                    onClick={() => onOpenChat(conv.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="friends" className="mt-0 min-h-0 flex-1">
          <div className="h-full overflow-y-auto pb-4 pr-1 im-scrollbar">
            {filteredFriends.length === 0 ? (
              <EmptyHint
                icon={<Users className="h-8 w-8 text-stone-300" />}
                title="还没有好友"
                desc="通过用户名搜索并添加好友"
                action={
                  <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-600 hover:bg-emerald-50" onClick={onOpenAddFriend}>
                    <UserPlus className="mr-1 h-3.5 w-3.5" /> 添加好友
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-0.5">
                {filteredFriends.map((friend) => (
                  <li key={friend.id}>
                    <button
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                        'hover:bg-white hover:shadow-sm'
                      )}
                      onClick={() => onOpenChat(friend.conversationId ?? '', friend.conversationId ? undefined : friend.id)}
                    >
                      <IMAvatar
                        nickname={friend.nickname}
                        color={friend.avatarColor}
                        size="md"
                        online={onlineUserIds.has(friend.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-stone-900">{friend.nickname}</p>
                        <p className="truncate text-xs text-stone-400">@{friend.username}</p>
                      </div>
                      <span
                        className={cn(
                          'text-xs',
                          onlineUserIds.has(friend.id) ? 'text-emerald-500' : 'text-stone-300'
                        )}
                      >
                        {onlineUserIds.has(friend.id) ? '在线' : '离线'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  )
}

/** 会话显示名 */
export function conversationDisplayName(conv: ConversationSummary, myId?: string): string {
  if (conv.type === 'group') return conv.name ?? '群聊'
  const other = conv.members.find((m) => m.id !== myId)
  return other?.nickname ?? conv.members[0]?.nickname ?? '对话'
}

function ConversationItem({
  conv,
  myId,
  active,
  online,
  typingUsers,
  onClick,
}: {
  conv: ConversationSummary
  myId: string
  active: boolean
  online: boolean | null
  typingUsers: string[]
  onClick: () => void
}) {
  const name = conversationDisplayName(conv, myId)
  const other = conv.members.find((m) => m.id !== myId)
  const isTyping = typingUsers.length > 0

  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
          active ? 'bg-emerald-100/70 shadow-sm' : 'hover:bg-white hover:shadow-sm'
        )}
      >
        <IMAvatar
          nickname={name}
          color={conv.type === 'single' ? other?.avatarColor ?? conv.avatarColor : conv.avatarColor}
          size="lg"
          online={online}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-semibold text-stone-900">{name}</p>
            {conv.lastMessage && (
              <span className="shrink-0 text-[11px] text-stone-400">
                {formatListTime(conv.lastMessage.createdAt)}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            {isTyping ? (
              <p className="truncate text-xs font-medium text-emerald-600">
                {conv.type === 'group' ? `${typingUsers[0]} 正在输入…` : '正在输入…'}
              </p>
            ) : conv.lastMessage ? (
              <p className="truncate text-xs text-stone-500">
                {conv.type === 'group' && conv.lastMessage.senderId !== myId
                  ? `${conv.lastMessage.senderNickname.split(' ')[0]}：`
                  : conv.lastMessage.senderId === myId
                    ? '我：'
                    : ''}
                {conv.lastMessage.content}
              </p>
            ) : (
              <p className="truncate text-xs text-stone-400 italic">开始对话吧</p>
            )}
            {conv.unreadCount > 0 && (
              <Badge className="shrink-0 rounded-full bg-emerald-500 px-1.5 hover:bg-emerald-500">
                {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
              </Badge>
            )}
          </div>
        </div>
      </button>
    </li>
  )
}

function EmptyHint({
  icon,
  title,
  desc,
  action,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      {icon}
      <p className="text-sm font-medium text-stone-600">{title}</p>
      <p className="flex items-center gap-1 text-xs text-stone-400">
        <ScrollText className="h-3 w-3" /> {desc}
      </p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
