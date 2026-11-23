import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SESSION_COOKIE, extractSessionToken, sessionCookieOptions } from '@/lib/auth'

export async function POST(req: NextRequest) {
  // 优先 Cookie，其次 Authorization 头（iframe 内嵌等 Cookie 受限场景）
  const token = extractSessionToken(req)
  if (token) {
    await db.session.deleteMany({ where: { token } }).catch(() => null)
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(req), maxAge: 0 })
  res.cookies.set('im_token', '', { ...sessionCookieOptions(req), httpOnly: false, maxAge: 0 })
  return res
}
