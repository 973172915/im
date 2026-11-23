import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { listConversationsForUser, getOrCreateSingleConversation, getConversationMemberIds } from '@/lib/conversations'
import { broadcastToChatService, refreshChatRooms } from '@/lib/chat-service'

const GROUP_COLORS = ['#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16']

/** 会话列表 */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const conversations = await listConversationsForUser(me.id)
  return NextResponse.json({ conversations })
}

/** 创建会话：type=single（与好友的单聊）或 type=group（新建群聊） */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const type = String(body?.type ?? 'single')

  if (type === 'single') {
    const userId = String(body?.userId ?? '')
    const target = await db.user.findUnique({ where: { id: userId } })
    if (!target) return NextResponse.json({ error: '用户不存在' }, { status: 404 })

    // 仅允许与好友单聊
    const friendship = await db.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: me.id, addresseeId: userId },
          { requesterId: userId, addresseeId: me.id },
        ],
      },
    })
    if (!friendship) {
      return NextResponse.json({ error: '你们还不是好友' }, { status: 403 })
    }

    const conv = await getOrCreateSingleConversation(me.id, userId)
    await refreshChatRooms([me.id, userId])
    const conversations = await listConversationsForUser(me.id)
    const summary = conversations.find((c) => c.id === conv.id)
    return NextResponse.json({ conversation: summary })
  }

  if (type === 'group') {
    const name = String(body?.name ?? '').trim()
    const memberIds: string[] = Array.isArray(body?.memberIds) ? body.memberIds : []

    if (!name || name.length > 30) {
      return NextResponse.json({ error: '请输入 1-30 字的群聊名称' }, { status: 400 })
    }
    if (memberIds.length === 0) {
      return NextResponse.json({ error: '请至少选择一位好友' }, { status: 400 })
    }

    // 校验成员均为好友
    const friendships = await db.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: me.id, addresseeId: { in: memberIds } },
          { requesterId: { in: memberIds }, addresseeId: me.id },
        ],
      },
    })
    const friendIds = new Set(
      friendships.map((f) => (f.requesterId === me.id ? f.addresseeId : f.requesterId))
    )
    const validMembers = memberIds.filter((id) => friendIds.has(id))
    if (validMembers.length === 0) {
      return NextResponse.json({ error: '所选成员均不是好友' }, { status: 400 })
    }

    const conv = await db.conversation.create({
      data: {
        type: 'group',
        name,
        avatarColor: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
        createdById: me.id,
        members: {
          create: [{ userId: me.id }, ...validMembers.map((uid) => ({ userId: uid }))],
        },
      },
    })

    const allMemberIds = await getConversationMemberIds(conv.id)
    await broadcastToChatService({
      userIds: allMemberIds,
      event: 'conversation:new',
      payload: { conversationId: conv.id, name },
    })
    await refreshChatRooms(allMemberIds)

    const conversations = await listConversationsForUser(me.id)
    const summary = conversations.find((c) => c.id === conv.id)
    return NextResponse.json({ conversation: summary })
  }

  return NextResponse.json({ error: '无效的会话类型' }, { status: 400 })
}
