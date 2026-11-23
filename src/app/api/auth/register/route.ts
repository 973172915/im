import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, createSession, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth'

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
    // httpOnly 会话 cookie
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    })
    // 非 httpOnly token，供前端 socket 认证
    res.cookies.set('im_token', token, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    })
    return res
  } catch (e) {
    console.error('register error:', e)
    return NextResponse.json({ error: '服务器错误，请稍后再试' }, { status: 500 })
  }
}
