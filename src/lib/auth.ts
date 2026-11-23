import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { cookies } from 'next/headers'

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

/** 从请求 cookie 中取当前登录用户（route handler 内使用） */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  return getUserByToken(cookieStore.get(SESSION_COOKIE)?.value)
}

export function sessionCookieOptions(maxAgeSeconds: number = SESSION_TTL_MS / 1000) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}
