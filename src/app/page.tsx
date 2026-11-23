'use client'

import { useEffect } from 'react'
import { AuthScreen } from '@/components/im/auth-screen'
import { ChatApp } from '@/components/im/chat-app'
import { api } from '@/lib/api'
import { useIMStore } from '@/store/im-store'

function readTokenCookie(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)im_token=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export default function Home() {
  const me = useIMStore((s) => s.me)
  const authChecked = useIMStore((s) => s.authChecked)
  const setMe = useIMStore((s) => s.setMe)
  const setToken = useIMStore((s) => s.setToken)
  const setAuthChecked = useIMStore((s) => s.setAuthChecked)

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then(({ user }) => {
        if (cancelled) return
        setMe(user)
        setToken(readTokenCookie())
      })
      .catch(() => {
        /* 未登录 */
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [setMe, setToken, setAuthChecked])

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-stone-50 to-amber-50">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-pulse rounded-2xl bg-emerald-500/60" />
          <p className="text-sm text-stone-400">正在加载…</p>
        </div>
      </div>
    )
  }

  if (!me) return <AuthScreen />
  return <ChatApp />
}
