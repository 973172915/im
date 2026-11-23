import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { findSingleConversation } from '@/lib/conversations'

export async function GET() {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const friendships = await db.friendship.findMany({
    where: {
      status: 'accepted',
      OR: [{ requesterId: me.id }, { addresseeId: me.id }],
    },
    include: {
      requester: true,
      addressee: true,
    },
  })

  const friends = await Promise.all(
    friendships.map(async (f) => {
      const friend = f.requesterId === me.id ? f.addressee : f.requester
      const conv = await findSingleConversation(me.id, friend.id)
      return {
        id: friend.id,
        username: friend.username,
        nickname: friend.nickname,
        avatarColor: friend.avatarColor,
        bio: friend.bio,
        conversationId: conv?.id ?? null,
      }
    })
  )

  return NextResponse.json({ friends })
}
