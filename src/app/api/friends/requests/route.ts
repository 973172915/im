import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { broadcastToChatService, refreshChatRooms } from '@/lib/chat-service'
import { getOrCreateSingleConversation } from '@/lib/conversations'

/** 获取我收到的好友请求 */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const requests = await db.friendship.findMany({
    where: { addresseeId: me.id, status: 'pending' },
    include: { requester: true },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({
    requests: requests.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      requester: {
        id: r.requester.id,
        username: r.requester.username,
        nickname: r.requester.nickname,
        avatarColor: r.requester.avatarColor,
        bio: r.requester.bio,
      },
    })),
  })
}

/** 发送好友请求 */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const username = String(body?.username ?? '').trim()

  if (!username) {
    return NextResponse.json({ error: '请输入对方用户名' }, { status: 400 })
  }

  const target = await db.user.findUnique({ where: { username } })
  if (!target) {
    return NextResponse.json({ error: '未找到该用户' }, { status: 404 })
  }
  if (target.id === me.id) {
    return NextResponse.json({ error: '不能添加自己为好友' }, { status: 400 })
  }

  // 已是好友？
  const existingAccepted = await db.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: me.id, addresseeId: target.id },
        { requesterId: target.id, addresseeId: me.id },
      ],
    },
  })
  if (existingAccepted) {
    return NextResponse.json({ error: '你们已经是好友了' }, { status: 409 })
  }

  // 对方已向我发过请求 → 直接互相成为好友
  const incoming = await db.friendship.findFirst({
    where: { requesterId: target.id, addresseeId: me.id, status: 'pending' },
  })
  if (incoming) {
    await db.friendship.update({
      where: { id: incoming.id },
      data: { status: 'accepted' },
    })
    const conv = await getOrCreateSingleConversation(me.id, target.id)
    await broadcastToChatService({
      userIds: [me.id, target.id],
      event: 'friend:accepted',
      payload: { byUserId: me.id, conversationId: conv.id },
    })
    await refreshChatRooms([me.id, target.id])
    return NextResponse.json({ ok: true, autoAccepted: true, conversationId: conv.id })
  }

  // 我已发过请求？
  const outgoing = await db.friendship.findFirst({
    where: { requesterId: me.id, addresseeId: target.id },
  })
  if (outgoing && outgoing.status === 'pending') {
    return NextResponse.json({ error: '已发送过好友请求，请等待对方处理' }, { status: 409 })
  }

  if (outgoing) {
    // 之前被拒绝过，重新发起
    await db.friendship.update({
      where: { id: outgoing.id },
      data: { status: 'pending', createdAt: new Date() },
    })
  } else {
    await db.friendship.create({
      data: { requesterId: me.id, addresseeId: target.id, status: 'pending' },
    })
  }

  await broadcastToChatService({
    userIds: [target.id],
    event: 'friend:request',
    payload: { fromUserId: me.id, fromNickname: me.nickname },
  })

  return NextResponse.json({ ok: true })
}
