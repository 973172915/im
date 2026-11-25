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
import { recallFacts, formatMemoryBlock, rememberFromMessage } from '@/lib/memory'
import { splitByBudget, mergeSummary, formatSummary } from '@/lib/context'
import { recallHistory, formatRecallBlock, RECALL_INTENT } from '@/lib/recall'

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL ?? 'http://127.0.0.1:9200'
/** 每次读多少条消息用于「预算窗口 + 摘要」计算（不是实际进 prompt 的数量） */
const HISTORY_SCAN_LIMIT = 60
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

    // 取比预算窗口更多的消息：多出来的部分用于生成滚动摘要
    const history = await db.message.findMany({
      where: { conversationId },
      orderBy: { id: 'desc' },
      take: HISTORY_SCAN_LIMIT,
      select: { id: true, senderId: true, content: true },
    })
    const ordered = history.slice().reverse()
    if (ordered.length === 0) return

    const withRole = ordered.map((m) => ({
      ...m,
      role: (m.senderId === agentId ? 'assistant' : 'user') as 'user' | 'assistant',
    }))

    // 按 token 预算切分：recent 进 prompt，overflow 进摘要
    const { recent, overflow } = splitByBudget(withRole)

    // 滚动摘要：只处理上次摘要之后的新溢出消息，避免重复压缩
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { summary: true, summaryMsgId: true },
    })
    let summary = conv?.summary ?? ''
    const coveredUpTo = conv?.summaryMsgId ?? 0
    const toSummarize = overflow.filter((m) => m.id > coveredUpTo)
    if (toSummarize.length) {
      summary = mergeSummary(summary, toSummarize)
      await db.conversation.update({
        where: { id: conversationId },
        data: { summary, summaryMsgId: toSummarize[toSummarize.length - 1].id },
      })
    }

    const messages = recent.map((m) => ({ role: m.role, content: m.content }))

    if (process.env.MEMORY_DEBUG === '1') {
      console.error(
        '[ai-agent] ctx recent=%d overflow=%d toSum=%d summaryLen=%d',
        recent.length,
        overflow.length,
        toSummarize.length,
        summary.length
      )
    }

    // 最近一条「人类」消息：记忆按人隔离，只取这个人说过的话
    const lastHuman = [...ordered].reverse().find((m) => m.senderId !== agentId)
    const parts: string[] = [agent.persona]
    const summaryBlock = formatSummary(summary)
    if (summaryBlock) parts.push(summaryBlock)
    if (lastHuman) {
      try {
        const facts = await recallFacts(lastHuman.senderId, lastHuman.content, 3)
        const block = formatMemoryBlock(facts)
        if (block) parts.push(block)
      } catch (e) {
        console.error('[ai-agent] 记忆召回失败:', e)
      }

      // 情景记忆：把被挤出上下文的历史原文捞回来（仅限显式回忆提问）
      if (RECALL_INTENT.test(lastHuman.content)) {
        try {
          const recalled = await recallHistory(
            conversationId,
            lastHuman.content,
            recent.map((m) => m.id),
            2
          )
          const block = formatRecallBlock(recalled)
          if (block) parts.push(block)
          if (process.env.MEMORY_DEBUG === '1') {
            console.error('[ai-agent] recall=%d', recalled.length)
          }
        } catch (e) {
          console.error('[ai-agent] 历史检索失败:', e)
        }
      }
    }
    const persona = parts.filter(Boolean).join('\n\n')

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

    if (process.env.MEMORY_DEBUG === '1') {
      console.error('[ai-agent] persona=%s', JSON.stringify(persona))
    }

    const res = await fetch(`${AI_GATEWAY_URL}/v1/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        persona,
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

    // 异步抽取长期记忆（不阻塞回复，失败不影响对话）
    if (lastHuman) {
      void rememberFromMessage(lastHuman.senderId, lastHuman.content, lastHuman.id).catch((e) =>
        console.error('[ai-agent] 记忆抽取失败:', e)
      )
    }

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
          senderKind: saved.sender.kind,
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
