import { NextRequest, NextResponse } from 'next/server'
import { getUserByToken } from '@/lib/auth'

/** 供 chat-service 验证 socket token */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  const user = await getUserByToken(token)
  if (!user) {
    return NextResponse.json({ valid: false }, { status: 401 })
  }
  return NextResponse.json({
    valid: true,
    userId: user.id,
    username: user.username,
    nickname: user.nickname,
    avatarColor: user.avatarColor,
  })
}
