import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import { ensureAiFriend } from '@/lib/ai-friend'

const COLORS = ['#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')
    const nickname = String(body?.nickname ?? '').trim() || username

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return NextResponse.json(
        { error: '用户名需为 3-20 位字母、数字或下划线' },
        { status: 400 }
      )
    }
    if (password.length < 6 || password.length > 64) {
      return NextResponse.json({ error: '密码长度需在 6-64 位之间' }, { status: 400 })
    }

    const existing = await db.user.findUnique({ where: { username } })
    if (existing) {
      return NextResponse.json({ error: '该用户名已被注册' }, { status: 409 })
    }

    const user = await db.user.create({
      data: {
        username,
        password: hashPassword(password),
        nickname,
        avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
      },
    })

    // 新用户开箱即有一个 AI 好友（否则好友列表为空）
    await ensureAiFriend(user.id)

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
    console.error('register error:', e)
    return NextResponse.json({ error: '服务器错误，请稍后再试' }, { status: 500 })
  }
}
