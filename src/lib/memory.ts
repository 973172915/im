/**
 * 长期记忆：抽取 / 存储 / 召回 / 注入。
 *
 * 设计要点：
 *  1. 抽取用规则（确定性、零延迟、离线可用），后续可替换成小模型抽取
 *  2. 存储按 userId 隔离，scope=global 预留给知识库
 *  3. 召回是「关键词命中 + 时间新鲜度」，向量层留作第二阶段
 *  4. 注入有字数上限，避免破坏微调后的短句人设
 */
import { db } from '@/lib/db'

/** 一条可抽取的事实模板 */
interface Rule {
  id: string
  /** 匹配用户消息 */
  re: RegExp
  /** 由匹配结果生成事实文本 */
  fact: (m: RegExpMatchArray) => string
  /** 召回用的关键词（命中任意一个即可加分） */
  keywords: string[]
  /** 有效期（天）；null 表示长期有效 */
  ttlDays: number | null
  /** 置信度 */
  confidence: number
}

const RULES: Rule[] = [
  {
    id: 'overtime',
    re: /(加班|熬夜|通宵)/,
    fact: () => '最近经常加班或熬夜，比较累',
    keywords: ['加班', '熬夜', '通宵', '累', '工作', '上班'],
    ttlDays: 14,
    confidence: 0.9,
  },
  {
    id: 'tired',
    re: /(好累|很累|累死|压力(?:好)?大|扛不住|顶不住|好烦|烦死)/,
    fact: () => '最近压力偏大，容易觉得累',
    keywords: ['累', '压力', '烦', '困', '没精神'],
    ttlDays: 14,
    confidence: 0.8,
  },
  {
    id: 'sleep',
    re: /(失眠|睡不着|睡不好|起不来|熬夜到)/,
    fact: () => '最近睡眠不太好',
    keywords: ['失眠', '睡不着', '睡不好', '困', '熬夜'],
    ttlDays: 21,
    confidence: 0.85,
  },
  {
    id: 'job',
    re: /我是(?:一?名?)?(程序员|工程师|设计师|产品经理|运营|老师|学生|医生|护士|销售|律师)/,
    fact: (m) => `职业是${m[1]}`,
    keywords: ['工作', '职业', '上班', '公司'],
    ttlDays: null,
    confidence: 0.9,
  },
  {
    id: 'company',
    re: /我在(.{2,10}?)(?:工作|上班)/,
    fact: (m) => `在${m[1]}工作`,
    keywords: ['工作', '公司', '上班', '单位'],
    ttlDays: null,
    confidence: 0.8,
  },
  {
    id: 'name',
    re: /(?:我叫|我的名字是|叫我)([\u4e00-\u9fa5]{2,4})(?:[，。！？,.!?\s]|$)/,
    fact: (m) => `名字叫${m[1]}`,
    keywords: ['名字', '叫我', '称呼'],
    ttlDays: null,
    confidence: 0.9,
  },
  {
    id: 'dislike',
    re: /我(?:不喜欢|讨厌|受不了)(.{2,10}?)(?:[，。！？,.!?\s]|$)/,
    fact: (m) => `不喜欢${m[1]}`,
    keywords: ['不喜欢', '讨厌', '受不了'],
    ttlDays: null,
    confidence: 0.8,
  },
  {
    id: 'like',
    re: /我(?:很)?(?:喜欢|爱)(.{2,10}?)(?:[，。！？,.!?\s]|$)/,
    fact: (m) => `喜欢${m[1]}`,
    keywords: ['喜欢', '爱'],
    ttlDays: null,
    confidence: 0.75,
  },
  {
    id: 'pet',
    re: /我(?:养了?|家有)(.{1,4}?)(猫|狗|仓鼠|兔子|鸟)/,
    fact: (m) => `养了${m[1]}${m[2]}`,
    keywords: ['猫', '狗', '宠物', '养'],
    ttlDays: null,
    confidence: 0.85,
  },
]

export interface ExtractedFact {
  ruleId: string
  content: string
  keywords: string[]
  confidence: number
  ttlDays: number | null
}

/** 从一条用户消息里抽取事实（纯函数，便于测试） */
export function extractFacts(text: string): ExtractedFact[] {
  const input = (text || '').trim()
  if (!input || input.length > 200) return []

  const out: ExtractedFact[] = []
  const seen = new Set<string>()

  for (const rule of RULES) {
    const m = input.match(rule.re)
    if (!m) continue
    const content = rule.fact(m)
    if (seen.has(content)) continue
    seen.add(content)
    out.push({
      ruleId: rule.id,
      content,
      keywords: rule.keywords,
      confidence: rule.confidence,
      ttlDays: rule.ttlDays,
    })
  }
  return out
}

/** 写入记忆（同内容去重：更新置信度与时间，不新增行） */
export async function saveFacts(
  userId: string,
  facts: ExtractedFact[],
  sourceMsgId?: number
): Promise<number> {
  if (!facts.length) return 0

  let saved = 0
  for (const f of facts) {
    const existing = await db.memoryItem.findFirst({
      where: { userId, kind: 'fact', content: f.content },
      select: { id: true },
    })

    const expiresAt = f.ttlDays ? new Date(Date.now() + f.ttlDays * 86400_000) : null

    if (existing) {
      await db.memoryItem.update({
        where: { id: existing.id },
        data: {
          confidence: f.confidence,
          expiresAt,
          keywords: f.keywords.join(' '),
        },
      })
    } else {
      await db.memoryItem.create({
        data: {
          scope: 'user',
          userId,
          kind: 'fact',
          content: f.content,
          keywords: f.keywords.join(' '),
          confidence: f.confidence,
          sourceMsgId,
          expiresAt,
        },
      })
      saved++
    }
  }
  return saved
}

/** 从一条消息中抽取并保存（给 ai-agent 异步调用） */
export async function rememberFromMessage(
  userId: string,
  text: string,
  sourceMsgId?: number
): Promise<number> {
  const facts = extractFacts(text)
  return saveFacts(userId, facts, sourceMsgId)
}

export interface RecalledFact {
  id: string
  content: string
  score: number
}

/** 显式回忆意图：「你还记得吗」「上次」「之前」——此时按时间取最近的记忆，不依赖关键词 */
const RECALL_INTENT = /(还记得|记得|记不记得|上次|之前|我说过|忘了吗|我说的话)/

/**
 * 召回：关键词命中为主，时间新鲜度做加权。
 * 若用户明确在问"记不记得"，则退化为按时间取最近的几条（纯关键词会漏，比如"忙"不在关键词里）。
 * 注意：必须带 userId 过滤，防跨用户串记忆。
 */
export async function recallFacts(
  userId: string,
  query: string,
  limit = 3
): Promise<RecalledFact[]> {
  const text = (query || '').trim()
  if (!text) return []

  const items = await db.memoryItem.findMany({
    where: {
      kind: 'fact',
      AND: [
        { OR: [{ scope: 'user', userId }, { scope: 'global' }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      ],
    },
    select: { id: true, content: true, keywords: true, createdAt: true, confidence: true, scope: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const now = Date.now()
  const scored: RecalledFact[] = []
  const wantsRecall = RECALL_INTENT.test(text)

  for (const it of items) {
    const kws = it.keywords.split(' ').filter(Boolean)
    let hits = 0
    for (const kw of kws) {
      if (kw && text.includes(kw)) hits++
    }
    // 没有关键词命中且不是显式回忆意图 → 不召回，避免噪音
    if (hits === 0 && !wantsRecall) continue

    const ageDays = (now - it.createdAt.getTime()) / 86400_000
    const fresh = ageDays <= 7 ? 0.3 : ageDays <= 30 ? 0.1 : 0
    // 显式回忆意图时，越新越靠前
    const score = (wantsRecall ? 1 : 0) + hits + fresh + it.confidence * 0.2

    scored.push({ id: it.id, content: it.content, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  // 记录被召回（用于后续统计与"最近提到过"）
  if (top.length) {
    await db.memoryItem
      .updateMany({
        where: { id: { in: top.map((t) => t.id) } },
        data: { lastUsedAt: new Date(), usedCount: { increment: 1 } },
      })
      .catch(() => {})
  }

  return top
}

/**
 * 拼成注入用的上下文片段。
 *
 * 实测结论（4B int4）：
 *  - 「你知道对方……」→ 模型不采纳，甚至答「我记不得」
 *  - 「[对方的情况]」+ 指令块 → 会被逐字复述
 *  - 「你记得对方说过……」→ 自然引用，问答都能命中 ✅
 * 所以固定用最后一种措辞，并限制长度避免破坏短句人设。
 */
export function formatMemoryBlock(facts: RecalledFact[]): string {
  if (!facts.length) return ''
  const joined = facts.map((f) => f.content).join('；')
  const block = `你记得对方说过：${joined}。`
  return block.length > 110 ? block.slice(0, 110) + '…' : block
}

/** 调试用：列出某用户的全部记忆 */
export async function listMemories(userId: string) {
  return db.memoryItem.findMany({
    where: { OR: [{ scope: 'user', userId }, { scope: 'global' }] },
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true,
      scope: true,
      kind: true,
      content: true,
      keywords: true,
      confidence: true,
      expiresAt: true,
      createdAt: true,
      lastUsedAt: true,
      usedCount: true,
    },
    take: 100,
  })
}
