/**
 * 语音合成代理：前端 <audio> 直接请求本接口，服务端转发到 TTS 服务。
 *
 * 为什么要代理：
 *   1. TTS 服务在另一端口，浏览器直连会有跨域与端口暴露问题
 *   2. 可以做登录校验，避免被当公共 TTS 用
 *
 * 环境变量：
 *   VOICE_URL   TTS 服务地址，默认 http://127.0.0.1:9100
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'

const VOICE_URL = (process.env.VOICE_URL ?? 'http://127.0.0.1:9100').replace(/\/$/, '')
const MAX_TEXT = 300

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: '未登录' }, { status: 401 })

  const text = (req.nextUrl.searchParams.get('text') ?? '').trim().slice(0, MAX_TEXT)
  const voice = req.nextUrl.searchParams.get('voice') ?? undefined
  if (!text) return NextResponse.json({ error: 'text 不能为空' }, { status: 400 })

  const url = new URL(`${VOICE_URL}/api/tts`)
  url.searchParams.set('text', text)
  if (voice) url.searchParams.set('voice', voice)

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      return NextResponse.json(
        { error: '语音合成失败', detail: detail.slice(0, 200) },
        { status: 502 }
      )
    }
    return new NextResponse(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'audio/mpeg',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json({ error: '语音服务不可用' }, { status: 503 })
  }
}
