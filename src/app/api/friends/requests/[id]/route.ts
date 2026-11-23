import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { broadcastToChatService, refreshChatRooms } from '@/lib/chat-service'
import { getOrCreateSingleConversation } from '@/lib/conversations'

/** 处理好友请求：接受 / 拒绝 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  const action = String(body?.action ?? '')

  const request = await db.friendship.findUnique({ where: { id } })
  if (!request || request.addresseeId !== me.id || request.status !== 'pending') {
    return NextResponse.json({ error: '请求不存在或已处理' }, { status: 404 })
  }

  if (action === 'reject') {
    await db.friendship.update({ where: { id }, data: { status: 'rejected' } })
    return NextResponse.json({ ok: true, action: 'rejected' })
  }

  if (action !== 'accept') {
    return NextResponse.json({ error: '无效的操作' }, { status: 400 })
  }

  await db.friendship.update({ where: { id }, data: { status: 'accepted' } })
  const conv = await getOrCreateSingleConversation(request.requesterId, me.id)

  await broadcastToChatService({
    userIds: [request.requesterId, me.id],
    event: 'friend:accepted',
    payload: { byUserId: me.id, conversationId: conv.id },
  })
  await refreshChatRooms([request.requesterId, me.id])

  return NextResponse.json({ ok: true, action: 'accepted', conversationId: conv.id })
}
