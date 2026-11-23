import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

/** 标记会话已读 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const { id } = await params
  const membership = await db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: me.id } },
  })
  if (!membership) {
    return NextResponse.json({ error: '无权访问该会话' }, { status: 403 })
  }

  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: me.id } },
    data: { lastReadAt: new Date() },
  })

  return NextResponse.json({ ok: true })
}
