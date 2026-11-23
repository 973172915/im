import { NextRequest, NextResponse } from 'next/server'
import { getUserOverview } from '@/lib/conversations'

/** 供 chat-service 获取用户会话概览（房间 + 相关用户） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
  const overview = await getUserOverview(id)
  return NextResponse.json(overview)
}
