/**
 * 记忆调试接口：
 *   GET    /api/memory   列出当前登录用户的全部记忆
 *   DELETE /api/memory   清空当前登录用户的记忆
 *
 * 仅用于开发/演示，生产环境应加权限控制或关闭。
 */
import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { listMemories } from '@/lib/memory'

export async function GET() {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const items = await listMemories(me.id)
  return NextResponse.json({
    count: items.length,
    items: items.map((it) => ({
      id: it.id,
      scope: it.scope,
      kind: it.kind,
      content: it.content,
      keywords: it.keywords,
      confidence: it.confidence,
      expiresAt: it.expiresAt,
      createdAt: it.createdAt,
      lastUsedAt: it.lastUsedAt,
      usedCount: it.usedCount,
    })),
  })
}

export async function DELETE() {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const res = await db.memoryItem.deleteMany({ where: { userId: me.id } })
  return NextResponse.json({ deleted: res.count })
}
