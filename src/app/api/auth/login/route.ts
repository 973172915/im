import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')

    if (!username || !password) {
      return NextResponse.json({ error: '请输入用户名和密码' }, { status: 400 })
    }

    const user = await db.user.findUnique({ where: { username } })
    if (!user || !verifyPassword(password, user.password)) {
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 })
    }

    const token = await createSession(user.id)
    const res = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        bio: user.bio,
        avatarColor: user.avatarColor,
      },
      token,
    })
    // httpOnly 会话 cookie（HTTPS 下 SameSite=None+Secure，兼容 iframe 内嵌）
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req))
    // 非 httpOnly token，供前端 socket 认证
    res.cookies.set('im_token', token, {
      ...sessionCookieOptions(req),
      httpOnly: false,
    })
    return res
  } catch (e) {
    console.error('login error:', e)
    return NextResponse.json({ error: '服务器错误，请稍后再试' }, { status: 500 })
  }
}
