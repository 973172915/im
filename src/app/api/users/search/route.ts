import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) return NextResponse.json({ users: [] })

  const users = await db.user.findMany({
    where: {
      id: { not: me.id },
      OR: [{ username: { contains: q } }, { nickname: { contains: q } }],
    },
    select: { id: true, username: true, nickname: true, avatarColor: true, bio: true },
    take: 20,
  })

  // 附加好友/请求状态，便于前端展示
  const friendships = await db.friendship.findMany({
    where: {
      OR: [{ requesterId: me.id }, { addresseeId: me.id }],
      status: { in: ['pending', 'accepted'] },
    },
  })

  const relationMap = new Map<string, { status: string; direction: 'outgoing' | 'incoming' }>()
  for (const f of friendships) {
    const otherId = f.requesterId === me.id ? f.addresseeId : f.requesterId
    relationMap.set(otherId, {
      status: f.status,
      direction: f.requesterId === me.id ? 'outgoing' : 'incoming',
    })
  }

  return NextResponse.json({
    users: users.map((u) => {
      const rel = relationMap.get(u.id)
      return {
        ...u,
        isFriend: rel?.status === 'accepted',
        hasOutgoingRequest: rel?.status === 'pending' && rel?.direction === 'outgoing',
        hasIncomingRequest: rel?.status === 'pending' && rel?.direction === 'incoming',
      }
    }),
  })
}
