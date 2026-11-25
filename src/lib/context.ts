/**
 * 上下文预算与滚动摘要。
 *
 * 规则：
 *  1. 从最新消息往前累加，直到超过预算，剩余部分不再进 prompt
 *  2. 被挤出去的消息压缩成一段摘要，累加到 Conversation.summary
 *  3. 摘要只保留线索（聊过什么），不做文学润色，且长度有上限
 */
import { estimateTokens } from '@/lib/tokens'

export interface Msg {
  id: number
  senderId: string
  content: string
  role?: 'user' | 'assistant'
}

/** 消息预算（token）。persona、摘要、记忆另算，这里只限制对话原文。 */
export const MESSAGE_TOKEN_BUDGET = Number(process.env.MESSAGE_TOKEN_BUDGET ?? 1200)

/** 摘要长度上限（字符） */
const SUMMARY_MAX_CHARS = 300
/** 每次摘要最多合并几条消息（分组，避免大批次丢中间） */
const SUMMARY_GROUP_SIZE = 6

/**
 * 从最新往前取，返回：
 *  - recent：进入 prompt 的消息（保持时间正序）
 *  - overflow：被挤出窗口、需要摘要的消息（时间正序）
 */
export function splitByBudget<T extends { content: string }>(
  messages: T[],
  budget = MESSAGE_TOKEN_BUDGET
): { recent: T[]; overflow: T[] } {
  if (!messages.length) return { recent: [], overflow: [] }

  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content)
    // 至少保留最新一条，否则模型没得回
    if (used + cost > budget && start < messages.length) break
    used += cost
    start = i
  }
  return { recent: messages.slice(start), overflow: messages.slice(0, start) }
}

function snippet(text: string, max = 14): string {
  const t = text.replace(/\s+/g, ' ').replace(/[，。！？,.!?]/g, ' ').trim()
  return t.length > max ? t.slice(0, max) : t
}

/**
 * 滚动摘要（模板版）。
 *
 * 分批处理：把溢出消息按 6 条一组切分，组内全部摘录后拼接。
 * 这样「一次溢出 30 条」也不会只保留头尾、丢掉中间。
 * 总长仍受 SUMMARY_MAX_CHARS 限制，超长时保留较新的部分——
 * 更早的细节不再依赖摘要，而是靠历史检索（recall）找回。
 */
export function mergeSummary(
  oldSummary: string,
  overflow: { role?: 'user' | 'assistant'; content: string }[]
): string {
  const userTexts = overflow
    .filter((m) => m.role !== 'assistant')
    .map((m) => snippet(m.content))
    .filter(Boolean)

  // 按组切分，组内去重后全部保留
  const groups: string[] = []
  for (let i = 0; i < userTexts.length; i += SUMMARY_GROUP_SIZE) {
    const group = [...new Set(userTexts.slice(i, i + SUMMARY_GROUP_SIZE))]
    if (group.length) groups.push(group.join('、'))
  }

  const add = groups.join('；')
  let merged = oldSummary && add ? `${oldSummary}；${add}` : oldSummary || add
  if (merged.length > SUMMARY_MAX_CHARS) {
    merged = '…' + merged.slice(-(SUMMARY_MAX_CHARS - 1))
  }
  return merged
}

/** 组装给模型看的摘要段落 */
export function formatSummary(summary: string): string {
  const s = (summary || '').trim()
  if (!s) return ''
  return `之前聊过：${s}`
}
