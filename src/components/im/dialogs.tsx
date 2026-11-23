'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Search, UserPlus, Check, X, Users } from 'lucide-react'
import { IMAvatar } from '@/components/im/im-avatar'
import { api } from '@/lib/api'
import { useIMStore } from '@/store/im-store'
import { cn } from '@/lib/utils'
import type { SearchUser } from '@/lib/im-types'

/* ---------------- 添加好友 ---------------- */
export function AddFriendDialog({
  open,
  onOpenChange,
  onAccepted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAccepted?: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SearchUser[]>([])
  const [searching, setSearching] = useState(false)
  const [sendingTo, setSendingTo] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<Set<string>>(new Set())
  const [searched, setSearched] = useState(false)
  const me = useIMStore((s) => s.me)

  useEffect(() => {
    if (!open) {
      setKeyword('')
      setResults([])
      setSearched(false)
      setSentTo(new Set())
    }
  }, [open])

  useEffect(() => {
    if (!keyword.trim()) {
      setResults([])
      setSearched(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      api
        .searchUsers(keyword.trim())
        .then(({ users }) => {
          setResults(users)
          setSearched(true)
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 350)
    return () => clearTimeout(timer)
  }, [keyword])

  async function sendRequest(u: SearchUser) {
    if (sendingTo) return
    setSendingTo(u.id)
    try {
      const res = await api.sendFriendRequest(u.username)
      if (res.autoAccepted) {
        setSentTo((prev) => new Set(prev).add(u.id))
        onAccepted?.()
      } else {
        setSentTo((prev) => new Set(prev).add(u.id))
      }
    } catch {
      /* 错误由全局处理 */
    } finally {
      setSendingTo(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-emerald-500" /> 添加好友
          </DialogTitle>
          <DialogDescription>输入用户名或昵称搜索用户，发送好友请求</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
          <Input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索用户名 / 昵称"
            className="pl-9"
          />
        </div>

        <ScrollArea className="h-72 rounded-lg border border-stone-100">
          {searching ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-sm text-stone-400">
              {searched && keyword ? '未找到相关用户' : '输入关键词开始搜索'}
            </div>
          ) : (
            <ul className="divide-y divide-stone-50 p-1">
              {results.map((u) => {
                const sent = sentTo.has(u.id) || u.hasOutgoingRequest
                return (
                  <li key={u.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-stone-50">
                    <IMAvatar nickname={u.nickname} color={u.avatarColor} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-stone-900">
                        {u.nickname}
                        {u.id === me?.id && <span className="ml-1 text-xs text-stone-400">（我）</span>}
                      </p>
                      <p className="truncate text-xs text-stone-400">@{u.username}</p>
                    </div>
                    {u.isFriend ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600">
                        <Check className="h-3.5 w-3.5" /> 已是好友
                      </span>
                    ) : sent ? (
                      <span className="text-xs text-stone-400">已发送</span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-8 bg-emerald-500 hover:bg-emerald-600"
                        disabled={sendingTo === u.id}
                        onClick={() => void sendRequest(u)}
                      >
                        {sendingTo === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '加好友'}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 好友请求列表 ---------------- */
export function FriendRequestsDialog({
  open,
  onOpenChange,
  onAccepted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAccepted?: () => void
}) {
  const requests = useIMStore((s) => s.friendRequests)
  const removeFriendRequest = useIMStore((s) => s.removeFriendRequest)
  const [processing, setProcessing] = useState<string | null>(null)

  async function respond(id: string, action: 'accept' | 'reject') {
    if (processing) return
    setProcessing(id)
    try {
      await api.respondFriendRequest(id, action)
      removeFriendRequest(id)
      if (action === 'accept') onAccepted?.()
    } catch {
      /* ignore */
    } finally {
      setProcessing(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-500" /> 好友请求
            {requests.length > 0 && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                {requests.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>处理其他人向你发送的好友请求</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-80 rounded-lg">
          {requests.length === 0 ? (
            <div className="py-10 text-center text-sm text-stone-400">暂无新的好友请求</div>
          ) : (
            <ul className="space-y-2 p-1">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-lg border border-stone-100 px-3 py-2.5">
                  <IMAvatar nickname={r.requester.nickname} color={r.requester.avatarColor} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-stone-900">{r.requester.nickname}</p>
                    <p className="truncate text-xs text-stone-400">
                      @{r.requester.username} 请求添加你为好友
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-8 bg-emerald-500 hover:bg-emerald-600"
                      disabled={processing === r.id}
                      onClick={() => void respond(r.id, 'accept')}
                    >
                      接受
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-stone-500"
                      disabled={processing === r.id}
                      onClick={() => void respond(r.id, 'reject')}
                    >
                      拒绝
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 创建群聊 ---------------- */
export function NewGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated?: (conversationId: string) => void
}) {
  const friends = useIMStore((s) => s.friends)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setName('')
      setSelected(new Set())
      setError('')
    }
  }, [open])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function create() {
    if (creating) return
    setError('')
    if (!name.trim()) {
      setError('请输入群聊名称')
      return
    }
    if (selected.size === 0) {
      setError('请至少选择一位好友')
      return
    }
    setCreating(true)
    try {
      const { conversation } = await api.createConversation({
        type: 'group',
        name: name.trim(),
        memberIds: Array.from(selected),
      })
      onCreated?.(conversation.id)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-500" /> 发起群聊
          </DialogTitle>
          <DialogDescription>选择好友，一起拉个群畅聊</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="群聊名称（1-30 字）"
            maxLength={30}
          />
          {friends.length === 0 ? (
            <div className="py-8 text-center text-sm text-stone-400">先去添加好友吧</div>
          ) : (
            <ScrollArea className="h-60 rounded-lg border border-stone-100">
              <ul className="divide-y divide-stone-50 p-1">
                {friends.map((f) => (
                  <li key={f.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-stone-50">
                      <Checkbox
                        checked={selected.has(f.id)}
                        onCheckedChange={() => toggle(f.id)}
                        className="data-[state=checked]:bg-emerald-500"
                      />
                      <IMAvatar nickname={f.nickname} color={f.avatarColor} size="sm" />
                      <span className="truncate text-sm text-stone-900">{f.nickname}</span>
                      <span className="ml-auto truncate text-xs text-stone-400">@{f.username}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
          <p className="text-xs text-stone-400">已选择 {selected.size} 位好友</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            取消
          </Button>
          <Button
            className="bg-emerald-500 hover:bg-emerald-600"
            onClick={() => void create()}
            disabled={creating || !name.trim() || selected.size === 0}
          >
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            创建群聊
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 邀请好友进群 ---------------- */
export function InviteMembersDialog({
  open,
  onOpenChange,
  conversationId,
  onInvited,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  conversationId: string | null
  onInvited?: () => void
}) {
  const friends = useIMStore((s) => s.friends)
  const conversations = useIMStore((s) => s.conversations)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState('')

  const conv = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId]
  )
  const memberIds = useMemo(() => new Set(conv?.members.map((m) => m.id) ?? []), [conv])
  const invitableFriends = useMemo(() => friends.filter((f) => !memberIds.has(f.id)), [friends, memberIds])

  useEffect(() => {
    if (!open) {
      setSelected(new Set())
      setError('')
    }
  }, [open])

  if (!conv) return null

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function invite() {
    if (!conversationId || inviting) return
    setInviting(true)
    setError('')
    try {
      await api.inviteMembers(conversationId, Array.from(selected))
      onInvited?.()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '邀请失败')
    } finally {
      setInviting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-emerald-500" /> 邀请好友加入「{conv.name}」
          </DialogTitle>
          <DialogDescription>选择好友加入群聊</DialogDescription>
        </DialogHeader>

        {invitableFriends.length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-400">
            好友都已在群里啦
          </div>
        ) : (
          <ScrollArea className="h-60 rounded-lg border border-stone-100">
            <ul className="divide-y divide-stone-50 p-1">
              {invitableFriends.map((f) => (
                <li key={f.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-stone-50">
                    <Checkbox
                      checked={selected.has(f.id)}
                      onCheckedChange={() => toggle(f.id)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <IMAvatar nickname={f.nickname} color={f.avatarColor} size="sm" />
                    <span className="truncate text-sm text-stone-900">{f.nickname}</span>
                    <span className="ml-auto truncate text-xs text-stone-400">@{f.username}</span>
                  </label>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={inviting}>
            取消
          </Button>
          <Button
            className="bg-emerald-500 hover:bg-emerald-600"
            onClick={() => void invite()}
            disabled={inviting || selected.size === 0}
          >
            {inviting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            邀请（{selected.size}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
