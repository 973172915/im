import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { cookies, headers } from 'next/headers'
import type { NextRequest } from 'next/server'

export const SESSION_COOKIE = 'im_session'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  try {
    const hashBuf = Buffer.from(hash, 'hex')
    const testBuf = scryptSync(password, salt, 64)
    return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf)
  } catch {
    return false
  }
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await db.session.create({
    data: {
      token,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })
  return token
}

export interface SessionUser {
  id: string
  username: string
  nickname: string
  bio: string
  avatarColor: string
}

export async function getUserByToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null
  const session = await db.session.findUnique({
    where: { token },
    include: { user: true },
  })
  if (!session || session.expiresAt < new Date()) return null
  const u = session.user
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    bio: u.bio,
    avatarColor: u.avatarColor,
  }
}

/** 从请求 cookie 中取当前登录用户（route handler 内使用）
 * 兼容 iframe 内嵌等第三方 Cookie 受限场景：
 * Cookie 缺失时回落到 Authorization: Bearer <token> 头认证 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  let token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) {
    const headerStore = await headers()
    const authorization = headerStore.get('authorization')
    if (authorization?.startsWith('Bearer ')) {
      token = authorization.slice(7).trim()
    }
  }
  return getUserByToken(token)
}

/** 根据请求协议返回 cookie 选项：
 * HTTPS（网关转发 x-forwarded-proto=https）时用 SameSite=None + Secure，
 * 保证预览面板等 iframe 内嵌场景可正常携带；本地 HTTP 保持 Lax */
export function sessionCookieOptions(
  req: NextRequest,
  maxAgeSeconds: number = SESSION_TTL_MS / 1000
) {
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
    req.nextUrl.protocol.replace(':', '')
  if (proto === 'https') {
    return {
      httpOnly: true,
      sameSite: 'none' as const,
      secure: true,
      path: '/',
      maxAge: maxAgeSeconds,
    }
  }
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

/** 从请求中提取会话 token（优先 Cookie，其次 Bearer 头），供登出等场景使用 */
export function extractSessionToken(req: NextRequest): string | undefined {
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value
  if (cookieToken) return cookieToken
  const authorization = req.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim()
  return undefined
}
