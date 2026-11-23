/**
 * AI 好友的回复生成器。
 *
 * 流程：读最近 N 条消息 → 调 ai-gateway（SSE）→ 逐块广播 message:delta
 *       → 结束落库 + 广播 message:new / message:done。
 *
 * 约定：同一会话同时只允许一个生成，新消息会打断旧的。
 */
import { db } from '@/lib/db'
import { broadcastToChatService } from '@/lib/chat-service'

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL ?? 'http://127.0.0.1:9200'
const HISTORY_LIMIT = 20
const FALLBACK_TEXT = '（走神了一下…你刚才说什么？）'

/** conversationId -> 正在跑的 AbortController */
const running = new Map<string, AbortController>()

export function isAgentReplying(conversationId: string): boolean {
  return running.has(conversationId)
}

/** 中断某会话正在进行的生成（用户发新消息时调用） */
export function cancelAgentReply(conversationId: string): void {
  running.get(conversationId)?.abort()
  running.delete(conversationId)
}

function sseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    events.push(rest.slice(0, idx))
    rest = rest.slice(idx + 2)
  }
  return { events, rest }
}

function payloadFromEvent(chunk: string): Record<string, unknown> | null {
  const line = chunk.split('\n').find((l) => l.startsWith('data:'))
  if (!line) return null
  try {
    return JSON.parse(line.slice(5).trim())
  } catch {
    return null
  }
}

export async function respondAsAgent(conversationId: string, agentId: string): Promise<void> {
  cancelAgentReply(conversationId)
  const controller = new AbortController()
  running.set(conversationId, controller)

  const room = `conv:${conversationId}`
  let agent: { id: string; nickname: string; avatarColor: string; persona: string } | null = null

  try {
    const found = await db.user.findUnique({
      where: { id: agentId },
      select: { id: true, nickname: true, avatarColor: true, persona: true, kind: true },
    })
    if (!found || found.kind !== 'ai') return
    agent = found

    // 上下文：最近 N 条，按 id 升序
    const history = await db.message.findMany({
      where: { conversationId },
      orderBy: { id: 'desc' },
      take: HISTORY_LIMIT,
      select: { senderId: true, content: true },
    })
    const messages = history
      .reverse()
      .map((m) => ({
        role: m.senderId === agentId ? 'assistant' : 'user',
        content: m.content,
      }))
    if (messages.length === 0) return

    // 「正在输入」
    await broadcastToChatService({
      room,
      event: 'typing:update',
      payload: {
        conversationId,
        userId: agent.id,
        nickname: agent.nickname,
        isTyping: true,
      },
    })

    const res = await fetch(`${AI_GATEWAY_URL}/v1/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        persona: agent.persona,
        session_id: conversationId,
      }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`ai-gateway ${res.status}`)

    let text = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parsed = sseEvents(buf)
      buf = parsed.rest
      for (const chunk of parsed.events) {
        const evt = payloadFromEvent(chunk)
        if (!evt) continue
        if (evt.type === 'delta' && typeof evt.text === 'string' && evt.text) {
          text += evt.text
          await broadcastToChatService({
            room,
            event: 'message:delta',
            payload: {
              conversationId,
              agentId: agent.id,
              nickname: agent.nickname,
              avatarColor: agent.avatarColor,
              text: evt.text,
            },
          })
        } else if (evt.type === 'error') {
          throw new Error(String(evt.message ?? 'ai-gateway error'))
        }
      }
    }

    const content = text.trim() || FALLBACK_TEXT
    const saved = await db.message.create({
      data: { conversationId, senderId: agent.id, content },
      include: { sender: true },
    })
    await db.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })

    await broadcastToChatService({
      room,
      event: 'message:new',
      payload: {
        message: {
          id: saved.id,
          conversationId: saved.conversationId,
          senderId: saved.senderId,
          senderNickname: saved.sender.nickname,
          senderAvatarColor: saved.sender.avatarColor,
          content: saved.content,
          createdAt: saved.createdAt.toISOString(),
        },
      },
    })
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      console.error('[ai-agent] 生成失败:', e)
      // 失败降级：让用户知道不是没反应
      try {
        if (agent) {
          await broadcastToChatService({
            room,
            event: 'message:delta',
            payload: {
              conversationId,
              agentId: agent.id,
              nickname: agent.nickname,
              avatarColor: agent.avatarColor,
              text: FALLBACK_TEXT,
            },
          })
        }
      } catch {
        /* ignore */
      }
    }
  } finally {
    running.delete(conversationId)
    // 清掉 typing
    if (agent) {
      await broadcastToChatService({
        room,
        event: 'typing:update',
        payload: { conversationId, userId: agent.id, nickname: agent.nickname, isTyping: false },
      }).catch(() => {})
    }
    await broadcastToChatService({
      room,
      event: 'message:done',
      payload: { conversationId, agentId },
    }).catch(() => {})
  }
}
