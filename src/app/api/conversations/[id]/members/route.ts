import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { getConversationMemberIds } from '@/lib/conversations'
import { broadcastToChatService, refreshChatRooms } from '@/lib/chat-service'

/** 群聊邀请更多好友 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const { id } = await params
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { members: true },
  })
  if (!conversation) return NextResponse.json({ error: '会话不存在' }, { status: 404 })
  if (conversation.type !== 'group') {
    return NextResponse.json({ error: '仅群聊支持邀请成员' }, { status: 400 })
  }
  if (!conversation.members.some((m) => m.userId === me.id)) {
    return NextResponse.json({ error: '无权访问该会话' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const memberIds: string[] = Array.isArray(body?.memberIds) ? body.memberIds : []
  if (memberIds.length === 0) {
    return NextResponse.json({ error: '请选择要邀请的好友' }, { status: 400 })
  }

  const existing = new Set(conversation.members.map((m) => m.userId))
  const toAdd = memberIds.filter((uid) => !existing.has(uid))
  if (toAdd.length === 0) {
    return NextResponse.json({ error: '所选好友已在群聊中' }, { status: 400 })
  }

  await db.conversationMember.createMany({
    data: toAdd.map((uid) => ({ conversationId: id, userId: uid })),
  })

  const allMemberIds = await getConversationMemberIds(id)
  await broadcastToChatService({
    userIds: allMemberIds,
    event: 'conversation:new',
    payload: { conversationId: id, name: conversation.name },
  })
  await refreshChatRooms(allMemberIds)

  return NextResponse.json({ ok: true, addedCount: toAdd.length })
}
