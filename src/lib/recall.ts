/**
 * 情景记忆（recall storage）：从历史消息里按关键词捞回细节。
 *
 * 为什么需要：
 *   上下文预算只保留最近的原文，被挤出去的消息虽然还在数据库里，
 *   但模型看不到。摘要只能保留线索，找不回具体细节。
 *   这里直接检索 Message 表，把命中的原始消息重新注入 prompt。
 *
 * 参考 MemGPT 的 recall storage 思路：淘汰 ≠ 删除，按需查回。
 */
import { db } from '@/lib/db'

/** 显式回忆意图：只有这类提问才触发历史检索，避免每轮都注入无关消息 */
export const RECALL_INTENT = /(还记得|记得|记不记得|上次|之前|我说过|忘了吗|我说的话|聊过|那次)/

/** 高频繁但无检索意义的词，避免匹配到大量无关消息 */
const STOPWORDS = new Set([
  '什么', '怎么', '为什么', '那个', '这个', '一下', '可以', '我们', '你们', '他们',
  '现在', '刚才', '然后', '就是', '还是', '不是', '有没有', '记得', '上次', '之前',
  '我说', '你说', '说过', '聊过',
])

/**
 * 从提问里抽关键词：按中文片段生成 3-gram 优先、2-gram 补足。
 * 简单但够用——检索目标是"能捞回相关消息"，不是分词准确率。
 */
export function extractKeywords(text: string, max = 8): string[] {
  // 先去掉"你还记得…吗""我之前说过"这类客套前缀，
  // 否则 3-gram 全被它们占满，真正的实词（想养猫）会被截掉
  const cleaned = text
    .replace(/(你还|你)?(记不记得|还记得|记得|记不记得)/g, '')
    .replace(/(我)?(之前|上次|那次|以前|刚才)(说|讲|提|聊)?(过|的)?/g, '')
    .replace(/[?？吗呢吧啊呀哦嗯]/g, ' ')
    .trim()

  const runs = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  const three = new Set<string>()
  const two = new Set<string>()

  for (const run of runs) {
    for (let i = 0; i + 3 <= run.length; i++) {
      const g = run.slice(i, i + 3)
      if (!STOPWORDS.has(g)) three.add(g)
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2)
      if (!STOPWORDS.has(g)) two.add(g)
    }
  }

  const picked = [...three, ...two]
  return picked.slice(0, max)
}

export interface RecalledMessage {
  id: number
  content: string
  createdAt: Date
  hits: number
}

/**
 * 在某个会话的历史消息里检索。
 *
 * 没有走 SQL LIKE：中文「想养猫」和原文「想养只猫」不是子串关系，LIKE 会漏。
 * 改为取出近期消息在内存里打分——二元组重叠 + 完整命中，兼顾模糊与精确。
 *
 * @param excludeIds 已在上下文里的消息 id，排除掉避免重复
 */
export async function recallHistory(
  conversationId: string,
  query: string,
  excludeIds: number[] = [],
  limit = 2
): Promise<RecalledMessage[]> {
  const keywords = extractKeywords(query)
  if (!keywords.length) return []

  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: { id: 'desc' },
    take: 500,
    select: { id: true, content: true, createdAt: true },
  })
  if (!rows.length) return []

  const queryBigrams = bigrams(query)
  const excluded = new Set(excludeIds)
  const threeGrams = keywords.filter((k) => k.length >= 3)
  const twoGrams = keywords.filter((k) => k.length === 2)

  const scored = rows
    .filter((r) => !excluded.has(r.id))
    .map((r) => {
      let score = 0

      // 完整命中权重最高
      for (const k of threeGrams) {
        if (r.content.includes(k)) score += 2
        // 「想养猫」vs 原文「想养只猫」：不是子串，但字符按序出现 —— 子序列算半个命中
        else if (isSubsequence(k, r.content)) score += 1.2
      }
      for (const k of twoGrams) {
        if (r.content.includes(k)) score += 0.8
      }

      // 二元组重叠作为补充信号
      const msgBigrams = bigrams(r.content)
      let overlap = 0
      for (const g of queryBigrams) if (msgBigrams.has(g)) overlap++
      const ratio = queryBigrams.size ? overlap / queryBigrams.size : 0

      return { id: r.id, content: r.content, createdAt: r.createdAt, score: score + ratio * 2, ratio }
    })
    // 排除与当前提问高度相似的消息：那是"上次问过的同一个问题"，不是可用的回忆
    .filter((r) => r.score >= 1.2 && r.ratio < 0.75)

  scored.sort((a, b) => b.score - a.score || b.id - a.id)
  return scored
    .slice(0, limit)
    .map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt, hits: Math.round(r.score * 10) / 10 }))
}

/** 判断 needle 的字符是否按顺序出现在 haystack 中（中文分词不一致时的兜底匹配） */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length < 2) return false
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

/** 生成文本的二元组集合（忽略标点空白） */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2))
  return out
}

/** 相对时间，让注入的文本更像"记忆"而不是日志 */
export function relativeTime(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  return `${Math.floor(days / 30)} 个月前`
}

/** 组装成注入块 */
export function formatRecallBlock(msgs: RecalledMessage[]): string {
  if (!msgs.length) return ''
  const lines = msgs
    .map((m) => `- ${relativeTime(m.createdAt)}你说过：${m.content.slice(0, 40)}`)
    .join('\n')
  const block = `你记得之前聊到过：\n${lines}`
  return block.length > 140 ? block.slice(0, 140) + '…' : block
}
