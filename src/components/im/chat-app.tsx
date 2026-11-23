'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useSocket, usePresenceSync } from '@/hooks/use-im-socket'
import { Sidebar } from '@/components/im/sidebar'
import { ChatWindow } from '@/components/im/chat-window'
import {
  AddFriendDialog,
  FriendRequestsDialog,
  NewGroupDialog,
  InviteMembersDialog,
} from '@/components/im/dialogs'
import { api } from '@/lib/api'
import { useIMStore } from '@/store/im-store'
import { cn } from '@/lib/utils'

export function ChatApp() {
  const { toast } = useToast()
  const socketRef = useSocket()
  usePresenceSync(socketRef)

  const activeConversationId = useIMStore((s) => s.activeConversationId)
  const setActiveConversation = useIMStore((s) => s.setActiveConversation)
  const upsertConversation = useIMStore((s) => s.upsertConversation)

  // 移动端视图：列表 / 聊天
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list')

  // 对话框状态
  const [addFriendOpen, setAddFriendOpen] = useState(false)
  const [friendRequestsOpen, setFriendRequestsOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [inviteConversationId, setInviteConversationId] = useState<string | null>(null)

  // 初始数据加载
  useEffect(() => {
    const store = useIMStore.getState()
    void api
      .getConversations()
      .then(({ conversations }) => store.setConversations(conversations))
      .catch(() => null)
    void api
      .getFriends()
      .then(({ friends }) => store.setFriends(friends))
      .catch(() => null)
    void api
      .getFriendRequests()
      .then(({ requests }) => store.setFriendRequests(requests))
      .catch(() => null)
  }, [])

  // 全局 toast：网络请求错误
  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      if (e.message?.includes('fetch')) return
    }
    window.addEventListener('error', handler)
    return () => window.removeEventListener('error', handler)
  }, [])

  /** 打开（或创建）会话 */
  const openChat = useCallback(
    async (conversationId: string, friendUserId?: string) => {
      try {
        let convId = conversationId
        if (!convId && friendUserId) {
          // 从好友列表进入：创建/获取单聊会话
          const { conversation } = await api.createConversation({ type: 'single', userId: friendUserId })
          convId = conversation.id
          upsertConversation(conversation)
        }
        if (!convId) return
        setActiveConversation(convId)
        setMobileView('chat')
      } catch (e) {
        toast({
          title: '打开会话失败',
          description: e instanceof Error ? e.message : undefined,
          variant: 'destructive',
        })
      }
    },
    [setActiveConversation, upsertConversation, toast]
  )

  async function refreshAfterFriendChange() {
    const store = useIMStore.getState()
    try {
      const [{ conversations }, { friends }, { requests }] = await Promise.all([
        api.getConversations(),
        api.getFriends(),
        api.getFriendRequests(),
      ])
      store.setConversations(conversations)
      store.setFriends(friends)
      store.setFriendRequests(requests)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-stone-100">
      {/* 左侧边栏：移动端可切换 */}
      <div
        className={cn(
          'h-full w-full shrink-0 md:w-80',
          mobileView === 'chat' ? 'hidden md:block' : 'block'
        )}
      >
        <Sidebar
          onOpenAddFriend={() => setAddFriendOpen(true)}
          onOpenFriendRequests={() => setFriendRequestsOpen(true)}
          onOpenNewGroup={() => setNewGroupOpen(true)}
          onOpenChat={(convId, friendId) => void openChat(convId, friendId)}
        />
      </div>

      {/* 聊天区 */}
      <div
        className={cn(
          'min-w-0 flex-1',
          mobileView === 'list' ? 'hidden md:flex' : 'flex'
        )}
      >
        <ChatWindow
          socketRef={socketRef}
          onBack={() => setMobileView('list')}
          onInviteMembers={(id) => setInviteConversationId(id)}
        />
      </div>

      {/* 对话框 */}
      <AddFriendDialog
        open={addFriendOpen}
        onOpenChange={setAddFriendOpen}
        onAccepted={() => void refreshAfterFriendChange()}
      />
      <FriendRequestsDialog
        open={friendRequestsOpen}
        onOpenChange={setFriendRequestsOpen}
        onAccepted={() => void refreshAfterFriendChange()}
      />
      <NewGroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        onCreated={(conversationId) => void openChat(conversationId)}
      />
      <InviteMembersDialog
        open={inviteConversationId !== null}
        onOpenChange={(v) => !v && setInviteConversationId(null)}
        conversationId={inviteConversationId}
        onInvited={() => void refreshAfterFriendChange()}
      />
    </div>
  )
}
