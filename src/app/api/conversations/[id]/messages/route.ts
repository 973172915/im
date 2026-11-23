import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { broadcastToChatService } from '@/lib/chat-service'
import { getConversationMemberIds } from '@/lib/conversations'

async function assertMember(conversationId: string, userId: string) {
  const membership = await db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  })
  return Boolean(membership)
}

/** 消息历史（向上分页）：?before=<messageId>&limit=30 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const { id } = await params
  if (!(await assertMember(id, me.id))) {
    return NextResponse.json({ error: '无权访问该会话' }, { status: 403 })
  }

  const before = Number(req.nextUrl.searchParams.get('before') ?? 0)
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 30) || 30, 100)

  const messages = await db.message.findMany({
    where: {
      conversationId: id,
      ...(before > 0 ? { id: { lt: before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
    include: { sender: true },
  })

  return NextResponse.json({
    messages: messages
      .map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        senderNickname: m.sender.nickname,
        senderAvatarColor: m.sender.avatarColor,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }))
      .reverse(),
    hasMore: messages.length === limit,
  })
}

/** 发送消息（写库 + 实时广播） */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const { id } = await params
  if (!(await assertMember(id, me.id))) {
    return NextResponse.json({ error: '无权访问该会话' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  if (!content) return NextResponse.json({ error: '消息不能为空' }, { status: 400 })
  if (content.length > 2000) return NextResponse.json({ error: '消息过长（最多 2000 字）' }, { status: 400 })

  const message = await db.message.create({
    data: { conversationId: id, senderId: me.id, content },
    include: { sender: true },
  })

  // 发送者视为已读
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: me.id } },
    data: { lastReadAt: new Date() },
  })

  // 会话更新时间（用于排序）
  await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } })

  const payload = {
    message: {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderNickname: message.sender.nickname,
      senderAvatarColor: message.sender.avatarColor,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    },
  }

  // 广播给房间 + 直接广播给每个成员的 socket（双保险，避免房间同步竞态导致漏收）
  const memberIds = await getConversationMemberIds(id)
  await broadcastToChatService({
    room: `conv:${id}`,
    userIds: memberIds,
    event: 'message:new',
    payload,
  })

  return NextResponse.json(payload)
}
